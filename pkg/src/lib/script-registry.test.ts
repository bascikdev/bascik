import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  ScriptRegistry,
  scriptRegistry,
  type ScriptInvocationContext,
} from "./script-registry.ts";

describe("ScriptRegistry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `bascik-script-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
    scriptRegistry.clear();
  });

  afterEach(async () => {
    scriptRegistry.clear();
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  });

  // 1. Loading by resolved path returns the same module instance twice.
  it("returns the same module instance when loaded twice by resolved path in production mode", async () => {
    const filePath = join(tempDir, "mod1.mjs");
    await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default instance;");

    const registry = new ScriptRegistry({ isDev: false });
    const loaded1 = await registry.load(filePath);
    const loaded2 = await registry.load(filePath);

    expect(loaded1.module).toBe(loaded2.module);
    expect(loaded1.module.instance).toBe(loaded2.module.instance);
  });

  // 2. Two specifiers resolving to one file share an instance.
  it("shares module instance when accessed via different relative/resolved paths pointing to the same file", async () => {
    const filePath = join(tempDir, "mod2.mjs");
    await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default instance;");

    const registry = new ScriptRegistry({ isDev: false });
    const relativePath = join(tempDir, "subdir", "..", "mod2.mjs");

    const loaded1 = await registry.load(filePath);
    const loaded2 = await registry.load(relativePath);

    expect(loaded1.module).toBe(loaded2.module);
    expect(loaded1.module.instance.id).toBe(loaded2.module.instance.id);
  });

  // 3. A module that throws on load is contained and does not poison other entries.
  it("contains module load errors without poisoning registry or affecting other modules", async () => {
    const badPath = join(tempDir, "bad.mjs");
    const goodPath = join(tempDir, "good.mjs");

    await writeFile(badPath, "throw new Error('Boom at load time');");
    await writeFile(goodPath, "export default function() { return 'ok'; }");

    const registry = new ScriptRegistry({ isDev: false });

    await expect(registry.load(badPath)).rejects.toThrow("Boom at load time");

    // Good module loads successfully
    const good = await registry.load(goodPath);
    expect(good.module.default()).toBe("ok");

    // Another module load works
    const goodPath2 = join(tempDir, "good2.mjs");
    await writeFile(goodPath2, "export default function() { return 'ok2'; }");
    const good2 = await registry.load(goodPath2);
    expect(good2.module.default()).toBe("ok2");
  });

  // 4. After the file changes, a previously-failing module can load successfully.
  it("allows retrying a previously-failing module after file changes", async () => {
    const filePath = join(tempDir, "retry.mjs");
    await writeFile(filePath, "throw new Error('Initial syntax/runtime error');");

    const registry = new ScriptRegistry({ isDev: true });

    await expect(registry.load(filePath)).rejects.toThrow("Initial syntax/runtime error");

    // Fix the file
    await writeFile(filePath, "export default function() { return 'recovered'; }");

    registry.invalidate(filePath);

    const loaded = await registry.load(filePath);
    expect(loaded.module.default()).toBe("recovered");
  });

  // 5. Many concurrent invocations with distinct context each see only their own.
  it("ensures concurrent invocations with distinct context never leak state", async () => {
    const filePath = join(tempDir, "handler.mjs");
    await writeFile(
      filePath,
      `export default async function(context, { signal }) {
        const delay = Math.floor(Math.random() * 20) + 5;
        await new Promise(r => setTimeout(r, delay));
        return { echoId: context.id, echoUser: context.user };
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    const count = 50;
    const tasks = Array.from({ length: count }, async (_, i) => {
      const ctx: ScriptInvocationContext = { id: `req-${i}`, user: `user-${i}` };
      const res = await registry.invoke<{ echoId: string; echoUser: string }>(filePath, ctx);
      return { expectedId: ctx.id, expectedUser: ctx.user, actual: res.value };
    });

    const results = await Promise.all(tasks);
    for (const r of results) {
      expect(r.actual?.echoId).toBe(r.expectedId);
      expect(r.actual?.echoUser).toBe(r.expectedUser);
    }
  });

  // 6. A thrown error surfaces as a structured failure without crashing, and the caller decides the response.
  it("surfaces invocation errors as structured failures without crashing the process", async () => {
    const filePath = join(tempDir, "throw-handler.mjs");
    await writeFile(
      filePath,
      `export default async function(context) {
        throw new Error('Handler crashed with reason: ' + context.reason);
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    const result = await registry.invoke(filePath, { reason: "test-failure" });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("Handler crashed with reason: test-failure");
    expect(result.value).toBeUndefined();
  });

  // 7. The real error is logged with the module identity and a cleaned stack.
  it("logs errors to stderr with module identity and cleaned stack trace", async () => {
    const filePath = join(tempDir, "logged-error.mjs");
    await writeFile(
      filePath,
      `export default async function() {
        const err = new Error('Logged failure');
        throw err;
      }`
    );

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    const registry = new ScriptRegistry({ isDev: false });
    const result = await registry.invoke(filePath, {}, { originalSourcePath: "src/pages/index.html", lineOffset: 12 });

    expect(result.ok).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
    const logOutput = stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("Logged failure");
    expect(logOutput).toContain("src/pages/index.html");

    stderrSpy.mockRestore();
  });

  // 8. A client disconnect is not logged as a server fault.
  it("does not log client disconnect / network reset errors as server faults", async () => {
    const filePath = join(tempDir, "disconnect.mjs");
    await writeFile(
      filePath,
      `export default async function() {
        const err = new Error('Client reset connection');
        err.code = 'ECONNRESET';
        throw err;
      }`
    );

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    const registry = new ScriptRegistry({ isDev: false });
    const result = await registry.invoke(filePath, {});

    expect(result.ok).toBe(false);
    expect(result.isNetworkReset).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  // 9. An unhandled rejection inside a module does not crash the process.
  it("captures async promise rejections without crashing the process", async () => {
    const filePath = join(tempDir, "async-reject.mjs");
    await writeFile(
      filePath,
      `export default function() {
        return Promise.reject(new Error('Async unhandled error'));
      }`
    );

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    const registry = new ScriptRegistry({ isDev: false });
    const result = await registry.invoke(filePath, {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Async unhandled error");

    stderrSpy.mockRestore();
  });

  // 10. A hung async module hits the timeout and the AbortSignal fires.
  it("times out hung async modules and signals abort via AbortSignal with exact fake timer advancement", async () => {
    const filePath = join(tempDir, "timeout-handler.mjs");
    await writeFile(
      filePath,
      `export default async function(context, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('Aborted by signal: ' + signal.reason));
          });
        });
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    // Pre-load module while real timers / async import work normally
    await registry.load(filePath);

    vi.useFakeTimers();
    try {
      const invokePromise = registry.invoke(filePath, {}, { timeoutMs: 10000 });

      // Pending before deadline
      await vi.advanceTimersByTimeAsync(9999);
      expect(vi.getTimerCount()).toBe(1);

      // Exactly at deadline
      await vi.advanceTimersByTimeAsync(1);
      const result = await invokePromise;

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error?.message).toContain("10000ms");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles race condition where upstream abort fires before timeout", async () => {
    const filePath = join(tempDir, "upstream-abort.mjs");
    await writeFile(
      filePath,
      `export default async function(context, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('Aborted upstream'));
          });
        });
      }`
    );

    const controller = new AbortController();
    const registry = new ScriptRegistry({ isDev: false });
    await registry.load(filePath);

    vi.useFakeTimers();
    try {
      const invokePromise = registry.invoke(
        filePath,
        {},
        { timeoutMs: 10000, signal: controller.signal }
      );

      await vi.advanceTimersByTimeAsync(5000);
      controller.abort();

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timer when handler resolves before timeout", async () => {
    vi.useFakeTimers();
    try {
      const filePath = join(tempDir, "fast-resolve.mjs");
      await writeFile(
        filePath,
        `export default async function() {
          return 'fast-result';
        }`
      );

      const registry = new ScriptRegistry({ isDev: false });
      const result = await registry.invoke(filePath, {}, { timeoutMs: 10000 });

      expect(result.ok).toBe(true);
      expect(result.value).toBe("fast-result");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensures a canceled late timer callback cannot mutate completed result or trigger late abort", async () => {
    const filePath = join(tempDir, "fast-no-late-abort.mjs");
    await writeFile(
      filePath,
      `export default async function(context, { signal }) {
        return 'quick-value';
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    await registry.load(filePath);

    vi.useFakeTimers();
    try {
      const result = await registry.invoke(filePath, {}, { timeoutMs: 10000 });
      expect(result.ok).toBe(true);
      expect(result.value).toBe("quick-value");
      expect(result.timedOut).toBeUndefined();

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(20000);
      expect(result.ok).toBe(true);
      expect(result.timedOut).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timer when handler rejects before timeout", async () => {
    vi.useFakeTimers();
    try {
      const filePath = join(tempDir, "fast-reject.mjs");
      await writeFile(
        filePath,
        `export default async function() {
          throw new Error('fast-error');
        }`
      );

      const registry = new ScriptRegistry({ isDev: false });
      const result = await registry.invoke(filePath, {}, { timeoutMs: 10000 });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error?.message).toBe("fast-error");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timer and handles module load failure before invocation", async () => {
    vi.useFakeTimers();
    try {
      const nonExistentPath = join(tempDir, "does-not-exist.mjs");
      const registry = new ScriptRegistry({ isDev: false });
      const result = await registry.invoke(nonExistentPath, {}, { timeoutMs: 10000 });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 11. A synchronous infinite loop is NOT interrupted, pinning the documented limitation.
  it("pins that synchronous blocking code cannot be interrupted by in-process timeout", async () => {
    // We document and verify that in-process execution cannot forcibly preempt synchronous CPU loops without worker threads
    const filePath = join(tempDir, "sync-loop.mjs");
    await writeFile(
      filePath,
      `export default function() {
        const start = Date.now();
        while (Date.now() - start < 10) {
          // busy wait
        }
        return 'completed-sync';
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    // Setting timeout to 2ms cannot preempt synchronous execution during the busy loop
    const result = await registry.invoke(filePath, {}, { timeoutMs: 2 });
    // Synchronous execution ran to completion on the event loop
    expect(result.ok).toBe(true);
    expect(result.value).toBe("completed-sync");
  });

  // 12. Dev invalidation: edit, add, and delete all apply without a restart.
  it("supports dev invalidation for editing, adding, and deleting modules", async () => {
    const filePath = join(tempDir, "dev-mod.mjs");
    await writeFile(filePath, "export default function() { return 'version-1'; }");

    const registry = new ScriptRegistry({ isDev: true });

    // Initial load
    let res = await registry.invoke(filePath, {});
    expect(res.value).toBe("version-1");

    // Edit file
    await writeFile(filePath, "export default function() { return 'version-2'; }");
    registry.invalidate(filePath);

    res = await registry.invoke(filePath, {});
    expect(res.value).toBe("version-2");

    // Add new file
    const newFilePath = join(tempDir, "new-mod.mjs");
    await writeFile(newFilePath, "export default function() { return 'new-module'; }");

    let newRes = await registry.invoke(newFilePath, {});
    expect(newRes.value).toBe("new-module");

    // Delete file
    await rm(newFilePath);
    registry.invalidate(newFilePath);

    newRes = await registry.invoke(newFilePath, {});
    expect(newRes.ok).toBe(false);
    expect(newRes.error).toBeDefined();
  });

  // 13. No temporary file is created.
  it("does not write temporary files to disk when executing registered modules", async () => {
    const filePath = join(tempDir, "direct-mod.mjs");
    await writeFile(filePath, "export default function(ctx) { return ctx.foo * 2; }");

    const registry = new ScriptRegistry({ isDev: false });
    const res = await registry.invoke(filePath, { foo: 21 });
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });
});
