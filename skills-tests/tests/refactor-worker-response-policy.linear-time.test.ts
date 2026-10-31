/**
 * Growth checks for skills/bascik-refactor/scripts/worker-response-policy.mjs
 * on hostile response bodies. They measure CPU time with
 * linear-time.test-helper.ts, so they run in the `linear-time` Vitest project
 * (`yarn skills:linear-time`), outside the unit project and coverage (R3-19).
 * The fixed-input tests are in refactor-worker-response-policy.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  executableInlineScripts,
  inlineStyles,
} from "../../skills/bascik-refactor/scripts/worker-response-policy.mjs";
import {
  LINEAR_TIME_TIMEOUT_MS,
  measureGrowth,
} from "./linear-time.test-helper.ts";

/**
 * Growth bound for these checks: linear work reads up to twice 4 where the
 * CPU cache holds the quarter size but not the full size (CI read 9.2), so
 * the bar is 12, above the helper's default.
 */
const MAX_HOSTILE_GROWTH = 12;
const CEILING_MS = 2_000;

/**
 * Times a quarter-size and a full-size input in this thread's CPU time
 * (linear-time.test-helper.ts) and requires the growth to stay under
 * `MAX_HOSTILE_GROWTH`, and one full-size run under `CEILING_MS`.
 */
const expectLinearTime = (
  input: (size: number) => string,
  size: number,
  run: (html: string) => unknown,
  label: string,
) => {
  const small = input(size / 4);
  const large = input(size);
  const { growth, smallMs, largeMs, runs } = measureGrowth(
    () => run(small),
    () => run(large),
    { maxGrowth: MAX_HOSTILE_GROWTH },
  );
  const what = `${label}: ${(smallMs / runs).toFixed(2)} ms at a quarter size, ${(largeMs / runs).toFixed(2)} ms at full size, ${runs} runs per sample`;
  expect(growth, `${what} (growth)`).toBeLessThan(MAX_HOSTILE_GROWTH);
  expect(largeMs / runs, `${what} (ceiling)`).toBeLessThan(CEILING_MS);
};

const repeatTo = (unit: string, size: number) =>
  unit.repeat(Math.ceil(size / unit.length));

describe("hostile response bodies take linear time", () => {
  // A server or stream script can reflect visitor input into the body, and with hashResponseBodies: true every HTML
  // response is scanned on the request path: super-linear work here is a per-request denial of service.
  const HOSTILE: [string, (size: number) => string][] = [
    ["start tags that never close", (n) => repeatTo("<script ", n)],
    ["style start tags that never close", (n) => repeatTo("<style ", n)],
    ["an attribute list with no >", (n) => `<script${repeatTo(' a="b"', n)}`],
    ["quote-opening attribute values", (n) => repeatTo('<script a="', n)],
    ["single quotes after =", (n) => repeatTo("<script a='", n)],
    ["quotes in attribute names", (n) => repeatTo(`<script "'`, n)],
    ["start tags with no end tag", (n) => repeatTo("<script>", n)],
    ["style start tags with no end tag", (n) => repeatTo("<style>", n)],
    [
      "end-tag look-alikes with no >",
      (n) => `<script>${repeatTo("</script ", n)}`,
    ],
    [
      "style end-tag look-alikes with no >",
      (n) => `<style>${repeatTo("</style\t", n)}`,
    ],
    ["near-miss end tags", (n) => `<script>${repeatTo("</scrip</scripts", n)}`],
    ["a flood of <", (n) => repeatTo("<", n)],
    ["a flood of </", (n) => `<script>${repeatTo("</", n)}`],
    [
      "one closed tag with a long attribute list",
      (n) => `<script${repeatTo(' a="b" c=d e', n)}>x()</script>`,
    ],
    [
      "one closed tag with long runs of = and whitespace",
      (n) => `<script a${repeatTo("= \t=", n)}>x()</script>`,
    ],
    ["many small scripts", (n) => repeatTo("<script>a()</script>", n)],
    ["many small styles", (n) => repeatTo("<style>.a{}</style>", n)],
    ["nested quoted start tags", (n) => repeatTo(`<script a="<script b='`, n)],
  ];
  it.each(HOSTILE)(
    "%s",
    (label, input) => {
      expectLinearTime(
        input,
        200_000,
        (html) => {
          executableInlineScripts(html);
          inlineStyles(html);
        },
        label,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
