/**
 * The dev server's `Content-Security-Policy` header always matches the page
 * it is sent with (`contentSecurityPolicy` in the config).
 *
 * A compiled page is servable as soon as it is in the memory store, and the
 * live-reload event goes out then. The route's script and style hashes used
 * to be recorded later, by the page's queued disk write, so a request in
 * between got the new page with a header that had no hashes (first build)
 * or the previous build's hashes (after an edit). The browser then blocked
 * every inline script and style on the page, the live-reload client
 * included, so the page stayed broken until a manual reload.
 *
 * This runs a REAL `bascik` dev server child on a temporary fixture and
 * checks every response the way a browser enforces the policy: each inline
 * script in the body must have its hash in the header.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

const PAGE_COUNT = 60;

const pageSource = (index: number, revision: number) => `<!doctype html>
<html lang="en">
  <head>
    <title>Book ${index}</title>
    <style>
      .rating-${index}-${revision} {
        color: rgb(0, 100, 0);
      }
    </style>
  </head>
  <body>
    <main data-testid="book-${index}-revision-${revision}">
      <h1>Book ${index}</h1>
    </main>
    <script>
      document.documentElement.dataset.book = "${index}";
      document.documentElement.dataset.revision = "${revision}";
    </script>
  </body>
</html>
`;

let root: string;
let base: string;
let child: ChildProcess;
let output = "";

const write = async (relPath: string, content: string) => {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
};

interface Response {
  status: number;
  body: string;
  policy: string | null;
}

/**
 * A port nothing is listening on. The requests start before the server
 * prints its address (that line comes after the first compile, and the
 * first compile is what the first test watches), so they go to the port the
 * server was asked to use. A port derived from the process id could be held
 * by a parallel test file or a stray server; the dev server would then move
 * to the next port, and this test would ask the other server.
 */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
};

/** Fails with the reason when the server did not get the port it asked for. */
const assertServerKeptItsPort = (): void => {
  const printed = /Server running at\s+(http:\/\/[^\s/]+)/.exec(output)?.[1];
  if (printed && printed !== base)
    throw new Error(
      `the dev server moved from ${base} to ${printed}, so the requests went to another server:\n${output}`,
    );
};

const get = async (path: string): Promise<Response | undefined> => {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "accept-encoding": "identity" },
    });
    return {
      status: res.status,
      body: await res.text(),
      policy: res.headers.get("content-security-policy"),
    };
  } catch {
    return undefined; // not listening yet
  }
};

const sha256 = (text: string): string =>
  `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

/** The inline scripts and styles of a page that its policy does not allow. */
const blockedInlineBlocks = ({ body, policy }: Response): string[] => {
  const blocked: string[] = [];
  for (const [tag, directive] of [
    ["script", "script-src"],
    ["style", "style-src"],
  ] as const) {
    const sources =
      new RegExp(`${directive} ([^;]*)`).exec(policy ?? "")?.[1] ?? "";
    const blocks = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
    for (const [, attributes = "", text] of body.matchAll(blocks)) {
      if (/\ssrc=/.test(attributes)) continue;
      if (!sources.includes(`'${sha256(text)}'`))
        blocked.push(`<${tag}> ${text.trim().slice(0, 60)}`);
    }
  }
  return blocked;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bascik-dev-csp-"));
  await write(
    "bascik.config.mjs",
    `export default {
  contentSecurityPolicy: { directives: { "default-src": ["'self'"] } },
  generate: { sitemap: false, robots: false },
};
`,
  );
  for (let index = 0; index < PAGE_COUNT; index++)
    await write(`src/pages/book-${index}.html`, pageSource(index, 0));
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, [PKG_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "0",
      BASCIK_PIN_SERVER_URL: "0",
      NO_COLOR: "1",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (output += data.toString()));
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    });
  }
  await rm(root, { recursive: true, force: true });
});

describe("dev server Content-Security-Policy header", () => {
  it("allows every inline script and style of a page from the first response that serves it", async () => {
    // Ask for every page, again and again, from before the server listens
    // until each has been served compiled several times.
    const served = new Array<number>(PAGE_COUNT).fill(0);
    const violations: string[] = [];
    const deadline = Date.now() + 60_000;
    while (served.some((count) => count < 3)) {
      if (child.exitCode !== null)
        throw new Error(`dev server exited:\n${output}`);
      assertServerKeptItsPort();
      if (Date.now() > deadline)
        throw new Error(`pages were not served in time:\n${output}`);
      await Promise.all(
        served.map(async (count, index) => {
          if (count >= 3) return;
          const response = await get(`/book-${index}`);
          // The boot page stands in until the page is compiled.
          if (!response?.body.includes(`book-${index}-revision-0`)) return;
          served[index]++;
          expect(response.policy).toContain("default-src 'self'");
          for (const block of blockedInlineBlocks(response))
            violations.push(`/book-${index} (response ${count + 1}): ${block}`);
        }),
      );
    }
    expect(violations).toEqual([]);
  }, 90_000);

  it("allows the edited inline script from the first response that serves the edit", async () => {
    const violations: string[] = [];
    for (let revision = 1; revision <= 8; revision++) {
      // Edit several pages at once so their disk writes queue up.
      const edited = [0, 1, 2, 3, 4, 5].map(
        (n) => (n * 7 + revision) % PAGE_COUNT,
      );
      await Promise.all(
        edited.map((index) =>
          write(`src/pages/book-${index}.html`, pageSource(index, revision)),
        ),
      );
      const pending = new Set(edited);
      const deadline = Date.now() + 30_000;
      while (pending.size > 0) {
        if (Date.now() > deadline)
          throw new Error(`edit ${revision} was not served:\n${output}`);
        await Promise.all(
          [...pending].map(async (index) => {
            const response = await get(`/book-${index}`);
            if (!response?.body.includes(`book-${index}-revision-${revision}`))
              return;
            pending.delete(index);
            for (const block of blockedInlineBlocks(response))
              violations.push(`/book-${index} revision ${revision}: ${block}`);
          }),
        );
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);
});
