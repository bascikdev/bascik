/**
 * Cost of the script-code lookup in attribute scoping (prompt 158 R2-09): a script body's
 * literal spans are read only when a tag candidate lies inside that script. A component's
 * markup tags sit outside its scripts, so most scoping runs never scan a script at all, and
 * the result is the same as when every script was scanned up front.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BascikComponent } from "./types.ts";

const { scannedBodies } = vi.hoisted(() => ({
  scannedBodies: [] as string[],
}));

vi.mock("./js-literal-spans.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./js-literal-spans.ts")>();
  return {
    ...actual,
    findJsLiteralSpans: (js: string) => {
      scannedBodies.push(js);
      return actual.findJsLiteralSpans(js);
    },
  };
});

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
  },
}));

const { prefixElementAttribute } = await import("./javascript.ts");

const scopeIds = (fileContent: string): string =>
  prefixElementAttribute(
    { name: "my-comp", fileContent } as BascikComponent,
    "id",
    "inst1",
  ).fileContent!;

beforeEach(() => {
  scannedBodies.length = 0;
});

describe("prefixElementAttribute – script literal spans are read on demand", () => {
  it("reads no script when no tag candidate lies inside one", () => {
    const script = "const total = price * count; if (total > 0) use(total);";
    const out = scopeIds(
      `<section id="panel"><button id="btn">Go</button></section><script>${script}</script>`,
    );
    expect(out).toContain('id="bascik__my-comp__inst1__panel"');
    expect(out).toContain('id="bascik__my-comp__inst1__btn"');
    expect(out).toContain(`<script>${script}</script>`);
    expect(scannedBodies).toEqual([]);
  });

  it("reads only the script a candidate lies in, once", () => {
    const quiet = "const a = 1;";
    const busy =
      "if (count<max && ok) { const id = items[i]; use(id); } el.innerHTML = '<p id=\"panel\">x</p>';";
    const out = scopeIds(
      `<div id="panel"></div><script>${quiet}</script><script>${busy}</script><script>${quiet}</script>`,
    );
    // The comparison stays code and the markup in the literal is scoped.
    expect(out).toContain("if (count<max && ok) { const id = items[i];");
    expect(out).toContain(`'<p id="bascik__my-comp__inst1__panel">x</p>'`);
    expect(scannedBodies).toEqual([busy]);
  });

  it("still treats a candidate in a non-JavaScript script as markup without reading it as code", () => {
    const out = scopeIds(
      '<div id="panel"></div><script type="text/template"><p id="panel">x</p></script>',
    );
    expect(out).toContain(
      '<script type="text/template"><p id="bascik__my-comp__inst1__panel">x</p></script>',
    );
    expect(scannedBodies).toEqual([]);
  });

  it("finds the script a candidate lies in after markup that follows earlier scripts", () => {
    // A forgetful author's component: markup between and after scripts, a script with an
    // unclosed string, and a comparison in the last script.
    const first = "const bad = 'unterminated";
    const last = "if (n<limit && ok) { let id = n; use(id) }";
    const html = `<p id="a">a</p><script>${first}</script><p id="b">b</p><script>${last}</script><p id="c">c</p>`;
    const out = scopeIds(html);
    for (const id of ["a", "b", "c"])
      expect(out).toContain(`id="bascik__my-comp__inst1__${id}"`);
    expect(out).toContain(`<script>${first}</script>`);
    expect(out).toContain(`<script>${last}</script>`);
    expect(scannedBodies).toEqual([last]);
  });
});
