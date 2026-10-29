#!/usr/bin/env node
// Worker response policy: a thin Cloudflare Worker wrapper around the Worker Bascik generates. For every HTML
// response it sends a strict Content-Security-Policy (no unsafe-inline) listing the SHA-256 hashes the build recorded
// for that route in dist/.bascik/csp-hashes.json. It sets X-Robots-Tag: noindex on preview environments, API
// responses, errors, redirects and PDFs, sets Cache-Control per response kind, and turns an empty 404 into a plain
// error page. A 304 Not Modified passes through untouched.
// Dependency-free and import-free, so the one file can be copied into a project; Node.js 22.18+ for the CLI; Web
// APIs only (crypto.subtle, Response) inside the Worker.
//
// Why the build's hashes and not the response's: a server or stream script's output is part of the response. Hashing
// the inline scripts of the finished body would also hash a <script> that a script reflected from the request
// without escaping, and the policy would then allow exactly the injection CSP exists to block. The build's hashes
// cover only what the build wrote, so injected markup gets no hash. They are known before the body, so streamed pages
// (data-bascik-stream) keep streaming and still get their policy.
//
// { hashResponseBodies: true } instead hashes each HTML response's own inline scripts and styles. Use it only on a
// site with no server or stream scripts: it gives no protection against injected markup. A header must be sent
// before the body, so in that mode streamed pages are buffered by default, which gives up their progressive
// delivery; { streamedHtml: "pass" } keeps them streaming without a CSP header.
//
// 1. Turn on the hash manifest in bascik.config.ts (generate: { cspHashes: true }) and build for Cloudflare:
//
//      bascik --build --target cloudflare
//
// 2. Copy this file into your project as scripts/worker-response-policy.mjs, and add worker-wrapper.js:
//
//      // worker-wrapper.js
//      import bascikWorker from "./dist/.bascik/cloudflare/worker.js";
//      import cspHashes from "./dist/.bascik/csp-hashes.json";
//      import { withResponsePolicy } from "./scripts/worker-response-policy.mjs";
//
//      export default withResponsePolicy(bascikWorker, {
//        cspHashes,
//        directives: { "img-src": ["'self'", "data:"] },
//      });
//
//    Pass base: "/docs/" when the site's base is not "/", so a request path finds its route in the manifest.
//
// 3. Point a root wrangler.jsonc at the wrapper. The wrapper sees static pages only when every request runs the
//    Worker first, which gives up the CDN's direct static serving:
//
//      {
//        "name": "my-site",
//        "main": "worker-wrapper.js",
//        "compatibility_date": "2026-08-01",
//        "compatibility_flags": ["nodejs_compat"],
//        "assets": {
//          "directory": "dist/.bascik/cloudflare/public",
//          "binding": "ASSETS",
//          "not_found_handling": "404-page",
//          "run_worker_first": ["/*"]
//        },
//        "vars": { "ENVIRONMENT": "production" }
//      }
//
//    Keep "not_found_handling": "404-page", or a missing page gets an empty 404 instead of your own 404.html.
//    Run and deploy from the project root (npx wrangler dev, npx wrangler deploy). The generated "deploy" script
//    deploys dist/.bascik/cloudflare on its own and would bypass this wrapper.
//
//    Set "ENVIRONMENT" to "preview" (or anything but "production") on preview deployments: every response then
//    carries X-Robots-Tag: noindex.
//
// From the command line, print the policy one built page needs:
//
//      node worker-response-policy.mjs --html dist/index.html

const HELP = `Usage: node worker-response-policy.mjs --html <built page> [--directive "<name> <value>..."]...

Prints a strict Content-Security-Policy for a built HTML file: SHA-256 hashes of its executable inline scripts and
inline styles, with no unsafe-inline. Import the module from a Worker wrapper to apply the build's hashes from
dist/.bascik/csp-hashes.json to every response (see the comment at the top of this file).

Options:
  --html <file>         A built page, such as dist/index.html
  --directive <text>    An extra directive, such as "img-src 'self' data:" (repeatable)
  --help                Show this message`;

