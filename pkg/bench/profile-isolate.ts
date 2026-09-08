import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, threadId } from "node:worker_threads";
import { profileJournal } from "./profile-diagnostics.ts";

const directory = process.env.BASCIK_PROFILE_CAPTURE_DIR;
if (directory) {
  const journal = profileJournal(directory);
  const session = new Session();
  journal("inspector-connect");
  session.connect();
  journal("inspector-enable");
  session.post("Profiler.enable");
  journal("inspector-start", { task: "startup" });
  session.post("Profiler.start");
  journal("inspector-start-returned", { task: "startup" });
  let sequence = 0;
  let taskSequence = 0;
  let taskId: string | undefined;
  let task = "startup";
  let startedAt = Date.now();
  const role = isMainThread ? "script-child" : "page-worker";
  function save() {
    const name = `${role}-${process.pid}-${threadId}-${sequence++}`;
    journal("inspector-stop", { taskId, task, name });
    session.post("Profiler.stop", (error, result) => {
      journal("inspector-stop-callback", { taskId, task, name, error: error ? String(error) : undefined });
      if (error) throw error;
      writeFileSync(join(directory!, `${name}.cpuprofile`), JSON.stringify(result.profile), { mode: 0o600 });
      journal("artifact-written", { taskId, name: `${name}.cpuprofile` });
      writeFileSync(join(directory!, `${name}.metadata.json`), JSON.stringify({ role, pid: process.pid, parentPid: process.ppid, threadId, task, taskId, startedAt, endedAt: Date.now(), profileStartTime: result.profile.startTime, profileEndTime: result.profile.endTime, argv: process.argv }), { mode: 0o600 });
      journal("artifact-written", { taskId, name: `${name}.metadata.json` });
    });
    journal("inspector-stop-returned", { taskId, task, name });
  }
  if (isMainThread) {
    task = process.argv[1];
    process.once("beforeExit", () => { save(); session.disconnect(); });
  } else if (parentPort) {
    parentPort.on = new Proxy(parentPort.on, {
      apply(target, receiver, [event, listener]: [string, (value: unknown) => void]) {
        if (event === "message") journal("listener-registered");
        return Reflect.apply(target, receiver, [event, event === "message" ? (input: string | { pagePath: string }) => {
          journal("listener-entry", { taskId: `${typeof input === "string" ? input : input.pagePath}:${taskSequence}` });
          if (sequence === 0) save();
          task = typeof input === "string" ? input : input.pagePath;
          taskId = `${task}:${taskSequence++}`;
          journal("inspector-start", { taskId });
          session.post("Profiler.start");
          journal("inspector-start-returned", { taskId });
          startedAt = Date.now();
          listener(input);
        } : listener]);
      },
    });
    const postMessage = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = (...args: Parameters<typeof postMessage>) => {
      save();
      journal("reply-sent", { taskId });
      return postMessage(...args);
    };
  }
}