/**
 * Prompt 112: module identity and live development invalidation.
 *
 * These tests reproduce the audited defect at its real boundary. A REAL `bascik`
 * dev server child process (actual config, `startServer`, `watchFiles`, chokidar,
 * the configured `scriptRegistry` singleton, and real loopback HTTP) serves an
 * API route and a `src=` server script from an isolated fixture. The fixture is
 * edited on disk, the test waits for the server to report the resulting module
 * identity change, and the next request must observe the new code.
 *
 * Nothing here is mocked: the point is that the singleton composition (not an
 * explicitly constructed dev registry) reloads edited modules. The transitive
 * cases (prompt 138) prove that editing only a helper, one or two levels below
 * the entry, changes the served output through the dev module graph hook.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Source entrypoint. Node 24 runs .ts directly, and pkg/dist is gitignored, so
// the compiled output cannot be a dependency of a unit test.
const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");

interface DevServer {
  base: string;
  child: ChildProcess;
  /** Resolve once stdout/stderr contains `pattern` (starting from the current offset). */
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<string>;
  logs(): string;
  close(): Promise<void>;
}

let portCounter = 9600 + (process.pid % 200);
const nextPort = (): number => portCounter++;

const startDevServer = async (root: string): Promise<DevServer> => {
  const port = nextPort();
  const child = spawn(process.execPath, [PKG_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
      // Never inherit a mode flag from the vitest environment.
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "0",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const waiters: Array<{ pattern: RegExp; from: number; resolve: (s: string) => void }> = [];
  const onData = (d: Buffer): void => {
    output += d.toString();
    for (const waiter of [...waiters]) {
      const slice = output.slice(waiter.from);
      if (waiter.pattern.test(slice)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(slice);
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const waitForLog = (pattern: RegExp, timeoutMs = 15000): Promise<string> => {
    const from = output.length;
    if (pattern.test(output.slice(from))) return Promise.resolve(output.slice(from));
    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === wrapped);
        if (idx >= 0) waiters.splice(idx, 1);
        rej(new Error(`log ${pattern} not seen within ${timeoutMs}ms. Output:\n${output}`));
      }, timeoutMs);
      const wrapped = (s: string): void => {
        clearTimeout(timer);
        res(s);
      };
      waiters.push({ pattern, from, resolve: wrapped });
    });
  };

  const base = `http://localhost:${port}`;
  // The dev server prints the URL only after the initial transpile and watcher
  // ready events, so this is a real readiness gate, not a sleep.
  await waitForLog(/Server running at/, 30000);

  return {
    base,
    child,
    waitForLog,
    logs: () => output,
    close: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3000).unref();
      }),
  };
};

const fetchText = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  return { status: res.status, body: await res.text() };
};

const writeAt = async (root: string, rel: string, content: string): Promise<string> => {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
};

const apiModule = (value: string): string =>
  `export const GET = async () => Response.json({ value: ${JSON.stringify(value)} });\n`;

const helperModule = (value: string): string =>
  `export const helperValue = () => ${JSON.stringify(value)};\n`;

const srcScriptModule = (): string =>
  `import { helperValue } from "./helper.ts";\nexport default () => '<span data-testid="src-value">' + helperValue() + '</span>';\n`;