// Script and style elements are found by a forward scan, not a regular expression: a response body can hold visitor
// input, and a pattern that retries from every "<script" and walks to the end of the body each time is quadratic.
// Every step below moves forward through the body, so the work is linear in its length. Tag names match ASCII
// letters in any case, as in HTML.
const TAB = 9,
  LF = 10,
  FF = 12,
  CR = 13,
  SPACE = 32;
const DQUOTE = 34,
  SQUOTE = 39,
  SLASH = 47,
  EQUALS = 61,
  GT = 62;
const isSpace = (c) =>
  c === SPACE || c === LF || c === TAB || c === FF || c === CR;
/** Whitespace, "/" or ">" ends a tag name for the HTML tokenizer, so "<script-x>" and "</scripts>" are other tags. */
const endsTagName = (c) => isSpace(c) || c === SLASH || c === GT;

/** True when `name` (lowercase ASCII) is spelled at `at`, in any ASCII case. */
function nameAt(html, at, name) {
  for (let k = 0; k < name.length; k++) {
    const c = html.charCodeAt(at + k);
    if ((c >= 65 && c <= 90 ? c + 32 : c) !== name.charCodeAt(k)) return false;
  }
  return true;
}

const BEFORE_NAME = 0,
  NAME = 1,
  AFTER_NAME = 2,
  BEFORE_VALUE = 3,
  UNQUOTED = 4;

/**
 * The index of the ">" that ends a start tag whose attributes begin at `i`, or -1 when the body ends first (the
 * tokenizer then drops the tag). Quotes are read as the HTML tokenizer reads them: they open a value only after
 * "=", so a quoted value may hold ">", while a quote inside a name or an unquoted value is an ordinary character.
 */
function startTagEnd(html, i) {
  let state = BEFORE_NAME;
  for (; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === GT) return i; // in every state; before a value it means the value is missing
    switch (state) {
      case BEFORE_NAME: // also the self-closing and after-quoted-value states, which act the same up to ">"
        if (!isSpace(c) && c !== SLASH) state = NAME; // "=" here starts a name, as in HTML
        break;
      case NAME:
        if (isSpace(c)) state = AFTER_NAME;
        else if (c === SLASH) state = BEFORE_NAME;
        else if (c === EQUALS) state = BEFORE_VALUE;
        break;
      case AFTER_NAME:
        if (c === SLASH) state = BEFORE_NAME;
        else if (c === EQUALS) state = BEFORE_VALUE;
        else if (!isSpace(c)) state = NAME;
        break;
      case BEFORE_VALUE:
        if (c === DQUOTE || c === SQUOTE) {
          i = html.indexOf(c === DQUOTE ? '"' : "'", i + 1);
          if (i < 0) return -1;
          state = BEFORE_NAME;
        } else if (!isSpace(c)) state = UNQUOTED;
        break;
      case UNQUOTED:
        if (isSpace(c)) state = BEFORE_NAME;
        break;
    }
  }
  return -1;
}

/**
 * The first end tag at or after `from`, as [start of "</", its closing ">"], or null when there is none. An end tag
 * is the name, then whitespace, "/" or ">", then anything up to ">". So "</script >" and "</script\t\n bar>" end the
 * element, while "</scripts>" and "</script-x>" are body text.
 */
function endTagFrom(html, from, name) {
  for (
    let k = html.indexOf("</", from);
    k >= 0;
    k = html.indexOf("</", k + 2)
  ) {
    if (!nameAt(html, k + 2, name)) continue;
    const after = k + 2 + name.length;
    const c = html.charCodeAt(after);
    if (c === GT) return [k, after];
    if (isSpace(c) || c === SLASH) {
      const gt = html.indexOf(">", after + 1);
      // No ">" anywhere after: no later end tag can close either.
      return gt < 0 ? null : [k, gt];
    }
  }
  return null;
}

/**
 * Every `name` element (script or style) in `html`, as { attrs, body }: `attrs` is the raw text between the tag
 * name and the start tag's ">", `body` the text up to the first end tag. An element whose start tag or end tag never
 * closes is not returned, and nothing after it is: the browser reads the rest of the body as that tag or that text.
 */
