/**
 * A stand-in for a speech-to-speech provider (Gemini Live): it gives out a
 * token, accepts the WebSocket a browser opens with it, and plays a scripted
 * turn. It speaks the parts of the protocol the voice-call component uses:
 * setup, microphone audio in, a transcript and audio out, and tool calls.
 * Started by playwright.config.ts.
 */
import { createServer } from "node:http";
import { acceptWebSocket, refuseUpgrade } from "../src/ws.ts";

const PORT = Number(process.argv[2] ?? 4480);
const SILENCE = Buffer.alloc(24_000).toString("base64"); // half a second at 24 kHz

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
    refuseUpgrade(socket, 401);
    return;
  }
  const client = acceptWebSocket(request, socket);
  if (!client) return;
  // In binary frames, as the real provider sends.
  const send = (message: unknown): void =>
    client.send(JSON.stringify(message), true);
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

  client.onMessage = (text) => {
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
  };
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1");
