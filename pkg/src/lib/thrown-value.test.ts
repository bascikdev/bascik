import { describe, expect, it } from "vitest";
import {
  describeNonErrorThrow,
  isWrappedNonErrorThrow,
  toThrownError,
} from "./thrown-value.ts";

describe("describeNonErrorThrow", () => {
  it.each([
    ["just a string", 'the string "just a string"'],
    [null, "null"],
    [undefined, "undefined (or rejected with no reason)"],
    [42, "the number 42"],
    [false, "the boolean false"],
    [{ code: "E_NOPE" }, 'an object {"code":"E_NOPE"}'],
    [Symbol("s"), "the symbol Symbol(s)"],
    [10n, "the bigint 10"],
  ])("names what was thrown: %s", (value, shown) => {
    expect(describeNonErrorThrow(value)).toBe(
      `The script threw ${shown}, not an Error, so it has no stack trace. bascik --check and the editor mark a literal value thrown or rejected in your code (rule throw-non-error), but not a value thrown through a variable or by a dependency: make that value an Error where it is created.`,
    );
  });

  // Misuse: values that cannot be printed as they are.
  it("still describes a circular object and cuts long values short", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeNonErrorThrow(circular)).toContain(
      "The script threw an object [object Object],",
    );
    // At most 200 characters of the value, beside the fixed sentence.
    const limit = describeNonErrorThrow("").length + 210;
    const long = describeNonErrorThrow("x".repeat(5000));
    expect(long.length).toBeLessThan(limit);
    expect(long).toContain("…");
    // A thrown function would print its whole source text.
    const body = "x".repeat(5000);
    const fn = new Function(`return "${body}";`);
    const described = describeNonErrorThrow(fn);
    expect(described).toMatch(/^The script threw the function /);
    expect(described.length).toBeLessThan(limit);
  });

  // The build and routes script runner embeds the function's source text.
  it("runs from its own source text, with nothing outside it", () => {
    // Bound to a name the way the runner binds it.
    const rebuilt = new Function(
      `const describe = ${describeNonErrorThrow.toString()}; return describe;`,
    )() as typeof describeNonErrorThrow;
    expect(rebuilt(null)).toBe(describeNonErrorThrow(null));
  });
});

describe("toThrownError", () => {
  it("returns an Error as it is", () => {
    const error = new TypeError("boom");
    expect(toThrownError(error)).toBe(error);
    expect(isWrappedNonErrorThrow(error)).toBe(false);
  });

  it("describes a non-Error with no stack frames, Bascik's or anyone's", () => {
    const error = toThrownError("just a string");
    expect(error.message).toContain('threw the string "just a string"');
    expect(error.stack).toBe(error.message);
    expect(error.stack).not.toMatch(/\n\s+at /);
    expect(isWrappedNonErrorThrow(error)).toBe(true);
  });
});