function rawTextElements(html, name) {
  const elements = [];
  let pos = 0;
  for (let lt = html.indexOf("<", pos); lt >= 0; lt = html.indexOf("<", pos)) {
    const attrsStart = lt + 1 + name.length;
    if (
      !nameAt(html, lt + 1, name) ||
      !endsTagName(html.charCodeAt(attrsStart))
    ) {
      pos = lt + 1;
      continue;
    }
    const tagEnd = startTagEnd(html, attrsStart);
    if (tagEnd < 0) break;
    const end = endTagFrom(html, tagEnd + 1, name);
    if (!end) break;
    elements.push({
      attrs: html.slice(attrsStart, tagEnd),
      body: html.slice(tagEnd + 1, end[0]),
    });
    pos = end[1] + 1;
  }
  return elements;
}

// One attribute as the HTML tokenizer reads it: a name, then optionally "=" and a quoted or unquoted value.
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

/**
 * Attributes by lowercase name, the first occurrence winning as in HTML. Matching whole names, not a `\bsrc` test
 * over the raw text, keeps data-src, data-type or a value such as " type=module" from reading as a script's own
 * src or type.
 */
function attributesOf(attrs) {
  const out = new Map();
  for (const m of attrs.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * Bodies of inline scripts that script-src governs: no src, and a type that is absent, a JavaScript MIME type,
 * module, importmap or speculationrules (browsers check the last two against script-src as well). Any other type
 * (JSON, JSON-LD, Bascik server scripts) is data, so CSP needs no hash for it.
 */
export function executableInlineScripts(html) {
  const bodies = [];
  for (const element of rawTextElements(html, "script")) {
    const attrs = attributesOf(element.attrs);
    if (attrs.has("src")) continue;
    const type = (attrs.get("type") ?? "").trim();
    if (
      type === "" ||
      /^(module|importmap|speculationrules)$/i.test(type) ||
      /^(text|application)\/(x-)?(java|ecma)script$/i.test(type)
    )
      bodies.push(element.body);
  }
  return bodies;
}

/** Bodies of every inline <style> element. Style attributes need 'unsafe-hashes' and are not covered. */
export function inlineStyles(html) {
  return rawTextElements(html, "style").map((element) => element.body);
}

/** Base64 SHA-256 of UTF-8 text, as CSP hash sources use it. */
export async function sha256Base64(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A strict policy: default-src, script-src and style-src 'self' plus the hashes, object-src 'none', base-uri 'self',
 * form-action 'self', frame-ancestors 'self'. Extra `directives` are merged in; 'unsafe-inline' is rejected.
 */
export function buildCsp({
  scriptHashes = [],
  styleHashes = [],
  directives = {},
} = {}) {
  const policy = new Map([
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)]],
    ["style-src", ["'self'", ...styleHashes.map((h) => `'sha256-${h}'`)]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
  ]);
  for (const [name, values] of Object.entries(directives)) {
    const list = Array.isArray(values) ? values : String(values).split(/\s+/);
    if (list.some((v) => /unsafe-inline/i.test(v)))
      throw new Error(
        `${name}: 'unsafe-inline' defeats the hashes; list the source or hash instead`,
      );
    policy.set(name, [...(policy.get(name) ?? []), ...list]);
  }
  return [...policy]
    .map(([name, values]) => [name, ...new Set(values)].join(" "))
    .join("; ");
}

/** "noindex" for preview environments and for API, error, redirect and PDF responses; otherwise null. */
export function robotsHeader({ kind, environment }) {
  if (environment && environment !== "production") return "noindex";
  return ["api", "error", "redirect", "pdf"].includes(kind) ? "noindex" : null;
}

const CACHE = {
  html: "public, max-age=0, must-revalidate",
  "hashed-asset": "public, max-age=31536000, immutable",
  api: "no-store",
  error: "no-store",
};

/** Cache-Control for html, hashed-asset, api and error responses. */
export function cacheControlFor(kind) {
  const value = CACHE[kind];
  if (!value)
    throw new Error(
      `cacheControlFor: unknown response kind "${kind}"; use ${Object.keys(CACHE).join(", ")}`,
    );
  return value;
}

/** esbuild's [hash] (8 uppercase letters or digits) or a hex content hash of 10+ characters before the extension. */
const HASHED = /[.-](?:[A-Z0-9]{8}|[a-f0-9]{10,})\.[a-z0-9]+$/;

function kindOf(url, response) {
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 304) return "not-modified";
  if (response.status >= 300 && response.status < 400) return "redirect";
  if (url.pathname.startsWith("/api/")) return "api";
  if (response.status >= 400) return "error";
  if (/^application\/pdf\b/i.test(type)) return "pdf";
  if (/^text\/html\b/i.test(type)) return "html";
  if (HASHED.test(url.pathname) || /[?&]v=[\w-]{6,}/.test(url.search))
    return "hashed-asset";
  return "asset";
}

