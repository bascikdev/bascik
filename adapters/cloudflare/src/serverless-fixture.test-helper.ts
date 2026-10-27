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
 * - an authored 404 and 500 page,
 * - with `components: true`, the catalog demo of the e2e fixture (prompt 157:
 *   `<product-card>` and `<product-card-live>` returned by server and stream
 *   scripts) plus test-only pages for the misuse lens: an unsupported
 *   component, a bound href, a nested job that throws, a self-returning
 *   component (depth), a component script without a default export,
 *   instance and nested-job budgets, nested jobs that return components and
 *   finish in random order, a job printing ANSI escapes, and a slow nested
 *   job that records its abort for the abort and timeout cases.
 *
 * Builds run as a REAL `bascik --build --target ...` child process against an
 * isolated temp project that has its own `node_modules/esbuild` (a symlink to
 * the workspace install) because esbuild is resolved from the project.
 */
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DeployTarget = "cloudflare-pages" | "cloudflare-workers";

export const SERVERLESS_FIXTURE_HEADER = "x-bascik-gate";

const write = async (
  root: string,
  rel: string,
  content: string,
): Promise<void> => {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
};

export interface ServerlessFixtureOptions {
  base?: string;
  /** Add the request-time component pages and components (prompt 157). */
  components?: boolean;
  /** `minify.identifiers`; off by default so scoped names stay readable. */
  identifiers?: boolean;
  /** `minify.html`; off by default. */
  minifyHtml?: boolean;
  /** `scripts.onServerScriptError`; "error" by default. */
  onServerScriptError?: "error" | "warn" | "ignore";
  /** `scripts.timeout` in ms; 5000 by default. */
  scriptTimeout?: number;
}

export const createServerlessFixture = async (
  name: string,
  options: ServerlessFixtureOptions = {},
): Promise<string> => {
  const root = join(
    tmpdir(),
    `bascik-serverless-${name}-${process.pid}-${Date.now()}`,
  );
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });

  const here = dirname(fileURLToPath(import.meta.url));
  const rootDir = resolve(here, "../../..");
  const adapterPkgDir = resolve(here, "..");
  const bascikPkgDir = resolve(rootDir, "pkg");

  await mkdir(join(root, "node_modules/@bascik"), { recursive: true });
  await symlink(
    adapterPkgDir,
    join(root, "node_modules/@bascik/adapter-cloudflare"),
    "dir",
  );
  await symlink(bascikPkgDir, join(root, "node_modules/@bascik/bascik"), "dir");

  await write(
    root,
    "bascik.config.js",
    `export default {
  ${options.base ? `base: ${JSON.stringify(options.base)},` : ""}
  directory: { components: ["src/components"] },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: ${options.identifiers === true}, html: ${options.minifyHtml === true} },
  scripts: { onServerScriptError: ${JSON.stringify(options.onServerScriptError ?? "error")}, timeout: ${options.scriptTimeout ?? 5000} },
  http: { apiTimeout: 2000 },
};`,
  );
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "serverless-fixture",
      type: "module",
      private: true,
    }),
  );

  await write(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Static</title></head><body><h1 data-testid="static-heading">Static home</h1></body></html>`,
  );
  // RFC 8615: a leading .well-known directory is the one public dot-directory.
  await write(
    root,
    "src/pages/.well-known/security.txt",
    "Contact: mailto:security@example.com\n",
  );
  await write(
    root,
    "src/pages/.well-known/.private/secret.txt",
    "well-known private marker\n",
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
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
  await write(
    root,
    "src/lib/wrap.ts",
    `export const wrap = (tag: string, text: string): string => "<" + tag + ">" + text + "</" + tag + ">";`,
  );
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
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
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
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/broken-stream.html",
    `<!DOCTYPE html><html><body><p data-testid="before">before</p>
<script data-bascik-stream>export default async function () { throw new Error("stream job failed on purpose"); }</script>
<p data-testid="after">after</p></body></html>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/broken-server.html",
    `<!DOCTYPE html><html><body><p>never</p>
<script data-bascik-server>export default function () { throw new Error("server job failed on purpose SECRET_DETAIL"); }</script>
</body></html>`,
  );
  await write(
    root,
    "src/pages/404.html",
    `<!DOCTYPE html><html><body><h1 data-testid="not-found">Custom 404</h1></body></html>`,
  );
  await write(
    root,
    "src/pages/500.html",
    `<!DOCTYPE html><html><body><h1 data-testid="server-error">Custom 500</h1></body></html>`,
  );
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
    "src/api/files/[...path].ts",
    `export const GET = async (_req: Request, ctx: { params: Record<string, string | string[]> }) =>
  Response.json({ path: ctx.params.path });`,
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
  if (options.components) await addComponentPages(root);
  return root;
};

