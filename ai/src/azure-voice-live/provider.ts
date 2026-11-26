/**
 * The Azure Voice Live provider and its relay: one-use tickets in a shared
 * store, the Node server a browser connects to, and the call that joins a
 * browser to Azure with the credential the browser never sees.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inProcessShared } from "../shared.ts";
import type { VoiceTicket } from "../voice.ts";
import { acceptWebSocket, refuseUpgrade, type ServerSocket } from "../ws.ts";
import { azureVoiceLiveSession, relayedClientEvent } from "./protocol.ts";
import type { AzureVoiceLiveOptions, AzureVoiceLiveProvider } from "./types.ts";

/** How often a refused connection to the provider is tried again, and after how long. */
const RETRIES = 1;
const RETRY_AFTER_MS = 600;
/**
 * How much the browser may say before the provider is ready for it. A
 * reader's microphone sends about 43 KB a second (16 kHz PCM, as base64), so
 * this is half a minute of it, many times what a connection takes.
 */
const MAX_EARLY_BYTES = 1_500_000;
/**
 * How much may wait to be sent to the provider. More means the browser sends
 * faster than real time, or the provider has stopped reading: the call ends.
 */
const MAX_UPSTREAM_BUFFERED_BYTES = 4_000_000;

interface Ticket {
  session: Record<string, unknown>;
}

type HeaderSocket = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

