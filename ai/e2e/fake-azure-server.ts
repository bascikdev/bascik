/**
 * A stand-in for Azure Voice Live: it accepts the WebSocket a relay opens
 * with a credential, takes the session setup, and plays a scripted turn in
 * the provider's event format: a transcript, audio, the time of each word,
 * and tool calls. Started by playwright.config.ts.
 */
import { createServer } from "node:http";
import { acceptWebSocket, refuseUpgrade } from "../src/ws.ts";

const PORT = Number(process.argv[2] ?? 4481);
/** How long the reader "speaks", and how long the model then thinks, in milliseconds. */
const SPEAKING_MS = 1500;
const THINKING_MS = 1200;
const SECOND = Buffer.alloc(48_000).toString("base64"); // one second at 24 kHz

const BOOKS = [
  `<card-grid>`,
  `<book-card title="Refactoring the Monolith" author="Grace Lin" rating="4.7">A field guide.</book-card>`,
  `<book-card title="Shipping Small Changes" author="Sam Rivera" rating="4.8">Why small releases win.</book-card>`,
  `</card-grid>`,
  `<ask-button say="Hold a copy of Shipping Small Changes">Hold the short one</ask-button>`,
].join("\n");

const server = createServer((_request, response) => {
  response.statusCode = 404;
  response.end();
});

