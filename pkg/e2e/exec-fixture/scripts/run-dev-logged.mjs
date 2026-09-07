/**
 * Launch the Bascik dev server for the exec-fixture E2E configs and mirror its
 * combined stdout+stderr to `.dev-server.log` (which the suite reads to assert
 * which pages a producer completion recompiled).
 *
 * Why a wrapper and not `node ... 2>&1 | tee .dev-server.log`: with a shell
 * pipeline the webServer process Playwright owns is `tee`, so the dev server's
 * exit code is hidden behind tee's, and killing the pipeline can orphan the
 * server. Here the child's exit code (or signal) is propagated, signals are
 * forwarded, and the wrapper exits only after the child has.
 *
 * Usage: node scripts/run-dev-logged.mjs <path-to-bascik-entry> [args...]
 * Environment is inherited unchanged (BASCIK_SERVER_PORT, gates, ...).
 * Runtime state from a previous run (`dist/.generation`,
 * `scripts/.armed-gate`, `.dev-server.log`) is removed before boot so
 * "startup runs exactly once" asserts against this boot, not history.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logPath = join(fixtureDir, ".dev-server.log");

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  process.stderr.write("usage: run-dev-logged.mjs <bascik-entry> [args...]\n");
  process.exit(2);
}

await Promise.all([
  rm(join(fixtureDir, "dist/.generation"), { force: true }),
  rm(join(fixtureDir, "scripts/.armed-gate"), { force: true }),
  rm(logPath, { force: true }),
]);

const log = createWriteStream(logPath, { flags: "a" });
const child = spawn(process.execPath, [entry, ...args], {
  cwd: fixtureDir,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

for (const [stream, sink] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    sink.write(chunk);
  });
}

const forward = (signal) => () => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGINT", forward("SIGINT"));
process.on("SIGHUP", forward("SIGHUP"));

child.on("error", (err) => {
  process.stderr.write(`[run-dev-logged] failed to start dev server: ${err.message}\n`);
  log.end(() => process.exit(1));
});

child.on("exit", (code, signal) => {
  log.end(() => {
    if (signal) {
      // Re-raise so the parent sees the same termination the child did.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
});
