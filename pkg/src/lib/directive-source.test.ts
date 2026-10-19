/**
 * Directive script positions: recorded on the tag when a file is read, read
 * back when the script runs, and turned into module padding. The CLI-level
 * behavior is covered by script-error-locations.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import {
  directiveSourceColumn,
  directiveSourcePosition,
  padToSourcePosition,
  stampDirectiveSources,
  trimmedStartPosition,
} from "./directive-source.ts";
import { cleanStackTrace } from "./stack-trace.ts";

const openTagAt = (
  html: string,
  needle = "<script",
): { index: number; openTag: string } => {
  const index = html.indexOf(needle);
  return { index, openTag: html.slice(index, html.indexOf(">", index) + 1) };
};

describe("stampDirectiveSources", () => {
  it("records the file, the body's line and column, and the opening tag's position", () => {
    const html =
      '<div>\n  <p>a</p>\n  <script data-bascik-server data-x="1">\n    export default () => "";\n  </script>\n</div>';
    expect(stampDirectiveSources(html, "src/components/a.html")).toBe(
      '<div>\n  <p>a</p>\n  <script data-bascik-server data-x="1" data-bascik-source-file="src%2Fcomponents%2Fa.html" ' +
        'data-bascik-source-line="3" data-bascik-source-column="41" data-bascik-source-tag="3:3">\n    export default () => "";\n  </script>\n</div>',
    );
  });

  it("stamps every directive, and only directives", () => {
    const html = [
      "<script data-bascik-build>a</script>",
      '<script data-bascik-build="page">b</script>',
      "<script data-bascik-server>c</script>",
      "<script data-bascik-stream>d</script>",
      "<script data-bascik-routes>e</script>",
      "<script>browser()</script>",
      '<script type="application/ld+json">{}</script>',
      '<script data-bascik-server-id="x"></script>',
    ].join("\n");
    const stamped = stampDirectiveSources(html, "src/pages/x.html");
    expect(stamped.match(/data-bascik-source-tag=/g)).toHaveLength(5);
    for (const untouched of [
      "<script>browser()",
      '<script type="application/ld+json">',
      '<script data-bascik-server-id="x">',
    ]) {
      expect(stamped).toContain(untouched);
    }
  });

  it("leaves scripts written inside comments alone", () => {
    const html =
      "<!-- <script data-bascik-build>example()</script> -->\n<script data-bascik-build>real()</script>";
    const stamped = stampDirectiveSources(html, "src/pages/x.html");
    expect(stamped).toContain(
      "<!-- <script data-bascik-build>example()</script> -->",
    );
    expect(stamped).toContain('data-bascik-source-tag="2:1"');
  });

  it("never rewrites tag-like text inside a browser script, a <style>, or a <textarea>", () => {
    const inside = [
      '<script>const tpl = "<script data-bascik-server>";</script>',
      "<script>const tpl = '<script data-bascik-build data-x=\"1\">';</script>",
      "<style>/* <script data-bascik-build> */ .a { color: red; }</style>",
      "<textarea><script data-bascik-stream>x</script></textarea>",
    ];
    for (const html of inside)
      expect(stampDirectiveSources(html, "src/pages/x.html")).toBe(html);
  });

  it("stamps a directive after a browser script whose strings look like comment delimiters", () => {
    const html =
      '<script>const open = "<!--";</script>\n<p>x</p>\n<script data-bascik-build>\n  run();\n</script>\n<script>const close = "-->";</script>';
    const stamped = stampDirectiveSources(html, "src/pages/a.html");
    expect(stamped).toContain('data-bascik-source-tag="3:1"');
    expect(stamped).toContain('<script>const open = "<!--";</script>');
    expect(stamped).toContain('<script>const close = "-->";</script>');
  });

  it("leaves every browser script body byte-identical, whatever tag-like text it holds", () => {
    const fragment = fc.constantFrom(
      "<script data-bascik-server>",
      '<script data-bascik-build="page">',
      "<!--",
      "-->",
      '"',
      "'",
      ">",
      "x",
      "\n",
      "<p>",
    );
    fc.assert(
      fc.property(
        fc.array(fragment, { maxLength: 12 }),
        fc.array(fragment, { maxLength: 12 }),
        (first, second) => {
          const browserA = `<script>${first.join("")}</script>`;
          const browserB = `<script type="module">${second.join("")}</script>`;
          const html = `${browserA}\n<script data-bascik-build>a()</script>\n${browserB}`;
          const stamped = stampDirectiveSources(html, "src/pages/x.html");
          expect(
            stamped.startsWith(
              `${browserA}\n<script data-bascik-build data-bascik-source-file=`,
            ),
          ).toBe(true);
          expect(stamped.endsWith(`>a()</script>\n${browserB}`)).toBe(true);
        },
      ),
    );
  });

  it("keeps a recorded file or line, and stamps a script once", () => {
    const html =
      '<script data-bascik-build data-bascik-source-file="src%2Fcomponents%2Fb.html">x</script>';
    const once = stampDirectiveSources(html, "src/pages/x.html");
    expect(once.match(/data-bascik-source-file=/g)).toHaveLength(1);
    expect(once).toContain(
      'data-bascik-source-file="src%2Fcomponents%2Fb.html"',
    );
    expect(stampDirectiveSources(once, "src/pages/x.html")).toBe(once);

    const handWritten =
      '<script data-bascik-server data-bascik-source-line="8">x</script>';
    expect(stampDirectiveSources(handWritten, "src/pages/x.html")).toBe(
      handWritten,
    );
  });

  it("counts CRLF line endings and multi-line opening tags", () => {
    const html =
      '<p>\r\n</p>\r\n<script\r\n  data-bascik-build\r\n  data-x="1">\r\nrun();\r\n</script>';
    const stamped = stampDirectiveSources(html, "src/pages/x.html");
    const { index, openTag } = openTagAt(stamped);
    expect(directiveSourcePosition(stamped, index, openTag)).toMatchObject({
      // `  data-x="1">` is 13 characters, so the body starts at column 14.
      tagLine: 3,
      tagColumn: 1,
      bodyLine: 5,
      bodyColumn: 14,
    });
  });

  it("adds no newlines, so text after a stamp keeps its line numbers", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "<p>x</p>",
            "\n",
            "<script data-bascik-build>a()</script>",
            "  ",
            "<!-- c -->",
          ),
        ),
        (parts) => {
          const html = parts.join("");
          const stamped = stampDirectiveSources(html, "src/pages/x.html");
          expect(stamped.split("\n").length).toBe(html.split("\n").length);
        },
      ),
    );
  });
});