server.on("upgrade", (request, socket) => {
  socket.on("error", () => {});
  const url = new URL(request.url ?? "/", "http://localhost");
  // Only a caller with a credential, asking for a model, gets a session.
  if (
    url.pathname !== "/voice-live/realtime" ||
    !url.searchParams.get("model") ||
    !(request.headers.authorization || request.headers["api-key"])
  ) {
    refuseUpgrade(socket, 401);
    return;
  }
  const client = acceptWebSocket(request, socket);
  if (!client) return;
  const send = (message: unknown): void => client.send(JSON.stringify(message));

  let ready = false;
  let responses = 0;
  let heardAudio = false;
  let afterTool: ((result: string) => void) | null = null;
  /** What the tools of the reply being made came to, in the order they answered. */
  let toolResults: string[] = [];

  /** One response: spoken words with their times and audio, then a tool call or the end. */
  const respond = (
    words: string,
    call?: { id: string; name: string; args: unknown },
    /** A second call, made a moment later in the same reply. */
    later?: { id: string; name: string; args: unknown },
  ): void => {
    const response_id = `resp_${++responses}`;
    send({ type: "response.created", response: { id: response_id } });
    const pieces = words.match(/\S+/g) ?? [];
    // A fifth of a second a word; a full stop arrives as a word of its own.
    let at = 0;
    for (const piece of pieces) {
      send({
        type: "response.audio_transcript.delta",
        response_id,
        delta: `${piece} `,
      });
      const [, word, stop] = /^(.*?)([.?!]?)$/.exec(piece)!;
      send({
        type: "response.audio_timestamp.delta",
        response_id,
        audio_offset_ms: at,
        audio_duration_ms: 180,
        text: word,
        timestamp_type: "word",
      });
      if (stop) {
        send({
          type: "response.audio_timestamp.delta",
          response_id,
          audio_offset_ms: at + 180,
          audio_duration_ms: 20,
          text: stop,
          timestamp_type: "word",
        });
      }
      at += 200;
    }
    for (let sent = 0; sent < at; sent += 1000) {
      send({ type: "response.audio.delta", response_id, delta: SECOND });
    }
    const calling = (made: { id: string; name: string; args: unknown }): void =>
      send({
        type: "response.function_call_arguments.done",
        response_id,
        call_id: made.id,
        name: made.name,
        arguments: JSON.stringify(made.args),
      });
    const finish = (): void =>
      send({
        type: "response.done",
        response: { id: response_id, status: "completed" },
      });
    if (call) calling(call);
    if (!later) {
      finish();
      return;
    }
    setTimeout(() => {
      calling(later);
      finish();
    }, 1500);
  };

  /** One scripted turn, by what was asked. */
  const answer = (asked: string): void => {
    if (/press/i.test(asked)) {
      // The reader said their answer: the form on screen is sent for them.
      respond("", {
        id: "call_fill",
        name: "fill_form",
        args: { press: "hold the short one" },
      });
      afterTool = (result) => respond(`Done. ${result}`);
      return;
    }
    if (/sneak/i.test(asked)) {
      // A model that tries to allow its own action: it asks to hold a book,
      // then, once the question is on screen, tries to press Allow itself.
      respond(
        "",
        {
          id: "call_hold",
          name: "place_hold",
          args: { title: "The Quiet Network" },
        },
        { id: "call_fill", name: "fill_form", args: { press: "Allow" } },
      );
      afterTool = () => {
        const [blocked, result] = toolResults;
        respond(`Blocked. ${blocked} The shop says: ${result}`);
      };
      return;
    }
    if (/hold/i.test(asked)) {
      respond("I can hold that for you.", {
        id: "call_hold",
        name: "place_hold",
        args: { title: "The Quiet Network" },
      });
      afterTool = (result) => respond(`The shop says: ${result}`);
      return;
    }
    respond("Here are two books from the shelf.", {
      id: "call_show",
      name: "show",
      args: { markup: BOOKS },
    });
    // The provider answers a tool's result with a response, even an empty one.
    afterTool = () => {
      const response_id = `resp_${++responses}`;
      send({ type: "response.created", response: { id: response_id } });
      send({
        type: "response.done",
        response: { id: response_id, status: "completed" },
      });
    };
  };

  send({ type: "session.created", session: { id: "sess_stand_in" } });
  client.onMessage = (text) => {
    const message = JSON.parse(text) as {
      type: string;
      audio?: string;
      session?: {
        instructions?: string;
        tools?: { name: string }[];
        input_audio_sampling_rate?: number;
        output_audio_timestamp_types?: string[];
      };
      item?: {
        type: string;
        output?: string;
        content?: { text: string }[];
      };
    };
    if (message.type === "session.update") {
      const session = message.session;
      // A setup without the app's instructions and the show tool is not one.
      if (
        !session?.instructions ||
        !session.tools?.some((tool) => tool.name === "show") ||
        session.input_audio_sampling_rate !== 16_000 ||
        session.output_audio_timestamp_types?.[0] !== "word"
      ) {
        send({ type: "error", error: { message: "Bad session." } });
        client.close(1007, "Bad session.");
        return;
      }
      ready = true;
      send({ type: "session.updated", session });
      return;
    }
    if (!ready) {
      send({ type: "error", error: { message: "No session yet." } });
      return;
    }
    if (message.type === "input_audio_buffer.append") {
      // The first sound from the microphone is "heard" as one sentence.
      if (heardAudio || !message.audio) return;
      if (Buffer.from(message.audio, "base64").length < 1000) return;
      heardAudio = true;
      send({ type: "input_audio_buffer.speech_started" });
      for (const delta of ["Recommend ", "a book"]) {
        send({
          type: "conversation.item.input_audio_transcription.delta",
          delta,
        });
      }
      setTimeout(() => {
        send({ type: "input_audio_buffer.speech_stopped" });
        send({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "Recommend a book",
        });
        setTimeout(() => answer("Recommend a book"), THINKING_MS);
      }, SPEAKING_MS);
    } else if (message.type === "conversation.item.create") {
      if (message.item?.type === "function_call_output") {
        toolResults.push(message.item.output ?? "");
      } else {
        toolResults = [];
        afterTool = null;
        pendingText = message.item?.content?.[0]?.text ?? "";
      }
    } else if (message.type === "response.create") {
      if (pendingText !== null) {
        const asked = pendingText;
        pendingText = null;
        answer(asked);
      } else {
        const done = afterTool;
        afterTool = null;
        const result = toolResults[0] ?? "";
        done?.(result);
        toolResults = [];
      }
    }
  };
  let pendingText: string | null = null;
});

server.listen(PORT, "127.0.0.1");
