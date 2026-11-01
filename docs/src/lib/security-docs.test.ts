/**
 * Docs for @bascik/bascik/html and server script safety (Collin 2026-10-28:
 * "cover all of it, usage, how to keep people safe, how to use it, and why").
 *
 * - /security (Scripts & Routing, after Stream Scripts) has every required
 *   section, the two component-demo boxes, and the third-party loading
 *   section; /html-helpers (Reference, after Package Exports) documents every
 *   export, every context and every error.
 * - Every server and stream script in docs/content and skills that
 *   interpolates into markup passes the server-script-unescaped-markup lint
 *   (the language server's own analyzer), so examples use html.
 * - The same-site rule from bca0714e is gone from the docs, and the old
 *   escaping claims ("a framework cannot know which row", "Bascik exports
 *   nothing for use inside a server script") are gone.
 * - Troubleshooting has an entry per html error and per lint rule; the FAQ
 *   answers "How do I keep server scripts safe?".
 * - The VS Code capture scene for the lint warning and quick fix exists and
 *   its WebP files are committed and shown.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NAV } from "./nav.ts";

const DOCS = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(DOCS, "..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const readRepo = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string): boolean => existsSync(path.join(DOCS, rel));

/** Markdown with code spans unwrapped and escapes dropped, for matching message text. */
const plain = (md: string): string => md.replace(/`/g, "").replace(/\\/g, "");

const h2s = (md: string): string[] =>
  [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

const sectionOf = (md: string, heading: string): string => {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const rest = md.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
};

// ─── Navigation ─────────────────────────────────────────────────────────────

describe("navigation", () => {
  const section = (name: string) => NAV.find((s) => s.section === name);

  it("Security sits in Scripts & Routing right after Stream Scripts", () => {
    const pages = section("Scripts & Routing")!.pages;
    const at = pages.findIndex((p) => p.href === "/security");
    expect(at).toBeGreaterThan(-1);
    expect(pages[at].label).toBe("Security");
    expect(pages[at - 1].href).toBe("/stream-scripts");
  });

  it("HTML Helpers sits in Reference right after Package Exports", () => {
    const pages = section("Reference")!.pages;
    const at = pages.findIndex((p) => p.href === "/html-helpers");
    expect(at).toBeGreaterThan(-1);
    expect(pages[at].label).toBe("HTML Helpers");
    expect(pages[at - 1].href).toBe("/package-exports");
  });

  it("both pages have content and a page shell", () => {
    for (const name of ["security", "html-helpers"]) {
      expect(exists(`content/${name}.md`), name).toBe(true);
      expect(exists(`src/pages/${name}.html`), name).toBe(true);
    }
  });
});

// ─── /security ──────────────────────────────────────────────────────────────

describe("/security", () => {
  const md = exists("content/security.md") ? read("content/security.md") : "";
  const headings = h2s(md);

  it("starts with the h1 Security", () => {
    expect(md.split("\n")[0]).toBe("# Security");
  });

  it.each([
    /string-returning servers are risky/i,
    /what bascik guarantees/i,
    /what is yours/i,
    /where values land/i,
    /using html/i,
    /malicious \?q=.*text/i,
    /the helpers/i,
    /cms and markdown/i,
    /dynamic components/i,
    /client data/i,
    /^loading scripts and styles from other sites$/i,
    /csp and request-time components/i,
    /linter/i,
    /checklist/i,
    /self-test/i,
  ])("has a section matching %s", (pattern) => {
    expect(
      headings.some((h) => pattern.test(h)),
      headings.join(" | "),
    ).toBe(true);
  });

  it("links the API reference, the CSP how-to and troubleshooting", () => {
    expect(md).toContain("](/html-helpers");
    expect(md).toContain("](/how-to/content-security-policy");
    expect(md).toContain("](/testing/troubleshooting");
  });

  it("what Bascik guarantees covers props, inherited attributes, URL bindings, srcdoc and budgets", () => {
    const text = plain(
      sectionOf(
        md,
        headings.find((h) => /what bascik guarantees/i.test(h)) ?? "",
      ),
    );
    for (const word of [
      "prop",
      "inherited",
      "about:invalid",
      "srcdoc",
      "budget",
      "Cloudflare",
    ])
      expect(text, word).toContain(word);
  });

  it("the sink table has an html column", () => {
    const text = sectionOf(
      md,
      headings.find((h) => /where values land/i.test(h)) ?? "",
    );
    expect(text).toMatch(/^\|.*\bhtml\b.*\|$/im);
    expect(text).toMatch(/on\*|onclick/);
    expect(text).toMatch(/<script>/);
  });

  it("Loading scripts and styles from other sites: allowed like the browser, why it is a risk, and the protections", () => {
    const text = plain(
      sectionOf(md, "Loading scripts and styles from other sites"),
    );
    expect(text).toMatch(/like the browser|as browsers? (do|allow)/i);
    expect(text).toMatch(/visitor/i);
    expect(text).toContain("script-src");
    expect(text).toContain("style-src");
    expect(text).toContain("safeUrl");
    expect(text).toContain("origins");
    expect(text).toMatch(/in the template/i);
    expect(text).toMatch(/fixed (variants|choices|fragments)/i);
  });

  it("CMS content: a sanitizer, then raw()", () => {
    const text = plain(
      sectionOf(md, headings.find((h) => /cms and markdown/i.test(h)) ?? ""),
    );
    expect(text).toMatch(/sanitiz/i);
    expect(text).toContain("raw(");
  });

  it("client data: data-* and json() in a JSON script", () => {
    const text = sectionOf(
      md,
      headings.find((h) => /client data/i.test(h)) ?? "",
    );
    expect(text).toContain("data-");
    expect(text).toContain('<script type="application/json">${json(');
  });

  it("dynamic components choose between fixed fragments, never <${tag}>", () => {
    const text = sectionOf(
      md,
      headings.find((h) => /dynamic components/i.test(h)) ?? "",
    );
    expect(text).toMatch(/html`<[a-z]+-[a-z]/);
    expect(text).toContain("tag name");
  });

  it("the self-test sends ?q=<product-card and an onerror payload and expects text", () => {
    const text = sectionOf(
      md,
      headings.find((h) => /self-test/i.test(h)) ?? "",
    );
    expect(text).toContain("?q=");
    expect(text).toMatch(/product-card/);
    expect(text).toMatch(/onerror/);
    expect(text).toMatch(/curl/);
  });

  it("has the two component-demo boxes: the html search page (Source and Output) and a malicious ?q=", () => {
    for (const marker of [
      "security-search-source",
      "security-search-output",
      "security-malicious-q-output",
    ])
      expect(md, marker).toContain(`<!-- demo:${marker}`);
  });

  it("states no same-site rule for script or stylesheet URLs", () => {
    expect(md).not.toMatch(/must be a (same-site )?path on (your|this) site/i);
  });
});

