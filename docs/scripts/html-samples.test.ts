/**
 * Every html`...` template a reader can copy runs through the real html tag here: the code samples in the docs
 * (docs/content), the agent skills (skills/**\/*.md and their reference templates), the docs diagrams
 * (docs/src/diagrams), and the source of the examples, the starter site, create-bascik and the docs site itself.
 *
 * html checks a template's structure before it looks at any value, and refuses what it cannot make safe: two holes
 * side by side in a URL attribute (url-scheme-split), a hole in an event handler, a hole in a tag name, and so on.
 * Those refusals throw at run time, so a sample that reads fine can still crash every page it is pasted into. The
 * test calls html with each template's own strings and a plain string for every hole, and fails on any structural
 * refusal. Refusals that depend on the value (a string where json() belongs, markup in an attribute) are skipped:
 * the test does not know the sample's real values.
 *
 * Test files are skipped (they build refused templates on purpose), and so is prose: a heading that quotes a refused
 * template to explain the error is not a sample.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { html, HtmlError, type HtmlErrorCode } from "@bascik/bascik/html";

const REPO = path.resolve(import.meta.dirname, "../..");

/** Refusals that depend on the value in the hole, not the template: the test's placeholder values cannot judge them. */
const VALUE_CODES = new Set<HtmlErrorCode>([
  "promise",
  "markup-in-attribute",
  "array-in-attribute",
  "markup-in-text-only",
  "json-script-value",
  "unconvertible-value",
  "array-depth",
  "raw-text-end",
]);

export interface HtmlTemplateSample {
  /** 1-based line of the html` tag in the source text. */
  line: number;
  /** The template's literal parts, as written (raw). */
  raw: string[];
}

/** The end of a string or template literal that starts at `start` (the quote), or text.length. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") i += 2;
    else if (quote === "`" && text.startsWith("${", i))
      i = skipExpression(text, i + 2) + 1;
    else i++;
  }
  return i;
}

/** The index of the } that closes a ${ expression whose body starts at `start`, or text.length. */
function skipExpression(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = skipQuoted(text, i) + 1;
    else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      if (--depth === 0) return i;
      i++;
    } else i++;
  }
  return i;
}

/** Every html`...` template in a piece of code, nested ones included, with its literal parts. */
export function htmlTemplates(code: string): HtmlTemplateSample[] {
  const out: HtmlTemplateSample[] = [];
  for (const tag of code.matchAll(/(?<![\w$])html`/g)) {
    const raw: string[] = [];
    let part = "";
    let i = tag.index + 5;
    let closed = false;
    while (i < code.length) {
      const c = code[i];
      if (c === "`") {
        closed = true;
        break;
      }
      if (c === "\\") {
        part += code.slice(i, i + 2);
        i += 2;
      } else if (code.startsWith("${", i)) {
        raw.push(part);
        part = "";
        i = skipExpression(code, i + 2) + 1;
      } else {
        part += c;
        i++;
      }
    }
    if (!closed) continue;
    raw.push(part);
    out.push({ line: code.slice(0, tag.index).split("\n").length, raw });
  }
  return out;
}

const cook = (raw: string): string =>
  raw.replace(
    /\\(.)/gs,
    (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c,
  );

/** The structural refusal html gives a template, or undefined when it renders with plain string values. */
export function structuralRefusal(
  sample: HtmlTemplateSample,
): HtmlError | undefined {
  const strings = Object.assign(sample.raw.map(cook), {
    raw: sample.raw,
  }) as unknown as TemplateStringsArray;
  const values = sample.raw.slice(1).map(() => "book-card");
  try {
    html(strings, ...values);
    return undefined;
  } catch (error) {
    if (error instanceof HtmlError && !VALUE_CODES.has(error.code))
      return error;
    if (error instanceof HtmlError) return undefined;
    throw error;
  }
}

/** The structural refusals in one file's samples, as `file:line: message`. Markdown is read only inside fences. */
export function refusedSamples(text: string, file: string): string[] {
  const blocks: { code: string; firstLine: number }[] = [];
  if (file.endsWith(".md")) {
    const fence = /^(\s*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2\s*$/gm;
    for (const f of text.matchAll(fence))
      blocks.push({
        code: f[3],
        firstLine: text.slice(0, f.index).split("\n").length + 1,
      });
  } else blocks.push({ code: text, firstLine: 1 });
  const out: string[] = [];
  for (const { code, firstLine } of blocks)
    for (const sample of htmlTemplates(code)) {
      const refusal = structuralRefusal(sample);
      if (refusal)
        out.push(
          `${file}:${firstLine + sample.line - 1}: ${refusal.code}: ${refusal.message}`,
        );
    }
  return out;
}

/** Where readers copy html templates from: [root, which files count]. */
const SOURCES: [string, (rel: string) => boolean][] = [
  ["docs/content", (rel) => rel.endsWith(".md")],
  ["docs/src/diagrams", (rel) => rel.endsWith(".md")],
  [
    "skills",
    (rel) =>
      rel.endsWith(".md") ||
      (rel.includes("/references/") && /\.(?:ts|mjs|js|html)$/.test(rel)),
  ],
  ["examples", (rel) => /\.(?:ts|mjs|js|html|md)$/.test(rel)],
  ["create/src", (rel) => /\.(?:ts|mjs|js|html)$/.test(rel)],
  ["docs/src", (rel) => /\.(?:ts|html)$/.test(rel)],
];

function sampleFiles(): string[] {
  const files = new Set<string>();
  for (const [root, keep] of SOURCES) {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === ".cache")
          continue;
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else {
          const rel = path.relative(REPO, abs).replace(/\\/g, "/");
          if (/\.test\.[cm]?[jt]s$/.test(rel)) continue;
          if (keep(rel)) files.add(rel);
        }
      }
    };
    walk(path.join(REPO, root));
  }
  return [...files].sort();
}

