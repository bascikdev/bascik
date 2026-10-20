import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const grammarPath = join(__dirname, "../syntaxes/bascik-html.tmLanguage.json");

const attributePattern = async (): Promise<RegExp> => {
  const grammar = JSON.parse(await readFile(grammarPath, "utf8")) as {
    patterns: { match: string }[];
  };
  return new RegExp(grammar.patterns[0].match, "g");
};

describe("Bascik HTML grammar", () => {
  it.each([
    "data-bascik-build",
    "data-bascik-build-once",
    "data-bascik-routes",
    "data-bascik-server",
    "data-bascik-stream",
    "data-bascik-preserve",
    "data-bascik-slot",
    "data-bascik-prop-title",
    "data-bascik-attr-href",
  ])("highlights the whole %s attribute name", async (name) => {
    const matches = `<script ${name}>`.match(await attributePattern());
    expect(matches).toEqual([name]);
  });
});
