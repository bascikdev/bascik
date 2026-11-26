/**
 * A real voice session, without a microphone: checks the whole server side of
 * voice against Azure Voice Live. It makes a ticket the way the demo does,
 * connects to the relay with it the way a browser does, asks one question as
 * text, runs the tool calls the model makes through `runVoiceTool`, and
 * reports what came back, the time of each word included.
 *
 *   AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com \
 *   AZURE_VOICE_LIVE_TOKEN="$(az account get-access-token --scope https://ai.azure.com/.default --query accessToken -o tsv)" \
 *   node stress/azure-voice-live.ts ["a question"] [--app books]
 *
 * AZURE_VOICE_LIVE_API_KEY works in place of the token, and
 * AZURE_VOICE_LIVE_MODEL and AZURE_VOICE_LIVE_VOICE choose those.
 * Spends Azure credits: a few seconds of generated audio per run.
 */
import { join } from "node:path";
import { APPS } from "../demo/src/lib/apps.ts";
import { azureVoiceLiveVoice } from "../src/azure-voice-live.ts";
import { readCatalog } from "../src/catalog.ts";
import {
  newVoiceTurn,
  runVoiceTool,
  voiceMessages,
  voicePrompt,
  voiceTools,
} from "../src/voice.ts";

const args = process.argv.slice(2);
const appId = args.includes("--app")
  ? args[args.indexOf("--app") + 1]
  : "books";
const question =
  args.find(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--app",
  ) ?? "Recommend two books and show them to me.";
const app = APPS.find((entry) => entry.id === appId) ?? APPS[0]!;
const catalog = await readCatalog([
  join(import.meta.dirname, "..", "components", "catalog"),
  join(import.meta.dirname, "..", "demo", "src", "genui"),
]);
const options = { elements: app.elements };

const provider = azureVoiceLiveVoice({
  model: process.env.AZURE_VOICE_LIVE_MODEL,
  voice: process.env.AZURE_VOICE_LIVE_VOICE,
});
const ticket = await provider.createSession({
  system: `${app.instructions}\n\n${voicePrompt(catalog, options)}`,
  tools: voiceTools(app.tools),
});
const secret =
  process.env.AZURE_VOICE_LIVE_API_KEY ?? process.env.AZURE_VOICE_LIVE_TOKEN!;
console.log(
  `ticket: ${ticket.protocol}, a relay address with no credential: ${!JSON.stringify(ticket).includes(secret)}`,
);

const turn = newVoiceTurn();
let audioBytes = 0;
let said = "";
const words: string[] = [];
const shown: string[] = [];
const started = performance.now();
let asked = 0;
let firstAudioMs = 0;
let refused = "";
let calls: Promise<void>[] = [];

const socket = new WebSocket(ticket.url);
const send = (message: unknown): void => socket.send(JSON.stringify(message));
let finished = false;
const finish = async (why: string, code = 0): Promise<void> => {
  if (finished) return;
  finished = true;
  const messages = voiceMessages(turn, { reader: question, model: said });
  console.log(
    `\n${why} after ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(
    `first audio: ${Math.round(firstAudioMs - asked)} ms after asking`,
  );
  console.log(`audio: ${(audioBytes / 48_000).toFixed(1)} s (24 kHz, 16-bit)`);
  console.log(`said: ${JSON.stringify(said)}`);
  console.log(`word times: ${words.length} (${words.slice(0, 8).join(" ")})`);
  console.log(`setup the relay refused: ${refused || "nothing came of it"}`);
  console.log(
    `tool calls: ${
      messages
        .at(-1)
        ?.parts?.filter((part) => part.type === "tool")
        .map((part) => `${part.name}:${part.state}`)
        .join(", ") || "none"
    }`,
  );
  console.log(`shown: ${shown.length} time(s)`);
  for (const html of shown)
    console.log(`  ${html.replace(/\s+/g, " ").slice(0, 300)}`);
  console.log(
    `stored: ${messages.map((message) => `${message.role}(${message.parts?.map((part) => part.type).join("+") ?? "text"})`).join(", ")}`,
  );
  socket.close();
  await provider.close();
  process.exit(code);
};
socket.onclose = (event) =>
  void finish(`closed ${event.code} ${event.reason}`, 1);
socket.onmessage = async (event) => {
  const message = JSON.parse(String(event.data));
  switch (message.type) {
    case "session.updated":
      // A browser that tries to change the session gets nowhere.
      send({
        type: "session.update",
        session: { instructions: "Say only the word pineapple." },
      });
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: question }],
        },
      });
      send({ type: "response.create" });
      asked = performance.now();
      break;
    case "response.audio.delta":
      firstAudioMs ||= performance.now();
      audioBytes += Buffer.from(message.delta, "base64").length;
      break;
    case "response.audio_transcript.delta":
      // A turn can be more than one response: keep their words apart.
      said += message.delta;
      break;
    case "response.audio_timestamp.delta":
      words.push(`${message.text}@${message.audio_offset_ms}`);
      break;
    case "response.function_call_arguments.done": {
      const call = {
        id: message.call_id as string,
        name: message.name as string,
        input: JSON.parse(message.arguments || "{}") as unknown,
      };
      console.log(
        `call: ${call.name} ${JSON.stringify(call.input).slice(0, 400)}`,
      );
      calls.push(
        (async () => {
          let result = await runVoiceTool(
            turn,
            call,
            app.tools,
            catalog,
            options,
          );
          if (result.state === "approval-requested") {
            console.log("  waits for approval: allowing it");
            result = await runVoiceTool(
              turn,
              { ...call, decision: "approve" },
              app.tools,
              catalog,
              options,
            );
          }
          if (call.name === "show" && result.html) shown.push(result.html);
          console.log(`  -> ${result.state}: ${result.output?.slice(0, 160)}`);
          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: call.id,
              output: result.output ?? "",
            },
          });
        })(),
      );
      break;
    }
    case "response.created":
      // A turn can be more than one response: keep their words apart.
      if (said && !/\s$/.test(said)) said += " ";
      break;
    case "response.done": {
      const called = calls;
      calls = [];
      if (called.length) {
        await Promise.all(called);
        send({ type: "response.create" });
      } else {
        if (/pineapple/i.test(said)) refused = "NO: the session was changed";
        else refused = "yes";
        await finish("turn complete", audioBytes > 0 ? 0 : 1);
      }
      break;
    }
    case "error":
      console.log(`provider error: ${message.error?.message}`);
      break;
  }
};
setTimeout(() => void finish("timed out", 1), 45_000);