describe("htmlTemplates and refusedSamples (misuse lens)", () => {
  it("reports two holes side by side in a URL attribute, at the line of the html tag", () => {
    const md = [
      "```ts",
      'import { html } from "@bascik/bascik/html";',
      "export const canonical = (siteUrl: string, urlPath: string) =>",
      '  html`<link rel="canonical" href="${siteUrl}${urlPath}" />`;',
      "```",
    ].join("\n");
    const found = refusedSamples(md, "x.md");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^x\.md:4: url-scheme-split: /);
  });

  it("reports a refused template nested in another template's hole, and one in an HTML component", () => {
    const component = [
      "<ul>",
      "<script data-bascik-build-once>",
      '  import { html } from "@bascik/bascik/html";',
      '  export default () => html`<li>${items.map((i) => html`<a href="${i.base}${i.slug}">${i.name}</a>`)}</li>`;',
      "</script>",
      "</ul>",
    ].join("\n");
    expect(refusedSamples(component, "c.html")).toEqual([
      expect.stringMatching(/^c\.html:4: url-scheme-split: /),
    ]);
    // A hole in an event handler is refused whatever the value is.
    expect(
      refusedSamples(
        'const b = html`<button onclick="${f}">Go</button>`;',
        "b.ts",
      ),
    ).toEqual([expect.stringMatching(/^b\.ts:1: event-handler: /)]);
  });

  it("allows one hole per URL, a hole after the first /, value-dependent cases, escaped backticks, and prose", () => {
    const md = [
      'Never write `` html`<a href="${a}${b}">` `` yourself.',
      "",
      "```ts",
      "const href = `${siteUrl}${urlPath}`;",
      'const a = html`<link rel="canonical" href="${href}" />`;',
      'const b = html`<a href="${base}/blog/${slug}">${title}</a>`;',
      "const c = html`<p title=\"${'}'}\">${`x${y}`}</p>`;",
      'const d = html`<script type="application/ld+json">${json(data)}</script>`;',
      "const e = html`<code>\\`${name}\\`</code>`;",
      "```",
    ].join("\n");
    expect(refusedSamples(md, "x.md")).toEqual([]);
  });

  it("does not read an unclosed html template as a sample", () => {
    expect(htmlTemplates("const x = html`<p>${a}</p>")).toEqual([]);
  });
});

describe("html templates readers copy", () => {
  it("render with html, so no sample throws HtmlError on first use", () => {
    const texts = sampleFiles().map(
      (rel) => [rel, readFileSync(path.join(REPO, rel), "utf8")] as const,
    );
    // The scan reaches the samples: a broken walk or extractor would pass with nothing checked.
    const count = texts.reduce((n, [, t]) => n + htmlTemplates(t).length, 0);
    expect(count).toBeGreaterThan(300);
    const found = texts.flatMap(([rel, text]) => refusedSamples(text, rel));
    expect(
      found,
      'html refused one of these templates. For url-scheme-split, build the URL in code and use one hole: const href = `${siteUrl}${urlPath}`; html`<a href="${href}">`. See docs/content/html-helpers.md.',
    ).toEqual([]);
  });
});
