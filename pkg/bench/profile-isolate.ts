import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, threadId } from "node:worker_threads";

const directory = process.env.BASCIK_PROFILE_CAPTURE_DIR;
if (directory) {
  const session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.start");
  let sequence = 0;
  let taskSequence = 0;
  let taskId: string | undefined;
  let task = "startup";
  let startedAt = Date.now();
  const role = isMainThread ? "script-child" : "page-worker";
  function save() {
    const name = `${role}-${process.pid}-${threadId}-${sequence++}`;
    session.post("Profiler.stop", (error, result) => {
      if (error) throw error;
      writeFileSync(join(directory!, `${name}.cpuprofile`), JSON.stringify(result.profile), { mode: 0o600 });
      writeFileSync(join(directory!, `${name}.metadata.json`), JSON.stringify({ role, pid: process.pid, parentPid: process.ppid, threadId, task, taskId, startedAt, endedAt: Date.now(), profileStartTime: result.profile.startTime, profileEndTime: result.profile.endTime, argv: process.argv }), { mode: 0o600 });
    });
  }
  if (isMainThread) {
    task = process.argv[1];
    process.once("beforeExit", () => { save(); session.disconnect(); });
  } else if (parentPort) {
    parentPort.on = new Proxy(parentPort.on, {
      apply(target, receiver, [event, listener]: [string, (value: unknown) => void]) {
        return Reflect.apply(target, receiver, [event, event === "message" ? (input: string | { pagePath: string }) => {
          if (sequence === 0) save();
          task = typeof input === "string" ? input : input.pagePath;
          taskId = `${task}:${taskSequence++}`;
          session.post("Profiler.start");
          startedAt = Date.now();
          listener(input);
        } : listener]);
      },
    });
    const postMessage = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = (...args: Parameters<typeof postMessage>) => {
      save();
      return postMessage(...args);
    };
  }
}