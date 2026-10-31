/**
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

describe("docs and skill code samples", () => {
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
