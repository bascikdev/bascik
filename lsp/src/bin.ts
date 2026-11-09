#!/usr/bin/env node
import {
  BIN_USAGE,
  MISSING_TRANSPORT_HINT,
  chooseBinMode,
} from "./bin-args.js";

const args = process.argv.slice(2);
const { mode, exitCode } = chooseBinMode(args);

if (mode === "help") {
  console.log(BIN_USAGE);
  process.exit(exitCode);
} else if (mode === "missing-transport") {
  console.error(MISSING_TRANSPORT_HINT);
  process.exit(exitCode);
} else if (mode === "check") {
  const { runCliCheck } = await import("./cli.js");
  process.exit(
    await runCliCheck(args.filter((a) => a !== "--check" && a !== "check")),
  );
} else {
  const { startLanguageServer } = await import("./start.js");
  startLanguageServer({
    typeScriptWorker: new URL("./typescript-worker.js", import.meta.url),
    typeScriptFallbackFrom: import.meta.url,
  });
}
