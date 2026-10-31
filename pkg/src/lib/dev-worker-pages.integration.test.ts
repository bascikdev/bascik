/**
 * Pages compiled by page workers in dev (`pipeline.workers: true`), across
 * the real thread boundary: a REAL `bascik` dev server child (real config,
 * chokidar, worker_threads and HTTP) on a temporary fixture.
 *
 * - F053: a page whose build script imports a helper that does not exist yet
 *   fails inside a worker; creating the helper must rebuild it. The worker
 *   recorded the missing helper only in its own store, so nothing rebuilt.
 * - F054: a component build script that throws inside a worker must reach
 *   the dev overlay with the component's file and line, not the page's.
 * - F055: a full rebuild runs in a fresh pool whose workers count versions
 *   from 1 again, so a rebuilt page must still get a version it never had.
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

let portCounter = 9700 + (process.pid % 90);

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

const get = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  return { status: res.status, body: await res.text() };
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

const versionOf = (html: string): string | undefined =>
  /data-bascik-live-reload-version="?(\d+)/.exec(html)?.[1];

/** An open live-reload stream that collects every build-error payload. */
const openLiveReload = async (base: string) => {
  const controller = new AbortController();
  const res = await fetch(`${base}/bascik-live-reload`, {
    headers: { accept: "text/event-stream", referer: `${base}/about` },
    signal: controller.signal,
  });
  const errors: Array<Record<string, unknown>> = [];
  let buffered = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf("\n\n")) !== -1) {
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (!event.startsWith("event: build-error")) continue;
          const data = /^data: (.*)$/m.exec(event)?.[1];
          if (data) errors.push(JSON.parse(data));
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })();
  return { errors, close: () => controller.abort() };
};

const page = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <title>${title}</title>
  </head>
  <body>
    ${body}
  </body>
</html>
`;

describe("dev server with page workers: failures and versions cross the thread boundary", () => {
  let root: string;
  let server: DevServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-dev-worker-pages-"));
    await writeFile(
      join(root, "bascik.config.js"),
      `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: true },
  logging: { level: "info", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
    );
    await mkdir(join(root, "src/components"), { recursive: true });
    await writeFile(
      join(root, "src/components/broken-card.html"),
      `<article class="card" data-testid="broken-card">
  <script data-bascik-build>
    export default () => {
      throw new Error("milk frother card failed");
    };
  </script>
</article>
`,
    );
    await mkdir(join(root, "src/pages"), { recursive: true });
    await writeFile(
      join(root, "src/pages/index.html"),
      page("Home", "<p>Home</p>"),
    );
    await writeFile(
      join(root, "src/pages/about.html"),
      page("About", "<p>About the milk frother</p>"),
    );
    await writeFile(
      join(root, "src/pages/broken.html"),
      page("Broken", "<broken-card></broken-card>"),
    );
    await writeFile(
      join(root, "src/pages/prices.html"),
      page(
        "Prices",
        `<script data-bascik-build>
      import { price } from "./lib/prices.ts";
      export default () => \`<p data-testid="price">\${price}</p>\`;
    </script>`,
      ),
    );
    server = await startDevServer(root);
  }, 120000);

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("rebuilds a page that failed in a worker once its missing helper is created (F053)", async () => {
    expect((await get(`${server.base}/prices`)).body).not.toContain(
      'data-testid="price"',
    );
    await mkdir(join(root, "src/pages/lib"), { recursive: true });
    await writeFile(
      join(root, "src/pages/lib/prices.ts"),
      "export const price: number = 129;\n",
    );
    const after = await until(
      () => get(`${server.base}/prices`),
      (r) => r.status === 200 && r.body.includes('data-testid="price"'),
      30000,
    );
    expect(after.body, server.logs()).toContain(
      '<p data-testid="price">129</p>',
    );
  }, 60000);

  it("names the component build script in the overlay and gives rebuilt pages new versions (F054, F055)", async () => {
    const before = await get(`${server.base}/about`);
    const bootVersion = versionOf(before.body);
    expect(bootVersion).toBeDefined();

    const live = await openLiveReload(server.base);
    try {
      // Adding a page rebuilds every page in a fresh worker pool.
      await writeFile(
        join(root, "src/pages/added.html"),
        page("Added", "<p>Added</p>"),
      );
      await until(
        async () => live.errors,
        (errors) =>
          errors.some((e) => String(e.file).includes("broken-card.html")),
        30000,
      );
      const located = live.errors.find((e) =>
        String(e.file).includes("broken-card.html"),
      );
      expect(located, JSON.stringify(live.errors)).toMatchObject({
        file: expect.stringMatching(/components\/broken-card\.html$/),
        line: expect.any(Number),
        column: expect.any(Number),
      });
      expect(String(located?.message)).not.toContain("worker transpile");

      const added = await until(
        () => get(`${server.base}/added`),
        (r) => r.status === 200,
        30000,
      );
      expect(added.status).toBe(200);
      const rebuilt = await until(
        () => get(`${server.base}/about`),
        (r) => versionOf(r.body) !== bootVersion,
        30000,
      );
      expect(versionOf(rebuilt.body)).not.toBe(bootVersion);
    } finally {
      live.close();
    }
  }, 60000);
});
