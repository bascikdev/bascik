import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "spawn", "shutdown", "reap", "kill-race"] as const)("retention cleanup: %s", async scenario => {
  const directory = await mkdtemp(join(tmpdir(), "bascik-retention-cleanup-"));
  const parent = fork(fileURLToPath(new URL("./module-retention-cleanup.test-helper.ts", import.meta.url)), ["parent", directory, scenario], {
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let subject: number | undefined;
  let descendant: number | undefined;
  let result: Record<string, unknown> | undefined;
  let stderr = "";
  parent.stderr!.on("data", chunk => { stderr += chunk; });
  parent.stdout!.resume();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; }>(resolveClosed => {
    parent.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  const ready = Promise.withResolvers<void>();
  let stopBlocked = false;
  parent.on("message", (message: { subject?: number; result?: Record<string, unknown>; observation?: { ready?: boolean; descendant?: number; stopBlocked?: boolean; }; }) => {
    subject ??= message.subject;
    descendant ??= message.observation?.descendant;
    if (message.observation?.ready) ready.resolve();
    if (message.observation?.stopBlocked) stopBlocked = true;
    if (message.result) result = message.result;
  });
  let deadline: NodeJS.Timeout | undefined;
  const bounded = <Result>(promise: Promise<Result>, milliseconds: number) => Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`cleanup did not settle: ${stderr}`)), milliseconds); }),
  ]).finally(() => clearTimeout(deadline));
  const kill = (pid: number) => {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  try {
    if (scenario === "SIGINT" || scenario === "SIGTERM" || scenario === "kill-race") {
      await bounded(ready.promise, 20_000);
      const config = await readFile(join(directory, "project/bascik.config.ts"), "utf8");
      const { http: { port } } = JSON.parse(config.slice("export default ".length, -1));
      expect((await fetch(`http://127.0.0.1:${port}/inline`, { signal: AbortSignal.timeout(5000) })).status).toBe(200);
      parent.kill(scenario === "kill-race" ? "SIGTERM" : scenario);
    }
    const outcome = await bounded(closed, scenario === "spawn" ? 5000 : 30_000);
    expect(result, `parent exited without cleanup: ${JSON.stringify(outcome)} ${stderr}`).toBeDefined();
    expect(result).toMatchObject({ logClosed: true, logDestroyed: true, stdoutDestroyed: true, stderrDestroyed: true, signalListenersRestored: true, messageListeners: 1 });
    expect(result).toMatchObject({ errorListeners: scenario === "spawn" ? 0 : 1, logErrorListeners: 0, logCloseListeners: 0 });
    if (scenario === "spawn") {
      expect(result!.failure).toContain("ENOENT");
      expect(result!.events).toEqual(["error", "close"]);
      expect(subject).toBeUndefined();
    } else {
      expect(subject).toBeTypeOf("number");
      expect(descendant).toBeTypeOf("number");
      expect(() => process.kill(-subject!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      expect(() => process.kill(descendant!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      if (scenario === "shutdown") {
        expect(stopBlocked).toBe(true);
        expect(result!.failure).toContain("retention shutdown deadline exceeded");
      } else if (scenario === "reap") {
        expect(result!.failure).toContain("retention final reap deadline exceeded");
      } else {
        expect(outcome).toEqual({ code: scenario === "SIGINT" ? 130 : 143, signal: null });
        expect(result!.failure).toContain(scenario === "kill-race" ? "SIGTERM" : scenario);
        if (scenario === "kill-race") expect(result!.killDenied).toBe(true);
      }
    }
    expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).success).toBe(false);
  } finally {
    clearTimeout(deadline);
    if (subject) kill(-subject);
    if (descendant) kill(descendant);
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);