/**
 * `--import` preload that CPU-profiles the main subject of a `cpu` capture in place of native `--cpu-prof`.
 *
 * Native `--cpu-prof` samples from bootstrap, through the first uses of the process-wide state that can deadlock
 * a sampled thread on Node 24/macOS (see profile-warmup.ts). This preload warms that state unsampled, then starts
 * the inspector Profiler at native `--cpu-prof`'s default 1 ms interval, and at exit writes the profile under the
 * name native `--cpu-prof` uses for the main thread (`CPU.<date>.<time>.<pid>.0.001.cpuprofile`), so artifact
 * validation and coverage find it exactly as before.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";
import { profileJournal } from "./profile-diagnostics.ts";
import { warmProcessWideState } from "./profile-warmup.ts";

const directory = process.env.BASCIK_PROFILE_CAPTURE_DIR;
assert(
  directory,
  "profile-main.ts needs BASCIK_PROFILE_CAPTURE_DIR, the directory the main CPU profile is written to",
);
const journal = profileJournal(directory);
await warmProcessWideState();
journal("main-warmed");

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const now = new Date();
const name = `CPU.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${process.pid}.0.001.cpuprofile`;

const session = new Session();
session.connect();
// An in-process session answers synchronously, so a failure throws here.
const post = (method: string, params?: object) =>
  session.post(method, params, (error) => {
    if (error) throw error;
  });
post("Profiler.enable");
post("Profiler.setSamplingInterval", { interval: 1000 });
post("Profiler.start");
journal("main-profiler-started");

process.once("exit", () => {
  session.post("Profiler.stop", (error, result) => {
    if (error) throw error;
    writeFileSync(join(directory, name), JSON.stringify(result.profile), {
      mode: 0o600,
    });
    journal("main-profile-written", { name });
  });
  session.disconnect();
});
