/**
 * Adding or deleting many pages at once on a large site.
 *
 * Each page added after boot fires one watcher event, and each such event
 * rebuilds every page. On a 2,000-page site, 300 pages written at once
 * started about 300 overlapping full rebuilds: the dev server ran out of file
 * handles (EMFILE on pages it was rereading), left new pages unserved and
 * deleted pages served, and then died of heap exhaustion. Rebuilds are now
 * coalesced: one runs, and the events that arrive meanwhile share one more.
 *
 * A REAL `bascik` dev server child (real config, chokidar and HTTP) serves a
 * fixture of SITE_PAGES pages, and the test writes, then deletes, a burst of
 * pages. It counts the full rebuilds from the "Starting transpiling..." log
 * line, and checks every added page is served and every deleted one is gone.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

const SITE_PAGES = 400;
const ADDED = 120;
const FOLDERS = 6;
const REBUILD_LINE = /Starting transpiling\.\.\./g;

let portCounter = 9400 + (process.pid % 150);

interface DevServer {
  base: string;
  child: ChildProcess;
  logs(): string;
  close(): Promise<void>;
}

const startDevServer = async (root: string): Promise<DevServer> => {
  const port = portCounter++;
  const child = spawn(process.execPath, [PKG_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "0",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const deadline = Date.now() + 60000;
  while (!/Server running at/.test(output)) {
    if (child.exitCode !== null)
      throw new Error(`dev server exited during boot:\n${output}`);
    if (Date.now() > deadline)
      throw new Error(`dev server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base: `http://localhost:${port}`,
    child,
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

const page = (title: string): string =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>
  <site-card data-testid="card">${title}</site-card>
</body></html>`;

const bulkPath = (i: number): string => `bulk/sub${i % FOLDERS}/p${i}`;

const status = async (url: string): Promise<number> => {
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  await res.arrayBuffer();
  return res.status;
};

/** Poll until `check` passes or the time runs out; return the last result. */
const until = async <T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    value = await read();
  }
  return value;
};

const rebuildCount = (server: DevServer, from: number): number =>
  server.logs().slice(from).match(REBUILD_LINE)?.length ?? 0;

/** Wait until no rebuild has started for `quietMs`. */
const waitForQuiet = async (
  server: DevServer,
  quietMs: number,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let length = server.logs().length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const now = server.logs().length;
    if (now !== length) {
      length = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
};

describe("dev server: many pages added or deleted at once", () => {
  let root: string;
  let server: DevServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-bulk-pages-"));
    await writeFile(
      join(root, "bascik.config.js"),
      `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: false },
  logging: { level: "info", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
    );
    await mkdir(join(root, "src/components"), { recursive: true });
    await writeFile(
      join(root, "src/components/site-card.html"),
      `<template><article class="card"><slot></slot></article></template>
<style>.card { padding: 1rem; }</style>`,
    );
    await mkdir(join(root, "src/pages/many"), { recursive: true });
    await writeFile(join(root, "src/pages/index.html"), page("home"));
    await Promise.all(
      Array.from({ length: SITE_PAGES }, (_, i) =>
        writeFile(join(root, `src/pages/many/p${i}.html`), page(`p${i}`)),
      ),
    );
    for (let f = 0; f < FOLDERS; f++)
      await mkdir(join(root, `src/pages/bulk/sub${f}`), { recursive: true });
    server = await startDevServer(root);
  }, 120000);

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("serves every page added in one burst after at most a few full rebuilds", async () => {
    const from = server.logs().length;
    await Promise.all(
      Array.from({ length: ADDED }, (_, i) =>
        writeFile(join(root, `src/pages/${bulkPath(i)}.html`), page(`b${i}`)),
      ),
    );
    const missing = async (): Promise<string[]> => {
      const statuses = await Promise.all(
        Array.from({ length: ADDED }, (_, i) =>
          status(`${server.base}/${bulkPath(i)}`).then((s) =>
            s === 200 ? null : bulkPath(i),
          ),
        ),
      );
      return statuses.filter((p): p is string => p !== null);
    };
    expect(await until(missing, (m) => m.length === 0, 60000)).toEqual([]);
    await waitForQuiet(server, 1500, 30000);

    const logs = server.logs().slice(from);
    expect(server.child.exitCode).toBeNull();
    expect(logs).not.toMatch(/EMFILE|heap out of memory/);
    // One rebuild for the first event, one for the rest of the burst. Events
    // that arrive after that second rebuild started can add one more; one
    // rebuild per added page (120) is the defect.
    expect(rebuildCount(server, from)).toBeGreaterThanOrEqual(1);
    expect(rebuildCount(server, from)).toBeLessThanOrEqual(4);
  }, 120000);

  it("stops serving every page deleted in one burst after at most a few full rebuilds", async () => {
    const from = server.logs().length;
    const deleted = Array.from({ length: ADDED / 2 }, (_, i) => bulkPath(i));
    await Promise.all(
      deleted.map((p) => rm(join(root, `src/pages/${p}.html`))),
    );
    const stillServed = async (): Promise<string[]> => {
      const statuses = await Promise.all(
        deleted.map((p) =>
          status(`${server.base}/${p}`).then((s) => (s === 404 ? null : p)),
        ),
      );
      return statuses.filter((p): p is string => p !== null);
    };
    expect(await until(stillServed, (s) => s.length === 0, 60000)).toEqual([]);
    await waitForQuiet(server, 1500, 30000);

    // The pages that were not deleted are still served.
    for (let i = ADDED / 2; i < ADDED; i += 7)
      expect(await status(`${server.base}/${bulkPath(i)}`)).toBe(200);
    expect(await status(`${server.base}/many/p1`)).toBe(200);

    expect(server.child.exitCode).toBeNull();
    expect(server.logs().slice(from)).not.toMatch(/EMFILE|heap out of memory/);
    expect(rebuildCount(server, from)).toBeLessThanOrEqual(4);
  }, 120000);
});
