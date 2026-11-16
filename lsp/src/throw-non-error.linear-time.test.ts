/**
 * Linear-time checks for `findNonErrorThrows` (throw-non-error.test.ts has
 * the rule's behavior). It runs on every directive script and Node module on
 * every edit, so no shape of code, finished or half-typed, may make it read
 * the rest of the script again per throw, per bracket or per operator:
 * groups are stepped over through a bracket table, a type-argument look is
 * capped, and an executor's reject calls are found through an index of
 * names. CPU-growth sampling takes seconds on Windows, so these run in the
 * `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import { findNonErrorThrows } from "./throw-non-error.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const cases: Array<[string, (n: number) => string]> = [
  ["many thrown strings", (n) => 'if (a) throw "not found";\n'.repeat(n)],
  [
    "a thrown string in deeply nested parentheses",
    (n) => `throw ${"(".repeat(n)}"x"${")".repeat(n)};`,
  ],
  ["parentheses that never close", (n) => "throw (".repeat(n)],
  ["a long concatenation", (n) => `throw "a"${" + a".repeat(n)};`],
  [
    "a chain of comparisons, each a possible type argument list",
    (n) => `throw a${" < b".repeat(n)};`,
  ],
  [
    "a chain of generic calls",
    (n) => `throw ${"f<T>(".repeat(n)}x${")".repeat(n)};`,
  ],
  ["a chain of casts", (n) => `throw "x"${" as T".repeat(n)};`],
  ["a long sequence", (n) => `throw ${"(a, 'x'), ".repeat(n)}'y';`],
  ["a long conditional chain", (n) => `throw ${"c ? 'a' : ".repeat(n)}'b';`],
  ["prefix operators", (n) => `throw ${"!".repeat(n)}x;`],
  ["a deep member chain", (n) => `throw err${".cause".repeat(n)};`],
  [
    "throws nested in functions inside a thrown value",
    (n) => `${'throw "a" + f(() => { '.repeat(n)}throw "b";${" });".repeat(n)}`,
  ],
  [
    "templates nested in holes",
    (n) => `throw ${"`${".repeat(n)}x${"}`".repeat(n)};`,
  ],
  ["unclosed templates", (n) => "throw `${".repeat(n)],
  ["throw keywords with nothing after them", (n) => "throw ".repeat(n)],
  ["many Promise.reject() calls", (n) => "Promise.reject('x');\n".repeat(n)],
  ["Promise.reject( that never closes", (n) => "Promise.reject(".repeat(n)],
  [
    "Promise.reject() nested in its own argument",
    (n) => `${"Promise.reject((".repeat(n)}"x"${"))".repeat(n)}`,
  ],
  [
    "executors nested in executors, each with the same reject name",
    (n) =>
      `${"new Promise((resolve, reject) => { reject('x'); ".repeat(n)}${"});".repeat(n)}`,
  ],
  [
    "executors nested in a reject call's argument",
    (n) => `${"new Promise((a, rej) => rej(".repeat(n)}'x'${"))".repeat(n)}`,
  ],
  [
    "one executor with many reject calls",
    (n) =>
      `new Promise((resolve, reject) => { ${"reject('x'); ".repeat(n)} });`,
  ],
  [
    "one executor with many plain reads of reject",
    (n) =>
      `new Promise((resolve, reject) => { ${"on('error', reject); ".repeat(n)} });`,
  ],
  [
    "executors that never close",
    (n) => "new Promise((resolve, reject".repeat(n),
  ],
  [
    "a multi-line comment between every token",
    (n) => `throw "a"${" /*\n*/ + /*\n*/ a".repeat(n)};`,
  ],
];

describe("findNonErrorThrows: linear time", () => {
  it.each(cases)(
    "misuse: %s",
    (_label, script) => {
      expect(() => findNonErrorThrows(script(10))).not.toThrow();
      const runOf = (n: number) => {
        const text = script(n);
        return () => findNonErrorThrows(text);
      };
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      expect(growthOf(runOf(2_000), runOf(8_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
