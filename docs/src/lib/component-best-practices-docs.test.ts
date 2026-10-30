/**
 * /component-best-practices (Collin 2026-10-30: the semantic HTML page and the name attribute page made each look like
 * more of a feature than it is; both are how to write a component well, so they are one Components page now).
 *
 * - The page is in the Components section of the nav, right after Preserve Scoping, and its h1 is its nav label.
 * - "Use HTML's Elements" (Collin 2026-10-29: "Bascik is all about web standards, which also means an emphasis on
 *   semantic HTML") says component tag names never reach the browser, so the tag need not be semantic; the root
 *   element and its markup must be. Tags are still named after what they are, for readability. It says Bascik ships
 *   the element you wrote and never rewrites or rejects markup: it guides and warns. It links to the HTML standard
 *   (WHATWG) and MDN, and covers landmarks, headings, buttons and links, lists, tables, figure, time, address, labels
 *   with fieldset and legend, native elements before ARIA, alt, and lang.
 * - "Name Form Controls and Groups" says `name` ships as written and is a page-level contract, names both fixes for
 *   a repeated radio group, the `shared-name-group` lint, the clobbering hazard, and the opt-in, which the
 *   Configuration page documents in full.
 * - The old URLs, /semantic-html and /name-attribute, are 301s to the section that holds their content.
 * - Getting Started, Why Bascik, Components, the FAQ, Switch, and Lighthouse Accessibility link to it.
 * - The examples on those entry pages follow it: Getting Started's first page has lang and <main>.
 *
 * docs/scripts/semantic-html-demos.test.ts and name-attribute-demos.test.ts build the demo boxes with the real
 * compiler.
 *
 * Misuse lens: a page missing from the nav, a link that points at a stale URL or anchor, a redirect to an anchor
 * the page does not have, prose that suggests Bascik enforces or rewrites markup, an em dash, and an entry-page
 * example that teaches the opposite of the page.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { marked, type Tokens } from "marked";
import { slugFromHeadingHtml } from "./heading-slug.ts";
import { NAV } from "./nav.ts";
import {
  PAGE_REDIRECTS,
  parseRedirectRules,
  pagesRedirects,
} from "./pages-headers.ts";

const DOCS = path.resolve(import.meta.dirname, "../..");
const PAGE = "/component-best-practices";
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const md = read("content/component-best-practices.md");
const shell = read("src/pages/component-best-practices.html");

/** Prose only: fenced blocks and comments removed, whitespace collapsed. */
const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ");

/** The ids the renderer stamps on the page's h2 and h3 headings. */
const anchors = new Set(
  marked
    .lexer(md)
    .filter((t): t is Tokens.Heading => t.type === "heading")
    .filter((t) => t.depth === 2 || t.depth === 3)
    .map((t) => slugFromHeadingHtml(marked.parseInline(t.text) as string)),
);

const section = (heading: string): string => {
  const start = md.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 4);
  return md.slice(start, next === -1 ? undefined : next);
};

