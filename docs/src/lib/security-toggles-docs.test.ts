/**
 * Docs for the `security` toggles, `scripts.stripAnsi`,
 * `scripts.renderLimits` and `components.expansionLimits` (Collin
 * 2026-10-29: "the code you wrote is the code that ships").
 *
 * - The Configuration and Security pages explain every key: its default,
 *   what it protects and what turning it off means, and both state the
 *   default rule in plain words: on by default when it cannot break a
 *   correct site and needs no setup; off by default when the right setting
 *   depends on the site and needs setup.
 * - The Security page shows how to limit which sites a page loads from with
 *   contentSecurityPolicy, with a worked example.
 * - The HSTS default change (no includeSubDomains) is documented, with how
 *   to opt in and how to undo an earlier policy (max-age=0).
 * - The exact script-URL scheme list appears once, on the Security page;
 *   everywhere else says "script URLs such as `javascript:`".
 * - The production server and Cloudflare pages, the compatibility table
 *   and the bascik-config skill agree with the code.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DOCS = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(DOCS, "..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const readRepo = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf8");

/** Markdown with code spans unwrapped, for matching words. */
const plain = (md: string): string => md.replace(/`/g, "");

/** The text under a heading (any level) up to the next heading of the same or a higher level. */
const sectionOf = (md: string, heading: RegExp): string => {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => {
    const m = line.match(/^(#{2,4}) (.+)$/);
    return m !== null && heading.test(plain(m[2]));
  });
  if (start === -1) return "";
  const level = lines[start].match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const m = line.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

const SECURITY_KEYS = [
  "blockScriptUrls",
  "blockCodeBindings",
  "headers",
  "hsts",
  "privateDynamicPages",
  "stripDirectiveScripts",
  "hideDotfiles",
];
const RENDER_LIMITS = [
  "maxInstances",
  "maxOutputLength",
  "maxNestedScripts",
  "maxDepth",
  "rescanFactor",
  "rescanBase",
];

const expectDefaultRule = (text: string, where: string) => {
  const t = plain(text);
  expect(t, `${where}: on-by-default half`).toMatch(
    /on by default when it cannot break a correct site and needs no setup/i,
  );
  expect(t, `${where}: off-by-default half`).toMatch(
    /off by default when the right setting depends on the site and needs setup/i,
  );
};

// ─── /configuration ─────────────────────────────────────────────────────────

describe("/configuration", () => {
  const md = read("content/configuration.md");
  const security = sectionOf(md, /^security$/);

  it("has a security section", () => {
    expect(security.length).toBeGreaterThan(200);
  });

  it("states the default rule in plain words, with the off-by-default examples", () => {
    expectDefaultRule(security, "configuration.md security");
    for (const example of [
      "contentSecurityPolicy",
      "http.trustProxy",
      "generate.cspHashes",
    ])
      expect(plain(security)).toContain(example);
  });

  it("documents every security key with its default, what it protects and what off means", () => {
    for (const key of SECURITY_KEYS) {
      const row = plain(security)
        .split("\n")
        .find((line) => line.startsWith("|") && line.includes(key));
      expect(row, key).toBeDefined();
      expect(row, key).toMatch(/\btrue\b/);
      // default | protects | off means: at least four cells.
      expect(row!.split("|").length, key).toBeGreaterThanOrEqual(5);
    }
  });

  it("security.headers lists the five headers and shows an override and a removal", () => {
    const headers = plain(sectionOf(md, /^security\.headers$/));
    for (const name of [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ])
      expect(headers.toLowerCase()).toContain(name);
    expect(headers).toMatch(/"x-frame-options": "DENY"/);
    expect(headers).toMatch(/"x-frame-options": false/);
  });

  it("security.hsts documents the changed default, opting in, max-age=0 and preload", () => {
    const hsts = plain(sectionOf(md, /^security\.hsts$/));
    expect(hsts).toMatch(/changed default/i);
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).toContain("includeSubDomains: true");
    expect(hsts).toMatch(/max-?Age: 0|max-age=0/);
    expect(hsts).toContain("preload");
    expect(hsts).toContain("trustProxy");
  });

  it("documents scripts.stripAnsi, scripts.renderLimits and components.expansionLimits", () => {
    expect(sectionOf(md, /^scripts\.stripAnsi$/).length).toBeGreaterThan(50);
    const render = plain(sectionOf(md, /^scripts\.renderLimits$/));
    for (const key of RENDER_LIMITS) expect(render, key).toContain(key);
    const expansion = plain(sectionOf(md, /^components\.expansionLimits$/));
    expect(expansion).toContain("maxInstances");
    expect(expansion).toContain("maxPageLength");
  });

  it("the full reference block lists the new keys with their defaults", () => {
    const reference = sectionOf(md, /^Full Configuration Reference/);
    expect(reference).toMatch(/security: \{/);
    for (const key of SECURITY_KEYS) expect(reference, key).toContain(key);
    expect(reference).toMatch(/stripAnsi: true/);
    expect(reference).toMatch(/renderLimits: \{/);
    expect(reference).toMatch(/maxInstances: 1000/);
    expect(reference).toMatch(/expansionLimits: \{/);
    expect(reference).toMatch(/maxInstances: 10000|maxInstances: 10_000/);
  });

  it("says which keys are read at build time and that the Worker uses the build's values", () => {
    expect(plain(security)).toMatch(/build time/i);
    expect(plain(security)).toMatch(/Worker|Cloudflare/);
  });

  it("the validation section shows a did-you-mean for a security typo", () => {
    expect(plain(sectionOf(md, /^Configuration Validation$/))).toMatch(
      /security\.blockScriptUrl\b/,
    );
  });
});

// ─── /security ──────────────────────────────────────────────────────────────

describe("/security", () => {
  const md = read("content/security.md");
  const off = sectionOf(md, /^Turning protections off$/);

  it("has a Turning protections off section with the default rule", () => {
    expect(off.length).toBeGreaterThan(500);
    expectDefaultRule(off, "security.md");
  });

  it("names every security key, with a reason to turn it off", () => {
    for (const key of SECURITY_KEYS) expect(plain(off), key).toContain(key);
    expect(plain(off)).toContain("data:application/pdf");
    expect(plain(off)).toContain(".nojekyll");
  });

  it("says plainly what turning each dangerous one off means", () => {
    const t = plain(off);
    expect(t).toMatch(/this lets a prop become code/i);
    expect(t).toMatch(
      /CMS content can run code during your build or on your server/i,
    );
    expect(t).toMatch(/a shared cache can show one visitor's page to another/i);
    expect(t).toMatch(/every dotfile in src\/pages is published/i);
    expect(t).toContain(".DS_Store");
  });

  it("says what stays on: traversal 400, the .bascik folder, and the html helper", () => {
    const t = plain(off);
    expect(t).toMatch(/400/);
    expect(t).toContain(".bascik");
    expect(t).toMatch(/html helper|\bhtml\b/);
  });

  it("What Bascik guarantees says the protections are on by default and can be switched off in security", () => {
    const guarantees = plain(sectionOf(md, /^What Bascik guarantees$/));
    expect(guarantees).toMatch(/on by default/i);
    expect(guarantees).toContain("security");
    expect(guarantees).toContain("scripts.renderLimits");
  });

  it("shows how to limit which sites pages load from with contentSecurityPolicy, with a worked example", () => {
    const limit = sectionOf(md, /^Limit which sites your pages load from$/);
    expect(plain(limit)).toMatch(
      /To limit which sites your pages can load from, list them in contentSecurityPolicy/,
    );
    expect(limit).toContain("https://cdn.example.com");
    expect(limit).toMatch(/script-src/);
    expect(limit).toMatch(/img-src/);
    expect(limit).toMatch(/Content-Security-Policy/i);
    expect(plain(limit)).toMatch(/browser/i);
    expect(plain(limit)).toMatch(/unchanged/i);
  });

  it("the checklist asks that each security key is on or turned off on purpose", () => {
    expect(plain(sectionOf(md, /^Checklist$/))).toMatch(
      /each security key is left on, or turned off on purpose/i,
    );
  });
});

// ─── the scheme list appears once ───────────────────────────────────────────

describe("script URLs such as javascript:", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory()
        ? files(full)
        : name.endsWith(".md")
          ? [full]
          : [];
    });

  it("the full scheme list (vbscript, livescript, mocha) is on the Security page only", () => {
    const offenders = [
      ...files(path.join(DOCS, "content")),
      path.join(REPO, "skills/bascik-scripts/SKILL.md"),
      path.join(REPO, "create/assets/skills/bascik-scripts/SKILL.md"),
    ]
      .filter((file) => !file.endsWith(path.join("content", "security.md")))
      .filter((file) =>
        /\b(livescript|vbscript):|`mocha:`/i.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  it("the Security page lists it once", () => {
    const md = read("content/security.md");
    expect(md).toMatch(/javascript:.*vbscript:.*livescript:.*mocha:/s);
  });

  it.each([
    "content/server-scripts.md",
    "content/props.md",
    "content/attribute-inheritance.md",
    "content/html-helpers.md",
  ])("%s says script URLs such as `javascript:`", (rel) => {
    expect(read(rel)).toContain("script URLs such as `javascript:`");
  });
});

// ─── other pages ────────────────────────────────────────────────────────────

describe("production server, Cloudflare and compatibility pages", () => {
  it("production-server.md has the right rateLimit default and the security rows", () => {
    const md = read("content/production-server.md");
    const rate = md.split("\n").find((l) => l.startsWith("| `http.rateLimit`"));
    expect(rate).toBeDefined();
    expect(rate).toMatch(/`true`/);
    for (const key of [
      "security.headers",
      "security.hsts",
      "security.privateDynamicPages",
      "security.hideDotfiles",
    ])
      expect(md, key).toContain(`\`${key}\``);
    expect(md).toMatch(/^## Security headers$/m);
  });

  it("cloudflare.md documents the security settings and what the Worker does not limit", () => {
    const md = read("content/deployment/cloudflare.md");
    const settings = plain(sectionOf(md, /^Security settings on Cloudflare$/));
    expect(settings.length).toBeGreaterThan(200);
    expect(settings).toMatch(/build/i);
    expect(settings).toContain("_headers");
    const t = plain(md);
    expect(t).toMatch(/no per-IP rate limit/i);
    expect(t).toMatch(/maxBodySize/);
    expect(t).toMatch(/rate limiting rules|rate-limiting rules/i);
  });

  it("compatibility.md has the current HSTS value and header list", () => {
    const md = read("content/compatibility.md");
    expect(md).not.toContain("max-age=31536000; includeSubDomains");
    expect(md).not.toContain("Permissions-Policy: interest-cohort");
    expect(md).toContain("Cross-Origin-Opener-Policy");
    expect(md).toContain("Cross-Origin-Resource-Policy");
  });

  it("internals/server.md and deployment/index.md mention the security config", () => {
    expect(read("content/internals/server.md")).toContain("security.hsts");
    expect(read("content/deployment/index.md")).toContain("security.hsts");
  });

  it("custom-adapters.md documents the new graph fields", () => {
    const md = read("content/deployment/custom-adapters.md");
    for (const field of [
      "responseSecurity",
      "hideDotfiles",
      "stripAnsi",
      "renderLimits",
    ])
      expect(md, field).toContain(field);
  });

  it.each([
    ["content/server-scripts.md", "security.blockScriptUrls"],
    ["content/props.md", "security.blockCodeBindings"],
    ["content/attribute-inheritance.md", "security.blockScriptUrls"],
    ["content/build-scripts.md", "security.stripDirectiveScripts"],
    ["content/faq.md", "security.hideDotfiles"],
    ["content/cli.md", "components.expansionLimits"],
  ])("%s links the protection to %s", (rel, key) => {
    expect(read(rel)).toContain(key);
  });
});

