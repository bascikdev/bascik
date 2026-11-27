/**
 * What the two stand-in voice providers share for the voice lab specs
 * (voice-lab.spec.ts): a record of the microphone audio a session received,
 * a speech-like voice to send back, and a small control surface over HTTP so
 * a test can ask what the provider heard.
 *
 *   POST /__lab/reset   {"canned": false}   forget everything; `canned: false`
 *                                           turns off the scripted first turn
 *                       {"cassette": "..."} play this recorded session (the
 *                                           text of a cassette file) to every
 *                                           call, in place of the script
 *   GET  /__lab/heard                       the latest session's audio and events
 *
 * A test steers a session by typing a message that starts with "lab:":
 *
 *   lab:speak 4        say four seconds of the voice, and stop if cut in on
 *   lab:late 4         the same, but a few pieces still arrive after the cut
 *   lab:slow 2         two seconds of the voice, sent slower than it plays
 *   lab:drop           start speaking, then cut the connection with no goodbye
 *   lab:close 1011 Why close with that code and reason
 *   lab:garbage        send a frame that is not JSON, then speak
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCassette } from "../voice-lab/cassette.ts";
import type { Cassette } from "../voice-lab/cassette.ts";
import { fromPcm16, rms, speechLike, toPcm16 } from "../voice-lab/signal.ts";

/** The voice the stand-ins speak with: 24 kHz, as the providers send. */
export const VOICE_RATE = 24_000;
/** A tenth of a second of the voice a message. */
const PIECE_SECONDS = 0.1;
/** A microphone piece at or above this level is the reader speaking. */
const LOUD = 0.02;

/** The stand-in's voice for `seconds`, the same samples every time. */
export const labVoice = (seconds: number): Float32Array =>
  speechLike(seconds, VOICE_RATE, { pitch: 185, rate: 3.6 });

/** The voice as the pieces a provider sends: 16-bit PCM, base64. */
export function labVoicePieces(seconds: number): string[] {
  const pcm = toPcm16(labVoice(seconds));
  const size = Math.round(VOICE_RATE * PIECE_SECONDS) * 2;
  const pieces: string[] = [];
  for (let at = 0; at < pcm.length; at += size) {
    pieces.push(pcm.subarray(at, at + size).toString("base64"));
  }
  return pieces;
}

/** What a typed "lab:" message asks the stand-in to do. */
export type LabCommand =
  | { kind: "speak"; seconds: number; late: boolean; slow: boolean }
  | { kind: "drop" }
  | { kind: "close"; code: number; reason: string }
  | { kind: "garbage" };

export function labCommand(text: string): LabCommand | null {
  const [, name, rest = ""] = /^lab:(\w+)\s*(.*)$/s.exec(text.trim()) ?? [];
  switch (name) {
    case "speak":
    case "late":
    case "slow":
      return {
        kind: "speak",
        seconds: Number(rest) || 3,
        late: name === "late",
        slow: name === "slow",
      };
    case "drop":
      return { kind: "drop" };
    case "close": {
      const [, code, reason = ""] = /^(\d+)\s*(.*)$/s.exec(rest) ?? [];
      return { kind: "close", code: Number(code) || 1000, reason };
    }
    case "garbage":
      return { kind: "garbage" };
    default:
      return null;
  }
}

/** One thing that happened in a session, and when (milliseconds, Date.now). */
export interface LabEvent {
  at: number;
  type: string;
}

/** What one session received and did. */
export interface LabSession {
  /** Keep a piece of microphone audio. True when it is loud enough to be speech. */
  hear(pcm: Buffer, format?: string): boolean;
  note(type: string): void;
  /**
   * Send the voice a piece at a time. `send` gets each piece; the returned
   * function stops it, and says how many pieces were still to come.
   */
  speak(
    command: { seconds: number; slow: boolean; late?: boolean },
    send: (piece: string) => void,
    done: () => void,
  ): () => number;
}

export interface Lab {
  /** False when a test turned the scripted first turn off. */
  canned(): boolean;
  /** The recorded session to play to every call, when a test gave one. */
  cassette(): Cassette | null;
  /** Answer a /__lab request. False when the request is not one. */
  http(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  session(): LabSession;
}

export function createLab(): Lab {
  let canned = true;
  let cassette: Cassette | null = null;
  let sessions = 0;
  let pieces: Buffer[] = [];
  let arrivals: number[] = [];
  let formats = new Set<string>();
  let events: LabEvent[] = [];
  const reset = (): void => {
    pieces = [];
    arrivals = [];
    formats = new Set();
    events = [];
  };
  return {
    canned: () => canned,
    cassette: () => cassette,
    async http(request, response) {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/__lab/")) return false;
      // The lab is for the tests' own process, on this machine.
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && url.pathname === "/__lab/reset") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const asked = JSON.parse(body || "{}") as {
          canned?: boolean;
          cassette?: string;
        };
        canned = asked.canned !== false;
        cassette = asked.cassette ? readCassette(asked.cassette) : null;
        sessions = 0;
        reset();
        response.end("{}");
        return true;
      }
      if (request.method === "GET" && url.pathname === "/__lab/heard") {
        const pcm = Buffer.concat(pieces);
        response.end(
          JSON.stringify({
            sessions,
            pieces: pieces.length,
            sizes: pieces.map((piece) => piece.length),
            arrivals,
            formats: [...formats],
            events,
            pcm: pcm.toString("base64"),
          }),
        );
        return true;
      }
      response.statusCode = 404;
      response.end("{}");
      return true;
    },
    session() {
      sessions++;
      reset();
      const mine = events;
      const note = (type: string): void => {
        mine.push({ at: Date.now(), type });
      };
      note("session");
      return {
        note,
        hear(pcm, format) {
          // A session that a later one replaced keeps nothing.
          if (mine !== events) return false;
          pieces.push(pcm);
          arrivals.push(Date.now());
          if (format) formats.add(format);
          return rms(fromPcm16(pcm)) >= LOUD;
        },
        speak({ seconds, slow, late }, send, done) {
          const queue = labVoicePieces(seconds);
          note("speak");
          // A provider sends faster than the voice plays; a slow one, slower.
          // One whose late pieces are tested is still making its reply when
          // the reader cuts in, so it sends only a little ahead of the voice.
          const every = slow ? PIECE_SECONDS * 1000 * 1.6 : late ? 70 : 20;
          const timer = setInterval(() => {
            const piece = queue.shift();
            if (piece !== undefined) send(piece);
            if (!queue.length) {
              clearInterval(timer);
              note("spoken");
              done();
            }
          }, every);
          return () => {
            clearInterval(timer);
            const left = queue.length;
            queue.length = 0;
            return left;
          };
        },
      };
    },
  };
}
