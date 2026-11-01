/**
 * Linear-time checks for the two attribute decoders (character-references.ts
 * for props, url-safety.ts for the URL check), which share one reference
 * regex. A prop value or inherited attribute is author text of any length.
 */
import { describe, expect, it } from "vitest";
import { decodeCharacterReferences } from "./character-references.ts";
import { decodeAttributeEntities } from "./url-safety.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

describe("character reference decoding takes linear time", () => {
  it.each([
    ["many short names with no semicolon", "&a"],
    ["one long name with no semicolon", "a"],
    ["a long run of digits", "1"],
    ["mixed references", "&mdash;&#150;&#x2014;&amp;x"],
  ])(
    "on %s",
    (_label, unit) => {
      const input = (n: number) =>
        unit.length === 1 && unit !== "&"
          ? `&${unit === "1" ? "#" : ""}${repeatTo(unit, n)}`
          : repeatTo(unit, n);
      expect(decodeCharacterReferences(input(40))).toBe(
        decodeCharacterReferences(input(40)),
      );
      expectLinearTime(input, 200_000, decodeCharacterReferences);
      expectLinearTime(input, 200_000, decodeAttributeEntities);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
