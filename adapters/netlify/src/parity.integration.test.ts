/**
 * Parity: the generated Netlify Function versus the Node oracle.
 *
 * One fixture site is built by the REAL `bascik --build --target
 * @bascik/adapter-netlify` in a child process. The same `dist/` is then served
 * by the real `bascik --server` (the oracle), while the function the adapter
 * bundled is imported and called in-process as Netlify calls it:
 * `handler(request, context)`. Every request must produce the same status,
 * body bytes and response headers on both, and every path the function
 * answers must match one of its `config.path` URLPatterns (how Netlify routes
 * requests to it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { FUNCTION_DIR, FUNCTION_FILE, PUBLISH_DIR } from "./paths.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const cli = join(repoRoot, "pkg/dist/index.js");

const write = async (root: string, rel: string, content: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content, "utf8");
};

const page = (title: string, body: string) =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

async function createFixture(): Promise<string> {
  const root = join(
    tmpdir(),
    `bascik-netlify-parity-${process.pid}-${Date.now()}`,
  );
  await mkdir(join(root, "node_modules/@bascik"), { recursive: true });
  await symlink(
    resolve(here, ".."),
    join(root, "node_modules/@bascik/adapter-netlify"),
    "dir",
  );
  await symlink(
    join(repoRoot, "pkg"),
    join(root, "node_modules/@bascik/bascik"),
    "dir",
  );
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "netlify-parity", type: "module" }),
  );

  await write(
    root,
    "src/pages/index.html",
    page("Home", "<h1>Static home</h1>"),
  );
  await write(
    root,
    "src/pages/hello.html",
    page(
      "Hello",
      `<h1>Hello</h1>
<script data-bascik-server type="text/typescript">
  import { html } from "@bascik/bascik/html";
  export default (request: Request) =>
    html\`<p data-testid="greeting">Hello, \${new URL(request.url).searchParams.get("n") ?? "you"}</p>\`;
</script>`,
    ),
  );
  await write(
    root,
    "src/pages/stream.html",
    page(
      "Stream",
      `<h1>Stream</h1>
<script data-bascik-server type="text/typescript">
  export default () => "<p>server first</p>";
</script>
<section>
  <script data-bascik-stream type="text/typescript">
    export default async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "<p>streamed later</p>";
    };
  </script>
</section>`,
    ),
  );
  await write(
    root,
    "src/components/greet-card/greet-card.html",
    `<style>
  .card { border: 1px solid; }
  h2 { color: rebeccapurple; }
</style>
<article class="card" data-testid="greet-card">
  <h2 data-bascik-prop-name>Friend</h2>
</article>
`,
  );
  await write(
    root,
    "src/pages/cards.html",
    page(
      "Cards",
      `<h1>Cards</h1>
<script data-bascik-server type="text/typescript">
  import { html } from "@bascik/bascik/html";
  export default (request: Request) => {
    const names = (new URL(request.url).searchParams.get("names") ?? "Ada").split(",");
    return names.map((name) => html\`<greet-card data-bascik-prop-name="\${name}"></greet-card>\`);
  };
</script>`,
    ),
  );
  await write(
    root,
    "src/api/hello.ts",
    `export const GET = () => Response.json({ hello: "world" });
export const POST = async (request: Request) =>
  Response.json({ echo: await request.text() }, { status: 201, headers: { "x-handler": "hello" } });
`,
  );
  await write(
    root,
    "src/api/items/[id].ts",
    `export const GET = (_request: Request, { params }: { params: Record<string, string> }) =>
  Response.json({ id: params.id });
`,
  );
  await write(
    root,
    "src/api/files/[...path].ts",
    `export const GET = (_request: Request, { params }: { params: Record<string, string> }) =>
  Response.json({ path: params.path });
`,
  );
  return root;
}

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });

async function startOracle(
  root: string,
): Promise<{ url: URL; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--server", "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: root,
      env: { ...process.env, BASCIK_LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  const url = new URL(`http://127.0.0.1:${port}/`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`bascik --server exited: ${stderr.join("")}`);
    try {
      if ((await fetch(new URL("/_health/ready", url))).status === 200) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGTERM");
      }),
  };
}

/** Headers both hosts must agree on (transport and timing headers differ by nature). */
const COMPARED_HEADERS = [
  "content-type",
  "cache-control",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "content-security-policy",
  "allow",
  "x-handler",
];

interface Observed {
  status: number;
  body: string;
  headers: Record<string, string | null>;
}

const observe = async (response: Response): Promise<Observed> => ({
  status: response.status,
  body: await response.text(),
  headers: Object.fromEntries(
    COMPARED_HEADERS.map((h) => [h, response.headers.get(h)]),
  ),
});

type NetlifyFunction = {
  default: (
    request: Request,
    context: { waitUntil: (p: Promise<unknown>) => void },
  ) => Promise<Response>;
  config: { path: string[]; preferStatic: boolean };
};