describe("rtc-demos generates the security demos from the real server", () => {
  it("DEMOS has the search and malicious ?q= entries in content/security.md", async () => {
    const { DEMOS } = await import("../../scripts/rtc-demos.ts");
    const security = DEMOS.filter(
      (d: { md: string }) => d.md === "content/security.md",
    );
    expect(
      security.map((d: { outputMarker: string }) => d.outputMarker).sort(),
    ).toEqual(["security-malicious-q-output", "security-search-output"]);
    const malicious = security.find(
      (d: { outputMarker: string }) =>
        d.outputMarker === "security-malicious-q-output",
    )!;
    const q = decodeURIComponent(
      new URL(malicious.url, "http://x").searchParams.get("q") ?? "",
    );
    expect(q).toContain("<product-card");
    expect(q).toContain("onerror");
  });

  it("the committed malicious ?q= Output shows the payload as text", () => {
    const md = exists("content/security.md") ? read("content/security.md") : "";
    const at = md.indexOf("<!-- demo:security-malicious-q-output");
    expect(at).toBeGreaterThan(-1);
    // The Output is the first fence after its marker.
    const fence = /```html\n([\s\S]*?)```/g;
    let output = "";
    for (const m of md.matchAll(fence)) {
      if ((m.index ?? 0) > at) {
        output = m[1];
        break;
      }
    }
    expect(output).toContain("&lt;product-card");
    expect(output).toContain("onerror");
    expect(output).not.toMatch(/<img[\s>]/);
  });
});

// ─── /html-helpers ──────────────────────────────────────────────────────────

