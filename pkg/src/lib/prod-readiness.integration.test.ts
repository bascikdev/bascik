import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

// ─── Controllable config (module-frozen at import, so a plain stand-in) ────
vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => false),
  BascikConfig: {
    base: "/",
    http: {
      httpCache: true,
      compression: true,
      cacheControl: "public, max-age=3600",
      rateLimit: false,
      trustProxy: false,
      hostname: "127.0.0.1",
      tls: { enabled: false },
      maxBodySize: 1048576,
      apiTimeout: 10000,
    },
    scripts: { timeout: 30000, onServerScriptError: "error" },
    logging: { level: "silent", requests: false },
    isProdServer: true,
    directory: { pages: "src/pages", components: ["src/components"], api: "src/api", out: "" },
    minify: { identifiers: false },
  },
}));

import { startProdServer } from "./server-prod.ts";
import { mem } from "./mem.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { setServerHealthState, getServerHealthState } from "./server-lifecycle.ts";
import { BascikConfig } from "./config.ts";
import { clearCompressedRepresentationCache } from "./caching.ts";

const setDistDir = (dir: string) => {
  (BascikConfig.directory as { out: string }).out = dir;
};

/**
 * Capture the underlying bound `http.Server` produced by the real shared core
 * so a successful boot can be torn down cleanly in `finally`.
 */
const captureBoundServer = (): (() => http.Server | undefined) => {
  let captured: http.Server | undefined;
  const original = http.createServer.bind(http);
  vi.spyOn(http, "createServer").mockImplementation((...args: unknown[]) => {
    captured = original(...(args as Parameters<typeof http.createServer>));
    return captured;
  });
  return () => captured;
};

const FETCH_OPTS: http.RequestOptions = {
  host: "127.0.0.1",
  method: "GET",
  headers: { accept: "*/*", "accept-encoding": "identity" },
};

const httpFetch = (url: string, path: string): Promise<{ status: number; body: string }> => {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { ...FETCH_OPTS, host: target.hostname, port: target.port, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
};

describe("production sidecar readiness integration", () => {
  let workDir: string;
  let distDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workDir = await mkdtemp(join(tmpdir(), `bascik-prod-readiness-${process.pid}-`));
    distDir = join(workDir, "dist");
    await mkdir(join(distDir, ".bascik"), { recursive: true });
    setDistDir(distDir);
    process.chdir(workDir);
    // Isolate the shared store between tests via the public remove API.
    for (const page of mem.pages()) mem.removePage(page.absolutePagePath);
    serverSidecarRegistry.clear();
    setServerHealthState("booting");
    clearCompressedRepresentationCache();
    process.env.BASCIK_SERVER = "1";
  });

  afterEach(async () => {
    delete process.env.BASCIK_SERVER;
    setServerHealthState("booting");
    serverSidecarRegistry.clear();
    clearCompressedRepresentationCache();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects an unresolved placeholder + malformed sidecar, never advertising readiness", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(distDir, "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
      "utf8",
    );
    await writeFile(join(distDir, ".bascik", "server-scripts.json"), "{corrupt", "utf8");
    const getBound = captureBoundServer();

    await expect(startProdServer()).rejects.toThrow(/Failed to load server scripts sidecar/);

    // A required runtime artifact that cannot be parsed must never reach the
    // ready state; the socket must never bind.
    expect(getServerHealthState()).toBe("booting");
    expect(getBound()).toBeUndefined();
  });

  it("rejects a present sidecar that cannot resolve a required placeholder", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(distDir, "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
      "utf8",
    );
    await writeFile(
      join(distDir, ".bascik", "server-scripts.json"),
      JSON.stringify({ version: "1", schema: 2, scripts: {} }),
      "utf8",
    );
    const getBound = captureBoundServer();

    await expect(startProdServer()).rejects.toThrow(/production startup validation failed/);

    expect(getServerHealthState()).toBe("booting");
    expect(getBound()).toBeUndefined();
  });

  it("rejects a placeholder page when the sidecar is missing, never advertising readiness", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(distDir, "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
      "utf8",
    );
    // No dist/.bascik/server-scripts.json at all.
    const getBound = captureBoundServer();

    await expect(startProdServer()).rejects.toThrow(/production startup validation failed/);
    await expect(startProdServer()).rejects.toThrow(/sidecar .*is missing/);

    // The page would 500 on every request; it must never be advertised ready.
    expect(getServerHealthState()).toBe("booting");
    expect(getBound()).toBeUndefined();
  });

  it("serves a genuinely static release with no sidecar and reports ready 200", async () => {
    await writeFile(join(distDir, "index.html"), "<h1>static</h1>", "utf8");
    const getBound = captureBoundServer();
    let url: string | undefined;

    try {
      url = await startProdServer();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(getServerHealthState()).toBe("ready");

      // Readiness advertises ok; the page is servable, not a 500.
      const ready = await httpFetch(url, "/_health/ready");
      expect(ready.status).toBe(200);
      expect(ready.body).toContain('"ready":true');
      const page = await httpFetch(url, "/");
      expect(page.status).toBe(200);
      expect(page.body).toContain("<h1>static</h1>");
    } finally {
      const bound = getBound();
      if (bound) await new Promise<void>((r) => bound.close(() => r()));
    }
  });
});