describe("live development module invalidation (real dev server)", () => {
  let root: string;
  let server: DevServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-112-dev-"));
    await writeAt(
      root,
      "bascik.config.js",
      `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: false },
  logging: { level: "info", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
    );
    await mkdir(join(root, "src/components"), { recursive: true });
    await writeAt(root, "src/api/value.ts", apiModule("OLD"));
    await writeAt(root, "src/lib/helper.ts", helperModule("HELPER-OLD"));
    await writeAt(root, "src/lib/src-script.ts", srcScriptModule());
    await writeAt(
      root,
      "src/pages/index.html",
      `<!DOCTYPE html><html><head><title>112</title></head><body>
  <p data-testid="page">page</p>
  <script data-bascik-server src="../lib/src-script.ts"></script>
</body></html>`,
    );
    server = await startDevServer(root);
  }, 60000);

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true }).catch(() => { });
  });

  it("serves the edited API route module after the watcher invalidates it (no restart)", async () => {
    const before = await fetchText(`${server.base}/api/value`);
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body).value).toBe("OLD");

    const changed = server.waitForLog(/api route change: src\/api\/value\.ts/);
    await writeAt(root, "src/api/value.ts", apiModule("NEW"));
    await changed;

    const after = await fetchText(`${server.base}/api/value`);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).value).toBe("NEW");
  }, 30000);

  it("recovers an API route after a syntax error is fixed", async () => {
    const broken = server.waitForLog(/api route change: src\/api\/value\.ts/);
    await writeAt(root, "src/api/value.ts", "export const GET = async ( => {\n");
    await broken;

    const failing = await fetchText(`${server.base}/api/value`);
    expect(failing.status).toBe(500);

    const fixed = server.waitForLog(/api route change: src\/api\/value\.ts/);
    await writeAt(root, "src/api/value.ts", apiModule("RECOVERED"));
    await fixed;

    const recovered = await fetchText(`${server.base}/api/value`);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body).value).toBe("RECOVERED");
  }, 30000);

  it("adds, deletes, and recreates an API route module without a restart", async () => {
    const added = server.waitForLog(/api route add: src\/api\/fresh\.ts/);
    await writeAt(root, "src/api/fresh.ts", apiModule("FRESH-1"));
    await added;
    expect(JSON.parse((await fetchText(`${server.base}/api/fresh`)).body).value).toBe("FRESH-1");

    const removed = server.waitForLog(/api route unlink: src\/api\/fresh\.ts/);
    await rm(join(root, "src/api/fresh.ts"));
    await removed;
    expect((await fetchText(`${server.base}/api/fresh`)).status).toBe(404);

    const recreated = server.waitForLog(/api route add: src\/api\/fresh\.ts/);
    await writeAt(root, "src/api/fresh.ts", apiModule("FRESH-2"));
    await recreated;
    expect(JSON.parse((await fetchText(`${server.base}/api/fresh`)).body).value).toBe("FRESH-2");
  }, 30000);

  it("reloads a src= server script entry module when the entry file itself changes", async () => {
    const before = await fetchText(`${server.base}/`);
    expect(before.body).toContain('data-testid="src-value">HELPER-OLD<');

    const changed = server.waitForLog(/module invalidated: src\/lib\/src-script\.ts/);
    await writeAt(
      root,
      "src/lib/src-script.ts",
      `export default () => '<span data-testid="src-value">ENTRY-EDITED</span>';\n`,
    );
    await changed;

    const after = await fetchText(`${server.base}/`);
    expect(after.body).toContain('data-testid="src-value">ENTRY-EDITED<');
  }, 30000);

  /**
   * Transitive helper imports (prompt 138). Node resolves `./helper.ts` from
   * the entry module's own URL, and a generation query on the entry alone
   * would not reach it. The dev-only module graph (`module-graph.ts`) records
   * child -> parent edges through a `node:module` resolve hook and advances the
   * entry's generation when the helper changes, so the next request must serve
   * the new helper value with the entry file untouched.
   */
  it("reloads a helper imported by a src= server script when only the helper changes", async () => {
    // Re-point the entry at the helper so this test does not depend on order.
    const entryChanged = server.waitForLog(/module invalidated: src\/lib\/src-script\.ts/);
    await writeAt(root, "src/lib/src-script.ts", srcScriptModule());
    await entryChanged;
    const before = await fetchText(`${server.base}/`);
    expect(before.body).toContain('data-testid="src-value">HELPER-OLD<');

    // The helper was imported by Node (transitively) and recorded by the
    // module graph hook; the watcher's invalidate must advance it and log it.
    const helperChanged = server.waitForLog(/module invalidated: src\/lib\/helper\.ts/);
    await writeAt(root, "src/lib/helper.ts", helperModule("HELPER-NEW"));
    const logged = await helperChanged;
    // The log names the entry the graph advanced transitively.
    expect(logged).toMatch(/module invalidated: src\/lib\/helper\.ts \(reloads src\/lib\/src-script\.ts\)/);

    const after = await fetchText(`${server.base}/`);
    expect(after.body).toContain('data-testid="src-value">HELPER-NEW<');
    expect(server.logs()).not.toMatch(/reloads .*bascik-gen/);
  }, 30000);

  it("reloads a helper two levels deep (entry -> helper -> util) when only the util changes", async () => {
    // Entry -> helper -> util: only the leaf is edited.
    const utilModule = (value: string): string => `export const utilValue = () => ${JSON.stringify(value)};\n`;
    const helperViaUtil = `import { utilValue } from "./util.ts";\nexport const helperValue = () => utilValue();\n`;

    await writeAt(root, "src/lib/util.ts", utilModule("UTIL-OLD"));
    const helperChanged = server.waitForLog(/module invalidated: src\/lib\/helper\.ts/);
    await writeAt(root, "src/lib/helper.ts", helperViaUtil);
    await helperChanged;
    const before = await fetchText(`${server.base}/`);
    expect(before.body).toContain('data-testid="src-value">UTIL-OLD<');

    const utilChanged = server.waitForLog(/module invalidated: src\/lib\/util\.ts/);
    await writeAt(root, "src/lib/util.ts", utilModule("UTIL-NEW"));
    const logged = await utilChanged;
    expect(logged).toMatch(/module invalidated: src\/lib\/util\.ts \(reloads src\/lib\/helper\.ts, src\/lib\/src-script\.ts\)/);

    const after = await fetchText(`${server.base}/`);
    expect(after.body).toContain('data-testid="src-value">UTIL-NEW<');
  }, 30000);

  it("reloads literal inline helpers without recompilation and preserves freshness on original-source reversion", async () => {
    await writeAt(root, "src/lib/inline-helper.ts", helperModule("INLINE-OLD"));
    const inlinePage = (marker: string): string =>
      `<!DOCTYPE html><html><head><title>inline</title></head><body>
  <script data-bascik-server>
    import { helperValue } from "@/lib/inline-helper.ts";
    // ${marker}
    export default () => '<span data-testid="inline-value">' + helperValue() + '</span>';
  </script>
</body></html>`;
    const compiled = server.waitForLog(/transpiled: pages\/inline\.html/);
    await writeAt(root, "src/pages/inline.html", inlinePage("v1"));
    await compiled;

    const before = await fetchText(`${server.base}/inline`);
    expect(before.status).toBe(200);
    expect(before.body).toContain('data-testid="inline-value">INLINE-OLD<');

    // The helper is tracked (the hook saw Node resolve it), so the watcher
    // logs an invalidation, but with no recorded importer it reloads nothing.
    const helperChanged = server.waitForLog(/module invalidated: src\/lib\/inline-helper\.ts/);
    await writeAt(root, "src/lib/inline-helper.ts", helperModule("INLINE-NEW"));
    const logged = await helperChanged;
    expect(logged).not.toMatch(/module invalidated: src\/lib\/inline-helper\.ts \(reloads/);

    const helperReloaded = await fetchText(`${server.base}/inline`);
    expect(helperReloaded.body).toContain('data-testid="inline-value">INLINE-NEW<');

    // Editing the page produces a new data: URL; resolving the helper from it
    // now hands back the helper's advanced generation, so the new value shows.
    const recompiled = server.waitForLog(/transpiled: pages\/inline\.html/);
    await writeAt(root, "src/pages/inline.html", inlinePage("v2"));
    await recompiled;
    const after = await fetchText(`${server.base}/inline`);
    expect(after.body).toContain('data-testid="inline-value">INLINE-NEW<');

    const reverted = server.waitForLog(/transpiled: pages\/inline\.html/);
    await writeAt(root, "src/pages/inline.html", inlinePage("v1"));
    await reverted;
    expect((await fetchText(`${server.base}/inline`)).body).toContain('data-testid="inline-value">INLINE-NEW<');
  }, 30000);
});

describe("production server module reuse (real --server)", () => {
  let root: string;
  let child: ChildProcess | undefined;
  let base: string;
  let prodOutput = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-112-prod-"));
    await writeAt(
      root,
      "bascik.config.js",
      `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: false },
  logging: { level: "silent", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
    );
    await mkdir(join(root, "src/components"), { recursive: true });
    await writeAt(root, "src/api/value.ts", apiModule("PROD-OLD"));
    await writeAt(root, "src/pages/index.html", `<!DOCTYPE html><html><head><title>p</title></head><body><p>p</p></body></html>`);

    // Build first so --server has a dist to load.
    await new Promise<void>((res, rej) => {
      const build = spawn(process.execPath, [PKG_ENTRY, "--build"], { cwd: root, stdio: "ignore", env: { ...process.env, BASCIK_SERVER: "0", BASCIK_BUILD: "0" } });
      build.once("exit", (code) => (code === 0 ? res() : rej(new Error(`build exited ${code}`))));
    });

    const port = nextPort();
    base = `http://localhost:${port}`;
    child = spawn(process.execPath, [PKG_ENTRY, "--server"], {
      cwd: root,
      env: { ...process.env, BASCIK_SERVER_PORT: String(port), BASCIK_ENABLE_TLS: "false", BASCIK_BUILD: "0", BASCIK_SERVER: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => { prodOutput += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { prodOutput += d.toString(); });
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        const res = await fetch(`${base}/`);
        if (res.status >= 200) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 60000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      await new Promise<void>((res) => {
        child!.once("exit", () => res());
        child!.kill("SIGTERM");
      });
    }
    await rm(root, { recursive: true, force: true }).catch(() => { });
  });

  it("keeps serving the loaded module after the source file is edited on disk", async () => {
    const before = await fetchText(`${base}/api/value`);
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body).value).toBe("PROD-OLD");

    await writeAt(root, "src/api/value.ts", apiModule("PROD-NEW"));
    // Production has no watcher and never re-imports: the very next request
    // must still be answered by the retained module identity.
    const after = await fetchText(`${base}/api/value`);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).value).toBe("PROD-OLD");
    // The dev module graph hook is never installed here: no generation marker
    // may appear in production output or logs.
    expect(prodOutput).not.toContain("bascik-gen");
    expect(prodOutput).not.toContain("module invalidated");
  }, 30000);
});