const ERROR_PHRASES: [code: string, phrase: string][] = [
  ["unquoted-attribute", "is an unquoted attribute value"],
  ["event-handler", "An event handler's value is JavaScript"],
  ["style-attribute", "is inside a style attribute"],
  ["script-body", "is inside a <script> element"],
  ["style-body", "is inside a <style> element"],
  ["tag-name", "is a tag name"],
  ["attribute-name", "is where an attribute name goes"],
  ["comment", "is inside an HTML comment"],
  ["srcdoc", "is inside srcdoc"],
  ["meta-http-equiv", "is a <meta http-equiv> value"],
  ["svg-animation-attribute", "chooses which attribute an SVG animation sets"],
  ["url-scheme-split", "continues the URL's scheme from the template text"],
  ["script-url", "is inside a javascript: URL"],
  ["script-comment-ambiguous", "whose text contains <!--"],
  ["unterminated", "fragment must end outside any tag"],
  ["promise", "received a Promise"],
  ["markup-in-attribute", "An attribute holds text"],
  ["array-in-attribute", "An attribute holds one text value"],
  ["markup-in-text-only", "holds text only"],
  ["json-script-value", "Only json(value) can fill this script"],
  ["unconvertible-value", "cannot be converted to text"],
  ["array-depth", "nested more than 1000 levels deep"],
  ["raw-text-end", "which ends the <noscript> early"],
];

const TYPE_ERRORS = [
  "html is a tagged template",
  "raw() takes a string of trusted HTML, not a template",
  "raw() takes one string of trusted HTML",
  "raw() received a Promise",
  "is not an origin",
  "esc() received an object that cannot be converted to text",
];

