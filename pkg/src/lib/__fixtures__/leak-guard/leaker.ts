/**
 * A process that leaks on purpose, for process-leak-guard.integration.test.ts.
 *
 *   node leaker.ts parent <pid file> <exit|wait> <inherit|scrub>
 *     Starts the orphan in its own session, writes the orphan's PID to the
 *     file, then exits at once (`exit`) or when stdin closes (`wait`). `scrub`
 *     gives the orphan an empty environment.
 *   node leaker.ts orphan
 *     Ignores SIGTERM and SIGHUP and stays alive.
 *
 * The orphan ends itself after a minute, so a broken guard cannot leave it on
 * the machine.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const ORPHAN_LIFETIME_MS = 60_000;
const [mode, pidFile, lifetime, environment] = process.argv.slice(2);

if (mode === "orphan") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  setTimeout(() => process.exit(0), ORPHAN_LIFETIME_MS);
} else if (mode === "parent") {
  const orphan = spawn(process.execPath, [process.argv[1], "orphan"], {
    detached: true,
    stdio: "ignore",
    env: environment === "scrub" ? {} : process.env,
  });
  orphan.unref();
  writeFileSync(pidFile, String(orphan.pid));
  if (lifetime === "wait") {
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  } else process.exit(0);
} else {
  console.error(`leaker.ts: unknown mode ${String(mode)}`);
  process.exit(2);
}
