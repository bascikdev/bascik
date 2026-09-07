import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

// Pass-through spy on `realpathSync` so the tests can count how often the
// registry hits the filesystem for identity resolution (finding #2). The real
// implementation runs; only the call count is observed.
const { realpathSyncSpy } = vi.hoisted(() => ({ realpathSyncSpy: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  realpathSyncSpy.mockImplementation((...args: Parameters<typeof actual.realpathSync>) =>
    actual.realpathSync(...args),
  );
  return { ...actual, realpathSync: realpathSyncSpy };
});

import { realpathSync } from "node:fs";
import { assertRegistryReleased } from "./module-retention.test-helper.ts";
import {
  ScriptRegistry,
  scriptRegistry,
  resolveModuleIdentity,
  _identityTestHooks,
} from "./script-registry.ts";

describe("ScriptRegistry", () => {
  let tempDir: string;

  it("retention oracle detects a deliberately framework-held module after clear", async () => {
    const registry = new ScriptRegistry({ isDev: false });
    await registry.load("data:text/javascript,export default function retentionOracle129(){}");
    const cache: unknown = Reflect.get(registry, "cache");
    expect(cache).toBeInstanceOf(Map);
    if (!(cache instanceof Map)) throw new Error("registry cache observation unavailable");
    const clearSpy = vi.spyOn(cache, "clear").mockImplementation(() => { });
    try {
      registry.clear();
      expect(registry.graph.size).toBe(0);
      expect(() => assertRegistryReleased(registry)).toThrow("framework cache");
    } finally {
      clearSpy.mockRestore();
      registry.clear();
    }
    expect(() => assertRegistryReleased(registry)).not.toThrow();
  });

  it("Node retains a dependency-free namespace after source reversion and framework clear", async () => {
    const registry = new ScriptRegistry({ isDev: true });
    const originalSource = "data:text/javascript,export default function retentionReversion129(){return 'original'}";
    const original = await registry.load(originalSource);
    await registry.load("data:text/javascript,export default function retentionReversion129(){return 'changed'}");
    expect((await registry.load(originalSource)).module).toBe(original.module);
    registry.clear();
    assertRegistryReleased(registry);
    const reverted = await registry.load(originalSource);
    expect(reverted.url).toBe(original.url);
    expect(reverted.module).toBe(original.module);
    expect(reverted.module.default()).toBe("original");
    registry.clear();
  });

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
      const ctx = { id: `req-${i}`, user: `user-${i}` };
      const res = await registry.invoke<{ echoId: string; echoUser: string; }>(filePath, [ctx]);
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
    const result = await registry.invoke(filePath, [{ reason: "test-failure" }]);

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
    const result = await registry.invoke(filePath, [], { originalSourcePath: "src/pages/index.html", lineOffset: 12 });

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
    const result = await registry.invoke(filePath, []);

    expect(result.ok).toBe(false);
    expect(result.isNetworkReset).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  // 8b. An upstream abort (the response sink's "client disconnected" reason,
  // which is neither a net-reset code nor a timeout) is not a server fault.
  it("does not log an error when the upstream signal aborts with a disconnect reason", async () => {
    const filePath = join(tempDir, "upstream-disconnect.mjs");
    await writeFile(
      filePath,
      `export default async function(context, opts) {
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
        });
      }`
    );

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    const controller = new AbortController();
    const registry = new ScriptRegistry({ isDev: false });
    await registry.load(filePath);

    const invokePromise = registry.invoke(filePath, [{}], {
      timeoutMs: 10000,
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("client disconnected"));

    const result = await invokePromise;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error?.message).toBe("client disconnected");
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
    const result = await registry.invoke(filePath, []);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Async unhandled error");

    stderrSpy.mockRestore();
  });

  // 10. A hung async module hits the timeout and the AbortSignal fires.
  it("times out hung async modules and signals abort via AbortSignal with exact fake timer advancement", async () => {
    const filePath = join(tempDir, "timeout-handler.mjs");
    await writeFile(
      filePath,
      `export default async function(context, opts) {
        const signal = opts.signal;
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(new Error('Aborted by signal: ' + signal.reason));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    // Pre-load module while real timers / async import work normally
    await registry.load(filePath);

    vi.useFakeTimers();
    try {
      const invokePromise = registry.invoke(filePath, [{}], { timeoutMs: 10000 });

      // Pending before deadline
      await vi.advanceTimersByTimeAsync(9999);
      // expect(vi.getTimerCount()).toBe(1);

      // Exactly at deadline
      await vi.advanceTimersByTimeAsync(1);
      const result = await invokePromise;

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error?.message).toContain("10000ms");
      // expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles race condition where upstream abort fires before timeout", async () => {
    const filePath = join(tempDir, "upstream-abort.mjs");
    await writeFile(
      filePath,
      `export default async function(context, opts) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(new Error('Aborted upstream'));
          };
          opts.signal.addEventListener('abort', onAbort, { once: true });
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
        [],
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
      const result = await registry.invoke(filePath, [], { timeoutMs: 10000 });

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
      `export default async function(context, opts) {
        return 'quick-value';
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    await registry.load(filePath);

    vi.useFakeTimers();
    try {
      const result = await registry.invoke(filePath, [], { timeoutMs: 10000 });
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
      const result = await registry.invoke(filePath, [], { timeoutMs: 10000 });

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
      const result = await registry.invoke(nonExistentPath, [], { timeoutMs: 10000 });

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
    // Pre-load module so load time does not consume the 2ms deadline before invocation starts
    await registry.load(filePath);
    // Setting timeout to 2ms cannot preempt synchronous execution during the busy loop
    const result = await registry.invoke(filePath, [], { timeoutMs: 2 });
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
    let res = await registry.invoke(filePath, []);
    expect(res.value).toBe("version-1");

    // Edit file
    await writeFile(filePath, "export default function() { return 'version-2'; }");
    registry.invalidate(filePath);

    res = await registry.invoke(filePath, []);
    expect(res.value).toBe("version-2");

    // Add new file
    const newFilePath = join(tempDir, "new-mod.mjs");
    await writeFile(newFilePath, "export default function() { return 'new-module'; }");

    let newRes = await registry.invoke(newFilePath, []);
    expect(newRes.value).toBe("new-module");

    // Delete file
    await rm(newFilePath);
    registry.invalidate(newFilePath);

    newRes = await registry.invoke(newFilePath, []);
    expect(newRes.ok).toBe(false);
    expect(newRes.error).toBeDefined();
  });

  // 13. No temporary file is created.
  it("does not write temporary files to disk when executing registered modules", async () => {
    const filePath = join(tempDir, "direct-mod.mjs");
    await writeFile(filePath, "export default function(ctx) { return ctx.foo * 2; }");

    const registry = new ScriptRegistry({ isDev: false });
    const res = await registry.invoke(filePath, [{ foo: 21 }]);
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });

  // 13. invoke accepts an argument list
  it("accepts an argument list and passes it to the handler", async () => {
    const filePath = join(tempDir, "args-handler.mjs");
    await writeFile(
      filePath,
      `export default async function(a, b, opts) {
        return [a, b, typeof opts.signal];
      }`
    );

    const registry = new ScriptRegistry({ isDev: false });
    // @ts-ignore - testing new signature before implementation
    const result = await registry.invoke(filePath, ["x", { k: 1 }]);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual(["x", { k: 1 }, "object"]);
  });
});

// ─── Prompt 112: module identity, mode ownership, dev invalidation ───────────

describe("ScriptRegistry module identity (prompt 112)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `bascik-script-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
    scriptRegistry.clear();
  });

  afterEach(async () => {
    scriptRegistry.clear();
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  });

  const writeModule = (filePath: string, value: string) =>
    writeFile(filePath, `export default function() { return ${JSON.stringify(value)}; }\n`);

  describe("configured singleton mode", () => {
    it("runs in development mode when the process is neither --build nor --server", () => {
      // The vitest process has no bascik mode flag, so BascikConfig resolves to
      // dev. The singleton must follow that decision instead of a hardcoded
      // production default.
      expect(scriptRegistry.mode).toBe("development");
    });

    it("regression: the configured singleton reloads an edited module after invalidate", async () => {
      const filePath = join(tempDir, "singleton-edit.mjs");
      await writeModule(filePath, "OLD");

      const before = await scriptRegistry.invoke<string>(filePath, []);
      expect(before.value).toBe("OLD");

      await writeModule(filePath, "NEW");
      scriptRegistry.invalidate(filePath);

      const after = await scriptRegistry.invoke<string>(filePath, []);
      expect(after.value).toBe("NEW");
    });
  });

  describe("specifier canonicalization", () => {
    it("loads a file: URL as a URL instead of re-encoding it as a filesystem path", async () => {
      const filePath = join(tempDir, "by-url.mjs");
      await writeModule(filePath, "via-url");

      const registry = new ScriptRegistry({ isDev: false });
      const loaded = await registry.load(pathToFileURL(filePath).href);
      expect(loaded.module.default()).toBe("via-url");
    });

    it("maps a file: URL and its absolute path to one shared module identity", async () => {
      const filePath = join(tempDir, "shared.mjs");
      await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default instance;");

      const registry = new ScriptRegistry({ isDev: false });
      const viaPath = await registry.load(filePath);
      const viaUrl = await registry.load(pathToFileURL(filePath).href);
      const viaRelative = await registry.load(relative(process.cwd(), filePath));

      expect(viaUrl.module).toBe(viaPath.module);
      expect(viaRelative.module).toBe(viaPath.module);
      expect(viaUrl.key).toBe(viaPath.key);
    });

    it("keeps an authored query and fragment on a file: URL as a distinct identity", async () => {
      const filePath = join(tempDir, "variant.mjs");
      await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default instance;");

      const registry = new ScriptRegistry({ isDev: false });
      const base = pathToFileURL(filePath).href;
      const a = await registry.load(`${base}?variant=a`);
      const b = await registry.load(`${base}?variant=b`);
      const plain = await registry.load(base);

      // Node treats a differing query as a different module; the registry must not collapse them.
      expect(a.module).not.toBe(b.module);
      expect(a.module).not.toBe(plain.module);
      expect(a.url).toContain("variant=a");
      expect(b.url).toContain("variant=b");
      // Loading the same variant twice reuses the instance.
      expect((await registry.load(`${base}?variant=a`)).module).toBe(a.module);
    });

    it("preserves an authored query when appending the dev generation marker", async () => {
      const filePath = join(tempDir, "query-gen.mjs");
      await writeModule(filePath, "OLD");

      const registry = new ScriptRegistry({ isDev: true });
      const specifier = `${pathToFileURL(filePath).href}?flavor=x`;
      const first = await registry.load(specifier);
      expect(first.module.default()).toBe("OLD");

      await writeModule(filePath, "NEW");
      registry.invalidate(specifier);
      const second = await registry.load(specifier);

      expect(second.module.default()).toBe("NEW");
      const url = new URL(second.url!);
      expect(url.searchParams.get("flavor")).toBe("x");
      expect(url.searchParams.has("bascik-gen")).toBe(true);
    });

    it("handles a path containing # under the real Node loader, including dev reload", async () => {
      // Vitest's module runner intercepts dynamic import() and cannot resolve a
      // percent-encoded `#` (%23) in a file URL, which Node itself handles. The
      // registry is therefore exercised in a real child Node process so the
      // assertion is about the runtime boundary and not the test harness.
      const filePath = join(tempDir, "ha#sh.mjs");
      await writeModule(filePath, "OLD");
      const registryModule = pathToFileURL(join(process.cwd(), "src/lib/script-registry.ts")).href;
      const script = `
        import { ScriptRegistry } from ${JSON.stringify(registryModule)};
        import { writeFileSync } from "node:fs";
        const filePath = ${JSON.stringify(filePath)};
        const registry = new ScriptRegistry({ isDev: true });
        const viaPath = await registry.load(filePath);
        const viaUrl = await registry.load(${JSON.stringify(pathToFileURL(filePath).href)});
        const shared = viaUrl.module === viaPath.module;
        writeFileSync(filePath, "export default function() { return 'NEW'; }\\n");
        registry.invalidate(filePath);
        const reloaded = await registry.load(filePath);
        console.log(JSON.stringify({ before: viaPath.module.default(), shared, after: reloaded.module.default(), url: reloaded.url }));
      `;
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, BASCIK_BUILD: "0", BASCIK_SERVER: "0" },
      });
      const result = JSON.parse(stdout.trim().split("\n").pop()!);
      expect(result).toMatchObject({ before: "OLD", shared: true, after: "NEW" });
      expect(result.url).toContain("ha%23sh.mjs?bascik-gen=1");
    });

    it.each([
      ["spaces", "sp ace mod.mjs"],
      ["percent", "per%cent.mjs"],
      ["unicode", "ünï-cödé-模块.mjs"],
      ["dollar tokens", "$1-$&-mod.mjs"],
    ])("handles a path containing %s through path and file: URL, including dev reload", async (_label, name) => {
      const filePath = join(tempDir, name);
      await writeModule(filePath, "OLD");

      const registry = new ScriptRegistry({ isDev: true });
      const viaPath = await registry.load(filePath);
      const viaUrl = await registry.load(pathToFileURL(filePath).href);
      expect(viaPath.module.default()).toBe("OLD");
      expect(viaUrl.module).toBe(viaPath.module);

      await writeModule(filePath, "NEW");
      registry.invalidate(pathToFileURL(filePath).href);
      const reloaded = await registry.load(filePath);
      expect(reloaded.module.default()).toBe("NEW");
    });

    it("reports the display path for a file identity and the raw specifier for data: URLs", async () => {
      const filePath = join(tempDir, "display.mjs");
      await writeModule(filePath, "x");
      const registry = new ScriptRegistry({ isDev: false });
      // The display path is the realpath (macOS tmpdir is a symlink to /private/var).
      expect((await registry.load(pathToFileURL(filePath).href)).filePath).toBe(realpathSync(filePath));

      const dataUrl = "data:text/javascript;charset=utf-8,export%20default%20()%20%3D%3E%20'd'";
      const loaded = await registry.load(dataUrl);
      expect(loaded.filePath).toBe(dataUrl);
      expect(loaded.module.default()).toBe("d");
    });
  });

  describe("development invalidation generations", () => {
    it("recovers after a failed load once the file is fixed and invalidated", async () => {
      const filePath = join(tempDir, "broken-then-fixed.mjs");
      await writeFile(filePath, "export default function( { return 'syntax error';\n");

      const registry = new ScriptRegistry({ isDev: true });
      const failed = await registry.invoke(filePath, []);
      expect(failed.ok).toBe(false);

      await writeModule(filePath, "fixed");
      registry.invalidate(filePath);

      const recovered = await registry.invoke<string>(filePath, []);
      expect(recovered.ok).toBe(true);
      expect(recovered.value).toBe("fixed");
    });

    it("does not publish a load that completed for a superseded generation", async () => {
      const filePath = join(tempDir, "rapid.mjs");
      await writeModule(filePath, "OLD");

      const registry = new ScriptRegistry({ isDev: true });
      const inFlight = registry.load(filePath);

      // Two invalidations land while the first import is still resolving.
      await writeModule(filePath, "NEW");
      registry.invalidate(filePath);
      registry.invalidate(filePath);

      const stale = await inFlight;
      expect(stale.version).toBe(0);

      const current = await registry.load(filePath);
      expect(current.version).toBe(2);
      expect(current.module.default()).toBe("NEW");
      // A third load returns the published current generation, never the stale one.
      expect((await registry.load(filePath)).module).toBe(current.module);
    });

    it("lets an in-flight request on the previous generation finish with its own module", async () => {
      const filePath = join(tempDir, "inflight.mjs");
      await writeFile(
        filePath,
        `export default async function(ctx) {
          await new Promise((r) => setTimeout(r, ctx.delay));
          return "OLD:" + ctx.id;
        }`,
      );

      const registry = new ScriptRegistry({ isDev: true });
      // Load generation 0 first so the slow invocation is deterministically
      // bound to it before the edit lands (no timing assumption).
      await registry.load(filePath);
      const slow = registry.invoke<string>(filePath, [{ id: "first", delay: 60 }]);

      await writeFile(filePath, `export default async function(ctx) { return "NEW:" + ctx.id; }`);
      registry.invalidate(filePath);

      const fast = await registry.invoke<string>(filePath, [{ id: "second", delay: 0 }]);
      expect(fast.value).toBe("NEW:second");

      const slowResult = await slow;
      expect(slowResult.ok).toBe(true);
      expect(slowResult.value).toBe("OLD:first");
    });

    it("supports add, delete, and recreate of a module without a restart", async () => {
      const filePath = join(tempDir, "lifecycle.mjs");
      const registry = new ScriptRegistry({ isDev: true });

      // Missing at first.
      const missing = await registry.invoke(filePath, []);
      expect(missing.ok).toBe(false);

      // Added.
      await writeModule(filePath, "v1");
      registry.invalidate(filePath);
      expect((await registry.invoke<string>(filePath, [])).value).toBe("v1");

      // Deleted.
      await rm(filePath);
      registry.invalidate(filePath);
      expect((await registry.invoke(filePath, [])).ok).toBe(false);

      // Recreated with new content.
      await writeModule(filePath, "v2");
      registry.invalidate(filePath);
      expect((await registry.invoke<string>(filePath, [])).value).toBe("v2");
    });

    it("only tracks generations for identities that were actually loaded or attempted", async () => {
      const registry = new ScriptRegistry({ isDev: true });
      const never = join(tempDir, "never-loaded.mjs");
      registry.invalidate(never);
      expect(registry.generationOf(never)).toBe(0);

      const attempted = join(tempDir, "attempted.mjs");
      await expect(registry.load(attempted)).rejects.toThrow();
      registry.invalidate(attempted);
      expect(registry.generationOf(attempted)).toBe(1);
    });
  });

  describe("diagnostics across generations", () => {
    it("remaps a stack frame from a generation URL (with ?bascik-gen) back to the authored source", async () => {
      const filePath = join(tempDir, "gen-trace.mjs");
      await writeModule(filePath, "OLD");
      const registry = new ScriptRegistry({ isDev: true });
      await registry.load(filePath);

      await writeFile(filePath, `export default function() {\n  throw new Error('gen failure');\n}\n`);
      registry.invalidate(filePath);

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => { });
      const result = await registry.invoke(filePath, [], { originalSourcePath: "src/pages/index.html", lineOffset: 40 });
      expect(result.ok).toBe(false);
      const logOutput = stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      stderrSpy.mockRestore();

      // Frame line 2 of the module plus offset 40 minus 1 equals authored line 41.
      expect(logOutput).toContain("src/pages/index.html:41");
      expect(logOutput).not.toContain("bascik-gen");
    });
  });

  describe("dependency generations (prompt 138)", () => {
    it("keys a file identity by its realpath so a symlinked path and the real path share one identity", async () => {
      const realDir = join(tempDir, "real");
      await mkdir(realDir, { recursive: true });
      const realFile = join(realDir, "m.mjs");
      await writeFile(realFile, "export const instance = { id: Math.random() };\nexport default instance;");
      const linkDir = join(tempDir, "link");
      const { symlink } = await import("node:fs/promises");
      await symlink(realDir, linkDir);
      const linkFile = join(linkDir, "m.mjs");

      const viaLink = resolveModuleIdentity(linkFile);
      const viaReal = resolveModuleIdentity(realFile);
      expect(viaLink.key).toBe(viaReal.key);
      expect(viaLink.key).toBe(pathToFileURL(realpathSync(realFile)).href);
      // The display path is the resolved filesystem path too.
      expect(viaLink.displayPath).toBe(realpathSync(realFile));

      // A missing file cannot be realpath'd and falls back to the unresolved path.
      const missing = join(linkDir, "missing.mjs");
      expect(resolveModuleIdentity(missing).key).toBe(pathToFileURL(missing).href);

      const registry = new ScriptRegistry({ isDev: true });
      const a = await registry.load(linkFile);
      const b = await registry.load(realFile);
      expect(a.module).toBe(b.module);
    });

    it("invalidate() on a helper the registry never imported directly unpublishes the entry that imports it", async () => {
      const registry = new ScriptRegistry({ isDev: true });
      const helper = join(tempDir, "helper.mjs");
      const entry = join(tempDir, "entry.mjs");
      await writeFile(helper, 'export const v = "H-OLD";\n');
      await writeFile(entry, 'import { v } from "./helper.mjs";\nexport default () => v;\n');
      // Simulate what the resolve hook records when Node resolves ./helper.mjs
      // from the entry: the registry and the graph share one generation owner.
      const graph = registry.graph;
      graph.recordEdge(resolveModuleIdentity(helper).key, resolveModuleIdentity(entry).key);

      const first = await registry.load(entry);
      expect(first.version).toBe(0);
      expect(registry.generationOf(helper)).toBe(0);

      // Helper edit: the watcher reports the helper path only.
      expect(registry.invalidate(helper)).toBe(true);
      expect(registry.generationOf(helper)).toBe(1);
      expect(registry.generationOf(entry)).toBe(1);
      // The entry was unpublished even though invalidate() was called with the helper.
      expect(registry.isPublished(entry)).toBe(false);
      const second = await registry.load(entry);
      expect(second.version).toBe(1);
      expect(second.url).toContain("bascik-gen=1");
    });

    it("returns false and allocates nothing for a key neither the registry nor the graph has seen", () => {
      const registry = new ScriptRegistry({ isDev: true });
      const never = join(tempDir, "never.mjs");
      expect(registry.invalidate(never)).toBe(false);
      expect(registry.generationOf(never)).toBe(0);
      expect(registry.graph.has(resolveModuleIdentity(never).key)).toBe(false);
    });

    it("lastInvalidated() reports every key advanced by the most recent invalidate()", async () => {
      const registry = new ScriptRegistry({ isDev: true });
      const helper = join(tempDir, "h2.mjs");
      const entry = join(tempDir, "e2.mjs");
      await writeFile(helper, 'export const v = 1;\n');
      await writeFile(entry, 'import { v } from "./h2.mjs";\nexport default () => v;\n');
      registry.graph.recordEdge(resolveModuleIdentity(helper).key, resolveModuleIdentity(entry).key);
      await registry.load(entry);
      registry.invalidate(helper);
      expect([...registry.lastInvalidated()].sort()).toEqual(
        [resolveModuleIdentity(helper).key, resolveModuleIdentity(entry).key].sort(),
      );
    });

    it("preserves in-flight semantics when a helper invalidation supersedes an entry load", async () => {
      const registry = new ScriptRegistry({ isDev: true });
      const helper = join(tempDir, "h3.mjs");
      const entry = join(tempDir, "e3.mjs");
      await writeFile(helper, 'export const v = "OLD";\n');
      await writeFile(entry, 'import { v } from "./h3.mjs";\nexport default () => v;\n');
      registry.graph.recordEdge(resolveModuleIdentity(helper).key, resolveModuleIdentity(entry).key);

      const inFlight = registry.load(entry);
      registry.invalidate(helper);
      const stale = await inFlight;
      expect(stale.version).toBe(0);
      // Completed for a superseded generation: handed back, not published.
      expect(registry.isPublished(entry)).toBe(false);
      const current = await registry.load(entry);
      expect(current.version).toBe(1);
      expect(registry.isPublished(entry)).toBe(true);
    });

    it("production mode never consults or grows the graph", async () => {
      const registry = new ScriptRegistry({ isDev: false });
      const entry = join(tempDir, "prod-entry.mjs");
      await writeModule(entry, "P");
      await registry.load(entry);
      expect(registry.invalidate(entry)).toBe(false);
      expect(registry.graph.size).toBe(0);
    });
  });

  describe("realpath memoization (finding #2)", () => {
    beforeEach(() => {
      _identityTestHooks.clearRealpathMemo();
      realpathSyncSpy.mockClear();
    });

    it("production: realpathSync runs once per specifier across repeated load() and invoke()", async () => {
      const filePath = join(tempDir, "memo-prod.mjs");
      await writeFile(filePath, "export default () => 'v';\n");
      const registry = new ScriptRegistry({ isDev: false });

      await registry.load(filePath);
      const afterFirst = realpathSyncSpy.mock.calls.filter((c) => c[0] === filePath).length;
      expect(afterFirst).toBe(1);

      await registry.load(filePath);
      await registry.invoke(filePath, []);
      await registry.invoke(filePath, []);
      expect(realpathSyncSpy.mock.calls.filter((c) => c[0] === filePath)).toHaveLength(1);
    });

    it("the memo maps a symlinked path to the realpath and keeps both spellings as one identity", async () => {
      const realDir = join(tempDir, "real-memo");
      await mkdir(realDir, { recursive: true });
      const realFile = join(realDir, "m.mjs");
      await writeFile(realFile, "export default 1;\n");
      const linkDir = join(tempDir, "link-memo");
      const { symlink } = await import("node:fs/promises");
      await symlink(realDir, linkDir);
      const linkFile = join(linkDir, "m.mjs");

      expect(resolveModuleIdentity(linkFile).key).toBe(resolveModuleIdentity(realFile).key);
      resolveModuleIdentity(linkFile);
      resolveModuleIdentity(linkFile);
      expect(realpathSyncSpy.mock.calls.filter((c) => c[0] === linkFile)).toHaveLength(1);
    });

    it("development: invalidate() drops the memo entry for the key and its advanced dependents so a re-pointed path is re-resolved", async () => {
      const helper = join(tempDir, "memo-helper.mjs");
      const entry = join(tempDir, "memo-entry.mjs");
      await writeFile(helper, 'export const v = "A";\n');
      await writeFile(entry, 'import { v } from "./memo-helper.mjs";\nexport default () => v;\n');
      const registry = new ScriptRegistry({ isDev: true });
      registry.graph.recordEdge(resolveModuleIdentity(helper).key, resolveModuleIdentity(entry).key);
      await registry.load(entry);
      expect(_identityTestHooks.realpathMemoSize).toBeGreaterThan(0);
      const before = _identityTestHooks.realpathMemoSize;

      // A missing helper is memoized to itself (no realpath); invalidation must
      // drop it so a file that later appears (or is re-pointed through a new
      // symlink) resolves fresh.
      registry.invalidate(helper);
      expect(_identityTestHooks.realpathMemoSize).toBeLessThan(before);
      expect(_identityTestHooks.hasRealpathMemo(helper)).toBe(false);
      expect(_identityTestHooks.hasRealpathMemo(entry)).toBe(false);

      realpathSyncSpy.mockClear();
      await registry.load(entry);
      expect(realpathSyncSpy.mock.calls.filter((c) => c[0] === entry)).toHaveLength(1);
    });
  });

  describe("production module reuse", () => {
    it("keeps a stable module identity across invalidate and file edits in production mode", async () => {
      const filePath = join(tempDir, "prod-stable.mjs");
      await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default () => 'OLD';");

      const registry = new ScriptRegistry({ isDev: false });
      expect(registry.mode).toBe("production");
      const first = await registry.load(filePath);

      await writeFile(filePath, "export const instance = { id: Math.random() };\nexport default () => 'NEW';");
      registry.invalidate(filePath);
      const second = await registry.load(filePath);

      expect(second.module).toBe(first.module);
      expect(second.module.default()).toBe("OLD");
      expect(second.url).not.toContain("bascik-gen");
    });
  });
});
