import { describe, expect, test } from "vitest";
import { mediaTypeOf } from "./sniff.ts";

describe("mediaTypeOf", () => {
  test("lowercases the type and drops its parameters", () => {
    expect(mediaTypeOf("Text/Markdown; charset=UTF-8")).toBe("text/markdown");
    expect(mediaTypeOf("  image/PNG ")).toBe("image/png");
    expect(mediaTypeOf("image/svg+xml;charset=utf-8")).toBe("image/svg+xml");
  });

  test("an empty claim stays empty", () => {
    expect(mediaTypeOf("")).toBe("");
    expect(mediaTypeOf(";charset=utf-8")).toBe("");
  });
});
