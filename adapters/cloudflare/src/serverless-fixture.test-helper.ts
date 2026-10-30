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
  /**
   * Add the attacker-lens components and the `/components-security` page
   * (prompt 157 security audit): a visitor's `?q=` escaped into props, slots
   * and inherited attributes of returned component tags.
   */
  security?: boolean;
  /**
   * Add the @bascik/bascik/html pages (Collin 2026-10-28): a server script,
   * a stream script and a component's own server script that import the
   * helpers, a json() page, and an onclick misuse page.
   */
  html?: boolean;
  /**
   * Set the opt-in `contentSecurityPolicy` option (default-src 'self',
   * script-src 'self' https://cdn.example.com) so both hosts send the header.
   * An object sets those directives instead.
   */
  csp?: boolean | Record<string, readonly string[]>;
  /** `minify.identifiers`; off by default so scoped names stay readable. */
  identifiers?: boolean;
  /** `minify.html`; off by default. */
  minifyHtml?: boolean;
  /** `scripts.onServerScriptError`; "error" by default. */
  onServerScriptError?: "error" | "warn" | "ignore";
  /** `scripts.timeout` in ms; 5000 by default. */
  scriptTimeout?: number;
  /**
   * The `security` config object (Collin 2026-10-29), written as is. Named
   * apart from `security`, which adds the attacker-lens pages.
   */
  securityConfig?: Record<string, unknown>;
  /** `scripts.stripAnsi`; unset by default (the config default, on). */
  stripAnsi?: boolean;
  /** `scripts.renderLimits`; unset by default (today's limits). */
  renderLimits?: Record<string, number>;
  /**
   * The source of a `post` exec script (`scripts/post-edit.mjs`), run in the
   * project root after the pages are written: a deploy step that edits dist/.
   */
  postExec?: string;
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
  scripts: { onServerScriptError: ${JSON.stringify(options.onServerScriptError ?? "error")}, timeout: ${options.scriptTimeout ?? 5000}${
    options.stripAnsi !== undefined ? `, stripAnsi: ${options.stripAnsi}` : ""
  }${
    options.renderLimits
      ? `, renderLimits: ${JSON.stringify(options.renderLimits)}`
      : ""
  } },${
    options.securityConfig
      ? `
  security: ${JSON.stringify(options.securityConfig)},`
      : ""
  }
  http: { apiTimeout: 2000 },${
    options.postExec
      ? `
  pipeline: { exec: [{ script: "scripts/post-edit.mjs", phase: "post" }] },`
      : ""
  }${
    options.csp
      ? `
  contentSecurityPolicy: {
    directives: ${
      typeof options.csp === "object"
        ? JSON.stringify(options.csp)
        : `{
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.example.com"],
    }`
    },
  },`
      : ""
  }
};`,
  );
  if (options.postExec)
    await write(root, "scripts/post-edit.mjs", options.postExec);
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
  if (typeof options.csp === "object")
    // A static page with an inline script and style, so its _headers rule
    // carries hashes merged into the author's directives.
    await write(
      root,
      "src/pages/csp-inline.html",
      `<!DOCTYPE html><html><head><title>Inline</title><style>h1{color:#222}</style></head><body><h1 data-testid="csp-inline">Inline</h1><script>document.body.dataset.ran = "yes";</script></body></html>`,
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
  // Inline server and stream scripts written in TypeScript, marked as a
  // browser script is: both hosts compile them before running them.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/typed.html",
    `<!DOCTYPE html><html><head><title>Typed</title></head><body>
<p data-testid="typed-static">Typed</p>
<script data-bascik-server type="text/typescript">
import type { Unused } from "@/lib/types.ts";
import { label } from "@/lib/format.ts";
interface Visitor { name: string }
export default function (request: Request): string {
  const visitor: Visitor = { name: request.headers.get("x-display-name") ?? "Guest" };
  return '<p data-testid="typed-server">' + label(visitor.name) + '</p>';
}
</script>
<script data-bascik-stream type="text/typescript">
export default async function (): Promise<string> {
  const parts: string[] = ["typed", "stream"];
  return '<p data-testid="typed-stream">' + parts.join(" ") + '</p>';
}
</script>
</body></html>`,
  );
  await write(
    root,
    "src/lib/types.ts",
    `export interface Unused { never: true }\n`,
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
  if (options.security) await addSecurityPages(root);
  if (options.html) await addHtmlPages(root);
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
  // Components that repeat their default slot, to multiply the slot content
  // a script passes: twice renders over the 4 MiB budget, four times grows
  // past the expansion tripwire, 200 times passes the engine's string limit
  // while the instance is built (a "failed during slot resolution"). Once
  // nests: each level reads its slot again (the scan budget).
  for (const [name, times] of [
    ["once-card", 1],
    ["twice-card", 2],
    ["four-card", 4],
    ["wide-card", 200],
  ] as const) {
    await write(
      root,
      `src/components/${name}/${name}.html`,
      `<div class="rep">${"<i data-bascik-slot></i>".repeat(times)}</div>
<style>.rep { color: rgb(16, 17, 18); }</style>`,
    );
  }
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
  // The same budgets from a stream script, for the stream side of the policy.
  await page(
    "src/pages/components-budget-stream.html",
    "Budget stream",
    `<section data-testid="slot"><script data-bascik-stream>
export default async function (request) {
  const url = new URL(request.url);
  const n = Number(url.searchParams.get("n") ?? 1);
  const tag = url.searchParams.get("kind") === "live" ? "product-card-live" : "product-card";
  let out = "";
  for (let i = 0; i < n; i++) out += "<" + tag + ' data-bascik-prop-name="item ' + i + '"></' + tag + ">";
  return out;
}
</script></section>`,
  );
  // The size budgets and a stage failure, by ?kind=: "rendered" renders
  // over 4 MiB, "grew" passes the tripwire, "refused" is over twice the
  // limit as written, "stage" fails during slot resolution, and "scan"
  // nests 999 usages around 1 MB of slot text, each level read again, which
  // the scan budget refuses (prompt 157 security audit).
  const sizeScript = (directive: string) => `<script data-bascik-${directive}>
export default async function (request) {
  const kind = new URL(request.url).searchParams.get("kind");
  const slotted = (tag, length) => "<" + tag + ">" + "x".repeat(length) + "</" + tag + ">";
  if (kind === "rendered") return slotted("twice-card", 2500000);
  if (kind === "grew") return slotted("four-card", 2500000);
  if (kind === "refused") return "x".repeat(${2 * 4 * 1024 * 1024 + 1}) + "<product-card></product-card>";
  if (kind === "stage") return slotted("wide-card", 3000000);
  if (kind === "scan") return "<once-card>".repeat(999) + "x".repeat(1000000) + "</once-card>".repeat(999);
  return "<product-card></product-card>";
}
</script>`;
  await page("src/pages/components-size.html", "Size", sizeScript("server"));
  await page(
    "src/pages/components-size-stream.html",
    "Size stream",
    `<section data-testid="slot">${sizeScript("stream")}</section>`,
  );
  await page(
    "src/pages/components-chain-stream.html",
    "Chain stream",
    `<section data-testid="slot"><script data-bascik-stream>
export default async function () { return "<chain-card></chain-card>"; }
</script></section>`,
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

/**
 * The attacker lens (prompt 157 security audit). One page echoes the
 * visitor's `?q=` through the escaper the docs' search example uses
 * (`&`, `<` and `"`), or the docs' full escaper with `?esc=full`, into:
 * a prop bound to an `href`, a `srcdoc` and a client `<script>` receiver,
 * an inherited `class` on a root whose class is single-quoted, an
 * inherited `data` on an `<object>` root (a URL only on that tag), `src`,
 * `srcdoc` and handler attributes on an `<iframe>` root (inherited as
 * written), a page's own handler and `javascript:void(0)` href,
 * a value spelling ` class=` or ` style=` inherited before a merged class or
 * style onto a root without one, a plain style and `on`-prefixed names that
 * are no handlers, and the
 * props and slot of the catalog's own cards (one with a nested job).
 */
export const addSecurityPages = async (root: string): Promise<void> => {
  await write(
    root,
    "src/components/sec-link/sec-link.html",
    `<a class="sec-link" data-testid="sec-link" href="/default" data-bascik-attr-href="u">go</a>`,
  );
  await write(
    root,
    "src/components/sec-srcdoc/sec-srcdoc.html",
    `<iframe class="sec-frame" data-testid="sec-srcdoc" data-bascik-attr-srcdoc="u"></iframe>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/sec-script/sec-script.html",
    `<div class="sec-script" data-testid="sec-script"><script data-bascik-prop-v>void 0;</script></div>`,
  );
  await write(
    root,
    "src/components/sec-inherit/sec-inherit.html",
    `<div class='sec-inherit' data-testid='sec-inherit'>inherit</div>`,
  );
  await write(
    root,
    "src/components/sec-embed/sec-embed.html",
    `<object class="sec-embed" data-testid="sec-embed" type="text/html" width="300" height="100"></object>`,
  );
  await write(
    root,
    "src/components/sec-frame/sec-frame.html",
    `<iframe class="sec-inherit-frame" data-testid="sec-frame" title="frame"></iframe>`,
  );
  await write(
    root,
    "src/components/sec-anchor/sec-anchor.html",
    `<a class="sec-anchor" data-testid="sec-anchor">go</a>`,
  );
  await write(
    root,
    "src/components/sec-badge/sec-badge.html",
    `<span data-testid="sec-badge">badge</span>`,
  );
  await write(
    root,
    "src/components/sec-sty/sec-sty.html",
    `<button class="sec-sty" data-testid="sec-sty">go</button>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/components-security.html",
    `<!DOCTYPE html><html><head><title>Security</title></head><body>
<header data-testid="shell">shell</header>
<script data-bascik-server>
const catalogEscape = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const fullEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export default function (request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "ok";
  const e = url.searchParams.get("esc") === "full" ? fullEscape : catalogEscape;
  const only = url.searchParams.get("only");
  const parts = {
    link: '<sec-link data-bascik-prop-u="' + e(q) + '"></sec-link>',
    srcdoc: '<sec-srcdoc data-bascik-prop-u="' + e(q) + '"></sec-srcdoc>',
    script: '<sec-script data-bascik-prop-v="' + e(q) + '"></sec-script>',
    inherit: '<sec-inherit class="' + e(q) + '" title="' + e(q) + '"></sec-inherit>',
    "inherit-merge": '<sec-badge title="' + e(q) + '" class="big"></sec-badge><sec-sty aria-label="' + e(q) + '" style="color:red"></sec-sty>',
    "inherit-plain": '<sec-badge online one="1" style="overscroll-behavior: contain; max-height: 20rem; --caption: \\'Data: ' + e(q) + '\\'"></sec-badge>',
    "inherit-url": '<sec-embed data="' + e(q) + '"></sec-embed><sec-frame src="' + e(q) + '" srcdoc="' + e(q) + '" onload="' + e(q) + '"></sec-frame>',
    "inherit-kept": '<sec-sty onclick="go()"></sec-sty><sec-anchor href="javascript:void(0)"></sec-anchor>',
    card: '<product-card data-bascik-prop-name="' + e(q) + '" data-bascik-prop-price="' + e(q) + '" title="' + e(q) + '">' + e(q) + '</product-card>',
    live: '<product-card-live data-bascik-prop-name="' + e(q) + '" data-bascik-prop-price="' + e(q) + '"><span>' + e(q) + '</span></product-card-live>',
  };
  return only ? parts[only] : Object.values(parts).join("");
}
</script>
<footer data-testid="tail">tail</footer>
</body></html>`,
  );
};

/**
 * Pages whose scripts import @bascik/bascik/html, resolved through the
 * package's export map (the fixture's node_modules/@bascik/bascik is a
 * symlink to pkg, so pkg/dist/html.js must be built) and bundled into the
 * Worker by the adapter's esbuild step.
 */
export const addHtmlPages = async (root: string): Promise<void> => {
  await write(
    root,
    "src/components/safe-card/safe-card.html",
    `<article class="safe-card" data-testid="safe-card">
  <h3 class="safe-card-name" data-bascik-prop-name>Unnamed</h3>
</article>
<style>.safe-card { color: rgb(20, 21, 22); }</style>`,
  );
  // A component whose own server script imports the helpers.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/components/safe-live/safe-live.html",
    `<section class="safe-live" data-testid="safe-live">
<script data-bascik-server>
import { html } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<p data-testid="safe-live-echo">\${q}</p>\`;
}
</script>
</section>
<style>.safe-live { color: rgb(23, 24, 25); }</style>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-search.html",
    `<!DOCTYPE html><html><head><title>Html search</title></head><body>
<header data-testid="shell">shell</header>
<script data-bascik-server>
import { html } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<p data-testid="echo">You searched for \${q}</p>
<safe-card data-bascik-prop-name="\${q}" title="\${q}"></safe-card>
<a data-testid="link" href="\${q}">again</a>
<ul>\${["a<", "b&"].map((n) => html\`<li>\${n}</li>\`)}</ul>
<safe-live></safe-live>\`;
}
</script>
<footer data-testid="tail">tail</footer>
</body></html>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-stream.html",
    `<!DOCTYPE html><html><head><title>Html stream</title></head><body>
<header data-testid="shell">shell</header>
<script data-bascik-stream>
import { html } from "@bascik/bascik/html";
export default async function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<p data-testid="echo">\${q}</p><safe-card data-bascik-prop-name="\${q}"></safe-card>\`;
}
</script>
<footer data-testid="tail">tail</footer>
</body></html>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-json.html",
    `<!DOCTYPE html><html><head><title>Html json</title></head><body>
<script data-bascik-server>
import { html, json } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<script type="application/json" id="data">\${json({ q })}<\\/script>\`;
}
</script>
</body></html>`,
  );
  // Red-team fix pass: U+0130 before </title> and a hole in <noscript>.
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-turkish.html",
    `<!DOCTYPE html><html><head><title>Html turkish</title></head><body>
<script data-bascik-server>
import { html } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<h2>İstanbul</h2><textarea>İ</textarea>
<a data-testid="link" href="\${q}">x</a>\`;
}
</script>
</body></html>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-noscript.html",
    `<!DOCTYPE html><html><head><title>Html noscript</title></head><body>
<script data-bascik-server>
import { html } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<noscript><img src="x" onerror="\${q}"></noscript>\`;
}
</script>
</body></html>`,
  );
  await write(
    root, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    "src/pages/html-misuse.html",
    `<!DOCTYPE html><html><head><title>Html misuse</title></head><body>
<script data-bascik-server>
import { html } from "@bascik/bascik/html";
export default function (request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return html\`<button onclick="\${q}">go</button>\`;
}
</script>
</body></html>`,
  );
};
