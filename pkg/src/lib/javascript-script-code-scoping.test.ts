/**
 * Attribute scoping reads markup that scripts build in their string and template literals,
 * but never the script code around them: `count<max && ok` is a comparison, and an `id =`
 * or `name =` assignment after it must stay JavaScript (review finding F038).
 */
import { describe, expect, it, vi } from "vitest";
import { prefixElementAttribute } from "./javascript.ts";
import type { BascikComponent } from "./types.ts";

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

const makeComponent = (fileContent: string): BascikComponent => ({
  name: "my-comp",
  fileContent,
});

const scriptBodies = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)].map(
    (m) => m[1],
  );

const expectParses = (html: string): void => {
  for (const body of scriptBodies(html))
    expect(() => new Function(body), body).not.toThrow();
};

describe("prefixElementAttribute – `<` comparisons in script code", () => {
  const script =
    "if (count<max && ok) { const id = items[i]; use(id); } if (a > b) go();";

  it("leaves an `id =` assignment after an unspaced `<` comparison alone", () => {
    const html = `<div id="panel"></div><script>${script}</script>`;
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain(`<script>${script}</script>`);
    expect(out).toContain('id="bascik__my-comp__inst1__panel"');
    expectParses(out);
  });

  it("does so even when the component markup declares no id", () => {
    const html = `<p>hi</p><script>${script}</script>`;
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toBe(html);
  });

  it("leaves a `name =` assignment alone under name scoping", () => {
    const source =
      "if (count<max && ok) { const name = user.name; use(name); } if (a > b) go();";
    const html = `<input name="q"><script>${source}</script>`;
    const out = prefixElementAttribute(
      makeComponent(html),
      "name",
      "inst1",
    ).fileContent!;
    expect(out).toContain(`<script>${source}</script>`);
    expect(out).toContain('name="bascik__my-comp__inst1__q"');
    expectParses(out);
  });

  it("leaves TypeScript type arguments in a text/typescript script alone", () => {
    const source =
      "const m = new Map<string, number>(); if (n<limit && m) { let id = m.size; use(id) } const z = 1 > 0;";
    const html = `<div id="panel"></div><script type="text/typescript">${source}</script>`;
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain(source);
  });

  it("still scopes markup built in string and template literals on the same line", () => {
    const html = [
      '<div id="panel"></div>',
      "<script>",
      'if (count<max && ok) { el.innerHTML = \'<p id="panel">\' + `<span id="panel">${count}</span>`; } if (a > b) go();',
      "</script>",
    ].join("\n");
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain(`'<p id="bascik__my-comp__inst1__panel">'`);
    expect(out).toContain(
      '`<span id="bascik__my-comp__inst1__panel">${count}</span>`',
    );
    expect(out).toContain("if (count<max && ok)");
    expectParses(out);
  });

  it("still scopes markup in server and stream script literals", () => {
    const html = [
      '<section id="results"></section>',
      "<script data-bascik-server>",
      'export default () => { const n = 2; return n<3 ? `<p id="results">few</p>` : "<p id=\'results\'>many</p>" }',
      "</script>",
    ].join("\n");
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain('`<p id="bascik__my-comp__inst1__results">few</p>`');
    expect(out).toContain(`"<p id='bascik__my-comp__inst1__results'>many</p>"`);
  });

  it("still treats a non-JavaScript script body as markup", () => {
    const html =
      '<div id="panel"></div><script type="text/template"><p id="panel">x</p></script>';
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain(
      '<script type="text/template"><p id="bascik__my-comp__inst1__panel">x</p></script>',
    );
  });

  it("is not thrown off by quotes in comments, regexes or an unterminated string", () => {
    const source = [
      "// don't stop here",
      "const re = /'/g; /* it's fine */",
      "const bad = 'unterminated",
      "if (count<max && ok) { const id = items[i]; use(id) } if (a > b) go()",
    ].join("\n");
    const html = `<div id="panel"></div><script>${source}</script>`;
    const out = prefixElementAttribute(
      makeComponent(html),
      "id",
      "inst1",
    ).fileContent!;
    expect(out).toContain(source);
  });
});