describe(PAGE, () => {
  it("sits in Components right after Preserve Scoping, with an h1 equal to its label", () => {
    const components = NAV.find((s) => s.section === "Components")!;
    const hrefs = components.pages.map((p) => p.href);
    expect(hrefs.indexOf(PAGE)).toBe(hrefs.indexOf("/preserve") + 1);
    expect(
      NAV.filter((s) => s.pages.some((p) => p.href === PAGE)),
    ).toHaveLength(1);
    expect(components.pages.find((p) => p.href === PAGE)!.label).toBe(
      "Component Best Practices",
    );
    expect(md.split("\n")[0]).toBe("# Component Best Practices");
    for (const old of ["/semantic-html", "/name-attribute"])
      expect(hrefs).not.toContain(old);
  });

  it("has the two parts as h2 sections, each with the anchor the old page's links point at", () => {
    expect(md).toContain("\n## Use HTML's Elements\n");
    expect(md).toContain("\n## Name Form Controls and Groups\n");
    expect(anchors.has("use-htmls-elements")).toBe(true);
    expect(anchors.has("name-form-controls-and-groups")).toBe(true);
    // Anchors other pages link to, kept from the old pages.
    for (const anchor of [
      "tag-names-never-reach-the-browser",
      "checklist",
      "naming-form-fields-for-submission",
      "radio-groups-per-component-instance",
      "exclusive-details-accordions",
      "what-bascik-does",
    ])
      expect(anchors.has(anchor), anchor).toBe(true);
  });

  it("redirects the old URLs to the section that holds their content, with a 301 each", () => {
    const rules = parseRedirectRules(pagesRedirects());
    expect(rules).toEqual(
      PAGE_REDIRECTS.map(([from, to]) => ({ from, to, status: 301 })),
    );
    const byFrom = Object.fromEntries(rules.map((r) => [r.from, r]));
    expect(byFrom["/semantic-html"].to).toBe(`${PAGE}#use-htmls-elements`);
    expect(byFrom["/name-attribute"].to).toBe(
      `${PAGE}#name-form-controls-and-groups`,
    );
    for (const { from, to } of rules) {
      // The old page is gone (a static page would never be reached: Pages follows the redirect first).
      expect(existsSync(path.join(DOCS, `src/pages${from}.html`)), from).toBe(
        false,
      );
      const [page, anchor] = to.split("#");
      expect(existsSync(path.join(DOCS, `src/pages${page}.html`)), to).toBe(
        true,
      );
      expect(anchors.has(anchor), to).toBe(true);
    }
  });

  it("says Bascik ships the element you wrote and guides and warns instead of restricting", () => {
    const text = prose(md);
    expect(text).toMatch(/Bascik ships the code you wrote/);
    expect(text).toMatch(/never turns a `<nav>` into a `<div>`/);
    expect(text).toMatch(/guides and warns/);
    expect(text).toMatch(/never rewrites or rejects your markup/);
    expect(text).not.toMatch(/Bascik (enforces|requires|blocks|rejects)/);
  });

  it("covers the checklist and links the HTML standard and MDN", () => {
    const elements = section("Use HTML's Elements");
    for (const topic of [
      "<header>",
      "<nav>",
      "<main",
      "<footer>",
      "<h1>",
      "<button",
      "<a href>",
      "<ul>",
      "<table>",
      "<figure>",
      "<time",
      "<address>",
      "<label>",
      "<fieldset>",
      "<legend>",
      "<details>",
      "<dialog>",
      "popover",
      "alt",
      "lang",
    ])
      expect(elements, topic).toContain(topic);
    expect(elements).toMatch(
      /\]\(https:\/\/html\.spec\.whatwg\.org\/multipage\//,
    );
    expect(elements).toMatch(/\]\(https:\/\/developer\.mozilla\.org\/en-US\//);
  });

  it("says tag names never reach the browser, and to name tags after what they are", () => {
    const text = prose(md);
    expect(md).toContain("\n### Tag Names Never Reach the Browser\n");
    expect(text).toMatch(/never see the tag name/);
    expect(text).toMatch(/does not have to be a semantic element/);
    expect(text).toMatch(/name a component after what it is/);
    expect(text).not.toMatch(/tag names? (must|should) be semantic/i);
  });

  it("says an attribute already on the root wins over the usage tag's", () => {
    // Real build: <nav aria-label="Root"> used as <site-nav aria-label="Usage" /> ships aria-label="Root".
    expect(prose(md)).toMatch(/already (set )?on the root wins/);
  });

  it("the good nav section does not claim Bascik adds nothing when its Output shows a scoped class", () => {
    expect(prose(md)).not.toMatch(/adds nothing/);
    expect(prose(md)).toMatch(/adds no element or role/);
  });

  it("the nav demos' label does not clash with a navigation landmark the docs site already has", () => {
    const siteLabels = new Set(
      [
        ...read("src/components/docs-nav/docs-nav.html").matchAll(
          /aria-label="([^"]+)"/g,
        ),
      ].map((m) => m[1]),
    );
    expect(siteLabels.has("Main")).toBe(true);
    const used = [
      ...shell.matchAll(/<site-nav\b[^>]*aria-label="([^"]+)"/g),
      ...md.matchAll(/<site-nav\b[^>]*aria-label="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const label of used) expect(siteLabels.has(label), label).toBe(false);
  });

  it("does not make every card an <article>: one that stands on its own, per the spec's definition", () => {
    const table = md.slice(
      md.indexOf("| Component job"),
      md.indexOf("\n\n", md.indexOf("| Component job")),
    );
    expect(table).not.toMatch(/card[^\n]*\|\s*`<article>`/i);
    expect(prose(md)).toMatch(
      /A card is an .{0,120}only when it stands on its own/,
    );
  });

  it("says name ships as written, names both fixes for a repeated radio group, the lint, and the clobbering hazard", () => {
    const names = section("Name Form Controls and Groups");
    const text = prose(names);
    expect(text).toMatch(/ships every `name` exactly as you write it/);
    expect(text).toMatch(/contract with the rest of the page/);
    expect(names).toContain("<form>");
    expect(names).toContain('data-bascik-attr-name="group"');
    expect(names).toContain("data-bascik-prop-group");
    expect(names).toContain("shared-name-group");
    expect(names).toContain("`action`");
    expect(names).toContain("`submit`");
    expect(names).toContain('| `<input type="radio">`');
    expect(names).toContain("| `<details>`");
    expect(names).toContain("| `<iframe>`");
  });

  it("keeps the opt-in short and routes to the Configuration page, which documents it in full", () => {
    const names = section("Name Form Controls and Groups");
    expect(names).not.toContain("defineConfig(");
    expect(names).toContain("](/configuration#scopingattributesname)");
    const config = read("content/configuration.md");
    expect(config).toContain("\n### `scoping.attributes.name`\n");
    expect(config).toContain("scoping: { attributes: { name: true } }");
    expect(config).toContain('data-bascik-preserve="name"');
    expect(config).toMatch(
      /\]\(\/component-best-practices#name-form-controls-and-groups\)/,
    );
  });

  it("the page shell renders the Markdown in ranges whose headings exist, with one demo box per demo", () => {
    for (const [, heading] of shell.matchAll(/(?:from|to): "([^"]+)"/g))
      expect(md, heading).toMatch(
        new RegExp(
          `\\n#{2,4} ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`,
        ),
      );
    expect(shell.match(/<component-demo\b/g)).toHaveLength(6);
    expect(shell).not.toContain("semantic-html.md");
    expect(shell).not.toContain("name-attribute.md");
  });

  it("uses no em dashes", () => {
    expect(md).not.toContain("—");
  });

  it("nothing links to the old URLs any more", () => {
    const stale = /\]\(\/(semantic-html|name-attribute)[)#]/;
    for (const rel of [
      "content",
      "src/pages",
      "../skills",
      "../pkg/src/lib/agent-setup.ts",
      "../create/src/agent-setup.ts",
    ]) {
      const abs = path.join(DOCS, rel);
      const files = existsSync(abs) && !abs.endsWith(".ts") ? walk(abs) : [abs];
      for (const file of files)
        expect(readFileSync(file, "utf8"), file).not.toMatch(stale);
    }
    for (const skill of ["bascik", "bascik-components", "bascik-compatibility"])
      expect(read(`../skills/${skill}/SKILL.md`)).not.toMatch(
        /\/(semantic-html|name-attribute)\b/,
      );
  });

  it("is linked from Getting Started, Why Bascik, Components, the FAQ, Switch, and Lighthouse Accessibility", () => {
    for (const page of [
      "content/getting-started.md",
      "content/why-bascik.md",
      "content/components.md",
      "content/faq.md",
      "content/switch.md",
      "content/lighthouse/accessibility.md",
    ])
      expect(read(page), page).toMatch(
        /\]\(\/component-best-practices#use-htmls-elements\)/,
      );
  });

  it("Components has a Pick the Root Element section that names the rule and links here", () => {
    const components = read("content/components.md");
    const start = components.indexOf("\n## Pick the Root Element\n");
    expect(start).toBeGreaterThan(-1);
    const section = components.slice(
      start,
      components.indexOf("\n## ", start + 5),
    );
    expect(section).toContain("<site-nav>");
    expect(section).toContain("<nav");
    expect(section).toMatch(
      /\]\(\/component-best-practices#use-htmls-elements\)/,
    );
  });

  it("the FAQ answers whether Bascik enforces semantic HTML: it guides and warns, never restricts", () => {
    const faq = read("content/faq.md");
    const at = faq.indexOf("Does Bascik enforce semantic HTML?");
    expect(at).toBeGreaterThan(-1);
    const answer = prose(faq.slice(at, faq.indexOf("\n#", at + 10)));
    expect(answer).toMatch(/warn/);
    expect(answer).toMatch(/never/);
  });

  it("Getting Started's first page has lang and a <main> around its content", () => {
    const gs = read("content/getting-started.md");
    const pageBlock =
      /```html\n(<!-- src\/pages\/index\.html -->[\s\S]*?)```/.exec(gs)?.[1];
    expect(pageBlock).toBeDefined();
    expect(pageBlock).toMatch(/<html lang="en">/);
    expect(pageBlock).toMatch(/<main\b[\s\S]*<h1>[\s\S]*<\/main>/);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(md|html)$/.test(e.name))
    .filter((e) => !e.parentPath.includes("node_modules"))
    .map((e) => path.join(e.parentPath, e.name));
}
