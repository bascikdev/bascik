/**
 * A real voice session, without a microphone: checks the whole server side of
 * voice against Gemini Live. It makes a ticket the way the demo does, connects
 * with it the way a browser does, asks one question as text, runs the tool
 * calls the model makes through `runVoiceTool`, and reports what came back.
 *
 *   GEMINI_API_KEY=... node stress/voice-live.ts ["a question"] [--app books]
 *
 * Spends API credits: a few seconds of generated audio per run.
 */
import { readCatalog } from "../src/catalog.ts";
import { geminiLiveVoice } from "../src/gemini-live.ts";
import {
  newVoiceTurn,
  runVoiceTool,
  voiceMessages,
  voicePrompt,
  voiceTools,
} from "../src/voice.ts";
import { APPS } from "../demo/src/lib/apps.ts";
import { join } from "node:path";

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
const tools = voiceTools(app.tools);

const ticket = await geminiLiveVoice().createSession({
  system: `${app.instructions}\n\n${voicePrompt(catalog, options)}`,
  tools,
});
console.log(
  `ticket: ${ticket.protocol}, url holds no API key: ${!ticket.url.includes(process.env.GEMINI_API_KEY!)}`,
);

const turn = newVoiceTurn();
let audioBytes = 0;
let said = "";
const shown: string[] = [];
const started = performance.now();
let firstAudioMs = 0;

const socket = new WebSocket(ticket.url);
const finish = (why: string, code = 0): never => {
  const messages = voiceMessages(turn, { reader: question, model: said });
  console.log(
    `\n${why} after ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(`first audio: ${Math.round(firstAudioMs)} ms`);
  console.log(`audio: ${(audioBytes / 48_000).toFixed(1)} s (24 kHz, 16-bit)`);
  console.log(`said: ${JSON.stringify(said)}`);
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
  process.exit(code);
};
socket.onopen = () => socket.send(JSON.stringify(ticket.setup));
socket.onclose = (event) => finish(`closed ${event.code} ${event.reason}`, 1);
socket.onmessage = async (event) => {
  const text =
    typeof event.data === "string"
      ? event.data
      : Buffer.from(await (event.data as Blob).arrayBuffer()).toString("utf8");
  const message = JSON.parse(text);
  if (message.setupComplete) {
    socket.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: question }] }],
          turnComplete: true,
        },
      }),
    );
    return;
  }
  const content = message.serverContent ?? {};
  for (const part of content.modelTurn?.parts ?? []) {
    if (!part.inlineData) continue;
    firstAudioMs ||= performance.now() - started;
    audioBytes += Buffer.from(part.inlineData.data, "base64").length;
  }
  said += content.outputTranscription?.text ?? "";
  if (message.toolCall) {
    const functionResponses = [];
    for (const call of message.toolCall.functionCalls) {
      console.log(
        `call: ${call.name} ${JSON.stringify(call.args).slice(0, 400)}`,
      );
      let result = await runVoiceTool(
        turn,
        { id: call.id, name: call.name, input: call.args },
        app.tools,
        catalog,
        options,
      );
      if (result.state === "approval-requested") {
        console.log("  waits for approval: allowing it");
        result = await runVoiceTool(
          turn,
          {
            id: call.id,
            name: call.name,
            input: call.args,
            decision: "approve",
          },
          app.tools,
          catalog,
          options,
        );
      }
      if (call.name === "show" && result.html) shown.push(result.html);
      console.log(`  -> ${result.state}: ${result.output?.slice(0, 160)}`);
      functionResponses.push({
        id: call.id,
        name: call.name,
        response: { result: result.output },
      });
    }
    socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
    return;
  }
  // The turn after the last tool result, with something said, is the end.
  if (content.turnComplete && audioBytes > 0) finish("turn complete");
};
setTimeout(() => finish("timed out", 1), 45_000);
