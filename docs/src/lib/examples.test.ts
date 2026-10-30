import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exampleFileBlock, EXAMPLES_DIR } from "./examples.ts";
import { highlightCode } from "./highlight.ts";

const decode = (html: string) =>
  html
    .replace(/<span data-code-token="[a-z]+">|<\/span>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("examples", () => {
  it("shows an example file highlighted at build time, with exactly the file's text", async () => {
    const path = "components/copy-button/copy-button.html";
    const source = (await readFile(join(EXAMPLES_DIR, path), "utf8")).replace(
      /\n$/,
      "",
    );
    const block = await exampleFileBlock(path);
    const body = /^<code-block [^>]*>([\s\S]*)<\/code-block>$/.exec(block)![1];
    expect(body).toBe(highlightCode(source, "html"));
    expect(body).toContain('data-code-token="kw"');
    expect(decode(body)).toBe(source);
  });
});
