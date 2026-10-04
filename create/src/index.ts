#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { run, type Io } from "./run.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const io: Io = {
  ask: (question) => rl.question(question),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  run: (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    return result.error ? null : result.status;
  },
  cwd: () => process.cwd(),
  platform: process.platform,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

// A download in progress leaves a staging folder next to the project. Remove it on Ctrl+C or a kill,
// and never touch anything else.
let staging: string | undefined;
const cleanup = (signal: NodeJS.Signals): void => {
  if (staging) rmSync(staging, { recursive: true, force: true });
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Tests point the downloader at a local server. A real user never sets this.
const archiveBase = process.env.CREATE_BASCIK_ARCHIVE_BASE;

let code: number;
try {
  code = await run(process.argv.slice(2), io, {
    onStaging: (directory) => {
      staging = directory;
    },
    ...(archiveBase ? { archiveBase } : {}),
  });
} finally {
  rl.close();
}
process.exit(code);
