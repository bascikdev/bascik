/**
 * No code sample in the docs (docs/content) or the agent skills (skills/**\/*.md) builds markup from data in a plain
 * template string either: a template that starts with a tag and has a hole is html`...`, or every hole is esc() or
 * safeUrl() (a feed, a sitemap). The language server's server-script-unescaped-markup only reads server and stream
 * scripts, so this test is what holds build-script, helper and exec-script samples to the rule.
 *
 * No code sample in the docs (docs/content) or the agent skills (skills/**\/*.md) writes its own HTML escaper.
 * Readers and agents copy samples, and a hand-written escapeHtml copied from a Bascik page ends up in every site
 * built from it. Samples build markup with `html` from @bascik/bascik/html instead (raw() for trusted markup,
 * json() for JSON-LD, esc() for a string built without html). The detector is the one audit-components uses
 * (skills/bascik/scripts/lib/escapers.mjs), so an XML escaper with a comment saying so passes here too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { handWrittenEscapers } from "../../skills/bascik/scripts/lib/escapers.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const ROOTS = ["docs/content", "skills"];

/** The hand-written escapers in one Markdown file's fenced code blocks, as `file:line`. */
export function escapersInMarkdown(md: string, file: string): string[] {
  const out: string[] = [];
  const fence = /^(\s*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2\s*$/gm;
  for (const f of md.matchAll(fence)) {
    const blockLine = md.slice(0, f.index).split("\n").length + 1;
    for (const escaper of handWrittenEscapers(f[3]))
      out.push(`${file}:${blockLine + escaper.line - 1}`);
  }
  return out;
}

/** Holes a plain template string may hold: values a Bascik escaper already made safe. */
const ESCAPED_HOLE = /^\s*(?:esc|safeUrl)\(/;

/**
 * Plain template strings that start with a tag and interpolate a value without esc() or safeUrl(), in one Markdown
 * file's fenced JavaScript, TypeScript and HTML blocks, as `file:line`. A template tagged html (or any tag) is fine.
 */
export function plainMarkupTemplatesInMarkdown(
  md: string,
  file: string,
): string[] {
  const out: string[] = [];
  const fence = /^(\s*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\2\s*$/gm;
  for (const f of md.matchAll(fence)) {
    const lang = f[3].trim().split(/\s/)[0];
    if (!/^(?:ts|js|mjs|typescript|javascript|html)?$/.test(lang)) continue;
    const body = f[4];
    const blockLine = md.slice(0, f.index).split("\n").length + 1;
    for (const open of body.matchAll(/(?<![\w$.\]\)])`\s*<[A-Za-z!?]/g)) {
      const holes: string[] = [];
      let i = open.index + 1;
      while (i < body.length && body[i] !== "`") {
        if (body[i] === "\\") i += 2;
        else if (body.startsWith("${", i)) {
          let depth = 1;
          let j = i + 2;
          while (j < body.length && depth > 0) {
            if (body[j] === "{") depth++;
            else if (body[j] === "}") depth--;
            j++;
          }
          holes.push(body.slice(i + 2, j - 1));
          i = j;
        } else i++;
      }
      // An XML document wrapper (<?xml ...) joins entries that esc() already escaped.
      const xmlDocument = /^`\s*<\?xml/.test(
        body.slice(open.index, open.index + 40),
      );
      if (!xmlDocument && holes.some((hole) => !ESCAPED_HOLE.test(hole)))
        out.push(
          `${file}:${blockLine + body.slice(0, open.index).split("\n").length - 1}`,
        );
    }
  }
  return out;
}

function markdownFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".md")) files.push(abs);
    }
  };
  for (const root of ROOTS) walk(path.join(REPO, root));
  return files.sort();
}

describe("escapersInMarkdown (misuse lens)", () => {
  it("reports an escaper in a fenced block at its line in the Markdown file", () => {
    const md = [
      "# Page",
      "",
      "```ts",
      "// src/lib/escape.ts",
      "export const escapeHtml = (s: string) => s.replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`);",
      "```",
      "",
    ].join("\n");
    expect(escapersInMarkdown(md, "x.md")).toEqual(["x.md:5"]);
  });

  it("ignores prose and inline code, a decoder, html, and an XML escaper with a comment saying so", () => {
    const md = [
      'Never write `s.replace(/[&<>]/g, (c) => "&#" + c.charCodeAt(0) + ";")` yourself.',
      "",
      "```ts",
      'const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&amp;/g, "&");',
      'import { html } from "@bascik/bascik/html";',
      "const card = (t: string) => html`<p>${t}</p>`;",
      "// sitemap.xml is XML: escape the five XML characters by hand.",
      'const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");',
      "```",
    ].join("\n");
    expect(escapersInMarkdown(md, "x.md")).toEqual([]);
  });
});

describe("plainMarkupTemplatesInMarkdown (misuse lens)", () => {
  it("reports a plain template that puts a value into markup, at its line", () => {
    const md = [
      "```ts",
      "export async function fetchHeroData() {",
      "  const data = await (await fetch(url)).json();",
      '  return `<h1 class="hero-title">${data.title}</h1>`;',
      "}",
      "```",
      "",
      "```html",
      "<script data-bascik-build>",
      '  export default () => `<link rel="canonical" href="${siteUrl}/about" />`;',
      "</script>",
      "```",
    ].join("\n");
    expect(plainMarkupTemplatesInMarkdown(md, "x.md")).toEqual([
      "x.md:4",
      "x.md:10",
    ]);
  });

  it("allows html templates, holes wrapped in esc() or safeUrl(), templates with no hole, and prose", () => {
    const md = [
      "Never write `` `<p>${name}</p>` `` in a build script.",
      "",
      "```ts",
      "const card = (t: string) => html`<p>${t}</p>`;",
      'const entry = (p: Post) => `<entry><title>${esc(p.title)}</title><link href="${esc(p.url)}" /></entry>`;',
      "const fixed = `<hr />`;",
      "const label = `Hello ${name}`;",
      "```",
      "",
      "```css",
      ".a::after { content: `<b>${x}</b>`; }",
      "```",
    ].join("\n");
    expect(plainMarkupTemplatesInMarkdown(md, "x.md")).toEqual([]);
  });
});

describe("docs and skill code samples", () => {
  it("build markup from data with html, never a plain template string", () => {
    const found = markdownFiles().flatMap((abs) =>
      plainMarkupTemplatesInMarkdown(
        readFileSync(abs, "utf8"),
        path.relative(REPO, abs).replace(/\\/g, "/"),
      ),
    );
    expect(
      found,
      "Build the markup with html from @bascik/bascik/html (see docs/content/html-helpers.md): return html`<p>${value}</p>`, raw() for trusted HTML such as a Markdown renderer's output, esc() for each value of a feed or sitemap.",
    ).toEqual([]);
  });

  it("build markup with html instead of a hand-written escaper", () => {
    const found = markdownFiles().flatMap((abs) =>
      escapersInMarkdown(
        readFileSync(abs, "utf8"),
        path.relative(REPO, abs).replace(/\\/g, "/"),
      ),
    );
    expect(
      found,
      "Build the markup with html from @bascik/bascik/html (see docs/content/html-helpers.md); for XML, use esc() or say why in a comment above the escaper.",
    ).toEqual([]);
  });
});
