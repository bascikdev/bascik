import { describe, it, expect } from "vitest";
import {
  findCompatibilityMatches,
  maskComments,
} from "./compatibility-checker.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("rule patterns on hostile input", () => {
  it.each([
    ["document.getElementById(", 20_000],
    ["document.getElementById( ", 20_000],
    ["document.getElementById('a", 20_000],
    ["document.getElementById(a.b.getAttribute('for'", 20_000],
    ["document.getElementById(a.getAttribute('href').slice(", 20_000],
    ["document.querySelector('.a", 20_000],
    ["document.getElementsByClassName('a", 20_000],
  ] as const)(
    "scans %j repeated without a closing parenthesis in linear time",
    (unit, count) => {
      const text = (n: number) => unit.repeat(n);
      expectLinearTime(text, count, (t) => findCompatibilityMatches(t, "js"));
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("maskComments", () => {
  it.each([
    ["css", '"', '\\"', 100_000],
    ["css", "'", "\\'", 100_000],
    ["css", "", "url( ", 60_000],
    ["css", "", 'url("', 60_000],
    ["css", "", "/*a", 60_000],
    ["js", "`", "\\`", 100_000],
    ["js", "", "/*a", 60_000],
  ] as const)(
    "stays linear on unclosed %s input %j + %j repeated",
    (kind, head, unit, count) => {
      // The replaced regex took tens of seconds on each of these.
      const text = (n: number) => head + unit.repeat(n);
      expect(maskComments(text(count), kind)).toBe(text(count));
      expectLinearTime(text, count, (t) => maskComments(t, kind));
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