const NOT_FOUND_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head><body><main><h1>Page not found</h1><p><a href="/">Go to the home page</a></p></main></body></html>';

/**
 * The csp-hashes.json key for a request path, as the build derives it from the page file: the base path, a trailing
 * slash, ".html" and a final "index" removed; "/" for the home page.
 */
export function routeKeyFor(pathname, base = "/") {
  const prefix = base.replace(/\/+$/, "");
  let path = pathname;
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`)))
    path = path.slice(prefix.length) || "/";
  path = path.replace(/\.html$/i, "").replace(/\/+$/, "");
  if (path === "" || path === "/index") return "/";
  if (path.endsWith("/index")) path = path.slice(0, -"/index".length);
  return path || "/";
}

/** Base64 bodies of a manifest's hash sources ("sha256-<b64>"), as buildCsp takes them. */
const hashBodies = (sources) =>
  (Array.isArray(sources) ? sources : []).map((source) =>
    String(source).replace(/^'?sha256-|'$/g, ""),
  );

/**
 * Wraps the Worker that `bascik --build --target cloudflare` writes. Returns a Worker ({ fetch }) that passes
 * request, env and ctx through unchanged and applies the policy to the response. env.ENVIRONMENT names the
 * environment ("production" when unset).
 *
 * Hashes come from `cspHashes`, the parsed dist/.bascik/csp-hashes.json: each HTML response lists the hashes of its
 * route (a 404 those of /404; a route the build never recorded gets none, so its inline code is blocked). Only with
 * `hashResponseBodies: true` are they read from the response body instead, which allows any script a server or
 * stream script injected (see the comment at the top of this file).
 */
export function withResponsePolicy(
  worker,
  {
    cspHashes,
    hashResponseBodies = false,
    base = "/",
    directives = {},
    streamedHtml = "buffer",
  } = {},
) {
  if (typeof worker?.fetch !== "function")
    throw new Error(
      'withResponsePolicy: pass the generated Worker, imported with `import bascikWorker from "./dist/.bascik/cloudflare/worker.js"`',
    );
  if (cspHashes !== undefined && hashResponseBodies)
    throw new Error(
      "withResponsePolicy: pass either cspHashes (the build's hashes) or hashResponseBodies: true, not both",
    );
  if (cspHashes === undefined && hashResponseBodies !== true)
    throw new Error(
      'withResponsePolicy: pass cspHashes, imported with `import cspHashes from "./dist/.bascik/csp-hashes.json"` (set generate: { cspHashes: true }), or hashResponseBodies: true for a site with no server or stream scripts',
    );
  if (
    cspHashes !== undefined &&
    (typeof cspHashes !== "object" ||
      cspHashes === null ||
      Array.isArray(cspHashes))
  )
    throw new Error(
      `withResponsePolicy: cspHashes must be the parsed csp-hashes.json object (import the JSON file), got ${Array.isArray(cspHashes) ? "an array" : JSON.stringify(cspHashes)}`,
    );
  if (streamedHtml !== "buffer" && streamedHtml !== "pass")
    throw new Error(
      `withResponsePolicy: streamedHtml must be "buffer" (hash every page) or "pass" (keep streamed pages streaming, without a CSP header); got ${JSON.stringify(streamedHtml)}`,
    );
  buildCsp({ directives }); // reject a bad directive at deploy time, not on the first request
  const routeHashes = (url, status) => {
    const key = status === 404 ? "/404" : routeKeyFor(url.pathname, base);
    const entry = Object.hasOwn(cspHashes, key) ? cspHashes[key] : undefined;
    return {
      scriptHashes: hashBodies(entry?.scripts),
      styleHashes: hashBodies(entry?.styles),
    };
  };
  return {
    async fetch(request, env, ctx) {
      const response = await worker.fetch(request, env, ctx);
      const url = new URL(request.url);
      const kind = kindOf(url, response);
      const environment = env?.ENVIRONMENT ?? "production";
      if (kind === "not-modified") {
        if (environment === "production") return response;
        const headers = new Headers(response.headers);
        headers.set("x-robots-tag", "noindex");
        return new Response(null, { status: 304, headers });
      }
      // Bascik's Worker marks a streamed page with content-encoding: identity and sends it as a ReadableStream.
      const isStreamed =
        response.headers.get("content-encoding") === "identity" &&
        /^text\/html\b/i.test(response.headers.get("content-type") ?? "");
      let body = response.body;
      let headers = new Headers(response.headers);
      const type = headers.get("content-type") ?? "";
      if (response.status === 404) {
        const text = await response.text();
        if (text.trim() === "") {
          body = NOT_FOUND_PAGE;
          headers.set("content-type", "text/html; charset=utf-8");
        } else body = text;
      }
      const isHtml = /^text\/html\b/i.test(headers.get("content-type") ?? type);
      if (isHtml && !hashResponseBodies) {
        // The build's hashes are known before the body: nothing is buffered.
        headers.set(
          "content-security-policy",
          buildCsp({ ...routeHashes(url, response.status), directives }),
        );
      } else if (
        isStreamed &&
        streamedHtml === "pass" &&
        response.status !== 404
      ) {
        // Keep the stream: no hashes are possible before the body ends.
      } else if (isHtml) {
        if (isStreamed) headers.delete("content-encoding");
        const html = typeof body === "string" ? body : await response.text();
        body = html;
        const [scriptHashes, styleHashes] = await Promise.all([
          Promise.all(executableInlineScripts(html).map(sha256Base64)),
          Promise.all(inlineStyles(html).map(sha256Base64)),
        ]);
        headers.set(
          "content-security-policy",
          buildCsp({ scriptHashes, styleHashes, directives }),
        );
        headers.delete("content-length");
      }
      const robots = robotsHeader({ kind, environment });
      if (robots) headers.set("x-robots-tag", robots);
      if (kind in CACHE) headers.set("cache-control", cacheControlFor(kind));
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

/** True when Node runs this file directly; false inside a Worker, which has no argv. */
function isMain(metaUrl) {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  const script = globalThis.process?.argv?.[1];
  if (typeof getBuiltin !== "function" || !script) return false;
  // Real paths on both sides: Node resolves symlinks before setting import.meta.url, so argv[1] as typed would not
  // match through a symlinked folder and the CLI would exit 0 without doing anything.
  const { fileURLToPath } = getBuiltin("node:url");
  const { realpathSync } = getBuiltin("node:fs");
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

async function main() {
  const { parseArgs } = process.getBuiltinModule("node:util");
  const { readFileSync } = process.getBuiltinModule("node:fs");
  const { values } = parseArgs({
    options: {
      html: { type: "string" },
      directive: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values.html) throw new Error("--html <built page> is required");
  const html = readFileSync(values.html, "utf8");
  const directives = {};
  for (const d of values.directive ?? []) {
    const [name, ...rest] = d.trim().split(/\s+/);
    directives[name] = rest;
  }
  console.log(
    buildCsp({
      scriptHashes: await Promise.all(
        executableInlineScripts(html).map(sha256Base64),
      ),
      styleHashes: await Promise.all(inlineStyles(html).map(sha256Base64)),
      directives,
    }),
  );
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`worker-response-policy: ${error.message}\n`);
    process.exit(1);
  });
}
