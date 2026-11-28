/**
 * Record a real voice session as a cassette (see cassette.ts).
 *
 *   node voice-lab/record.ts gemini-live --out e2e/cassettes/books.jsonl
 *   node voice-lab/record.ts azure-voice-live --out e2e/cassettes/books-azure.jsonl
 *
 * It starts a recorder in front of the real provider and the demo pointed at
 * the recorder, with whatever keys your shell has (GEMINI_API_KEY, or
 * AZURE_VOICE_LIVE_ENDPOINT with a key or an `az login`). Open the address
 * the demo prints, hold one call, hang up, and press Ctrl+C here: the last
 * call is written to --out. Spends API credits: it is a real call.
 *
 * Options:
 *   --out <file>        where the cassette goes (required unless --no-demo)
 *   --note <text>       a line about the session, kept in the cassette
 *   --port <n>          the recorder's port (default 4490)
 *   --upstream <url>    the provider's WebSocket address, when not the usual
 *   --no-demo           only the recorder: you start the app yourself, with
 *                       GEMINI_LIVE_WS or AZURE_VOICE_LIVE_WS set to it. The
 *                       latest call is then saved by
 *                       POST /__lab/save?name=<name> into --dir (default
 *                       e2e/cassettes), which is how the live specs keep theirs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  recordSession,
  typedIn,
  voiceSeconds,
  writeCassette,
} from "./cassette.ts";
import type { Cassette } from "./cassette.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const provider = args[0] ?? "";
const here = join(import.meta.dirname, "..");

/** Where each provider is, and which setting points the app at a recorder instead. */
const PROVIDERS: Record<string, { upstream: () => string; setting: string }> = {
  "gemini-live": {
    upstream: () => "wss://generativelanguage.googleapis.com",
    setting: "GEMINI_LIVE_WS",
  },
  "azure-voice-live": {
    upstream: () => {
      const endpoint = process.env.AZURE_VOICE_LIVE_ENDPOINT;
      if (!endpoint) throw new Error("Set AZURE_VOICE_LIVE_ENDPOINT first.");
      return endpoint.replace(/^http/, "ws").replace(/\/+$/, "");
    },
    setting: "AZURE_VOICE_LIVE_WS",
  },
};

const known = PROVIDERS[provider];
if (!known) {
  console.error(
    `Name a provider: ${Object.keys(PROVIDERS).join(" or ")}. See the top of voice-lab/record.ts.`,
  );
  process.exit(2);
}
const withDemo = !args.includes("--no-demo");
const out = option("out");
if (withDemo && !out) {
  console.error(
    "Say where the cassette goes: --out e2e/cassettes/<name>.jsonl",
  );
  process.exit(2);
}
const directory = resolve(here, option("dir") ?? "e2e/cassettes");

function save(cassette: Cassette, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, writeCassette(cassette));
  const typed = typedIn(cassette);
  console.log(
    `\nSaved ${file}: ${cassette.frames.length} messages, ${voiceSeconds(cassette).toFixed(1)} s of the model's voice, ${typed.length} typed message${typed.length === 1 ? "" : "s"}.`,
  );
  console.log(
    "Read it before you commit it: what was typed and what the model said are in it as text.",
  );
}

const recording = await recordSession({
  upstream: option("upstream") ?? known.upstream(),
  provider,
  note: option("note") ?? "",
  port: Number(option("port") ?? 4490),
  http(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "POST" || url.pathname !== "/__lab/save")
      return false;
    // A name is a file name and nothing else.
    const name = (url.searchParams.get("name") ?? "").replace(/[^\w-]/g, "");
    const cassette = recording.cassette();
    if (!name || !cassette.frames.length) {
      response.statusCode = 400;
      response.end("Nothing to save, or no name.");
      return true;
    }
    cassette.note ||= `Recorded live: ${name}.`;
    save(cassette, join(directory, `${name}.jsonl`));
    response.end("Saved.");
    return true;
  },
});
console.log(`Recording ${provider} at ${recording.url}`);

const demo = withDemo
  ? spawn("yarn", ["demo"], {
      cwd: here,
      stdio: "inherit",
      env: { ...process.env, [known.setting]: recording.url },
    })
  : null;
if (withDemo) {
  console.log(
    "Open the address the demo prints below, hold one call, hang up, then press Ctrl+C here.",
  );
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const cassette = recording.cassette();
  if (out && cassette.frames.length) save(cassette, resolve(out));
  else if (out) console.log("\nNo call was made: nothing saved.");
  demo?.kill("SIGINT");
  await recording.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