describe("directiveSourcePosition", () => {
  it("reads the recorded position after the HTML around the script has changed", () => {
    const original =
      "<div>\n<style>\n.a{}\n</style>\n<script data-bascik-build>\n  x();\n</script>\n</div>";
    const stamped = stampDirectiveSources(original, "src/components/c.html");
    // What Bascik does before running it: extract the style and minify.
    const moved = stamped
      .replace(/<style>[\s\S]*?<\/style>\n/, "")
      .replace(/\n/g, " ");
    const { index, openTag } = openTagAt(moved);

    expect(directiveSourcePosition(moved, index, openTag)).toEqual({
      sourceFile: "src/components/c.html",
      tagLine: 5,
      tagColumn: 1,
      bodyLine: 5,
      bodyColumn: 27,
    });
  });

  it("measures the HTML it is given when nothing was recorded", () => {
    const html = "<p>a</p>\n  <script data-bascik-build>x()</script>";
    const { index, openTag } = openTagAt(html);
    expect(directiveSourcePosition(html, index, openTag)).toEqual({
      sourceFile: undefined,
      tagLine: 2,
      tagColumn: 3,
      bodyLine: 2,
      bodyColumn: 29,
    });
  });

  it("uses a recorded line that has no column, starting the body at column 1", () => {
    const html =
      '<p>a</p>\n<script data-bascik-server data-bascik-source-line="8">x</script>';
    const { index, openTag } = openTagAt(html);
    expect(directiveSourcePosition(html, index, openTag)).toMatchObject({
      bodyLine: 8,
      bodyColumn: 1,
    });
    expect(directiveSourceColumn(openTag)).toBeUndefined();
  });
});

describe("trimmedStartPosition", () => {
  it("maps a body that starts on the tag's line", () => {
    // `<script data-bascik-server>  return 1;` with the body at column 29.
    expect(trimmedStartPosition("  return 1;", 4, 29)).toEqual({
      line: 4,
      columnOffset: 30,
    });
  });

  it("maps a body that starts on a later line, keeping that line's indentation", () => {
    expect(
      trimmedStartPosition("\n\n    export default () => 1;\n", 7, 29),
    ).toEqual({ line: 9, columnOffset: 4 });
  });

  it("agrees with V8 for the trimmed module, through the stack cleaner", () => {
    const body = "\n  const a = 1;\n  throw new Error('x');\n";
    const { line, columnOffset } = trimmedStartPosition(body, 4, 25);
    let stack = "";
    try {
      runInNewContext(
        `eval(${JSON.stringify(`${body.trim()}\n//# sourceURL=mod.js`)})`,
      );
    } catch (error) {
      stack = String((error as Error).stack);
    }
    // In the file: line 4 is the tag, `const` is on line 5, `throw new Error` on line 6 at column 9.
    expect(
      cleanStackTrace(stack, "mod.js", "file.html", line, columnOffset),
    ).toContain("file.html:6:9");
  });
});

describe("padToSourcePosition", () => {
  /** Runs `code` as a script named `file` and returns the `line:column` V8 reports for the throw. */
  const thrownAt = (code: string): string => {
    try {
      runInNewContext(
        `eval(${JSON.stringify(`${code}\n//# sourceURL=file.html`)})`,
      );
    } catch (error) {
      return /file\.html:(\d+:\d+)/.exec(String((error as Error).stack))![1];
    }
    throw new Error("did not throw");
  };

  it("puts the first character at the recorded line and column", () => {
    // In the file, the body starts right after `>` on line 7, column 30.
    expect(thrownAt(padToSourcePosition("throw new Error('x');", 7, 30))).toBe(
      "7:36",
    );
  });

  it("keeps lines after the first, with their own indentation, on their file lines", () => {
    const body = "\n  const a = 1;\n  throw new Error('x');\n";
    expect(thrownAt(padToSourcePosition(body, 4, 25))).toBe("6:9");
  });

  it("changes nothing for a script that starts at line 1, column 1", () => {
    expect(padToSourcePosition("x", 1, 1)).toBe("x");
  });
});
