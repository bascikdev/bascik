#!/usr/bin/env node
import { startLanguageServer } from "./start.js";
import { runCliCheck } from "./cli.js";

const args = process.argv.slice(2);
if (args.includes("--check") || args.includes("check")) {
  const exitCode = await runCliCheck(
    args.filter((a) => a !== "--check" && a !== "check"),
  );
  process.exit(exitCode);
} else {
  startLanguageServer();
}
