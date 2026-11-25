/**
 * A `VoiceProvider` for Azure Voice Live (Microsoft Foundry).
 *
 * Azure has no one-use token a browser could connect with: a WebSocket to
 * Voice Live is opened with the resource's key or a Microsoft Entra token,
 * and either would let a browser use the whole resource. So this provider
 * runs a small relay. The browser connects to the relay with a one-use
 * ticket; the relay connects to Azure with the credential, sends the
 * session's setup itself (instructions, tools, voice), and passes on only
 * the messages a call needs. The browser cannot change what the session may
 * do, and never sees a credential.
 *
 * The cost is that the audio passes through this server, which Gemini Live
 * avoids. The relay needs Node (it listens on a port), so it does not run on
 * an edge runtime.
 *
 * With several servers, the audio connection is one process's: it stays on
 * the server the browser reached. Only the ticket has to be known to all of
 * them, so give the provider a `shared` store (`@bascik/genui/shared`) and
 * start the relay on every server (`listen()`).
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "./model.ts";
import { inProcessShared, type Shared } from "./shared.ts";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTicket,
} from "./voice.ts";
import { acceptWebSocket, refuseUpgrade, type ServerSocket } from "./ws.ts";

export interface AzureVoiceLiveOptions {
  /** The resource, as `https://<name>.services.ai.azure.com`. Defaults to AZURE_VOICE_LIVE_ENDPOINT. */
  endpoint?: string;
  /** The resource's key. Defaults to AZURE_VOICE_LIVE_API_KEY. */
  apiKey?: string;
  /**
   * A Microsoft Entra token for `https://ai.azure.com/.default`, or a
   * function that returns a fresh one, used when there is no key. Defaults
   * to AZURE_VOICE_LIVE_TOKEN.
   */
  token?: string | (() => string | Promise<string>);
  /** A model Voice Live offers in the resource's region. */
  model?: string;
  /**
   * A voice name. An Azure voice (`en-US-AvaMultilingualNeural`) sends the
   * time of each word, which captions follow exactly; an OpenAI voice
   * (`marin`) does not.
   */
  voice?: string;
  apiVersion?: string;
  /** Where the relay listens. Port 0, the default, takes any free port. */
  relay?: {
    port?: number;
    /** The interface to listen on (default 127.0.0.1). */
    host?: string;
    /**
     * The address a browser reaches the relay at, for example
     * `wss://example.com/voice`, when it is behind a proxy. Left out, it is
     * `ws://<host>:<port>`.
     */
    publicUrl?: string;
  };
  /**
   * Where one-use tickets are kept. Default: this process's memory, which is
   * right for one server. With several, pass the store they share, so a
   * ticket made on one server is honored once on another. A ticket holds the
   * session's instructions: keep the store private.
   */
  shared?: Pick<Shared, "set" | "take" | "delete">;
  /** How long a ticket may be used to start a session, in seconds (default 60). */
  startWithinSeconds?: number;
  /** How long a session may last, in seconds (default 900). */
  sessionSeconds?: number;
  /** The provider's WebSocket root. Replace it for a test server. */
  wsBase?: string;
}

export interface AzureVoiceLiveProvider extends VoiceProvider {
  /**
   * Start the relay now, without making a ticket. With tickets in a shared
   * store, every server calls this when it starts: a ticket made on one
   * server may be used on another, which has to be listening already.
   */
  listen(): Promise<void>;
  /** Stop the relay and end every call on it. */
  close(): Promise<void>;
}

/** How often a refused connection to the provider is tried again, and after how long. */
const RETRIES = 1;
const RETRY_AFTER_MS = 600;

const isAzureVoice = (name: string): boolean =>
  /^[a-z]{2,3}-[A-Z]{2}-/.test(name);

function declaration(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/** The session setup the relay sends, which the browser has no say in. */
export function azureVoiceLiveSession(
  config: VoiceSessionConfig,
  options: { voice: string },
): Record<string, unknown> {
  const azureVoice = isAzureVoice(options.voice);
  return {
    modalities: ["text", "audio"],
    instructions: config.system,
    voice: {
      type: azureVoice ? "azure-standard" : "openai",
      name: options.voice,
    },
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_sampling_rate: 16_000,
    // What the reader says, as text: their side of the stored conversation.
    input_audio_transcription: { model: "azure-speech" },
    turn_detection: { type: "azure_semantic_vad" },
    input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
    input_audio_echo_cancellation: { type: "server_echo_cancellation" },
    // Only an Azure voice can say when each word is spoken.
    ...(azureVoice ? { output_audio_timestamp_types: ["word"] } : {}),
    tools: config.tools.map(declaration),
    tool_choice: "auto",
  };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/**
 * What a browser may say to the provider through the relay, rebuilt field by
 * field: microphone audio, a typed message, a tool's result, and asking for
 * or stopping a reply. Anything else, a new session setup included, is null.
 */
export function relayedClientEvent(
  raw: string,
): Record<string, unknown> | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { type, audio, item } = event as Record<string, unknown>;
  switch (type) {
    case "input_audio_buffer.append":
      return text(audio, 400_000) ? { type, audio } : null;
    case "input_audio_buffer.clear":
    case "response.cancel":
    case "response.create":
      return { type };
    case "conversation.item.create": {
      if (typeof item !== "object" || item === null) return null;
      const {
        type: kind,
        call_id,
        output,
        content,
      } = item as Record<string, unknown>;
      if (kind === "function_call_output") {
        return text(call_id, 200) && text(output, 200_000)
          ? { type, item: { type: kind, call_id, output } }
          : null;
      }
      const said = Array.isArray(content)
        ? (content[0] as { text?: unknown } | undefined)?.text
        : undefined;
      return kind === "message" && text(said, 20_000)
        ? {
            type,
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: said }],
            },
          }
        : null;
    }
    default:
      return null;
  }
}

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
      if (early) early.push(message);
      else if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
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
      server.on("upgrade", (request, socket) => {
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
          const browser = acceptWebSocket(request, socket);
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