/** The e2e fixture the Cloudflare demo is deployed from. */
const E2E_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../e2e/fixture",
);

/** `component_script_<hex(name::ordinal)>`, the staged id of a component's script (server-sidecar.ts). */
export const componentScriptId = (name: string, ordinal = 1): string =>
  `component_script_${Buffer.from(`${name}::${ordinal}`, "utf8").toString("hex")}`;

/**
 * The catalog demo exactly as deployed (copied from the e2e fixture, so the
 * parity test exercises the live demo's bytes), and the test-only components
 * and pages the misuse lens needs (prompt 157).
 */
const addComponentPages = async (root: string): Promise<void> => {
  for (const component of [
    "product-card",
    "product-card-live",
    "demo-favicons",
  ]) {
    await cp(
      join(E2E_FIXTURE, "src/components", component),
      join(root, "src/components", component),
      { recursive: true },
    );
  }
  for (const page of ["catalog.html", "catalog-stream.html"]) {
    await cp(
      join(E2E_FIXTURE, "src/pages", page),
      join(root, "src/pages", page),
    );
  }

  // Unsupported at request time: a prop bound to `id` is value-dependent
  // before scoping, so the tag must reach the client as the author wrote it.
  await write(
    root,
    "src/components/bound-id-card/bound-id-card.html",
    `<div class="bound" data-bascik-attr-id="anchor" data-testid="bound-id-card">bound</div>
<style>.bound { color: rgb(1, 2, 3); }</style>`,
  );
  // A bound href is rewritten for the base inside the rendered instance only.
  await write(
    root,
    "src/components/link-card/link-card.html",
    `<a class="link" data-testid="link-card" data-bascik-attr-href="target">Pricing</a>
<style>.link { color: rgb(4, 5, 6); }</style>`,
  );
  // A nested job that throws: the parent's policy decides what the reader sees.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/boom-card/boom-card.html",
    `<section class="boom" data-testid="boom-card"><p class="boom-title">boom card</p>
<script data-bascik-server>
export default function () { throw new Error("nested job failed on purpose SECRET_DETAIL"); }
</script>
</section>
<style>.boom { color: rgb(7, 8, 9); }</style>`,
  );
  // A component whose script returns itself: the depth budget must stop it.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/chain-card/chain-card.html",
    `<div class="chain" data-testid="chain-card">
<script data-bascik-server>
export default function () { return "<chain-card></chain-card>"; }
</script>
</div>
<style>.chain { color: rgb(10, 11, 12); }</style>`,
  );
  // A component script that forgot its default export.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/nodefault-card/nodefault-card.html",
    `<div class="nodefault" data-testid="nodefault-card">
<script data-bascik-server>
export const render = () => "never called";
</script>
</div>
<style>.nodefault { color: rgb(13, 14, 15); }</style>`,
  );

  const page = (rel: string, title: string, body: string) =>
    write(
      root,
      rel,
      `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<header data-testid="shell">shell</header>
${body}
<footer data-testid="tail">tail</footer>
</body></html>`,
    );

  // Misuse output: a typo'd tag, an escaped tag, a tag inside an attribute
  // value, a guessed staged placeholder, an unsupported component, and a
  // supported one with a bound href. Only the last is rendered.
  await page(
    "src/pages/components-misuse.html",
    "Misuse",
    `<script data-bascik-server>
export default function () {
  return '<product-crad data-testid="typo">typo stays</product-crad>' +
    '<p data-testid="escaped">&lt;product-card&gt; stays text</p>' +
    '<p data-testid="attr" title="<product-card>">attr stays</p>' +
    '<script type="text/bascik-server" data-bascik-server-id="${componentScriptId("product-card-live")}"></' + 'script>' +
    '<bound-id-card data-bascik-prop-anchor="x"></bound-id-card>' +
    '<link-card data-bascik-prop-target="/pricing"></link-card>';
}
</script>`,
  );
  // Budgets: ?n= instances of <product-card>, or of <product-card-live>
  // (one nested job each) with ?kind=live.
  await page(
    "src/pages/components-budget.html",
    "Budget",
    `<script data-bascik-server>
export default function (request) {
  const url = new URL(request.url);
  const n = Number(url.searchParams.get("n") ?? 1);
  const tag = url.searchParams.get("kind") === "live" ? "product-card-live" : "product-card";
  let out = "";
  for (let i = 0; i < n; i++) out += "<" + tag + ' data-bascik-prop-name="item ' + i + '"></' + tag + ">";
  return out;
}
</script>`,
  );
  await page(
    "src/pages/components-chain.html",
    "Chain",
    `<script data-bascik-server>
export default function () { return "<chain-card></chain-card>"; }
</script>`,
  );
  await page(
    "src/pages/components-boom.html",
    "Boom",
    `<script data-bascik-server>
export default function () { return '<boom-card></boom-card><p data-testid="after-boom">after</p>'; }
</script>`,
  );
  await page(
    "src/pages/components-boom-stream.html",
    "Boom stream",
    `<section data-testid="slot"><script data-bascik-stream>
export default async function () { return '<boom-card></boom-card><p data-testid="after-boom">after</p>'; }
</script></section>`,
  );
  await page(
    "src/pages/components-nodefault.html",
    "No default",
    `<script data-bascik-server>
export default function () { return "<nodefault-card></nodefault-card>"; }
</script>`,
  );
  // Nested jobs that return a component and finish in a random order: the
  // ids of what they return must not follow completion order.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/nest-card/nest-card.html",
    `<div class="nest" data-testid="nest-card">
<script data-bascik-server>
export default async function () {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 40));
  return '<product-card data-bascik-prop-name="inner"></product-card>';
}
</script>
</div>
<style>.nest { color: rgb(16, 17, 18); }</style>`,
  );
  await page(
    "src/pages/components-nest.html",
    "Nest",
    `<script data-bascik-server>
export default function () { return "<nest-card></nest-card><nest-card></nest-card><nest-card></nest-card>"; }
</script>`,
  );
  // A component script printing terminal colors: stripped on both hosts.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/ansi-card/ansi-card.html",
    `<div class="ansi" data-testid="ansi-card">
<script data-bascik-server>
export default function () { return '<i class="esc">\\u001b[31mred\\u001b[0m</i>'; }
</script>
</div>
<style>.ansi { color: rgb(19, 20, 21); } .esc { font-style: normal; }</style>`,
  );
  await page(
    "src/pages/components-ansi.html",
    "ANSI",
    `<script data-bascik-server>
export default function () { return '<ansi-card></ansi-card>\\u001b[1mpage\\u001b[22m'; }
</script>`,
  );
  // A nested job that waits ?ms= (forever by default) and records under
  // ?key= whether it started, finished, or saw its signal abort, for the
  // abort and timeout cases; /api/abort-probe reads the record back. One
  // process (Node) or one isolate (workerd) holds both modules.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/slow-card/slow-card.html",
    `<div class="slow" data-testid="slow-card">
<script data-bascik-server>
export default function (request, context, options) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "none";
  const ms = Number(url.searchParams.get("ms") ?? 600000);
  const probe = (globalThis.__bascikAbortProbe ??= {});
  probe[key] = "started";
  const signal = options && options.signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { probe[key] = "finished"; resolve('<p data-testid="slow-done">done</p>'); }, ms);
    // Rejects with the reason, as an aborted fetch() does.
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); probe[key] = "aborted"; reject(signal.reason); }, { once: true });
  });
}
</script>
</div>
<style>.slow { color: rgb(22, 23, 24); }</style>`,
  );
  await page(
    "src/pages/components-slow.html",
    "Slow",
    `<script data-bascik-server>
export default function () { return '<slow-card></slow-card><p data-testid="after-slow">after</p>'; }
</script>`,
  );
  await page(
    "src/pages/components-slow-stream.html",
    "Slow stream",
    `<section data-testid="slot"><script data-bascik-stream>
export default async function () { return '<slow-card></slow-card><p data-testid="after-slow">after</p>'; }
</script></section>`,
  );
  await write(
    root,
    "src/api/abort-probe.ts",
    `export const GET = async (request: Request) => {
  const key = new URL(request.url).searchParams.get("key") ?? "none";
  const probe = (globalThis as { __bascikAbortProbe?: Record<string, string> }).__bascikAbortProbe ?? {};
  return Response.json({ state: probe[key] ?? "unseen" });
};`,
  );
  // A script that resolves synchronously inside its own abort listener: a
  // plain function returning a native promise, so nothing but the
  // deadline-wins rule decides the outcome. Once the deadline fired it is a
  // timeout on both hosts; "yielded-late" must never reach a response.
  const resolvesOnAbort = (value: string) =>
    `export default function (request, context, options) {
  return new Promise((resolve) => {
    options.signal.addEventListener("abort", () => resolve(${JSON.stringify(value)}), { once: true });
  });
}`;
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/yield-card/yield-card.html",
    `<div class="yield" data-testid="yield-card">
<script data-bascik-server>
${resolvesOnAbort('<p data-testid="yielded">yielded-late</p>')}
</script>
</div>
<style>.yield { color: rgb(25, 26, 27); }</style>`,
  );
  await page(
    "src/pages/deadline-yield.html",
    "Deadline yield",
    `<script data-bascik-server>
${resolvesOnAbort("yielded-late")}
</script>`,
  );
  await page(
    "src/pages/deadline-yield-stream.html",
    "Deadline yield stream",
    `<section data-testid="slot"><script data-bascik-stream>
${resolvesOnAbort("yielded-late")}
</script></section>`,
  );
  await page(
    "src/pages/components-yield.html",
    "Component yield",
    `<script data-bascik-server>
export default function () { return '<yield-card></yield-card><p data-testid="after-yield">after</p>'; }
</script>`,
  );
  await page(
    "src/pages/components-yield-stream.html",
    "Component yield stream",
    `<section data-testid="slot"><script data-bascik-stream>
export default async function () { return '<yield-card></yield-card><p data-testid="after-yield">after</p>'; }
</script></section>`,
  );
  await write(
    root,
    "src/api/deadline-yield.ts",
    `export const GET = (request: Request, context: unknown, options: { signal: AbortSignal }) =>
  new Promise<Response>((resolve) => {
    options.signal.addEventListener("abort", () => resolve(new Response("yielded-late")), { once: true });
  });`,
  );
};

/** A component whose server script imports a builtin Workers does not provide. */
export const addUnsupportedImportComponent = async (
  root: string,
): Promise<void> => {
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/forked-card/forked-card.html",
    `<div class="forked">
<script data-bascik-server>
import { execFile } from "node:child_process";
export default function () { return typeof execFile; }
</script>
</div>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/forked.html",
    `<!DOCTYPE html><html><body><script data-bascik-server>
export default function () { return "<forked-card></forked-card>"; }
</script></body></html>`,
  );
};

/** Add an API route that imports a builtin Workers does not provide. */
export const addUnsupportedImportRoute = async (
  root: string,
): Promise<void> => {
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

export const buildServerlessFixture = async (
  root: string,
  target: DeployTarget,
  extraArgs: string[] = [],
) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, "../../../pkg/dist/index.js");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "--build", "--target", target, ...extraArgs],
      {
        cwd: root,
        env: { ...process.env, BASCIK_BUILD: "1" },
      },
    );
    return { stdout, stderr };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
};

export const cleanupServerlessFixture = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};
