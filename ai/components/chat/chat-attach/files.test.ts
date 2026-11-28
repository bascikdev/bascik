import { describe, expect, test } from "vitest";
import { refusals } from "../../../src/files/uploads.ts";
import {
  attachLimits,
  claimedType,
  KNOWN,
  markupName,
  refusal,
  sizeText,
  type ChosenFile,
} from "./files.ts";

const MB = 1024 * 1024;
const file = (name: string, type: string, size = 10): ChosenFile => ({
  name,
  type,
  size,
});
const defaults = attachLimits({});

describe("attachLimits", () => {
  test("are the server's own defaults when a page sets nothing", () => {
    expect(defaults).toEqual({
      maxBytes: 5 * MB,
      maxFiles: 4,
      maxTotal: 10 * MB,
      types: Object.keys(KNOWN),
    });
  });

  test("takes what a page set, and trims the list of types", () => {
    expect(
      attachLimits({
        maxBytes: "2048",
        maxFiles: "1",
        maxTotal: "4096",
        types: " text/plain , image/png,",
      }),
    ).toEqual({
      maxBytes: 2048,
      maxFiles: 1,
      maxTotal: 4096,
      types: ["text/plain", "image/png"],
    });
  });

  test.each(["", "0", "-3", "many", "Infinity"])(
    "falls back to the default for the value %j",
    (value) => {
      expect(attachLimits({ maxFiles: value, maxBytes: value })).toMatchObject({
        maxFiles: 4,
        maxBytes: 5 * MB,
      });
    },
  );

  test("a list of types with nothing in it allows the defaults", () => {
    expect(attachLimits({ types: " , " }).types).toEqual(Object.keys(KNOWN));
  });
});

describe("sizeText", () => {
  test.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [MB, "1 MB"],
    [2.25 * MB, "2.3 MB"],
  ])("%d bytes is %s", (bytes, text) => {
    expect(sizeText(bytes)).toBe(text);
  });
});

describe("claimedType", () => {
  test("is what the browser said, without its parameters, in lower case", () => {
    expect(claimedType(file("a.bin", "Text/Plain; charset=utf-8"))).toBe(
      "text/plain",
    );
  });

  test("is read from the extension when the browser said nothing", () => {
    expect(claimedType(file("notes.MD", ""))).toBe("text/markdown");
    expect(claimedType(file("cover.jpeg", ""))).toBe("image/jpeg");
    expect(claimedType(file("archive.zip", ""))).toBe("");
    expect(claimedType(file("no-extension", ""))).toBe("");
  });
});

describe("markupName", () => {
  test.each([
    "page.html",
    "page.HTM",
    "drawing.svg",
    "feed.xml",
    "page.html. ",
    "page.html\u200B",
    "folder/page.xhtml",
    "C:\\folder\\drawing.svgz",
  ])("%j is markup", (name) => {
    expect(markupName(name)).toBe(true);
  });

  test.each(["notes.txt", "html", "page.html.txt", "svg.png"])(
    "%j is not",
    (name) => {
      expect(markupName(name)).toBe(false);
    },
  );
});

describe("refusal", () => {
  test("a file inside every limit is taken", () => {
    expect(refusal(file("notes.txt", "text/plain"), [], defaults)).toBeNull();
  });

  test("says what the server says, word for word", () => {
    const one = attachLimits({ maxFiles: "1" });
    expect(
      refusal(file("b.txt", "text/plain"), [file("a.txt", "text/plain")], one),
    ).toBe(refusals.count(1));
    expect(
      refusal(
        file("b.txt", "text/plain"),
        new Array(4).fill(file("a.txt", "text/plain")),
        defaults,
      ),
    ).toBe(refusals.count(4));
    expect(refusal(file("drawing.svg", "image/svg+xml"), [], defaults)).toBe(
      refusals.markup("drawing.svg"),
    );
    expect(refusal(file("page.html", "text/plain"), [], defaults)).toBe(
      refusals.markup("page.html"),
    );
    expect(refusal(file("archive.zip", "application/zip"), [], defaults)).toBe(
      refusals.type("archive.zip", defaults.types),
    );
    expect(refusal(file("empty.txt", "text/plain", 0), [], defaults)).toBe(
      refusals.empty("empty.txt"),
    );
    expect(refusal(file("big.txt", "text/plain", 6 * MB), [], defaults)).toBe(
      refusals.tooLarge("big.txt", 6 * MB, 5 * MB),
    );
    expect(
      refusal(
        file("c.txt", "text/plain", 4 * MB),
        [
          file("a.txt", "text/plain", 4 * MB),
          file("b.txt", "text/plain", 4 * MB),
        ],
        defaults,
      ),
    ).toBe(refusals.total(12 * MB, 10 * MB));
  });

  test("names a type the page allows that has no short name by its media type", () => {
    const limits = attachLimits({ types: "text/plain,application/epub+zip" });
    expect(refusal(file("cover.png", "image/png"), [], limits)).toBe(
      '"cover.png" cannot be attached: that type of file is not allowed. Allowed types: plain text, application/epub+zip.',
    );
  });

  test("names a file by the last part of its path", () => {
    expect(
      refusal(file("C:\\books\\empty.txt", "text/plain", 0), [], defaults),
    ).toBe('"empty.txt" is empty.');
  });

  test("the count is checked first, so a full message refuses any file the same way", () => {
    const one = attachLimits({ maxFiles: "1" });
    expect(
      refusal(
        file("page.html", "text/html"),
        [file("a.txt", "text/plain")],
        one,
      ),
    ).toBe(refusals.count(1));
  });
});