describe("/html-helpers API reference", () => {
  const md = exists("content/html-helpers.md")
    ? read("content/html-helpers.md")
    : "";
  const text = plain(md);

  it("starts with the h1 HTML Helpers and shows the import", () => {
    expect(md.split("\n")[0]).toBe("# HTML Helpers");
    expect(md).toContain('from "@bascik/bascik/html"');
  });

  it.each(["html", "raw", "esc", "safeUrl", "json", "isHtml", "HtmlError"])(
    "documents %s under its own heading",
    (name) => {
      expect(md).toMatch(new RegExp(`^##+ \`?${name}\\b`, "m"));
    },
  );

  it("has the contexts table and the values table", () => {
    expect(md).toMatch(/^## Where a value lands/m);
    expect(md).toMatch(/^## Values/m);
    for (const word of [
      "srcset",
      "data-bascik-prop-",
      "application/json",
      "about:invalid",
      "<textarea>",
    ])
      expect(text, word).toContain(word);
  });

  it("documents safeUrl's base, origins and image options", () => {
    for (const option of ["base", "origins", "image: true"])
      expect(text, option).toContain(option);
  });

  it.each(ERROR_PHRASES)("lists the %s error (%s)", (code, phrase) => {
    expect(text).toContain(code);
    expect(text).toContain(phrase);
  });

  it.each(TYPE_ERRORS)("lists the TypeError %j", (phrase) => {
    expect(text).toContain(phrase);
  });

  it("has Nesting, Performance (with the bench numbers) and Compatibility sections", () => {
    expect(md).toMatch(/^## Nesting/m);
    expect(md).toMatch(/^## Performance/m);
    expect(sectionOf(md, "Performance")).toMatch(/1,?000/);
    expect(sectionOf(md, "Performance")).toMatch(
      /\d+(\.\d+)?x|\d[\d,]* ops\/s/,
    );
    expect(md).toMatch(/^## Compatibility/m);
    expect(text).toContain("22.22");
    expect(text).toMatch(/Cloudflare Workers?/);
  });

  it("links /security and Troubleshooting", () => {
    expect(md).toContain("](/security");
    expect(md).toContain("](/testing/troubleshooting");
  });

  it("package-exports.md lists @bascik/bascik/html in the export map and links /html-helpers", () => {
    const exportsMd = read("content/package-exports.md");
    expect(exportsMd).toMatch(
      /^\| `@bascik\/bascik\/html` .*\(\/html-helpers\)/m,
    );
    expect(exportsMd).toMatch(/^## `@bascik\/bascik\/html`/m);
  });
});

// ─── server-scripts.md and the same-site undo ───────────────────────────────

describe("server-scripts.md escaping and injection", () => {
  const md = read("content/server-scripts.md");

  it("drops the claim that a framework cannot know which row and that Bascik exports nothing for scripts", () => {
    expect(md).not.toContain("A framework cannot know which row");
    expect(md).not.toContain(
      "Bascik exports nothing for use inside a server script",
    );
  });

  it("teaches html in Escaping and injection, with the handwritten escaper only as a footnote", () => {
    const text = sectionOf(md, "Escaping and injection");
    expect(text).toContain('import { html } from "@bascik/bascik/html"');
    expect(text).toContain("html`");
    expect(text).toContain("](/security");
    const escaper = text.indexOf("replace(/[&<>");
    if (escaper !== -1) expect(text.indexOf("html`")).toBeLessThan(escaper);
  });

  it("the search demo source imports html and has no handwritten escape", () => {
    // The Usage is the first fence after its marker.
    const at = md.indexOf("<!-- demo:rtc-search-source-usage -->");
    const open = md.indexOf("```html", at);
    const block = md.slice(open, md.indexOf("\n```\n", open + 7));
    expect(block).toContain('import { html } from "@bascik/bascik/html"');
    expect(block).not.toMatch(/const escape\b/);
  });
});

describe("the same-site rule from bca0714e is gone from the docs", () => {
  it.each([
    "content/props.md",
    "content/compatibility.md",
    "content/server-scripts.md",
    "content/testing/troubleshooting.md",
    "content/how-to/content-security-policy.md",
  ])("%s", (file) => {
    const md = read(file);
    expect(md).not.toMatch(/must be a (same-site )?path on (your|this) site/i);
    expect(md).not.toMatch(/must be a same-site path/i);
    expect(md).not.toContain("received a URL outside this site");
  });

  it("props.md points URLs the page runs to the third-party section of /security", () => {
    expect(read("content/props.md")).toContain(
      "/security#loading-scripts-and-styles-from-other-sites",
    );
  });
});

// ─── Examples use html (the language server's own analyzer) ─────────────────

type Analyze = (
  body: string,
  opts: { hasSrcAttribute: boolean; directive: string },
) => { code: string; message: string }[];

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath, e.name));

describe("every server and stream script example uses html where it interpolates into markup", () => {
  it("docs/content and skills pass server-script-unescaped-markup", async () => {
    const { analyzeServerScriptSource } = (await import(
      new URL("../../../lsp/src/server-script-rules.ts", import.meta.url).href
    )) as { analyzeServerScriptSource: Analyze };
    // The oracle must know the rule, or every example would pass vacuously.
    expect(
      analyzeServerScriptSource(
        'export default (request) => `<p>${request.headers.get("x")}</p>`;',
        { hasSrcAttribute: false, directive: "server" },
      ).map((d) => d.code),
    ).toContain("server-script-unescaped-markup");
    const files = [
      ...markdownFiles(path.join(DOCS, "content")),
      ...markdownFiles(path.join(REPO, "skills")),
    ];
    const findings: string[] = [];
    for (const file of files) {
      const md = readFileSync(file, "utf8");
      for (const fence of md.matchAll(/(^.*\n)?```[a-z]*\n([\s\S]*?)```/gm)) {
        // A block that shows the unsafe pattern on purpose says so right above it.
        if (/<!--\s*unsafe-example\s*-->/.test(fence[1] ?? "")) continue;
        for (const script of fence[2].matchAll(
          /<script\b([^>]*\bdata-bascik-(server|stream)\b[^>]*)>([\s\S]*?)<\/script>/g,
        )) {
          if (/\ssrc\s*=/.test(script[1])) continue;
          const diags = analyzeServerScriptSource(script[3], {
            hasSrcAttribute: false,
            directive: script[2],
          }).filter((d) => d.code === "server-script-unescaped-markup");
          for (const d of diags)
            findings.push(`${path.relative(REPO, file)}: ${d.message}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("the starter and the skills that show server scripts import html", () => {
    for (const rel of [
      "skills/bascik-scripts/SKILL.md",
      "skills/bascik/SKILL.md",
      "create/src/scaffold.ts",
    ])
      expect(readRepo(rel), rel).toContain("@bascik/bascik/html");
    expect(readRepo("skills/bascik-config/SKILL.md")).toContain(
      "contentSecurityPolicy",
    );
  });
});

// ─── Troubleshooting and FAQ ────────────────────────────────────────────────

describe("troubleshooting and FAQ", () => {
  const md = read("content/testing/troubleshooting.md");
  const section = plain(sectionOf(md, "Server script safety"));

  it("has a Server script safety section", () => {
    expect(h2s(md)).toContain("Server script safety");
  });

  it.each(ERROR_PHRASES)("has an entry for %s (%s)", (_code, phrase) => {
    expect(section).toContain(phrase);
  });

  it.each(TYPE_ERRORS)("has an entry for the TypeError %j", (phrase) => {
    expect(section).toContain(phrase);
  });

  it("has entries for the lint rules and for [object Promise] / commas between cards", () => {
    expect(section).toContain("server-script-unescaped-markup");
    expect(section).toContain("html-escaped-twice");
    expect(section).toContain("[object Promise]");
    expect(section).toMatch(/commas between/i);
  });

  it("the FAQ answers How do I keep server scripts safe?", () => {
    const faq = read("content/faq.md");
    expect(faq).toMatch(/^#+ How do I keep server scripts safe\?$/m);
    const at = faq.indexOf("How do I keep server scripts safe?");
    const answer = faq.slice(at, at + 2000);
    expect(answer).toContain("](/security");
    expect(answer).toContain("](/html-helpers");
  });
});

// ─── CSP docs ───────────────────────────────────────────────────────────────

describe("CSP docs (opt-in contentSecurityPolicy)", () => {
  it("the how-to has a recipe per host and links safeUrl origins on /security", () => {
    const md = read("content/how-to/content-security-policy.md");
    for (const host of [
      /node|production server|bascik --server/i,
      /dev(elopment)? server/i,
      /cloudflare/i,
      /static host/i,
    ])
      expect(
        h2s(md)
          .concat([...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]))
          .some((h) => host.test(h)),
        String(host),
      ).toBe(true);
    expect(md).toContain("contentSecurityPolicy");
    expect(md).toContain("reportOnly");
    expect(md).toContain("](/security");
    expect(md).toMatch(/curl -I/);
  });

  it("configuration.md documents contentSecurityPolicy with its validation messages", () => {
    const md = read("content/configuration.md");
    expect(md).toContain("contentSecurityPolicy");
    expect(md).toContain('is not a CSP directive. Did you mean "script-src"?');
    expect(md).toContain("so every inline script runs");
  });

  it("deployment, Cloudflare and production server pages link the recipes", () => {
    for (const file of [
      "content/deployment/index.md",
      "content/deployment/cloudflare.md",
      "content/production-server.md",
    ])
      expect(read(file), file).toContain("/how-to/content-security-policy");
  });
});

// ─── Linter and VS Code ─────────────────────────────────────────────────────

describe("linter and VS Code docs", () => {
  it("the linter page lists both rules, the quick fix, why --fix skips it, escapeFunctions and suppression", () => {
    const md = plain(read("content/tools/linter.md"));
    for (const word of [
      "server-script-unescaped-markup",
      "html-escaped-twice",
      "Wrap template in html...",
      "--fix",
      "escapeFunctions",
      "bascik-ignore server-script-unescaped-markup",
    ])
      expect(md, word).toContain(word);
  });

  it("the capture script has a scene for the lint warning and quick fix", () => {
    const script = read("scripts/capture-vscode-screenshots.ts");
    expect(script).toMatch(/name: "unescaped-markup"/);
    expect(script).toContain("@bascik/bascik/html");
  });

  it("the scene's animated WebP and still are committed and shown on both pages", () => {
    for (const file of [
      "src/pages/assets/vscode/unescaped-markup@2x.webp",
      "src/pages/assets/vscode/unescaped-markup-still@2x.webp",
    ])
      expect(exists(file), file).toBe(true);
    for (const page of [
      "content/tools/vscode-extension.md",
      "content/tools/linter.md",
    ])
      expect(read(page), page).toContain("/assets/vscode/unescaped-markup");
  });
});

// ─── Fix pass: the docs match the real module and the real CLI ─────────────

/** Each refusal the module can produce, as a call that throws it. */
const REAL_ERRORS: [name: string, call: (h: any) => unknown][] = [
  ["unquoted-attribute", (h) => h.html`<p class=${"v"}>`],
  ["event-handler", (h) => h.html`<button onclick="${"v"}">`],
  ["style-attribute", (h) => h.html`<p style="${"v"}">`],
  ["script-body", (h) => h.html`<script>${"v"}</script>`],
  ["style-body", (h) => h.html`<style>${"v"}</style>`],
  ["tag-name", (h) => h.html`<${"v"}>`],
  ["attribute-name", (h) => h.html`<input ${"v"}>`],
  ["comment", (h) => h.html`<!-- ${"v"} -->`],
  ["srcdoc", (h) => h.html`<iframe srcdoc="${"v"}"></iframe>`],
  ["meta-http-equiv", (h) => h.html`<meta http-equiv="${"v"}">`],
  [
    "svg-animation-attribute",
    (h) => h.html`<svg><set attributeName="${"v"}"/></svg>`,
  ],
  ["url-scheme-split", (h) => h.html`<a href="java${"v"}">`],
  ["url-scheme-split host:port", (h) => h.html`<a href="${"v"}:8080">`],
  ["url-scheme-split two holes", (h) => h.html`<a href="${"v"}${"w"}">`],
  ["script-url", (h) => h.html`<a href="javascript:${"v"}">`],
  [
    "script-comment-ambiguous",
    (h) => h.html`<script><!--</script><p>${"v"}</p>`,
  ],
  ["script-comment-ambiguous hole 0", (h) => h.html`<script><!--</script>`],
  ["unterminated", (h) => h.html`<a href="${"v"}`],
  ["promise", (h) => h.html`<p>${Promise.resolve(1)}</p>`],
  ["markup-in-attribute", (h) => h.html`<p title="${h.html`<b></b>`}">`],
  ["array-in-attribute", (h) => h.html`<p class="${["a"]}">`],
  ["markup-in-text-only", (h) => h.html`<title>${h.html`<b></b>`}</title>`],
  [
    "json-script-value",
    (h) => h.html`<script type="application/json">${"v"}</script>`,
  ],
  [
    "foreign-content",
    (h) => h.html`<svg>${h.html`<script>a < b</script>`}</svg>`,
  ],
  [
    "unconvertible-value",
    (h) => h.html`<p>${JSON.parse('{"toString":"x"}')}</p>`,
  ],
  [
    "array-depth",
    (h) => h.html`<ul>${JSON.parse("[".repeat(1001) + "]".repeat(1001))}</ul>`,
  ],
  [
    "raw-text-end",
    (h) => h.html`<noscript>${h.html`<p title="</noscript>">x</p>`}</noscript>`,
  ],
];

/** The message after the location prefix, with the excerpt's template removed. */
const reason = async (call: (h: any) => unknown): Promise<string> => {
  const h = await import(path.join(REPO, "pkg/src/html.ts"));
  try {
    call(h);
  } catch (error) {
    return (error as Error).message
      .replace(/^html: hole \d+ in html`.*?` (?=[a-z(])/, "")
      .replace(/^html: the template html`.*?` /, "");
  }
  throw new Error("expected a refusal");
};

describe("the html-helpers Errors table and Troubleshooting quote the real messages", () => {
  const helpers = plain(read("content/html-helpers.md"));
  const trouble = plain(read("content/testing/troubleshooting.md"));
  it.each(REAL_ERRORS)("%s", async (_name, call) => {
    const text = plain(await reason(call));
    // Examples in the docs use the same names (class, onclick, href, <input>, ...).
    expect(helpers).toContain(text);
    // Troubleshooting headings quote at least the first sentence.
    expect(trouble).toContain(text.split(/(?<=\.) /)[0]);
  });

  it("json() shows the escape sequences, not the characters they replace", () => {
    const md = read("content/html-helpers.md");
    expect(md).toContain(
      "`\\u003c`, `\\u003e`, `\\u0026`, `\\u2028` and `\\u2029`",
    );
    expect(md).not.toMatch(/[\u2028\u2029]/);
  });

  it("documents boolean attributes and the false-in-an-attribute trap", () => {
    expect(helpers).toMatch(/## Boolean attributes/);
    expect(helpers).toContain('checked=""');
    expect(read("content/security.md")).toContain(
      "/html-helpers#boolean-attributes",
    );
  });

  it("says an html value is not a string: String(value) in tests, SafeHtml for helper types", () => {
    expect(helpers).toContain("String(output)");
    expect(helpers).toContain("type SafeHtml");
    expect(read("content/testing/server-scripts.md")).toContain(
      "String(output)",
    );
  });

  it("tells a handler test to print the return with serverScriptOutput, not String(), which adds commas to an array", () => {
    const testing = read("content/testing/server-scripts.md");
    expect(testing).toContain(
      'import { serverScriptOutput } from "@bascik/bascik/runtime";',
    );
    expect(testing).toContain("printed.text");
    expect(testing).toContain("printed.error");
    expect(testing).not.toMatch(/String\(\s*await weatherHandler/);
    expect(readRepo("skills/bascik-testing/SKILL.md")).toContain(
      "serverScriptOutput(await handler(",
    );
  });

  it("says the html error is in the terminal in dev (the browser shows a plain 500)", () => {
    expect(read("content/security.md")).toMatch(/terminal/);
    expect(helpers).toMatch(/terminal/);
  });
});

describe("the linter docs match the CLI", () => {
  const CLI_FORMAT =
    /src\/pages\/search\.html:\d+:\d+ - warning: \(server-script-unescaped-markup\) This markup template/;
  it.each(["content/tools/linter.md", "content/security.md"])(
    "%s shows bascik --check output in its real format",
    (file) => {
      const md = read(file);
      expect(md).toMatch(CLI_FORMAT);
      expect(md).not.toMatch(/:\d+:\d+ warning server-script-unescaped-markup/);
    },
  );

  it("no code span on the linter page ends in a backslash (CommonMark does not escape a backtick inside one)", async () => {
    const { renderMd } = await import("./md-renderer.ts");
    const rendered = await renderMd(path.join(DOCS, "content/tools/linter.md"));
    expect(rendered).not.toMatch(/<code>[^<]*\\<\/code>/);
    expect(rendered).toContain("<code>safeUrl</code>, or <code>json</code>");
  });

  it("documents html-joined-string, hand-written escapers and multi-line suppression", () => {
    const md = plain(read("content/tools/linter.md"));
    expect(md).toContain("html-joined-string");
    expect(md).toContain("hand-written escaper");
    expect(md).toMatch(/first line/);
    expect(plain(read("content/testing/troubleshooting.md"))).toContain(
      "My page shows &lt;li&gt; as text",
    );
  });
});

describe("the rest of the docs teach html too", () => {
  it("the templating how-to leads with html for server and stream scripts", () => {
    const md = read("content/how-to/templating.md");
    expect(md).toContain('import { html } from "@bascik/bascik/html"');
    expect(md).toContain("](/security");
    expect(md).toContain("](/html-helpers");
  });

  it("build-script examples next to html examples use html", () => {
    const server = read("content/server-scripts.md");
    expect(server).not.toContain('(l) => `<a href="${l.href}">');
    expect(server).toContain('(l) => html`<a href="${l.href}">');
    expect(read("content/exec-scripts.md")).not.toContain(
      "(item) => `<li>${item.title}</li>`",
    );
    expect(read("content/security.md")).toMatch(/build time|build script/i);
  });

  it("the testing page's helper builds its markup with html", () => {
    const md = read("content/testing/server-scripts.md");
    expect(md).not.toMatch(/`<h4>\$\{data\.city\}<\/h4>/);
    expect(md).toContain('from "@bascik/bascik/html"');
  });

  // The full scheme list lives on the Security page only (Collin
  // 2026-10-29); the table names the rule with "script URLs such as".
  it("the What html does table names the script-URL rule", () => {
    const md = read("content/server-scripts.md");
    const at = md.indexOf("## Escaping and injection");
    expect(md.slice(at, at + 6000)).toContain(
      "script URLs such as `javascript:`",
    );
    expect(read("content/security.md")).toContain("`livescript:`");
  });

  it("the CMS recipe shows the sanitize call", () => {
    const md = read("content/security.md");
    const at = md.indexOf("## CMS and Markdown content");
    expect(md.slice(at, at + 3000)).toMatch(/sanitize\w*\(/);
  });

  it("the CSP how-to shows an instance-independent component script and inline styles", () => {
    const md = read("content/how-to/content-security-policy.md");
    expect(md).toContain("### Components rendered at request time");
    expect(md).toContain('closest(".save")');
    expect(md).toContain("hashes: { scripts: true, styles: false }");
    expect(read("content/security.md")).toContain(
      "/how-to/content-security-policy#components-rendered-at-request-time",
    );
    expect(read("content/configuration.md")).toContain("styles: false");
  });
});
