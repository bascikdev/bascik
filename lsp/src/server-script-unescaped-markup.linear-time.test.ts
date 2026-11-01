/**
 * Linear-time checks for server-script-unescaped-markup
 * (server-script-unescaped-markup.test.ts has the rule's behavior).
 * CPU-growth sampling takes minutes on Windows, so these run in the
 * `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeServerScriptSource,
  type AnalyzeOptions,
} from "./server-script-rules.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const RULE = "server-script-unescaped-markup";
const IMPORT = `import { html, raw, esc, safeUrl, json } from "@bascik/bascik/html";\n`;

const analyze = (body: string) =>
  analyzeServerScriptSource(body, {
    hasSrcAttribute: false,
    directive: "server",
  } as AnalyzeOptions);

/** The source text each diagnostic of the rule covers. */
const covered = (body: string) =>
  analyze(body)
    .filter((d) => d.code === RULE)
    .map((d) => body.slice(d.start, d.end));

describe("server-script-unescaped-markup: linear time", () => {
  // Tick-aware CPU-time growth: see linear-time.test.util.ts.
  const growthOfBodies = (small: string, large: string): number =>
    growthOf(
      () => analyze(small),
      () => analyze(large),
    );

  it(
    "templates nested deep read in linear time, with no stack overflow (CPU growth under 8x for 4x the depth)",
    () => {
      // The template finder and the tokenizer keep the open templates on an
      // explicit stack (fix round 1): recursion overflowed past ~5000.
      const nested = (depth: number) =>
        "export default (q) => " +
        "`<b>${".repeat(depth) +
        "q" +
        "}</b>`".repeat(depth) +
        ";\n";
      const small = nested(5_000);
      const large = nested(20_000);
      expect(covered(large)).toHaveLength(20_000);
      expect(growthOfBodies(small, large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "a 10k-line script of markup templates lints in linear time (CPU growth under 8x for 4x the lines)",
    () => {
      const line = (i: number) =>
        `  out += \`<li data-i="\${i}">\${rows[${i}].name} \${esc(rows[${i}].x)}</li>\`;\n`;
      const script = (lines: number) =>
        `${IMPORT}export default () => {\n  let out = "";\n${Array.from({ length: lines }, (_, i) => line(i)).join("")}  return out;\n};\n`;
      const small = script(2_500);
      const large = script(10_000);
      const diags = analyze(large).filter((d) => d.code === RULE);
      expect(diags).toHaveLength(10_000 * 2);
      expect(growthOfBodies(small, large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "an import specifier with a long run of tabs reads in linear time (CPU growth under 8x for 4x the tabs)",
    () => {
      // `{ html<tabs>x }`: splitting the specifier on /\s+as\s+/ retried the
      // tab run from every tab, so typing in a large import froze the editor.
      const script = (tabs: number) =>
        `import { html${"\t".repeat(tabs)}x } from "@bascik/bascik/html";\nexport default () => \`<p>\${q}</p>\`;\n`;
      const small = script(5_000);
      const large = script(20_000);
      expect(covered(large)).toEqual(["${q}"]);
      expect(growthOfBodies(small, large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each([
    [
      "an unquoted attribute and text",
      (i: number) => `<li class=\${x${i}}>\${y${i}}</li>`,
    ],
    ["text before a tag", (i: number) => `\${x${i}}<b>`],
    ["a hole where an attribute name goes", (i: number) => `<p \${x${i}}`],
  ])(
    "one long template with many holes (%s) lints in linear time in a module (CPU growth under 8x for 4x the holes)",
    (_name, item) => {
      // Each hole once re-read the whole template before it, so one 12k-row
      // table helper took 37 seconds in bascik --check.
      const module = (n: number) =>
        `export const table = () => \`${Array.from({ length: n }, (_, i) => item(i)).join("\n")}\`;\n`;
      const lint = (body: string) =>
        analyzeServerScriptSource(body, {
          hasSrcAttribute: false,
          directive: "module",
        } as AnalyzeOptions);
      const small = module(2_000);
      const large = module(8_000);
      lint(small);
      expect(
        growthOf(
          () => lint(small),
          () => lint(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("build-time code and Node modules: linear time (review round 2)", () => {
  const analyzeModule = (body: string) =>
    analyzeServerScriptSource(body, {
      hasSrcAttribute: false,
      directive: "module",
      escapeFunctions: [],
    } as AnalyzeOptions);
  const growthOfModules = (small: string, large: string): number =>
    growthOf(
      () => analyzeModule(small),
      () => analyzeModule(large),
    );

  it(
    "nested declarations, each scanned to its end, read in linear time (CPU growth under 8x for 4x the depth)",
    () => {
      const nested = (d: number) =>
        Array.from({ length: d }, (_, i) => `const a${i} = () => { `).join("") +
        "return 1;" +
        " };".repeat(d);
      expect(growthOfModules(nested(2_000), nested(8_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "a one-line run of declarations with no end reads in linear time (CPU growth under 8x for 4x the run)",
    () => {
      const run = (n: number) => "const a = x / y / `<p>${z}</p>` / ".repeat(n);
      expect(growthOfModules(run(2_500), run(10_000))).toBeLessThan(8);
      const open = (n: number) => "const a = `<p>${x}".repeat(n);
      expect(growthOfModules(open(2_500), open(10_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "a local name declared in every function is read once, not once per hole (CPU growth under 8x for 4x the functions; review round 3)",
    () => {
      // findBindings collects every `const count` in the module, and each
      // `${count}` hole once checked all of them: 2000 helpers took 8.5 s.
      const helper = (i: number) =>
        `export function card${i}(items: string[], done: number) {\n  const count = items.length;\n  const pct = Math.round((done / count) * 100);\n  return \`<p class="progress">\${count} items, \${pct}%</p>\`;\n}\n`;
      const module = (n: number) =>
        Array.from({ length: n }, (_, i) => helper(i)).join("");
      expect(analyzeModule(module(250)).filter((d) => d.code === RULE)).toEqual(
        [],
      );
      expect(growthOfModules(module(500), module(2_000))).toBeLessThan(8);
      const division = (n: number) =>
        "const r = a / b; const h = `<p>${r}</p>`;\n".repeat(n);
      expect(growthOfModules(division(1_000), division(4_000))).toBeLessThan(8);
      const regex = (n: number) =>
        "const r = /`/; const h = `<p>${r}</p>`;\n".repeat(n);
      expect(growthOfModules(regex(1_000), regex(4_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "templates nested in each other's holes read in linear time (CPU growth under 8x for 4x the depth)",
    () => {
      const nested = (n: number) =>
        "export const t = () => " +
        "`<p>${".repeat(n) +
        "x" +
        "}</p>`".repeat(n) +
        ";";
      expect(growthOfModules(nested(500), nested(2_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
