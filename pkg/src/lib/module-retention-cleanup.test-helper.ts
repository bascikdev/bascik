import childProcess, { type ChildProcess } from "node:child_process";
import fs, { type WriteStream } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const [role, directory, scenario] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);

if (role === "descendant") {
  process.on("SIGTERM", () => { });
  process.on("SIGINT", () => { });
  process.send!({ ready: true });
  setInterval(() => { }, 60_000);
} else if (role === "subject") {
  const descendant = childProcess.fork(fixture, ["descendant"], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise<void>((resolveReady, reject) => {
    descendant.once("error", reject);
    descendant.once("message", () => resolveReady());
  });
  process.send!({ descendant: descendant.pid });
  process.argv = [process.execPath, fixture, directory, "dev"];
  await import("./module-retention-subject.test-helper.ts");
  if (scenario === "shutdown") {
    const handlers = process.listeners("message");
    process.removeAllListeners("message");
    process.on("message", message => {
      const command = message as { action: string; id: number; };
      if (command.action === "stop") {
        process.removeAllListeners("SIGTERM");
        process.on("SIGTERM", () => { });
        process.send!({ id: command.id, stopBlocked: true });
      } else {
        for (const handler of handlers) Reflect.apply(handler, process, [message]);
      }
    });
  }
} else {
  const originalFork = childProcess.fork;
  const originalLog = fs.createWriteStream;
  const originalKill = process.kill;
  let killDenied = false;
  let subject: ChildProcess | undefined;
  let log: WriteStream | undefined;
  const events: string[] = [];
  const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  if (scenario === "kill-race") process.kill = (pid, signal) => {
    if (pid === -subject!.pid! && signal === "SIGKILL" && !killDenied) {
      killDenied = true;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return originalKill(pid, signal);
  };
  childProcess.fork = ((_path, _args, options) => {
    subject = originalFork(fixture, ["subject", directory, scenario], {
      ...options, ...(scenario === "spawn" ? { execPath: `${directory}/missing-node` } : {}),
    });
    if (scenario === "reap") {
      const emit = subject.emit;
      subject.emit = function(event: string | symbol, ...args: unknown[]): boolean {
        return event === "close" ? false : Reflect.apply(emit, this, [event, ...args]);
      };
    }
    subject.once("error", () => events.push("error"));
    subject.once("exit", () => events.push("exit"));
    subject.once("close", () => events.push("close"));
    subject.on("message", message => process.send!({ observation: message, subject: subject!.pid }));
    return subject;
  }) as typeof childProcess.fork;
  fs.createWriteStream = ((...args: Parameters<typeof originalLog>) => {
    log = originalLog(...args);
    return log;
  }) as typeof originalLog;
  syncBuiltinESMExports();
  const { runRetentionExperiment } = await import("./module-retention.test-helper.ts");
  let failure: string | undefined;
  try {
    await runRetentionExperiment(directory, false, 2);
  } catch (error) {
    failure = String(error);
  } finally {
    process.send!({
      result: {
        failure, events, subject: subject?.pid, killDenied,
        logClosed: log?.closed, logDestroyed: log?.destroyed,
        stdoutDestroyed: subject?.stdout?.destroyed, stderrDestroyed: subject?.stderr?.destroyed,
        signalListenersRestored: process.listenerCount("SIGINT") === listeners.SIGINT && process.listenerCount("SIGTERM") === listeners.SIGTERM,
        messageListeners: subject?.listenerCount("message"),
        errorListeners: subject?.listenerCount("error"),
        logErrorListeners: log?.listenerCount("error"),
        logCloseListeners: log?.listenerCount("close"),
      }
    });
    process.disconnect!();
  }
}