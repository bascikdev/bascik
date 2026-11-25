/**
 * Does a spoken "show me that a different way" change the kind of view? A
 * real Azure Voice Live session without a microphone: it asks for something
 * to be shown, then asks to see it differently, and reports the components
 * of each view. Run it a few times: models vary.
 *
 *   AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com \
 *   AZURE_VOICE_LIVE_TOKEN="$(az account get-access-token --scope https://ai.azure.com/.default --query accessToken -o tsv)" \
 *   node stress/azure-voice-variety.ts [--app books] ["first request"] ["second request"]
 *
 * Exits 0 when the second view uses different components. Spends Azure credits.
 */
import { join } from "node:path";
import { APPS } from "../demo/src/lib/apps.ts";
import { azureVoiceLiveVoice } from "../src/azure-voice-live.ts";
import { readCatalog } from "../src/catalog.ts";
import {
  newVoiceTurn,
  runVoiceTool,
  voicePrompt,
  voiceTools,
} from "../src/voice.ts";

const args = process.argv.slice(2);
const appId = args.includes("--app")
  ? args[args.indexOf("--app") + 1]
  : "books";
const said = args.filter(
  (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--app",
);
const requests = [
  said[0] ?? "Recommend three books and show them to me.",
  said[1] ?? "Can you show me that a different way?",
];
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

const turn = newVoiceTurn();
/** The components of each view, by the request that led to it. */
const views: string[][][] = [[], []];
let asked = -1;
let calls: Promise<void>[] = [];
const tagsOf = (markup: string): string[] => [
  ...new Set(
    [...markup.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)*)[\s/>]/g)].map(
      (match) => match[1]!,
    ),
  ),
];

const socket = new WebSocket(ticket.url);
const send = (message: unknown): void => socket.send(JSON.stringify(message));
const ask = (): void => {
  asked++;
  send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: requests[asked]! }],
    },
  });
  send({ type: "response.create" });
};
let finished = false;
const finish = async (code: number, why = ""): Promise<void> => {
  if (finished) return;
  finished = true;
  const [first, second] = views.map((shown) => shown.at(-1) ?? []);
  console.log(`first view:  ${first!.join(", ") || "nothing shown"}`);
  console.log(
    `second view: ${second!.join(", ") || "nothing shown"} (${views[1]!.length} show call(s))`,
  );
  const changed =
    second!.length > 0 &&
    [...second!].sort().join() !== [...first!].sort().join();
  console.log(why || (changed ? "CHANGED" : "SAME"));
  socket.close();
  await provider.close();
  process.exit(code || (changed ? 0 : 1));
};
socket.onclose = () => void finish(1, "closed early");
socket.onmessage = async (event) => {
  const message = JSON.parse(String(event.data));
  switch (message.type) {
    case "session.updated":
      ask();
      break;
    case "response.function_call_arguments.done": {
      const call = {
        id: message.call_id as string,
        name: message.name as string,
        input: JSON.parse(message.arguments || "{}") as { markup?: string },
      };
      if (call.name === "show" && call.input.markup) {
        views[asked]!.push(tagsOf(call.input.markup));
      }
      calls.push(
        runVoiceTool(turn, call, app.tools, catalog, options).then((result) =>
          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: call.id,
              output: result.output ?? "",
            },
          }),
        ),
      );
      break;
    }
    case "response.done": {
      const called = calls;
      calls = [];
      if (called.length) {
        await Promise.all(called);
        send({ type: "response.create" });
      } else if (asked === 0) {
        ask();
      } else {
        await finish(0);
      }
      break;
    }
  }
};
setTimeout(() => void finish(1, "timed out"), 90_000);
