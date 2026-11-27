/*
 * Cassettes: a real voice session, recorded once and played back in tests.
 *
 * A stand-in provider says what its author thought the provider says. A
 * cassette says what the provider did say: every message of a real session,
 * in order, with the time between them. `recordSession` sits between a
 * browser (or a relay) and the real provider and writes the cassette;
 * `playCassette` then takes the provider's place for a test, with nothing to
 * pay for and nothing that changes from run to run.
 *
 * What a cassette keeps, and what it leaves out:
 *
 * - The provider's messages are kept whole, its audio included: that voice
 *   is what a test plays and measures.
 * - The browser's microphone audio is not kept, only how much of it there
 *   was. A cassette holds nobody's voice but the model's.
 * - Tokens, keys and session ids are replaced before anything is written
 *   (`scrub`), so a cassette can be committed.
 *
 * Playing back, the provider's messages are sent with the gaps they had.
 * Where the recording shows the browser said something first (the setup, a
 * typed message, a tool's result), playback waits for the browser to say a
 * message of that kind, then goes on. Microphone audio is never waited for:
 * a reply that followed speech follows the recorded pause.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptWebSocket } from "../src/ws.ts";
import type { ServerSocket } from "../src/ws.ts";

/** One message of a session. */
export interface Frame {
  /** Milliseconds since the session began. */
  at: number;
  from: "browser" | "provider";
  /** The message, as JSON text. Microphone audio is replaced by its size. */
  data: string;
}

/** A recorded session. */
export interface Cassette {
  /** What was recorded: "gemini-live", "azure-voice-live", or a name of your own. */
  provider: string;
  /** A line about the session, for whoever reads the file. */
  note: string;
  frames: Frame[];
}

/** A cassette as text: a first line about it, then a line a message. */
export function writeCassette(cassette: Cassette): string {
  const { frames, ...about } = cassette;
  return (
    [
      JSON.stringify({ cassette: 1, ...about }),
      ...frames.map((frame) => JSON.stringify(frame)),
    ].join("\n") + "\n"
  );
}

export function readCassette(text: string): Cassette {
  const [first, ...lines] = text.split("\n").filter((line) => line.trim());
  const about = JSON.parse(first ?? "{}") as {
    cassette?: number;
    provider?: string;
    note?: string;
  };
  if (about.cassette !== 1) throw new Error("Not a cassette.");
  return {
    provider: about.provider ?? "",
    note: about.note ?? "",
    frames: lines.map((line) => JSON.parse(line) as Frame),
  };
}

/** Field names whose values identify an account, a session or a person. */
const SECRET =
  /token|secret|password|authorization|api[-_]?key|credential|^session_?id$|^user$|email/i;
/** Text that is a credential wherever it stands. */
const SECRET_TEXT =
  /auth_tokens\/[\w-]+|Bearer\s+[\w.~+/-]+=*|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;

/** How many bytes a base64 text holds. */
function base64Bytes(text: string): number {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/**
 * A message with what must not be kept taken out: secrets by field name and
 * by shape, and the browser's microphone audio, which becomes its size.
 */
export function scrub(data: string, from: Frame["from"]): string {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    // Not JSON: kept as text, with anything shaped like a credential removed.
    return data.replace(SECRET_TEXT, "[removed]");
  }
  const clean = (value: unknown, name: string): unknown => {
    if (typeof value === "string") {
      if (SECRET.test(name)) return "[removed]";
      // The reader's voice: Gemini's realtimeInput and Azure's input buffer.
      if (
        from === "browser" &&
        (name === "data" || name === "audio") &&
        value.length > 64
      ) {
        return { $audio: base64Bytes(value) };
      }
      return value.replace(SECRET_TEXT, "[removed]");
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, name));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, clean(item, key)]),
      );
    }
    return value;
  };
  return JSON.stringify(clean(message, ""));
}

/**
 * What kind of message this is, for matching what a browser says in a test
 * with what one said in the recording: Azure's `type`, or the one key of a
 * Gemini message. Microphone audio is "audio", and is never waited for.
 */
export function kindOf(data: string): string {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return "text";
  }
  if (typeof message !== "object" || message === null) return "text";
  if (typeof message.type === "string") {
    const type = message.type;
    if (type === "input_audio_buffer.append") return "audio";
    if (type !== "conversation.item.create") return type;
    // A typed message and a tool's result are different things to wait for.
    const item = message.item as { type?: string } | undefined;
    return `${type}:${item?.type ?? ""}`;
  }
  const [key = "text"] = Object.keys(message);
  if (key === "realtimeInput") return "audio";
  return key;
}

