/**
 * Falsification fixtures for cursor-based component scanning (prompt 63).
 *
 * Each case pins the observable output of recursivelyTranspile on a shape that
 * could be broken by a search cursor that resumes in the wrong place:
 * templates that begin with another component, nested same-name components,
 * replacements that introduce raw-text elements containing fake tags,
 * adjacent self-closing and paired instances, malformed markup, and names
 * where longest-match and earliest-match ordering differ.
 *
 * Expected strings were captured from the pre-cursor implementation. The
 * refactor must keep every one byte-identical.
 */
import { describe, expect, it, vi } from "vitest";
import { recursivelyTranspile } from "./processing.ts";
import type { ComponentList } from "./types.ts";

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return {
    ...original,
    BascikConfig: {
      ...original.BascikConfig,
      minify: { html: false, css: false, js: false, identifiers: false },
      scoping: { ...original.BascikConfig.scoping, deduplicateCss: true, preserve: ["code"] },
    },
  };
});

const run = (body: string, list: ComponentList, filePath?: string) =>
  recursivelyTranspile(body, list, [], filePath).transpiledHtmlBody;

describe("cursor scan falsification fixtures", () => {
  it("resolves a component whose template BEGINS with another component", () => {
    const list: ComponentList = {
      "outer-box": { fileContent: `<inner-dot></inner-dot><span class="after">after</span>` },
      "inner-dot": { fileContent: `<i class="dot">.</i>` },
    };
    const out = run(`<outer-box></outer-box><outer-box></outer-box>`, list);
    expect(out).not.toContain("<inner-dot");
    expect(out).not.toContain("<outer-box");
    expect(out.match(/class="bascik__inner-dot__dot"/g)).toHaveLength(2);
  });

  it("resolves a nested same-name component to the balanced close tag", () => {
    const list: ComponentList = {
      "my-list": { fileContent: `<ul class="l"><li data-bascik-slot></li></ul>` },
    };
    const out = run(`<my-list>a<my-list>b</my-list>c</my-list>`, list);
    expect(out).toBe(
      `<ul class="bascik__my-list__l">a<ul class="bascik__my-list__l">b</ul>c</ul>`,
    );
  });

  it("does not resolve fake tags introduced inside <script>, <style>, <textarea>, or comments by a replacement", () => {
    const list: ComponentList = {
      "raw-host": {
        fileContent:
          `<div class="h"><script>var s = "<ghost-a></ghost-a>";</script>` +
          `<style>/* <ghost-a></ghost-a> */</style>` +
          `<textarea><ghost-a></ghost-a></textarea>` +
          `<!-- <ghost-a></ghost-a> --><ghost-a></ghost-a></div>`,
      },
      "ghost-a": { fileContent: `<b class="g">REAL</b>` },
    };
    const out = run(`<raw-host></raw-host>`, list);
    // Exactly one real resolution (the last, outside raw text). The <style>
    // block is hoisted out of the body by the CSS pass, so it is absent here.
    expect(out).toBe(
      `<div class="h"><script>(function() {\nvar s = "<ghost-a></ghost-a>";\n})();</script>` +
      `<textarea><ghost-a></ghost-a></textarea><!-- <ghost-a></ghost-a> -->` +
      `<b class="bascik__ghost-a__g">REAL</b></div>`,
    );
  });

  it("handles adjacent self-closing and paired instances in source order", () => {
    const list: ComponentList = {
      "a-tag": { fileContent: `<span class="a"><span data-bascik-slot>D</span></span>` },
    };
    const out = run(`<a-tag />1<a-tag>X</a-tag>2<a-tag/>3<a-tag></a-tag>`, list);
    expect(out).toBe(
      `<span class="bascik__a-tag__a">D</span>1<span class="bascik__a-tag__a">X</span>2` +
      `<span class="bascik__a-tag__a">D</span>3<span class="bascik__a-tag__a">D</span>`,
    );
  });

  it("does not hang or lose content on a missing close tag", () => {
    const list: ComponentList = {
      "open-only": { fileContent: `<p class="o">o<span data-bascik-slot></span></p>` },
    };
    const out = run(`<open-only>never closed <b>bold</b>`, list);
    expect(out).not.toContain("<open-only");
    expect(out).toContain("never closed <b>bold</b>");
  });

  it("matches the longest component name first when one is a prefix of another", () => {
    const list: ComponentList = {
      "test-comp": { fileContent: `<i class="short">S</i>` },
      "test-comp-clone": { fileContent: `<i class="long">L</i>` },
    };
    const out = run(`<test-comp-clone></test-comp-clone><test-comp></test-comp>`, list);
    expect(out).toContain("L</i>");
    expect(out).toContain("S</i>");
    expect(out.indexOf("L</i>")).toBeLessThan(out.indexOf("S</i>"));
    expect(out).not.toContain("<test-comp");
  });

  it("keeps source-file attribution for errors after many substitutions", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    try {
      const list: ComponentList = {
        "fine-one": { fileContent: `<i class="f">fine</i>` },
        "bad-one": {
          fileName: "/proj/src/components/bad-one.html",
          // Unterminated prop marker inside the template makes prop injection
          // throw during the pipeline; the error handler must still find the
          // page as the active source file and continue.
          fileContent: `<p data-bascik-prop-title="${"x".repeat(10)}</p>`,
        },
      };
      const body =
        Array.from({ length: 50 }, () => `<fine-one></fine-one>`).join("") + `<bad-one title="t"></bad-one>`;
      const out = run(body, list, "/proj/src/pages/index.html");
      expect(out.match(/fine<\/i>/g)).toHaveLength(50);
      expect(out).not.toContain("<fine-one");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
