/**
 * A stand-in for a speech-to-speech provider (Gemini Live): it gives out a
 * token, accepts the WebSocket a browser opens with it, and plays a scripted
 * turn. It speaks the parts of the protocol the voice-call component uses:
 * setup, microphone audio in, a transcript and audio out, and tool calls.
 * Started by playwright.config.ts. It has no dependencies, so the WebSocket
 * handshake and framing are done here.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

const PORT = Number(process.argv[2] ?? 4480);
const SILENCE = Buffer.alloc(24_000).toString("base64"); // half a second at 24 kHz

/** One unmasked frame from server to client. Binary, as the real provider sends. */
function frame(payload: Buffer, opcode = 0x2): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]),
            Buffer.from([
              (length >>> 24) & 0xff,
              (length >>> 16) & 0xff,
              (length >>> 8) & 0xff,
              length & 0xff,
            ]),
          ]);
  return Buffer.concat([header, payload]);
}

/** Calls `onMessage` with each complete text message a client sends. */
function reader(socket: Duplex, onMessage: (text: string) => void): void {
  let buffered = Buffer.alloc(0);
  let message: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const opcode = buffered[0]! & 0x0f;
      const final = (buffered[0]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        at = 10;
      }
      // A browser always masks what it sends.
      if (buffered.length < at + 4 + length) return;
      const mask = buffered.subarray(at, at + 4);
      const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length));
      for (let index = 0; index < payload.length; index++) {
        payload[index]! ^= mask[index % 4]!;
      }
      buffered = buffered.subarray(at + 4 + length);
      if (opcode === 0x8) {
        socket.end(frame(Buffer.alloc(0), 0x8));
        return;
      }
      if (opcode === 0x9) socket.write(frame(payload, 0xa));
      if (opcode > 0x2) continue;
      message.push(payload);
      if (final) {
        onMessage(Buffer.concat(message).toString("utf8"));
        message = [];
      }
    }
  });
}

const BOOKS = [
  `<card-grid>`,
  `<book-card title="Refactoring the Monolith" author="Grace Lin" rating="4.7">A field guide.</book-card>`,
  `<book-card title="Shipping Small Changes" author="Sam Rivera" rating="4.8">Why small releases win.</book-card>`,
  `</card-grid>`,
  `<ask-button say="Hold a copy of Shipping Small Changes">Hold the short one</ask-button>`,
].join("\n");

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/v1beta/auth_tokens") {
    let body = "";
    for await (const chunk of request) body += chunk;
    // Only a request with a key, and with a setup to lock in, gets a token.
    const setup = (JSON.parse(body) as { bidiGenerateContentSetup?: unknown })
      .bidiGenerateContentSetup;
    if (!request.headers["x-goog-api-key"] || !setup) {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ error: { message: "Bad token request." } }),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: "auth_tokens/stand-in" }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.searchParams.get("access_token") !== "auth_tokens/stand-in") {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(
      `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const send = (message: unknown): void => {
    socket.write(frame(Buffer.from(JSON.stringify(message))));
  };
  const say = (text: string): void => {
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      send({ serverContent: { outputTranscription: { text: piece } } });
    }
    send({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: SILENCE } },
          ],
        },
      },
    });
  };
  const endTurn = (): void => {
    send({ serverContent: { generationComplete: true } });
    send({ serverContent: { turnComplete: true } });
  };
  let heardAudio = false;
  let afterTool: ((result: string) => void) | null = null;

  /** One scripted turn, by what was asked. */
  const answer = (asked: string): void => {
    if (/hold/i.test(asked)) {
      say("I can hold that for you.");
      send({
        toolCall: {
          functionCalls: [
            {
              id: "call_hold",
              name: "place_hold",
              args: { title: "The Quiet Network" },
            },
          ],
        },
      });
      afterTool = (result) => {
        say(`The shop says: ${result}`);
        endTurn();
      };
      return;
    }
    say("Here are two books from the shelf.");
    send({
      toolCall: {
        functionCalls: [
          { id: "call_show", name: "show", args: { markup: BOOKS } },
        ],
      },
    });
    afterTool = () => endTurn();
  };

  reader(socket, (text) => {
    const message = JSON.parse(text) as {
      setup?: unknown;
      realtimeInput?: { audio?: { data: string; mimeType: string } };
      clientContent?: { turns: { parts: { text: string }[] }[] };
      toolResponse?: { functionResponses: { response: { result: string } }[] };
    };
    if (message.setup) {
      send({ setupComplete: {} });
    } else if (message.realtimeInput?.audio) {
      // The first sound from the microphone is "heard" as one sentence.
      const audio = message.realtimeInput.audio;
      if (heardAudio || audio.mimeType !== "audio/pcm;rate=16000") return;
      if (Buffer.from(audio.data, "base64").length < 1000) return;
      heardAudio = true;
      send({ serverContent: { inputTranscription: { text: "Recommend " } } });
      send({ serverContent: { inputTranscription: { text: "a book" } } });
      answer("Recommend a book");
    } else if (message.clientContent) {
      answer(message.clientContent.turns.at(-1)?.parts[0]?.text ?? "");
    } else if (message.toolResponse) {
      const done = afterTool;
      afterTool = null;
      done?.(message.toolResponse.functionResponses[0]?.response.result ?? "");
    }
  });
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1");
