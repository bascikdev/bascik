/**
 * Prompt 82: single-pass script tokenization and char-code scanning.
 *
 * 1. Operation-count guard: extractScriptDeps must tokenize a script exactly
 *    once. Before this prompt findModuleSpecifiers and
 *    findCallArgumentStringLiterals each tokenized independently (2 passes).
 * 2. Exhaustive BMP equivalence: every char-code predicate used by scanCode
 *    must agree with the regex it replaced on all 65,536 BMP code units.
 * 3. Output identity: the single-pass extraction returns the same specifiers
 *    and call-argument literals as the two separate calls.
 */
import { describe, expect, it } from "vitest";
import {
  __tokenizeStatsForTests,
  findModuleSpecifiers,
  findCallArgumentStringLiterals,
  scanScript,
  __charClassesForTests,
} from "./module-specifiers.ts";
import { extractScriptDeps } from "./build-scripts.ts";

const SAMPLE = `
import { renderMd } from '@/lib/md-renderer.ts';
import x from "./helpers/x.ts"; // comment with 'quotes'
const re = /a[/]b/g; const y = a / b / c;
const data = await readFile('./content/page.md', 'utf8');
const j = JSON.parse(readFileSync("./data/items.json"));
export { x } from '../shared/y.mjs';
const t = \`tpl \${fn('./inner/z.md')} end\`;
console.log(a.import, "not-an-import.md");
`;

describe("extractScriptDeps tokenization count", () => {
  it("tokenizes each script body exactly once", () => {
    __tokenizeStatsForTests.reset();
    extractScriptDeps(SAMPLE, "/proj/src/pages", { importRoot: "/proj/src" });
    expect(__tokenizeStatsForTests.tokenizeCalls).toBe(1);
  });
});

describe("scanScript single-pass extraction matches the two separate calls", () => {
  it("returns identical module specifiers and call-argument literals", () => {
    const { moduleSpecifiers, callArgumentLiterals } = scanScript(SAMPLE);
    expect(moduleSpecifiers).toEqual(findModuleSpecifiers(SAMPLE));
    expect(callArgumentLiterals).toEqual(findCallArgumentStringLiterals(SAMPLE));
    expect(moduleSpecifiers.map((s) => s.value)).toEqual([
      "@/lib/md-renderer.ts",
      "./helpers/x.ts",
      "../shared/y.mjs",
    ]);
    expect(callArgumentLiterals.map((s) => s.value)).toEqual([
      "./content/page.md",
      "utf8",
      "./data/items.json",
      "./inner/z.md",
      "not-an-import.md",
    ]);
  });
});

describe("char-code predicates are exhaustively equivalent to their regexes over the BMP", () => {
  const cases: [string, (code: number) => boolean, RegExp][] = [
    ["isSpace ~ /\\s/", __charClassesForTests.isSpace, /\s/],
    ["isIdStart ~ /[A-Za-z_$]/", __charClassesForTests.isIdStart, /[A-Za-z_$]/],
    ["isIdPart ~ /[A-Za-z0-9_$]/", __charClassesForTests.isIdPart, /[A-Za-z0-9_$]/],
    ["isDigit ~ /[0-9]/", __charClassesForTests.isDigit, /[0-9]/],
    ["isNumberPart ~ /[A-Za-z0-9_.]/", __charClassesForTests.isNumberPart, /[A-Za-z0-9_.]/],
    ["isAlpha ~ /[A-Za-z]/", __charClassesForTests.isAlpha, /[A-Za-z]/],
  ];
  for (const [name, predicate, regex] of cases) {
    it(name, () => {
      const mismatches: number[] = [];
      for (let code = 0; code < 0x10000; code++) {
        if (predicate(code) !== regex.test(String.fromCharCode(code))) mismatches.push(code);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
