/**
 * The language server's Find All References reads component tags the way the
 * compiler does (lsp/src/component-usages.ts mirrors the compiler, since the
 * language server does not depend on this package). This test compares the
 * two on random markup built from the pieces where they could drift: raw-text
 * names and look-alikes (`<style-guide>`, `<script.x>`), names cut short or
 * run on (`<my-card.foo>`, `<my-card</p>`, `<my-card:x>`), comments, quotes,
 * attribute values, tag whitespace, names inside other tags and bogus comments
 * (`<p<my-card>`, `<!x<my-card>`, `</ <my-card>`), and closers with
 * attributes or other white space (`</style/>`, `</style x>`, `</style\v>`).
 *
 * The mirror is loaded by path at run time: the language server is its own
 * package, outside this one's TypeScript root.
 */
import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maskRawTextContent } from "./component-masking.ts";
import { getFirstComponent } from "./component-tags.ts";
import type { ComponentList } from "./types.ts";

interface LspUsages {
  maskLikeCompiler(html: string): string;
  findComponentUsages(
    html: string,
    names: ReadonlySet<string>,
  ): Array<{ name: string; start: number }>;
}

const LSP_USAGES = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "lsp/src/component-usages.ts",
);
const lsp = (await import(pathToFileURL(LSP_USAGES).href)) as LspUsages;

const NAMES = ["my-card", "x-a", "a", "a:b", "style-guide", "script-loader"];
const list = Object.fromEntries(
  NAMES.map((name) => [name, { fileContent: "C" }]),
) as unknown as ComponentList;

/** Every usage the compiler's search finds, `[start, name]`, each search from just after the last. */
const compilerUsages = (html: string): Array<[number, string]> => {
  const masked = maskRawTextContent(html);
  const found: Array<[number, string]> = [];
  for (let from = 0; ;) {
    const usage = getFirstComponent(html, list, masked, from);
    if (usage.name === undefined || usage.index === undefined) return found;
    found.push([usage.index, usage.name]);
    from = usage.index + 1;
  }
};

const lspUsages = (html: string): Array<[number, string]> =>
  lsp
    .findComponentUsages(html, new Set(NAMES))
    .map((usage) => [usage.start, usage.name]);

const PIECES = [
  "<",
  ">",
  "/>",
  "</",
  "<!--",
  "-->",
  "--!>",
  "my-card",
  "MY-CARD",
  "x-a",
  "a",
  "a:b",
  "style",
  "STYLE",
  "script",
  "textarea",
  "style-guide",
  "script-loader",
  "-guide",
  ".foo",
  ":x",
  ":",
  "-",
  "_",
  " ",
  "\t",
  "\n",
  "\f",
  " ",
  '"',
  "'",
  "=",
  "p",
  "x",
  "<p",
  "<!",
  "<?",
  "</ ",
  "<p ",
  "/",
  "\u000b",
  "\u00a0",
  "</style/>",
  "</style x>",
  "</script\u000b>",
  "</my-card x>",
  "</my-card/>",
  '<p title="<script>">',
  "<p title=<style>>",
];

/** A small deterministic generator (mulberry32), so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("Find All References agrees with the compiler on random markup", () => {
  it("masks and finds the same usages on 5,000 random inputs", () => {
    const next = random(20261029);
    for (let run = 0; run < 5_000; run++) {
      const length = 1 + Math.floor(next() * 24);
      let html = "";
      for (let index = 0; index < length; index++)
        html += PIECES[Math.floor(next() * PIECES.length)];
      expect(lsp.maskLikeCompiler(html), JSON.stringify(html)).toBe(
        maskRawTextContent(html),
      );
      expect(lspUsages(html), JSON.stringify(html)).toEqual(
        compilerUsages(html),
      );
    }
  });

  it.each([
    "<style-guide></style-guide><my-card></my-card><style></style>",
    "<script-loader><my-card></my-card></script>",
    "<my-card.foo></my-card.foo><my-card></my-card>",
    "<p><my-card</p><x-a></x-a>",
    "<my-card:x></my-card:x><a:b></a:b><a:c></a>",
    "<style\t><my-card></style><x-a>",
    `<p title="<script>">tip</p><my-card></my-card><script>x()</script>`,
    "<p<style><my-card></my-card></style>",
    "<!x<my-card><my-card></my-card>",
    "</ <my-card>><my-card></my-card>",
    "<?<my-card><x-a></x-a>",
    "<style></style/><my-card></my-card></style>",
    "<style></style\u000b><my-card></my-card></style>",
    "<script></script x=1><my-card></my-card></script>",
    "<!--<my-card></my-card>",
  ])("agrees on %j", (html) => {
    expect(lsp.maskLikeCompiler(html)).toBe(maskRawTextContent(html));
    expect(lspUsages(html)).toEqual(compilerUsages(html));
  });
});
