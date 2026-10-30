/**
 * /semantic-html (Collin 2026-10-29: "Bascik is all about web standards, which also means an emphasis on semantic
 * HTML. Not sure our docs or skills mention this, but it should.")
 *
 * - The page is in the Overview section of the nav, right after "Why Bascik", and its h1 is its nav label.
 * - It says Bascik ships the element you wrote and never rewrites or rejects markup: it guides and warns.
 * - It links to the HTML standard (WHATWG) and MDN, and covers landmarks, headings, buttons and links, lists, tables,
 *   figure, time, address, labels with fieldset and legend, native elements before ARIA, alt, and lang.
 * - Getting Started, Why Bascik, Components, the FAQ, Switch, and Lighthouse Accessibility link to it.
 * - The examples on those entry pages follow it: Getting Started's first page has lang and <main>.
 *
 * docs/scripts/semantic-html-demos.test.ts builds the demo boxes with the real compiler.
 *
 * Misuse lens: a page missing from the nav, a link that points at a stale anchor, prose that suggests Bascik enforces
 * or rewrites markup, an em dash, and an entry-page example that teaches the opposite of the page.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NAV } from "./nav.ts";

const DOCS = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const md = read("content/semantic-html.md");

/** Prose only: fenced blocks and comments removed, whitespace collapsed. */
const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ");

describe("/semantic-html", () => {
  it("sits in Overview right after Why Bascik, with an h1 equal to its label", () => {
    const overview = NAV.find((s) => s.section === "Overview")!;
    const hrefs = overview.pages.map((p) => p.href);
    expect(hrefs.indexOf("/semantic-html")).toBe(
      hrefs.indexOf("/why-bascik") + 1,
    );
    const entry = overview.pages.find((p) => p.href === "/semantic-html")!;
    expect(entry.label).toBe("Semantic HTML");
    expect(md.split("\n")[0]).toBe("# Semantic HTML");
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
      expect(md, topic).toContain(topic);
    expect(md).toMatch(/\]\(https:\/\/html\.spec\.whatwg\.org\/multipage\//);
    expect(md).toMatch(/\]\(https:\/\/developer\.mozilla\.org\/en-US\//);
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
    const shell = read("src/pages/semantic-html.html");
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

  it("uses no em dashes", () => {
    expect(md).not.toContain("—");
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
      expect(read(page), page).toMatch(/\]\(\/semantic-html(#[\w-]+)?\)/);
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
    expect(section).toMatch(/\]\(\/semantic-html/);
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
