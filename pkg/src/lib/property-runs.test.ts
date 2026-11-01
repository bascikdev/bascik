import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPERTY_SEED,
  PROPERTY_TEST_TIMEOUT_MS,
  propertyBounds,
} from "./property-runs.test-helper.ts";

describe("propertyBounds", () => {
  it("runs the CI count from a fixed seed under the 30 s timeout by default", () => {
    const bounds = propertyBounds(150, "MASK_ORACLE_RUNS", {});
    expect(bounds.options).toEqual({ numRuns: 150, seed: PROPERTY_SEED });
    expect(bounds.timeoutMs).toBe(PROPERTY_TEST_TIMEOUT_MS);
    expect(PROPERTY_TEST_TIMEOUT_MS).toBe(30_000);
  });

  it("runs the count the named variable asks for, and gives a deep run a longer timeout", () => {
    const bounds = propertyBounds(150, "MASK_ORACLE_RUNS", {
      MASK_ORACLE_RUNS: "1500",
    });
    expect(bounds.options.numRuns).toBe(1500);
    expect(bounds.timeoutMs).toBe(10 * PROPERTY_TEST_TIMEOUT_MS);
  });

  it("keeps the 30 s floor when the variable asks for fewer runs", () => {
    const bounds = propertyBounds(150, "MASK_ORACLE_RUNS", {
      MASK_ORACLE_RUNS: "20",
    });
    expect(bounds.options.numRuns).toBe(20);
    expect(bounds.timeoutMs).toBe(PROPERTY_TEST_TIMEOUT_MS);
  });

  it("ignores run variables the test does not name", () => {
    const bounds = propertyBounds(150, undefined, { MASK_ORACLE_RUNS: "9" });
    expect(bounds.options.numRuns).toBe(150);
  });

  it("starts from PROPERTY_SEED when it is set, to explore other cases", () => {
    expect(
      propertyBounds(10, undefined, { PROPERTY_SEED: "-42" }).options.seed,
    ).toBe(-42);
  });

  it("gives fast-check exactly the bounded run count and replays the same cases", () => {
    const seen: number[][] = [[], []];
    for (const runs of seen) {
      let count = 0;
      fc.assert(
        fc.property(fc.nat(), (value) => {
          runs.push(value);
          count++;
        }),
        propertyBounds(37, undefined, {}).options,
      );
      expect(count).toBe(37);
    }
    expect(seen[0]).toEqual(seen[1]);
  });

  // fast-check runs no case at all for numRuns NaN or 0 and passes, so a
  // typo'd or empty variable would turn the property into a no-op.
  it.each(["", " ", "abc", "0", "-5", "2.5", "1e400", "12abc"])(
    "misuse: names the variable and the value when MASK_ORACLE_RUNS=%j is not a positive whole number",
    (value) => {
      expect(() =>
        propertyBounds(150, "MASK_ORACLE_RUNS", { MASK_ORACLE_RUNS: value }),
      ).toThrow(
        `MASK_ORACLE_RUNS must be a positive whole number of property runs, got ${JSON.stringify(value)}`,
      );
    },
  );

  it.each(["", "abc", "1.5", "2147483648", "9007199254740993"])(
    "misuse: names PROPERTY_SEED when it is %j, not a 32-bit whole number",
    (value) => {
      expect(() =>
        propertyBounds(10, undefined, { PROPERTY_SEED: value }),
      ).toThrow(
        `PROPERTY_SEED must be a 32-bit whole number, got ${JSON.stringify(value)}`,
      );
    },
  );

  it.each([0, -1, 2.5, Number.NaN])(
    "misuse: rejects a CI run count of %s written in a test",
    (runs) => {
      expect(() => propertyBounds(runs, undefined, {})).toThrow(
        "propertyBounds needs a positive whole number of CI runs",
      );
    },
  );
});
