import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { highlight, highlightCode } from "../../lib/highlight.ts";

describe("code-block component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/code-block/code-block.html",
  );
  const cssPath = join(
    process.cwd(),
    "src/components/code-block/code-block.css",
  );

  it("renders language and file props, default slot, and a copy button with no highlighter", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain("data-bascik-prop-lang");
    expect(html).toContain("data-bascik-prop-file");
    expect(html).toContain("data-bascik-slot");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toMatch(/role="status"\s+aria-live="polite"/);
    // Highlighting happens at build time (src/lib/highlight.ts). A script here is copied into every block.
    expect(html).not.toContain("function highlight(");
    expect(html).not.toContain("<script");
    expect(html).toContain("data-cblock-copy");
    expect(html).toContain("data-cblock-code");
    expect(html).toContain("data-cblock-status");
  });

  it("copies with one handler per page, in docs-footer, that reads the block's plain text", async () => {
    const footer = await readFile(
      join(process.cwd(), "src/components/docs-footer/docs-footer.html"),
      "utf8",
    );
    expect(footer).toContain('closest("[data-cblock-copy]")');
    expect(footer).toContain("[data-cblock-code]");
    expect(footer).toContain(".textContent");
    expect(footer).not.toContain("innerHTML");
    // Component class names are renamed per component, so state set from docs-footer is an attribute.
    expect(footer).toContain('button.setAttribute("data-copied", "")');
    const css = await readFile(cssPath, "utf8");
    expect(css).toContain(".cblock-copy[data-copied]");
    expect(css).not.toContain("--done");
  });

  // The build puts the highlighter's output straight into the page, so it must be the escaped source plus
  // token spans and nothing else, for any input.
  it("highlighter output is the escaped source plus token spans, for any input", async () => {
    const unescape = (text: string): string =>
      text.replace(
        /&(lt|gt|amp);/g,
        (_entity, name: string) =>
          ({ lt: "<", gt: ">", amp: "&" })[name] as string,
      );
    const assertEscaped = (source: string, lang: string): void => {
      const output = highlight(source, lang);
      if (output === null) return;
      const text = output.replace(
        /<span data-code-token="[a-z]+">|<\/span>/g,
        "",
      );
      expect(text, `${lang}: ${JSON.stringify(source)}`).not.toMatch(/[<>]/);
      expect(unescape(text), `${lang}: ${JSON.stringify(source)}`).toBe(source);
    };

    const corpus = [
      "<img src=x onerror=alert(1)>",
      "<script>alert(1)</script>",
      "</code><script>alert(1)</script>",
      "<!-- unterminated comment <b>",
      "<a title=\"<b>bold</b>\" href='x'>",
      '<style>p::before { content: "</style><script>x</script>" }</style>',
      '<script type="module">const s = "</script>";</script>',
      '"unterminated <img src=x onerror=1>',
      '`${"<b>"}` /* <i> */ // <u>',
      "echo \"<b>\" '<i>' $HOME # <u>",
      '{"html": "<b>&amp;</b>"}',
      "&lt;already&gt; &amp;amp;",
    ];
    const langs = ["html", "css", "js", "ts", "json", "sh"];
    for (const lang of langs)
      for (const source of corpus) assertEscaped(source, lang);

    const alphabet = [
      "<",
      ">",
      "/",
      '"',
      "'",
      "`",
      "&",
      "!",
      "-",
      "*",
      "#",
      "$",
      "{",
      "}",
      "=",
      " ",
      "\n",
      "a",
      "script",
      "style",
    ];
    let seed = 0xc0de;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    for (let run = 0; run < 3_000; run++) {
      let source = "";
      const length = next() % 30;
      for (let index = 0; index < length; index++)
        source += alphabet[next() % alphabet.length];
      assertEscaped(source, langs[run % langs.length]);
    }
  });

  it("highlightCode leaves text, unknown languages, and blank code as escaped text", () => {
    expect(highlightCode("<b> & </b>", "text")).toBe(
      "&lt;b&gt; &amp; &lt;/b&gt;",
    );
    expect(highlightCode("<b>", "brainfuck")).toBe("&lt;b&gt;");
    expect(highlightCode("  \n", "js")).toBe("  \n");
    expect(highlightCode("const a = 1;", " JS ")).toBe(
      highlight("const a = 1;", "js"),
    );
    expect(highlightCode("const a = 1;", "js")).toBe(
      '<span data-code-token="kw">const</span> a = <span data-code-token="num">1</span>;',
    );
  });

  it("contains sr-only / cblock-status styles for screen reader announcements", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(".cblock-status");
    expect(css).toContain("clip: rect(0, 0, 0, 0);");
  });
});
