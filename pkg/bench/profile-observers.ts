import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { cleanGeneratorEnvironment, workerCpuLimitation, type ProcessCoverage } from "./profile-workload.ts";
import type { WorkerOptions } from "node:worker_threads";
import { profileJournal } from "./profile-diagnostics.ts";

export function observeSubjects(directory: string | undefined) {
  const journal = profileJournal(directory);
  const require = createRequire(import.meta.url);
  const threads: typeof import("node:worker_threads") = require("node:worker_threads");
  const children: typeof import("node:child_process") = require("node:child_process");
  const OriginalWorker = threads.Worker;
  const originalExecFile = children.execFile;
  const preload = fileURLToPath(new URL("./profile-isolate.ts", import.meta.url));
  const events: object[] = [];
  const environment = () => ({ ...cleanGeneratorEnvironment(process.env), ...(directory && !workerCpuLimitation() ? { BASCIK_PROFILE_CAPTURE_DIR: directory, NODE_OPTIONS: `--import=${preload}` } : {}) });
  threads.Worker = class extends OriginalWorker {
    sequence = 0;
    pending?: ProcessCoverage;
    constructor(filename: string | URL, options?: WorkerOptions) {
      super(filename, { ...options, env: environment(), execArgv: [] });
      events.push({ role: "page-worker", threadId: this.threadId, pid: process.pid, filename: String(filename), startedAt: Date.now() });
      const workerThreadId = this.threadId;
      journal("worker-created", { workerThreadId, filename: String(filename) });
      this.on("online", () => journal("worker-online", { workerThreadId }));
      this.on("error", (error) => journal("worker-error", { workerThreadId, taskId: this.pending?.taskId, error: String(error), stack: error.stack }));
      this.on("exit", (code) => journal("worker-exit", { workerThreadId, taskId: this.pending?.taskId, code }));
      this.prependListener("message", () => {
        journal("reply-received", { workerThreadId, taskId: this.pending?.taskId });
        if (this.pending) this.pending.completedAt = Date.now();
        this.pending = undefined;
      });
    }
    override postMessage(...args: Parameters<InstanceType<typeof OriginalWorker>["postMessage"]>) {
      const input = args[0] as string | { pagePath: string };
      const task = typeof input === "string" ? input : input.pagePath;
      this.pending = { role: "page-worker", pid: process.pid, threadId: this.threadId, taskId: `${task}:${this.sequence++}`, dispatchedAt: Date.now() };
      events.push(this.pending);
      journal("dispatch", { workerThreadId: this.threadId, taskId: this.pending.taskId });
      super.postMessage(...args);
    }
    override async terminate() {
      const workerThreadId = this.threadId;
      journal("termination-requested", { workerThreadId, taskId: this.pending?.taskId });
      const code = await super.terminate();
      journal("termination-completed", { workerThreadId, code });
      return code;
    }
  };
  children.execFile = ((...args: unknown[]) => {
    const options = args[2];
    if (options && typeof options === "object") {
      const original = options as { env?: NodeJS.ProcessEnv };
      args[2] = { ...original, env: { ...cleanGeneratorEnvironment(original.env ?? process.env), ...(directory ? { BASCIK_PROFILE_CAPTURE_DIR: directory, NODE_OPTIONS: `--import=${preload}` } : {}) } };
    }
    const child = Reflect.apply(originalExecFile, children, args) as import("node:child_process").ChildProcess;
    events.push({ role: args[0] === process.execPath ? "script-child" : "native-child", pid: child.pid, parentPid: process.pid, command: args.slice(0, 2), startedAt: Date.now() });
    journal("child-created", { childPid: child.pid });
    child.on("exit", (code, signal) => journal("child-exit", { childPid: child.pid, code, signal }));
    return child;
  }) as typeof children.execFile;
  syncBuiltinESMExports();
  return events;
}