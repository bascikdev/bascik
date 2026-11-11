import { describe, expect, it } from "vitest";
import { parseByteRange } from "./byte-range.ts";

// Audit 159 finding 34: static files answer a single byte range (RFC 9110
// section 14), so media can seek and Safari plays audio and video.
describe("parseByteRange", () => {
  const size = 1000;

  it.each([
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100, end: 999 }],
    ["bytes=-100", { start: 900, end: 999 }],
    ["bytes=990-5000", { start: 990, end: 999 }],
    ["bytes=-5000", { start: 0, end: 999 }],
    ["BYTES = 5 - 9", { start: 5, end: 9 }],
  ])("reads %s", (header, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });

  it.each(["bytes=1000-", "bytes=1000-1001", "bytes=-0"])(
    "calls %s unsatisfiable",
    (header) => {
      expect(parseByteRange(header, size)).toBe("unsatisfiable");
    },
  );

  it("calls every range of an empty file unsatisfiable", () => {
    expect(parseByteRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  // RFC 9110 lets a server ignore a Range it does not support; the client
  // then gets the whole file with 200, which is always correct.
  it.each([
    undefined,
    "",
    "items=0-9",
    "bytes=9-5",
    "bytes=a-b",
    "bytes=-",
    "bytes=0-9,20-29",
    "bytes=0-9, -5",
    "bytes=1e3-",
  ])("ignores %s", (header) => {
    expect(parseByteRange(header, size)).toBeUndefined();
  });
});
