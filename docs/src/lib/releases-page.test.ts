import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync(
  new URL("../pages/releases.html", import.meta.url),
  "utf8",
);

describe("releases page", () => {
  it("shows a pointer to GitHub Releases when the changelog has no entries", () => {
    // renderMd(..., { skipToFirstH2: true }) returns "" with no `## ` entry,
    // which would leave the page empty below its intro.
    expect(page).toContain("https://github.com/bascikdev/bascik/releases");
    expect(page).toMatch(/\|\|\s*["'`]<p>/);
  });
});
