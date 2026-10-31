import { describe, expect, it } from "vitest";
import {
  blockFooter,
  extractTypeScriptBlocks,
  mayHaveTypeScriptBlocks,
  toGeneratedOffset,
  toSourceOffset,
  virtualBlockText,
} from "./typescript-blocks.js";

describe("extractTypeScriptBlocks", () => {
  it("finds only type=text/typescript blocks, each with its directive and program", () => {
    const html = [
      "<script>const a = 1;</script>",
      '<script type="module">const b = 1;</script>',
      '<script type="text/typescript" data-bascik-build>export default () => "";</script>',
      "<script type='text/typescript' data-bascik-server>export default () => '';</script>",
      '<script type="text/typescript">const c: number = 1;</script>',
      '<script type="TEXT/TypeScript" data-bascik-routes>export default () => [];</script>',
      '<script type="text/typescript" data-bascik-stream>export default () => "";</script>',
      '<script type=" text/typescript " data-bascik-build-once>export default () => "";</script>',
      "<script type=text/typescript>let d = 1;</script>",
    ].join("\n");
    const blocks = extractTypeScriptBlocks(html);
    expect(blocks.map((block) => [block.directive, block.program])).toEqual([
      ["build", "server"],
      ["server", "server"],
      [undefined, "client"],
      ["routes", "server"],
      ["stream", "server"],
      ["build-once", "server"],
      [undefined, "client"],
    ]);
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("records each block's exact offset and text", () => {
    const html =
      '<p>x</p>\n<script type="text/typescript">\n  const n: number = 1;\n</script>';
    const [block] = extractTypeScriptBlocks(html);
    expect(
      html.slice(block.contentStart, block.contentStart + block.content.length),
    ).toBe("\n  const n: number = 1;\n");
  });

  it("reads Prettier's wrapped attributes and a `>` inside a quoted value", () => {
    const html =
      '<script\n  type="text/typescript"\n  data-note="a > b"\n  data-bascik-server\n>\n  export default () => "";\n</script\n>';
    const blocks = extractTypeScriptBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].directive).toBe("server");
    expect(blocks[0].content).toBe('\n  export default () => "";\n');
  });

  it("misuse: an unclosed script element yields no block instead of throwing", () => {
    expect(
      extractTypeScriptBlocks('<script type="text/typescript">const a = 1;'),
    ).toEqual([]);
    // The blocks before it are still found.
    expect(
      extractTypeScriptBlocks(
        '<script type="text/typescript">let a = 1;</script><script type="text/typescript">let b',
      ),
    ).toHaveLength(1);
  });

  it("misuse: an unclosed open tag or quote yields no block", () => {
    expect(extractTypeScriptBlocks('<script type="text/typescript')).toEqual(
      [],
    );
    expect(
      extractTypeScriptBlocks("<script type='text/typescript>x</script>"),
    ).toEqual([]);
  });

  it("misuse: a block inside an HTML comment is not a block, and an unclosed comment hides the rest", () => {
    expect(
      extractTypeScriptBlocks(
        '<!-- <script type="text/typescript">const a: number = "x";</script> -->',
      ),
    ).toEqual([]);
    expect(
      extractTypeScriptBlocks(
        '<!-- open\n<script type="text/typescript">const a: number = "x";</script>',
      ),
    ).toEqual([]);
  });

  it("misuse: a typo'd type is not TypeScript", () => {
    for (const type of [
      "text/typscript",
      "text/ts",
      "typescript",
      "text/typescript; x",
    ]) {
      expect(
        extractTypeScriptBlocks(
          `<script type="${type}">const a: number = 1;</script>`,
        ),
      ).toEqual([]);
    }
  });

  it("skips a script with src, and script text inside style, textarea and title", () => {
    expect(
      extractTypeScriptBlocks(
        '<script type="text/typescript" src="./a.ts"></script>',
      ),
    ).toEqual([]);
    const hidden = '<script type="text/typescript">let a = 1;</script>';
    for (const element of ["style", "textarea", "title"]) {
      expect(
        extractTypeScriptBlocks(`<${element}>${hidden}</${element}>`),
      ).toEqual([]);
    }
  });

  it("keeps a TypeScript string that mentions an HTML comment inside the block", () => {
    const [block] = extractTypeScriptBlocks(
      '<script type="text/typescript">const marker = "<!--";</script><script type="text/typescript">let b = 1;</script>',
    );
    expect(block.content).toBe('const marker = "<!--";');
    expect(
      extractTypeScriptBlocks(
        '<script type="text/typescript">const marker = "<!--";</script><script type="text/typescript">let b = 1;</script>',
      ),
    ).toHaveLength(2);
  });

  it("does not take <scripted> or <scripts> for a script tag", () => {
    expect(
      extractTypeScriptBlocks(
        '<scripts type="text/typescript">let a;</scripts>',
      ),
    ).toEqual([]);
  });

  it("skips the scan when the file never mentions text/typescript", () => {
    expect(mayHaveTypeScriptBlocks("<script>let a;</script>")).toBe(false);
    expect(mayHaveTypeScriptBlocks('<script type="Text/TypeScript">')).toBe(
      true,
    );
  });
});

describe("virtualBlockText and offset mapping", () => {
  const html =
    '<main></main>\n<script type="text/typescript" data-bascik-server>\nexport default (request) => request.url;\n</script>';
  const [block] = extractTypeScriptBlocks(html);
  const at = block.content.indexOf("(request)");
  const end = block.content.indexOf(";", at);
  const virtual = virtualBlockText(block, [
    { at: end, text: ")" },
    { at, text: "__bascikScript(" },
  ]);

  it("inserts the text in order and appends the footer for the directive", () => {
    expect(virtual.text).toBe(
      "\nexport default __bascikScript((request) => request.url);\n\n" +
        blockFooter("server").slice(1),
    );
    expect(virtual.text.slice(virtual.footerStart)).toBe(blockFooter("server"));
    expect(blockFooter("server")).toContain("__bascik.ServerScript");
    expect(blockFooter("build-once")).toContain("__bascik.BuildScript");
    expect(blockFooter("routes")).toContain("__bascik.RoutesScript");
    expect(blockFooter(undefined)).toBe("\nexport {};\n");
  });

  it("maps every source character there and back", () => {
    for (let offset = 0; offset <= block.content.length; offset++) {
      const source = block.contentStart + offset;
      const generated = toGeneratedOffset(virtual, source);
      expect(generated).toBeDefined();
      expect(toSourceOffset(virtual, generated!)).toBe(source);
      if (offset < block.content.length)
        expect(virtual.text[generated!]).toBe(html[source]);
    }
  });

  it("maps a position inside inserted text to the next source character, and the footer to the block end", () => {
    const inside = virtual.text.indexOf("__bascikScript(") + 3;
    expect(toSourceOffset(virtual, inside)).toBe(block.contentStart + at);
    expect(toSourceOffset(virtual, virtual.footerStart + 5)).toBe(
      block.contentStart + block.content.length,
    );
  });

  it("has no generated offset for a position outside the block", () => {
    expect(toGeneratedOffset(virtual, 0)).toBeUndefined();
    expect(toGeneratedOffset(virtual, html.length)).toBeUndefined();
  });
});