export function azureVoiceLiveVoice(
  options: AzureVoiceLiveOptions = {},
): AzureVoiceLiveProvider {
  const {
    model = "gpt-realtime-2",
    voice = "en-US-AvaMultilingualNeural",
    apiVersion = "2026-04-10",
    startWithinSeconds = 60,
    sessionSeconds = 900,
    relay = {},
  } = options;
  const tickets = options.shared ?? inProcessShared();
  const ticketKey = (id: string): string => `azure-voice-live:ticket:${id}`;
  /** The tickets this provider made and when each lapses, so `close` can withdraw them. */
  const issued = new Map<string, number>();
  const calls = new Set<() => void>();
  let listening: Promise<Server> | null = null;

  const credential = async (): Promise<Record<string, string>> => {
    const apiKey = options.apiKey ?? process.env.AZURE_VOICE_LIVE_API_KEY;
    if (apiKey) return { "api-key": apiKey };
    const source = options.token ?? process.env.AZURE_VOICE_LIVE_TOKEN;
    const token = typeof source === "function" ? await source() : source;
    if (!token) throw new Error("No Azure Voice Live key or token is set.");
    return { Authorization: `Bearer ${token}` };
  };

  const upstreamUrl = (): string => {
    const endpoint = options.endpoint ?? process.env.AZURE_VOICE_LIVE_ENDPOINT;
    const base =
      options.wsBase ??
      (endpoint ? endpoint.replace(/^http/, "ws").replace(/\/+$/, "") : "");
    if (!base) throw new Error("No Azure Voice Live endpoint is set.");
    return `${base}/voice-live/realtime?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;
  };

  /** One call: a browser on one side, the provider on the other. */
  async function connect(browser: ServerSocket, ticket: Ticket): Promise<void> {
    let upstream: WebSocket | null = null;
    /** What the browser said before the provider was ready for it. */
    let early: string[] | null = [];
    let earlyBytes = 0;
    const end = (reason: string): void => {
      clearTimeout(limit);
      calls.delete(hangUp);
      browser.close(1000, reason);
      if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
    };
    const hangUp = (): void => end("The server is stopping.");
    const limit = setTimeout(
      () => end("The call reached its time limit."),
      sessionSeconds * 1000,
    );
    calls.add(hangUp);
    browser.onClose = () => end("");
    browser.onMessage = (raw) => {
      const event = relayedClientEvent(raw);
      if (!event) return;
      const message = JSON.stringify(event);
      if (early) {
        earlyBytes += message.length;
        if (earlyBytes > MAX_EARLY_BYTES) {
          early = [];
          end("Too much was sent before the call started.");
          return;
        }
        early.push(message);
      } else if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > MAX_UPSTREAM_BUFFERED_BYTES) {
          end("The voice provider is not keeping up with the call.");
          return;
        }
        upstream.send(message);
      }
    };
    /**
     * Connect to the provider. A refusal before the connection opens is
     * tried once more after a moment: the provider sometimes turns a new
     * session away and takes the next one.
     */
    const dial = async (attempt: number): Promise<void> => {
      let socket: WebSocket;
      try {
        socket = new (WebSocket as unknown as HeaderSocket)(upstreamUrl(), {
          headers: await credential(),
        });
      } catch {
        end("The voice provider could not be reached.");
        return;
      }
      if (!browser.open) {
        socket.close();
        return;
      }
      upstream = socket;
      let reached = false;
      let over = false;
      socket.onopen = () => {
        reached = true;
      };
      /** Why the provider's side ended, for the reader and for the server's log. */
      const lost = (said: string): void => {
        if (over) return;
        over = true;
        if (!reached && attempt < RETRIES && browser.open) {
          setTimeout(() => void dial(attempt + 1), RETRY_AFTER_MS);
          return;
        }
        const reason =
          said ||
          (reached
            ? "The voice provider hung up."
            : "The voice provider refused the connection. Its key or token may have expired.");
        if (browser.open) console.error(`[azure-voice-live] ${reason}`);
        end(reason);
      };
      socket.onmessage = (event: MessageEvent) => {
        const raw = String(event.data);
        // Only the kind of message is read here; the rest passes as it came.
        const type = /"type"\s*:\s*"([^"]+)"/.exec(raw.slice(0, 200))?.[1];
        if (type === "session.created") {
          socket.send(
            JSON.stringify({ type: "session.update", session: ticket.session }),
          );
        } else if (type === "session.updated") {
          // The setup holds the app's instructions: the browser is only told it is on.
          browser.send(JSON.stringify({ type: "session.updated" }));
          for (const message of early ?? []) socket.send(message);
          early = null;
        } else {
          browser.send(raw);
        }
      };
      socket.onclose = (event: CloseEvent) => lost(event.reason.slice(0, 100));
      socket.onerror = (event: Event) => {
        // The reason goes to the server's log only: it can name the resource.
        const detail = (event as { message?: string }).message;
        if (detail) console.error(`[azure-voice-live] ${detail}`);
        lost("");
      };
    };
    await dial(0);
  }

  const listen = (): Promise<Server> =>
    (listening ??= new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        response.statusCode = 404;
        response.end();
      });
      server.on("upgrade", (request, socket, head) => {
        socket.on("error", () => {});
        const id = new URL(request.url ?? "/", "http://relay").searchParams.get(
          "ticket",
        );
        void (async () => {
          // A ticket starts one call, once, on whichever server it is used.
          let ticket: Ticket | undefined;
          try {
            const raw = id ? await tickets.take(ticketKey(id)) : undefined;
            ticket =
              raw === undefined ? undefined : (JSON.parse(raw) as Ticket);
          } catch (error) {
            console.error("[azure-voice-live] the ticket store failed:", error);
          }
          if (!ticket) {
            refuseUpgrade(socket, 401);
            return;
          }
          // Frames sent with the handshake are in `head`, not socket data.
          const browser = acceptWebSocket(request, socket, head);
          if (browser) void connect(browser, ticket);
        })();
      });
      server.once("error", reject);
      server.listen(relay.port ?? 0, relay.host ?? "127.0.0.1", () => {
        // The relay alone does not keep a finished process alive.
        server.unref();
        resolve(server);
      });
    }));

  return {
    protocol: "azure-voice-live",
    async createSession(config): Promise<VoiceTicket> {
      // Fail here, where the caller can answer the reader, not in the relay.
      upstreamUrl();
      await credential();
      const server = await listen();
      const now = Date.now();
      for (const [id, lapses] of issued) {
        if (lapses < now) issued.delete(id);
      }
      const id = randomUUID();
      const ticket: Ticket = {
        session: azureVoiceLiveSession(config, { voice }),
      };
      await tickets.set(
        ticketKey(id),
        JSON.stringify(ticket),
        startWithinSeconds * 1000,
      );
      issued.set(id, now + startWithinSeconds * 1000);
      const { port } = server.address() as AddressInfo;
      const base =
        relay.publicUrl ?? `ws://${relay.host ?? "127.0.0.1"}:${port}`;
      return {
        protocol: "azure-voice-live",
        url: `${base}${base.includes("?") ? "&" : "?"}ticket=${id}`,
        // The relay sends the setup; the browser has none to send.
        setup: null,
        label: `Azure Voice Live · ${model}`,
      };
    },
    async listen(): Promise<void> {
      await listen();
    },
    async close(): Promise<void> {
      await Promise.all(
        [...issued.keys()].map((id) => tickets.delete(ticketKey(id))),
      ).catch(() => {});
      issued.clear();
      for (const hangUp of [...calls]) hangUp();
      const server = await listening?.catch(() => null);
      listening = null;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}