/** A browser message playback does not wait for: sound, and Azure's cancel, which races. */
const unawaited = (kind: string): boolean =>
  kind === "audio" || kind === "response.cancel";

/** A recorder that is running: where to connect, and how to stop and get the cassette. */
export interface Recording {
  /** The address a browser or relay connects to in place of the provider. */
  url: string;
  /** The session so far, as a cassette. */
  cassette(): Cassette;
  close(): Promise<void>;
}

/** A socket that takes headers, as Node's does and a browser's does not. */
type HeaderSocket = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

/**
 * Stand between a client and the real provider at `upstream`, passing every
 * message both ways and keeping it. The path and query a client asks for are
 * added to `upstream`, and the credential headers it sends are passed on.
 */
export async function recordSession(options: {
  upstream: string;
  provider: string;
  note?: string;
  port?: number;
  /** Answer a plain HTTP request to the recorder. False when it is not for you. */
  http?: (request: IncomingMessage, response: ServerResponse) => boolean;
}): Promise<Recording> {
  // One session at a time: a new connection starts a new cassette.
  let frames: Frame[] = [];
  let began = 0;
  const keep = (from: Frame["from"], data: string): void => {
    began ||= Date.now();
    frames.push({ at: Date.now() - began, from, data: scrub(data, from) });
  };
  const server = createServer((request, response) => {
    if (options.http?.(request, response)) return;
    response.statusCode = 404;
    response.end();
  });
  const open = new Set<{ close(): void }>();
  server.on("upgrade", (request, socket) => {
    socket.on("error", () => {});
    const client = acceptWebSocket(request, socket);
    if (!client) return;
    frames = [];
    began = 0;
    const headers: Record<string, string> = {};
    for (const name of [
      "authorization",
      "api-key",
      "x-goog-api-key",
      "x-ms-client-request-id",
    ]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const base = options.upstream.replace(/\/+$/, "");
    const provider = new (WebSocket as unknown as HeaderSocket)(
      `${base}${request.url ?? ""}`,
      { headers },
    );
    provider.binaryType = "arraybuffer";
    open.add(provider);
    // What the client says before the provider is reached is sent when it is.
    const early: string[] = [];
    const decoder = new TextDecoder();
    let binary = false;
    client.onMessage = (text) => {
      keep("browser", text);
      if (provider.readyState === WebSocket.OPEN) provider.send(text);
      else early.push(text);
    };
    provider.onopen = () => {
      for (const text of early.splice(0)) provider.send(text);
    };
    provider.onmessage = (event) => {
      // Gemini sends its JSON in binary frames: the client gets what it would have.
      binary = typeof event.data !== "string";
      const text = binary
        ? decoder.decode(event.data as ArrayBuffer)
        : (event.data as string);
      keep("provider", text);
      client.send(text, binary);
    };
    provider.onclose = (event) => {
      open.delete(provider);
      keep(
        "provider",
        JSON.stringify({ $closed: { code: event.code, reason: event.reason } }),
      );
      client.close(
        event.code >= 1000 && event.code !== 1005 && event.code !== 1006
          ? event.code
          : 1000,
        event.reason,
      );
    };
    client.onClose = () => provider.close();
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cassette: () => ({
      provider: options.provider,
      note: options.note ?? "",
      frames: [...frames],
    }),
    close: () => closeServer(server, open),
  };
}

/** How a cassette is played. */
export interface PlayOptions {
  /** Play the gaps this many times faster. 1 is as recorded. */
  speed?: number;
  /** The longest gap kept between two messages, in milliseconds: a recorded half minute of thought need not be waited out. */
  longestGap?: number;
}

/**
 * Play a cassette to one client: the provider's side of the session. Gives
 * a promise of how it ended: "played" when every message was sent, "left"
 * when the client went first.
 */
export function playCassette(
  cassette: Cassette,
  client: ServerSocket,
  options: PlayOptions = {},
): Promise<"played" | "left"> {
  const { speed = 1, longestGap = 3000 } = options;
  // Gemini's messages go out in binary frames, as the provider's do.
  const binary = cassette.provider === "gemini-live";
  /** The kinds of message the client has sent and playback has not used yet. */
  const said: string[] = [];
  /** Ends the wait for a message, and the wait of a gap. */
  let heard: (() => void) | null = null;
  let waited: (() => void) | null = null;
  let left = false;
  client.onMessage = (text) => {
    const kind = kindOf(text);
    if (unawaited(kind)) return;
    said.push(kind);
    heard?.();
  };
  return new Promise((resolve) => {
    client.onClose = () => {
      left = true;
      heard?.();
      waited?.();
      resolve("left");
    };
    void (async () => {
      let last = 0;
      for (const frame of cassette.frames) {
        if (left) return;
        if (frame.from === "browser") {
          const kind = kindOf(frame.data);
          if (unawaited(kind)) continue;
          // Wait for the client to say what the recording's browser said here.
          // Anything else it said in between is not what is waited for.
          for (;;) {
            const at = said.indexOf(kind);
            if (at >= 0) {
              said.splice(0, at + 1);
              break;
            }
            await new Promise<void>((next) => (heard = next));
            if (left) return;
          }
          last = frame.at;
          continue;
        }
        const gap = Math.min(longestGap, frame.at - last) / speed;
        last = frame.at;
        if (gap > 1) {
          await new Promise<void>((next) => {
            const timer = setTimeout(next, gap);
            // A client that leaves is not played to for the rest of the gap.
            waited = () => {
              clearTimeout(timer);
              next();
            };
          });
        }
        if (left) return;
        const closed = closedBy(frame.data);
        if (closed) {
          // Played to its end: the close that follows is the recording's own.
          resolve("played");
          client.close(closed.code, closed.reason);
          return;
        }
        client.send(frame.data, binary);
      }
      resolve("played");
    })();
  });
}

/** The close a recording ended with, when this frame is one. */
function closedBy(data: string): { code: number; reason: string } | null {
  if (!data.startsWith('{"$closed"')) return null;
  const { $closed } = JSON.parse(data) as {
    $closed: { code: number; reason: string };
  };
  const sendable =
    $closed.code >= 1000 && ![1004, 1005, 1006, 1015].includes($closed.code);
  return { code: sendable ? $closed.code : 1000, reason: $closed.reason };
}

/** A cassette player that is running. */
export interface Player {
  url: string;
  /** How many sessions have been played to the end. */
  played(): number;
  close(): Promise<void>;
}

/** Serve a cassette to every client that connects, each from the start. */
export async function serveCassette(
  cassette: Cassette,
  options: PlayOptions & { port?: number } = {},
): Promise<Player> {
  let played = 0;
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const open = new Set<{ close(): void }>();
  server.on("upgrade", (request, socket) => {
    socket.on("error", () => {});
    const client = acceptWebSocket(request, socket);
    if (!client) return;
    const closing = { close: () => client.close(1001, "The player stopped.") };
    open.add(closing);
    void playCassette(cassette, client, options).then((how) => {
      open.delete(closing);
      if (how === "played") played++;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    played: () => played,
    close: () => closeServer(server, open),
  };
}

async function closeServer(
  server: Server,
  open: Set<{ close(): void }>,
): Promise<void> {
  for (const socket of open) socket.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * The typed messages of a recorded session, in order: what a test types to
 * take the browser's part. Gemini's `clientContent` and Azure's user item.
 */
export function typedIn(cassette: Cassette): string[] {
  const typed: string[] = [];
  for (const frame of cassette.frames) {
    if (frame.from !== "browser") continue;
    const kind = kindOf(frame.data);
    const message = JSON.parse(frame.data) as {
      clientContent?: { turns?: { parts?: { text?: string }[] }[] };
      item?: { content?: { text?: string }[] };
    };
    if (kind === "clientContent") {
      const text = message.clientContent?.turns?.at(-1)?.parts?.[0]?.text;
      if (text) typed.push(text);
    } else if (kind === "conversation.item.create:message") {
      const text = message.item?.content?.[0]?.text;
      if (text) typed.push(text);
    }
  }
  return typed;
}

/** How many seconds of the model's voice a cassette holds (24 kHz, 16-bit). */
export function voiceSeconds(cassette: Cassette): number {
  let bytes = 0;
  for (const frame of cassette.frames) {
    if (frame.from !== "provider") continue;
    let message: {
      type?: string;
      delta?: string;
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
      };
    };
    try {
      message = JSON.parse(frame.data) as typeof message;
    } catch {
      continue;
    }
    if (message.type === "response.audio.delta" && message.delta) {
      bytes += base64Bytes(message.delta);
    }
    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        bytes += base64Bytes(part.inlineData.data);
      }
    }
  }
  return bytes / 48_000;
}
