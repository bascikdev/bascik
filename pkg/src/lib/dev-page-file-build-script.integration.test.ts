/**
 * A component build script that reads the page through `BASCIK_PAGE_FILE`
 * must follow every edit to that page in the dev server, with page workers
 * on and off. A REAL `bascik` dev server child (real config, chokidar,
 * worker_threads and HTTP) on a temporary fixture.
 *
 * The script's cache key folds the page's content in through the
 * build-script content memo. The page watcher did not drop that memo on a
 * page edit, so the key kept the old content: the page served its new
 * `<title>` next to the component's output from before the edit (with
 * workers, from two edits earlier, after the first edit had refreshed).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

// Below the ephemeral port range; one port per server this file starts.
let portCounter = 24340 + (process.pid % 20);

interface DevServer {
  base: string;
  logs(): string;
  close(): Promise<void>;
}

const startDevServer = async (root: string): Promise<DevServer> => {
  const port = portCounter++;
  const child: ChildProcess = spawn(process.execPath, [PKG_ENTRY], {
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
  const close = () =>
    new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res();
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    });
  const deadline = Date.now() + 60000;
  while (!/Server running at/.test(output)) {
    if (child.exitCode !== null) {
      throw new Error(`dev server exited during boot:\n${output}`);
    }
    if (Date.now() > deadline) {
      await close();
      throw new Error(`dev server did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { base: `http://localhost:${port}`, logs: () => output, close };
};

const getBody = async (url: string): Promise<string> => {
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  return res.text();
};

/** Poll until `check` passes or the time runs out; return the last body. */
const until = async (
  url: string,
  check: (body: string) => boolean,
  timeoutMs = 15000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let body = await getBody(url);
  while (!check(body) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    body = await getBody(url);
  }
  return body;
};

const page = (title: string): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <title>${title}</title>
  </head>
  <body>
    <page-title></page-title>
  </body>
</html>
`;

const PAGE_TITLE_COMPONENT = `<p class="page-title" data-testid="page-title">
  <script data-bascik-build>
    import { readFile } from "node:fs/promises";
    export default async () => {
      const page = await readFile(process.env.BASCIK_PAGE_FILE, "utf8");
      return \`Title: \${page.match(/<title>([^<]*)/)?.[1]}\`;
    };
  </script>
</p>
`;

const writeFixture = async (root: string, workers: boolean): Promise<void> => {
  await writeFile(
    join(root, "bascik.config.js"),
    `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: ${workers} },
  logging: { level: "info", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
  );
  await mkdir(join(root, "src/components/page-title"), { recursive: true });
  await writeFile(
    join(root, "src/components/page-title/page-title.html"),
    PAGE_TITLE_COMPONENT,
  );
  await mkdir(join(root, "src/pages"), { recursive: true });
  // Two pages, so the worker pool is started (and so has a memo) with more
  // than one worker.
  await writeFile(join(root, "src/pages/index.html"), page("Home"));
  await writeFile(
    join(root, "src/pages/release-1.0.html"),
    page("Release 1.0"),
  );
};

/** The title the component rendered, and the page's own `<title>`. */
const titles = (body: string) => ({
  page: /<title>([^<]*)<\/title>/.exec(body)?.[1],
  component: /Title: ([^<\n]*)/.exec(body)?.[1]?.trim(),
});

for (const workers of [false, true]) {
  describe(`dev server, pipeline.workers ${workers}: a component that reads BASCIK_PAGE_FILE follows page edits`, () => {
    let root: string;
    let server: DevServer | undefined;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "bascik-dev-page-file-"));
      await writeFixture(root, workers);
      server = await startDevServer(root);
    }, 120000);

    afterAll(async () => {
      await server?.close();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    });

    it("renders the new title after each of several page edits", async () => {
      const url = `${server!.base}/release-1.0`;
      const pagePath = join(root, "src/pages/release-1.0.html");
      expect(titles(await getBody(url))).toEqual({
        page: "Release 1.0",
        component: "Release 1.0",
      });

      for (const title of ["Release 1.0b", "Release 1.0c", "Release 1.0d"]) {
        await writeFile(pagePath, page(title));
        const body = await until(url, (b) => titles(b).page === title);
        // The page's own <title> is current; give the component the same
        // time to follow before reading it, so a slow rebuild is not stale.
        const settled = await until(
          url,
          (b) => titles(b).component === title,
          5000,
        );
        expect(titles(body).page, server!.logs()).toBe(title);
        expect(titles(settled), server!.logs()).toEqual({
          page: title,
          component: title,
        });
      }
    }, 90000);

    // An editor or `git checkout` can replace the page by deleting and
    // creating it, which reaches the watcher as unlink then add.
    it("renders the new title when the page is deleted and created again", async () => {
      const url = `${server!.base}/release-1.0`;
      const pagePath = join(root, "src/pages/release-1.0.html");
      await unlink(pagePath);
      await until(url, (b) => titles(b).page !== "Release 1.0d");
      await writeFile(pagePath, page("Release 1.0e"));
      const body = await until(
        url,
        (b) => titles(b).component === "Release 1.0e",
      );
      expect(titles(body), server!.logs()).toEqual({
        page: "Release 1.0e",
        component: "Release 1.0e",
      });
    }, 90000);
  });
}
