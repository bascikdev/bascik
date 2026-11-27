/**
 * A stand-in for a speech-to-speech provider (Gemini Live): it gives out a
 * token, accepts the WebSocket a browser opens with it, and plays a scripted
 * turn. It speaks the parts of the protocol the voice-call component uses:
 * setup, microphone audio in, a transcript and audio out, and tool calls.
 * Started by playwright.config.ts.
 */
import { createServer } from "node:http";
import { acceptWebSocket, refuseUpgrade } from "../src/ws.ts";
import { playCassette } from "../voice-lab/cassette.ts";
import { createLab, labCommand, labVoicePieces } from "./fake-lab.ts";
import type { LabCommand } from "./fake-lab.ts";

const PORT = Number(process.argv[2] ?? 4480);
/** How long the model thinks before it answers what it heard from the microphone. */
const THINKING_MS = 2200;
const SILENCE = Buffer.alloc(24_000).toString("base64"); // half a second at 24 kHz

const BOOKS = [
  `<card-grid>`,
  `<book-card title="Refactoring the Monolith" author="Grace Lin" rating="4.7">A field guide.</book-card>`,
  `<book-card title="Shipping Small Changes" author="Sam Rivera" rating="4.8">Why small releases win.</book-card>`,
  `</card-grid>`,
  `<ask-button say="Hold a copy of Shipping Small Changes">Hold the short one</ask-button>`,
].join("\n");

/**
 * A tool call's id. A provider never gives the same one twice, and the
 * server refuses one it has seen, so each is numbered.
 */
let calls = 0;
const callId = (name: string): string => `call_${name}_${++calls}`;

/** What the voice lab specs read and steer (see fake-lab.ts). */
const lab = createLab();

const server = createServer(async (request, response) => {
  if (await lab.http(request, response)) return;
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
  // A test gave a recorded session: it is played, and the script is not.
  const tape = lab.cassette();
  if (tape) {
    void playCassette(tape, client, { longestGap: 1500 });
    return;
  }
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
  const session = lab.session();
  /** Stops the lab voice that is being sent, when one is. */
  let stopSpeaking: (() => number) | null = null;
  let lateOnCut = false;

  /** One audible piece of the lab voice. */
  const sendVoice = (data: string): void =>
    send({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }],
        },
      },
    });

  /** What a typed "lab:" message asks for (see fake-lab.ts). */
  const runLab = (command: LabCommand): void => {
    if (command.kind === "close") {
      client.close(command.code, command.reason);
      return;
    }
    if (command.kind === "garbage") {
      client.send("{ this is not JSON", true);
      send({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: "@@not base64@@" } }] },
        },
      });
    }
    const speaking =
      command.kind === "speak"
        ? command
        : { seconds: 3, late: false, slow: false };
    lateOnCut = speaking.late;
    send({
      serverContent: { outputTranscription: { text: "The lab voice speaks." } },
    });
    let sent = 0;
    stopSpeaking = session.speak(
      speaking,
      (piece) => {
        sendVoice(piece);
        // A connection that is cut: no close frame, no reason, mid-sentence.
        if (command.kind === "drop" && ++sent === 5) {
          stopSpeaking?.();
          stopSpeaking = null;
          socket.destroy();
        }
      },
      () => {
        // The voice is sent well before it has been played: the turn ends,
        // and a reader who speaks while it plays still cuts in.
        endTurn();
        setTimeout(() => {
          stopSpeaking = null;
        }, speaking.seconds * 1000).unref();
      },
    );
  };

  /** One scripted turn, by what was asked. */
  const answer = (asked: string): void => {
    const command = labCommand(asked);
    if (command) {
      runLab(command);
      return;
    }
    if (/press/i.test(asked)) {
      // The reader said their answer: the form on screen is sent for them.
      send({
        toolCall: {
          functionCalls: [
            {
              id: callId("fill"),
              name: "fill_form",
              args: { press: "hold the short one" },
            },
          ],
        },
      });
      afterTool = (result) => {
        say(`Done. ${result}`);
        endTurn();
      };
      return;
    }
    if (/sneak/i.test(asked)) {
      // A model that tries to allow its own action: it asks to hold a book,
      // then, once the question is on screen, tries to press Allow itself.
      send({
        toolCall: {
          functionCalls: [
            {
              id: callId("hold"),
              name: "place_hold",
              args: { title: "The Quiet Network" },
            },
          ],
        },
      });
      setTimeout(() => {
        send({
          toolCall: {
            functionCalls: [
              {
                id: callId("fill"),
                name: "fill_form",
                args: { press: "Allow" },
              },
            ],
          },
        });
      }, 1500);
      afterTool = (blocked) => {
        say(`Blocked. ${blocked}`);
        afterTool = (result) => {
          say(`The shop says: ${result}`);
          endTurn();
        };
      };
      return;
    }
    if (/hold/i.test(asked)) {
      say("I can hold that for you.");
      send({
        toolCall: {
          functionCalls: [
            {
              id: callId("hold"),
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
          { id: callId("show"), name: "show", args: { markup: BOOKS } },
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
      const pcm = Buffer.from(audio.data, "base64");
      const loud = session.hear(pcm, audio.mimeType);
      if (loud && stopSpeaking) {
        // The reader cut in: the model stops, and says that it was cut off.
        session.note("cut");
        const left = stopSpeaking();
        stopSpeaking = null;
        send({ serverContent: { interrupted: true } });
        if (lateOnCut) {
          // Pieces that were already on their way still arrive.
          for (const piece of labVoicePieces(0.5)) sendVoice(piece);
        }
        // A turn that had not finished ends here; one that had is not ended twice.
        if (left > 0) send({ serverContent: { turnComplete: true } });
        return;
      }
      if (!lab.canned()) return;
      if (heardAudio || audio.mimeType !== "audio/pcm;rate=16000") return;
      if (pcm.length < 1000) return;
      heardAudio = true;
      send({ serverContent: { inputTranscription: { text: "Recommend " } } });
      send({ serverContent: { inputTranscription: { text: "a book" } } });
      // The model takes a moment to start: the reader waits, and sees that.
      setTimeout(() => answer("Recommend a book"), THINKING_MS);
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
