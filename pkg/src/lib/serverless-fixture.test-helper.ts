/**
 * Shared fixture for the serverless build and runtime tests (prompts 133-135).
 *
 * The site exercises every request-time surface the adapter must carry:
 * - a static page (must bypass the worker),
 * - a buffered `data-bascik-server` page with an inline job that reads a
 *   platform binding,
 * - a mixed page with a `src=` server job (relative imports and a transitive
 *   helper) plus an inline job using the `@/` alias, and two
 *   `data-bascik-stream` jobs, one gated,
 * - a page whose stream job fails, and one whose server job fails,
 * - API routes: static, dynamic, multi-method, streaming body, cookies,
 * - an authored 404 and 500 page.
 *
 * Builds run as a REAL `bascik --build --target ...` child process against an
 * isolated temp project that has its own `node_modules/esbuild` (a symlink to
 * the workspace install) because esbuild is resolved from the project.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runRealBuild } from "./build-fixtures.ts";
import type { DeployTarget } from "./cli.ts";

export const SERVERLESS_FIXTURE_HEADER = "x-bascik-gate";

const write = async (root: string, rel: string, content: string): Promise<void> => {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
};

export const createServerlessFixture = async (name: string, options: { base?: string } = {}): Promise<string> => {
  const root = join(tmpdir(), `bascik-serverless-${name}-${process.pid}-${Date.now()}`);
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });

  // esbuild is the project's dependency; link the workspace install (hoisted
  // by Yarn to the repo root) into the fixture's own node_modules.
  const here = dirname(fileURLToPath(import.meta.url));
  const esbuildPkgJson = createRequire(join(here, "package.json")).resolve("esbuild/package.json");
  await symlink(dirname(esbuildPkgJson), join(root, "node_modules/esbuild"), "dir");
  // esbuild's platform binary package is a sibling it resolves at runtime.
  const binaryPkg = `@esbuild/${process.platform}-${process.arch}`;
  try {
    const binaryPkgJson = createRequire(join(here, "package.json")).resolve(`${binaryPkg}/package.json`);
    await mkdir(join(root, "node_modules/@esbuild"), { recursive: true });
    await symlink(dirname(binaryPkgJson), join(root, "node_modules", binaryPkg), "dir");
  } catch {
    // Some installs ship the binary inside esbuild itself; resolution falls back.
  }

  await write(
    root,
    "bascik.config.js",
    `export default {
  ${options.base ? `base: ${JSON.stringify(options.base)},` : ""}
  directory: { components: ["src/components"] },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false, html: false },
  scripts: { onServerScriptError: "error", timeout: 5000 },
  http: { apiTimeout: 2000 },
};`,
  );
  await write(root, "package.json", JSON.stringify({ name: "serverless-fixture", type: "module", private: true }));

  await write(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Static</title></head><body><h1 data-testid="static-heading">Static home</h1></body></html>`,
  );
  await write(
    root,
    "src/pages/account.html",
    `<!DOCTYPE html><html><head><title>Account</title></head><body>
<p data-testid="account-static">Account</p>
<script data-bascik-server>
export default function (request, context) {
  const name = request.headers.get("x-display-name") ?? "Guest";
  const kv = context.platform && context.platform.env && context.platform.env.GREETING ? context.platform.env.GREETING : "none";
  return '<p data-testid="account-greeting">Hello ' + name + ' via ' + context.platform.name + ' (' + kv + ') ip=' + context.remoteIp + '</p>';
}
</script>
</body></html>`,
  );
  await write(
    root,
    "src/lib/format.ts",
    `import { wrap } from "./wrap.ts";
export const label = (text: string): string => wrap("label", text);`,
  );
  await write(root, "src/lib/wrap.ts", `export const wrap = (tag: string, text: string): string => "<" + tag + ">" + text + "</" + tag + ">";`);
  await write(
    root,
    "src/pages/scripts/header.ts",
    `import { label } from "../../lib/format.ts";
import { wrap } from "../../lib/wrap.ts";
export default function (request: Request) {
  return '<div data-testid="header-job">' + label("hdr") + wrap("em", new URL(request.url).pathname) + '</div>';
}`,
  );
  await write(
    root,
    "src/pages/dashboard.html",
    `<!DOCTYPE html><html><head><title>Dashboard</title></head><body>
<header data-testid="shell">Shell 日本 🚀</header>
<script data-bascik-server src="./scripts/header.ts"></script>
<script data-bascik-server>
import { label } from "@/lib/format.ts";
export default function () { return '<span data-testid="alias-job">' + label("alias") + '</span>'; }
</script>
<section data-testid="fast-slot"><script data-bascik-stream>
export default async function () { return '<p data-testid="fast-fragment">fast</p>'; }
</script></section>
<section data-testid="slow-slot"><script data-bascik-stream>
export default async function (request, context) {
  if (context.platform && context.platform.env && context.platform.env.GATE) {
    await context.platform.env.GATE.fetch("http://gate/");
  }
  return '<p data-testid="slow-fragment">slow ünï</p>';
}
</script></section>
<footer data-testid="tail">tail</footer>
</body></html>`,
  );
  await write(
    root,
    "src/pages/broken-stream.html",
    `<!DOCTYPE html><html><body><p data-testid="before">before</p>
<script data-bascik-stream>export default async function () { throw new Error("stream job failed on purpose"); }</script>
<p data-testid="after">after</p></body></html>`,
  );
  await write(
    root,
    "src/pages/broken-server.html",
    `<!DOCTYPE html><html><body><p>never</p>
<script data-bascik-server>export default function () { throw new Error("server job failed on purpose SECRET_DETAIL"); }</script>
</body></html>`,
  );
  await write(root, "src/pages/404.html", `<!DOCTYPE html><html><body><h1 data-testid="not-found">Custom 404</h1></body></html>`);
  await write(root, "src/pages/500.html", `<!DOCTYPE html><html><body><h1 data-testid="server-error">Custom 500</h1></body></html>`);
  await write(root, "src/pages/assets/logo.txt", "logo bytes\n");
  await write(root, "src/pages/style.css", "body{color:#111}\n");

  await write(
    root,
    "src/api/health.ts",
    `export const GET = async () => Response.json({ ok: true });`,
  );
  await write(
    root,
    "src/api/users/[id].ts",
    `export const GET = async (_req: Request, ctx: { params: Record<string, string>; remoteIp: string; platform?: { name: string } }) =>
  Response.json({ id: ctx.params.id, platform: ctx.platform?.name ?? "unknown", ip: ctx.remoteIp });
export const DELETE = async () => new Response(null, { status: 204 });`,
  );
  await write(
    root,
    "src/api/echo.ts",
    `export const POST = async (req: Request) => {
  const body = await req.text();
  return new Response(body, { status: 201, headers: [["content-type", "text/plain"], ["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"]] });
};`,
  );
  await write(
    root,
    "src/api/stream.ts",
    `export const GET = async () => {
  const enc = new TextEncoder();
  let n = 0;
  const body = new ReadableStream({
    pull(controller) {
      n++;
      if (n <= 3) controller.enqueue(enc.encode("chunk" + n + "\\n"));
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain" } });
};`,
  );
  await write(
    root,
    "src/api/boom.ts",
    `export const GET = async () => { throw new Error("api SECRET_DETAIL"); };`,
  );
  return root;
};

/** Add an API route that imports a builtin Workers does not provide. */
export const addUnsupportedImportRoute = async (root: string): Promise<void> => {
  await write(
    root,
    "src/lib/run.ts",
    `import { execFile } from "node:child_process";
export const run = () => typeof execFile;`,
  );
  await write(
    root,
    "src/api/run.ts",
    `import { run } from "../lib/run.ts";
export const GET = async () => new Response(run());`,
  );
};

export const buildServerlessFixture = async (root: string, target: DeployTarget, extraArgs: string[] = []) =>
  runRealBuild({ projectRoot: root, args: ["--target", target, ...extraArgs] });

export const cleanupServerlessFixture = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};
