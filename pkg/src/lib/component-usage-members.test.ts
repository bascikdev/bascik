import { describe, expect, it } from "vitest";
import { hasRenderableContent } from "./component-usage-members.ts";

describe("hasRenderableContent", () => {
  it("is false for whitespace and comments only", () => {
    expect(hasRenderableContent("")).toBe(false);
    expect(hasRenderableContent("  \n <!-- note -->\n ")).toBe(false);
    // A comment the content ends inside runs to the end.
    expect(hasRenderableContent("<!-- <p>x</p>")).toBe(false);
  });

  it.each([
    ["`--!>`", "<!-- a --!><p>shown</p>"],
    ["`<!-->`", "<!--><p>shown</p><!-- b -->"],
    ["`<!--->`", "<!---><p>shown</p><!-- b -->"],
  ])(
    "ends a comment at %s, where the browser ends it, so the markup after it counts",
    (_end, content) => {
      expect(hasRenderableContent(content)).toBe(true);
    },
  );
});