// ─── bascik-config skill ────────────────────────────────────────────────────

describe("bascik-config skill", () => {
  const skill = readRepo("skills/bascik-config/SKILL.md");

  it("has a Security settings section with every key, the default rule and the HSTS change", () => {
    const section = sectionOf(skill, /^Security settings$/);
    expect(section.length).toBeGreaterThan(200);
    for (const key of SECURITY_KEYS) expect(section, key).toContain(key);
    expectDefaultRule(section, "bascik-config skill");
    expect(section).toContain("includeSubDomains");
  });

  it("the create copy is the same file", () => {
    expect(readRepo("create/assets/skills/bascik-config/SKILL.md")).toBe(skill);
  });
});

// ─── review fixes: anchors, Cloudflare static files, plain words ────────────

describe("links into /configuration land on their section", () => {
  const listMd = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory()
        ? listMd(full)
        : name.endsWith(".md")
          ? [full]
          : [];
    });

  it("every /configuration#anchor in the docs and every #anchor on the page is a heading id", async () => {
    const { renderMd } = await import("./md-renderer.ts");
    const html = await renderMd(path.join(DOCS, "content/configuration.md"));
    const ids = new Set(
      [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]),
    );
    const missing: string[] = [];
    for (const file of listMd(path.join(DOCS, "content"))) {
      const md = readFileSync(file, "utf8");
      const rel = path.relative(DOCS, file);
      for (const m of md.matchAll(/\]\(\/configuration#([\w-]+)\)/g))
        if (!ids.has(m[1])) missing.push(`${rel}: /configuration#${m[1]}`);
      if (rel === path.join("content", "configuration.md"))
        for (const m of md.matchAll(/\]\(#([\w-]+)\)/g))
          if (!ids.has(m[1])) missing.push(`${rel}: #${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("static files on Cloudflare get none of the response headers", () => {
  const caveat = /static files[^.]*Cloudflare[^.]*(none of|no )/i;
  const link = "/deployment/cloudflare#security-settings-on-cloudflare";

  it("the Security page's guarantee about headers says so, with a link", () => {
    const guarantees = sectionOf(
      read("content/security.md"),
      /^What Bascik guarantees$/,
    );
    const bullet = guarantees
      .split("\n")
      .find((l) => l.includes("Responses carry security headers"))!;
    expect(plain(bullet)).toMatch(caveat);
    expect(bullet).toContain(link);
  });

  it.each([/^security\.headers$/, /^security\.hsts$/])(
    "configuration.md %s says so, with a link",
    (heading) => {
      const section = sectionOf(read("content/configuration.md"), heading);
      expect(plain(section)).toMatch(caveat);
      expect(section).toContain(link);
    },
  );

  it("cloudflare.md shows the pipeline.exec script that writes the _headers rule", () => {
    const settings = sectionOf(
      read("content/deployment/cloudflare.md"),
      /^Security settings on Cloudflare$/,
    );
    expect(settings).toMatch(/phase: "post"/);
    expect(settings).toMatch(/writeFile\([^)]*dist\/_headers/);
    expect(settings).toContain("Strict-Transport-Security: max-age=31536000");
  });
});

describe("plain words for a reader who is not a security expert", () => {
  const config = read("content/configuration.md");
  const security = read("content/security.md");

  it("the headers are not said to block cross-origin access; CORP is described truthfully", () => {
    for (const md of [config, security]) {
      expect(plain(md)).not.toMatch(/cross-origin (access|reads)/i);
    }
    const headers = sectionOf(config, /^security\.headers$/);
    expect(headers).toMatch(/\| Header +\| Value +\| What it does +\|/);
    const corp = headers
      .split("\n")
      .find((l) => l.startsWith("| `cross-origin-resource-policy`"))!;
    expect(plain(corp)).toMatch(/other sites (can|may) load/i);
  });

  it("hsts says why it matters: someone on the same network can intercept a plain-HTTP request", () => {
    const row = config.split("\n").find((l) => l.startsWith("| `hsts`"))!;
    expect(plain(row)).toMatch(/public Wi-Fi/i);
  });

  it("blockScriptUrls says a script URL runs code when the link is followed", () => {
    const row = config
      .split("\n")
      .find((l) => l.startsWith("| `blockScriptUrls`"))!;
    expect(plain(row)).toMatch(/runs code when/i);
    const bullet = sectionOf(security, /^What Bascik guarantees$/)
      .split("\n")
      .find((l) => l.includes("URL bindings are checked"))!;
    expect(plain(bullet)).toMatch(/runs code when/i);
  });

  it("the CSP example warns, right after it, about style attributes and instance-id scripts", () => {
    const limit = sectionOf(
      security,
      /^Limit which sites your pages load from$/,
    );
    expect(limit).toContain("](#csp-and-request-time-components)");
    expect(plain(limit)).toMatch(/style="/);
  });

  it("blockCodeBindings off fills <script> and <style> as written, not entity-escaped", () => {
    const row = config
      .split("\n")
      .find((l) => l.startsWith("| `blockCodeBindings`"))!;
    expect(plain(row)).toMatch(/<\/script/);
    const off = plain(sectionOf(security, /^Turning protections off$/));
    expect(off).toMatch(/<\\\/script/);
  });
});
