/**
 * While the dev server's first compile runs, a page that is not in memory yet
 * gets the boot page, which reloads into the page once it lands. A page whose
 * URL has a dot (`src/pages/release-1.0.html` at `/release-1.0`, served since
 * the dotted-path fix) answered a plain 404 instead: its URL looked like a
 * missing file. This runs a real dev server whose pages take a few seconds to
 * compile, and asks for them before they have.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);
/**
 * The first port in 24661-24699 nothing listens on. The requests start before
 * the server prints its address (that line comes after the first compile,
 * which is what this test watches), so they go to the port the server was
 * asked to use. If that port were taken, the dev server would move to the
 * next one and this test would ask the other server.
 */
const freePort = async (): Promise<number> => {
  for (let port = 24661; port < 24700; port++) {
    const probe = createServer();
    const free = await new Promise<boolean>((done) => {
      probe.once("error", () => done(false));
      probe.listen(port, () => done(true));
    });
    if (free) {
      await new Promise<void>((done) => probe.close(() => done()));
      return port;
    }
  }
  throw new Error("no free port in 24661-24699");
};
const BOOT_MARKER = "/bascik-live-reload?boot=1";

/** A page whose build script holds the first compile for `delayMs`. */
const slowPage = (title: string, delayMs: number): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <script data-bascik-build>
      export default async () => {
        await new Promise((done) => setTimeout(done, ${delayMs}));
        return "<p>${title} ready</p>";
      };
    </script>
  </body>
</html>
`;

let root = "";
let child: ChildProcess | undefined;
let output = "";
let port = 0;
let base = "";

const fetchPage = async (path: string) => {
  const response = await fetch(`${base}${path}`, {
    headers: { "accept-encoding": "identity" },
  });
  return { status: response.status, body: await response.text() };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bascik-dev-boot-dotted-"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "bascik.config.js"),
    "export default { generate: { sitemap: false, robots: false } };\n",
  );
  await mkdir(join(root, "src/pages/v1.2"), { recursive: true });
  await writeFile(join(root, "src/pages/index.html"), slowPage("Home", 6000));
  await writeFile(
    join(root, "src/pages/release-1.0.html"),
    slowPage("Release", 6000),
  );
  await writeFile(
    join(root, "src/pages/v1.2/index.html"),
    slowPage("Version", 6000),
  );
  port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, [PKG_ENTRY], {
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
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  // The port opens before the first compile ends ("Server running at" is
  // printed after it), so wait for the socket, not the message.
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`dev server exited during boot:\n${output}`);
    if (Date.now() > deadline)
      throw new Error(`dev server did not start:\n${output}`);
    try {
      await fetch(`${base}/bascik-live-reload`, { method: "HEAD" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (/Server running at/.test(output))
    throw new Error(`the first compile ended before the test ran:\n${output}`);
}, 90000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) =>
      child!.once("exit", () => done()),
    );
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child!.exitCode === null) child!.kill("SIGKILL");
    }, 3000).unref();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
});

describe("dev boot page for a page whose URL has a dot", () => {
  it("serves the boot page during the first compile, then the page", async () => {
    // All three pages are still compiling (each build script waits 6 s).
    for (const path of ["/", "/release-1.0", "/v1.2", "/v1.2/"]) {
      const during = await fetchPage(path);
      expect({ path, status: during.status }).toEqual({ path, status: 200 });
      expect(during.body).toContain(BOOT_MARKER);
    }
    // A missing asset is still a 404 during boot, not a boot page.
    const asset = await fetchPage("/missing-cover.png");
    expect(asset.status).toBe(404);

    const deadline = Date.now() + 60000;
    let after = await fetchPage("/release-1.0");
    while (after.body.includes(BOOT_MARKER) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      after = await fetchPage("/release-1.0");
    }
    expect(after.status).toBe(200);
    expect(after.body).toContain("Release ready");
    expect((await fetchPage("/v1.2")).body).toContain("Version ready");
    // Once the compile is done, a dotted URL no page has is a 404.
    expect((await fetchPage("/release-9.9")).status).toBe(404);
    // The server kept the port it was given, so every request above went to it.
    expect(output).toMatch(
      new RegExp(`Server running at\\s+http://[^\\s/]+:${port}\\b`),
    );
  }, 90000);
});