describe("Netlify function parity with bascik --server", () => {
  let root: string;
  let oracle: Awaited<ReturnType<typeof startOracle>>;
  let fn: NetlifyFunction;
  let outDir: string;
  let buildOutput: string;

  beforeAll(async () => {
    root = await createFixture();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, "--build", "--target", "@bascik/adapter-netlify"],
      {
        cwd: root,
        env: {
          ...process.env,
          BASCIK_BUILD: "1",
          BASCIK_SITE_URL: "https://example.com",
        },
      },
    );
    buildOutput = stdout + stderr;
    outDir = join(root, "dist/.bascik/netlify");
    if (!existsSync(outDir)) {
      const { readdirSync } = await import("node:fs");
      const [target] = readdirSync(join(root, "dist/.bascik")).filter((d) =>
        existsSync(join(root, "dist/.bascik", d, FUNCTION_DIR)),
      );
      outDir = join(root, "dist/.bascik", target!);
    }
    // The function logs every request; keep test output readable.
    const info = console.info;
    const logLine = console.log;
    console.info = () => {};
    console.log = () => {};
    try {
      fn = (await import(
        pathToFileURL(join(outDir, FUNCTION_DIR, FUNCTION_FILE)).href
      )) as NetlifyFunction;
    } finally {
      console.info = info;
      console.log = logLine;
    }
    oracle = await startOracle(root);
  }, 180_000);

  afterAll(async () => {
    await oracle?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const viaFunction = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const pending: Promise<unknown>[] = [];
    const info = console.info;
    const logLine = console.log;
    console.info = () => {};
    console.log = () => {};
    try {
      const response = await fn.default(
        new Request(new URL(path, "https://example.com"), init),
        {
          waitUntil: (p) => pending.push(p),
        },
      );
      const body = await response.arrayBuffer();
      await Promise.all(pending);
      return new Response(response.status === 101 ? null : body, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      console.info = info;
      console.log = logLine;
    }
  };

  const routed = (path: string): boolean => {
    const pathname = new URL(path, "https://example.com").pathname;
    return fn.config.path.some((pattern) =>
      new URLPattern({ pathname: pattern }).test({ pathname }),
    );
  };

  const both = async (path: string, init?: RequestInit) => ({
    node: await observe(await fetch(new URL(path, oracle.url), init)),
    netlify: await observe(await viaFunction(path, init)),
  });

  it("renders component tags, so the build does not warn about them", () => {
    expect(buildOutput).not.toContain("are not rendered on this host");
    expect(buildOutput).toContain("component manifest");
  });

  it("leaves static pages to the CDN and keeps private files out of publish/", async () => {
    expect(routed("/")).toBe(false);
    expect(routed("/index.html")).toBe(false);
    expect(existsSync(join(outDir, PUBLISH_DIR, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, PUBLISH_DIR, ".bascik"))).toBe(false);
  });

  it("writes the security headers for static files into _headers", async () => {
    const headers = await readFile(
      join(outDir, PUBLISH_DIR, "_headers"),
      "utf8",
    );
    expect(headers).toContain("/*\n");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).not.toMatch(/strict-transport-security/i);
  });

  for (const path of [
    "/hello?n=Ada",
    "/hello.html",
    "/hello/",
    "/stream",
    "/cards?names=Ada,Grace",
    "/cards?names=%3Cb%3E",
  ]) {
    it(`page ${path}: routed, same status, bytes and headers`, async () => {
      expect(routed(path)).toBe(true);
      const { node, netlify } = await both(path);
      expect(netlify).toEqual(node);
      expect(netlify.status).toBe(200);
    });
  }

  it("component output carries the component's scoped markup", async () => {
    const { netlify } = await both("/cards?names=Ada,Grace");
    expect(netlify.body.match(/data-testid="greet-card"/g)).toHaveLength(2);
    expect(netlify.body).toContain("rebeccapurple");
    expect(netlify.body).toContain(">Grace<");
  });

  it("HEAD and 405 on pages match", async () => {
    const head = await both("/hello", { method: "HEAD" });
    expect(head.netlify).toEqual(head.node);
    const post = await both("/hello", { method: "POST" });
    expect(post.netlify).toEqual(post.node);
    expect(post.netlify.status).toBe(405);
  });

  for (const [path, init] of [
    ["/api/hello", undefined],
    ["/api/hello", { method: "POST", body: "ping" }],
    ["/api/hello", { method: "DELETE" }],
    ["/api/items/42", undefined],
    ["/api/files/a/b/c.txt", undefined],
    // An encoded slash stays one segment for [id] (the URL parser would
    // already have collapsed an encoded dot segment before any host saw it).
    ["/api/items/a%2Fb", undefined],
  ] as const) {
    it(`API ${init?.method ?? "GET"} ${path}: routed, same status, bytes and headers`, async () => {
      expect(routed(path)).toBe(true);
      const { node, netlify } = await both(path, init);
      expect(netlify).toEqual(node);
    });
  }
});
