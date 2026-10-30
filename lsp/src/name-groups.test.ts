/**
 * `shared-name-group`: a component that holds a whole name group (two or more radios with one name and no form of
 * its own, two or more `<details>` with one name, or a `<map name>`) and is used more than once on a page. `name`
 * ships as written, so the copies act as one group on the page.
 */
import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver";
import { createDiagnostics } from "./analyzer.js";
import { parseScopesName, type ProjectSnapshot } from "./project.js";

const COMPONENTS = "/site/src/components";
const PAGES = "/site/src/pages";

const project = (
  components: Record<string, string>,
  pages: Record<string, string>,
  overrides: Partial<ProjectSnapshot> = {},
): ProjectSnapshot => {
  const componentMap = new Map<string, string>();
  const componentSourceByFile = new Map<string, string>();
  for (const [name, source] of Object.entries(components)) {
    const file = `${COMPONENTS}/${name}.html`;
    componentMap.set(name, file);
    componentSourceByFile.set(file, source);
  }
  return {
    projectRoot: "/site",
    componentRoots: [COMPONENTS],
    apiRoot: "/site/src/api",
    componentMap,
    componentMetadata: new Map(),
    importRoot: "/site/src",
    pagesRoot: PAGES,
    htmlUsageByFile: new Map(
      Object.entries(pages).map(([page, html]) => [`${PAGES}/${page}`, html]),
    ),
    componentSourceByFile,
    ...overrides,
  };
};

const RADIOS = [
  "<fieldset>",
  "  <legend>Size</legend>",
  '  <label><input type="radio" name="size" value="s"> Small</label>',
  '  <label><input type="radio" name="size" value="l"> Large</label>',
  "</fieldset>",
].join("\n");

/** The `shared-name-group` diagnostics for component `name`, checked as an open document. */
const sharedNameGroups = (
  name: string,
  snapshot: ProjectSnapshot,
  openDocumentTexts: { fsPath: string; text: string }[] = [],
) => {
  const file = `${COMPONENTS}/${name}.html`;
  const text = snapshot.componentSourceByFile!.get(file)!;
  return createDiagnostics(
    TextDocument.create(`file://${file}`, "html", 1, text),
    file,
    snapshot,
    openDocumentTexts,
  ).filter((diagnostic) => diagnostic.code === "shared-name-group");
};

describe("shared-name-group", () => {
  it("warns on the name of a radio group in a component used twice on one page, naming both fixes", () => {
    const snapshot = project(
      { "size-picker": RADIOS },
      { "index.html": "<size-picker></size-picker>\n<size-picker />" },
    );
    const found = sharedNameGroups("size-picker", snapshot);
    expect(found).toHaveLength(1);
    const [warning] = found;
    expect(warning.severity).toBe(DiagnosticSeverity.Warning);
    // The range is the first radio's name attribute.
    const text = RADIOS;
    const nameAt = text.indexOf('name="size"');
    const doc = TextDocument.create("file:///x.html", "html", 1, text);
    expect(warning.range).toEqual({
      start: doc.positionAt(nameAt),
      end: doc.positionAt(nameAt + 'name="size"'.length),
    });
    const message = String(warning.message);
    expect(message).toContain('name="size"');
    expect(message).toContain("<size-picker>");
    expect(message).toContain("2 times");
    expect(message).toContain("src/pages/index.html");
    expect(message).toContain("one radio group");
    expect(message).toContain("<form>");
    expect(message).toContain('data-bascik-attr-name="');
    expect(message).toContain("data-bascik-prop-");
  });

  it("does not warn when the component is used once per page, even on many pages", () => {
    const snapshot = project(
      { "size-picker": RADIOS },
      {
        "index.html": "<size-picker></size-picker>",
        "about.html": "<size-picker />",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("does not warn when the radios are inside the component's own form", () => {
    const source = `<form method="post" action="/api/size">${RADIOS}<button>Save</button></form>`;
    const snapshot = project(
      { "size-picker": source },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("warns for the radios after the component's form closes", () => {
    const source = `<form><input type="radio" name="a"><input type="radio" name="a"></form>\n<input type="radio" name="b"><input type="radio" name="b">`;
    const snapshot = project(
      { "two-groups": source },
      { "index.html": "<two-groups></two-groups><two-groups></two-groups>" },
    );
    const found = sharedNameGroups("two-groups", snapshot);
    expect(found).toHaveLength(1);
    expect(String(found[0].message)).toContain('name="b"');
  });

  it("does not warn when the name is bound to a prop, with or without a literal name beside the binding", () => {
    const bound = [
      '<input type="radio" data-bascik-attr-name="group" value="s">',
      '<input type="radio" data-bascik-attr-name="group" value="l">',
    ].join("\n");
    const boundOverLiteral = [
      '<input type="radio" name="size" data-bascik-attr-name="group" value="s">',
      '<input type="radio" name="size" data-bascik-attr-name="group" value="l">',
    ].join("\n");
    for (const source of [bound, boundOverLiteral]) {
      const snapshot = project(
        { "size-picker": source },
        {
          "index.html":
            '<size-picker data-bascik-prop-group="a"></size-picker><size-picker data-bascik-prop-group="b"></size-picker>',
        },
      );
      expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
    }
  });

  it("does not warn for one radio per component: radios spread over instances are meant to be one group", () => {
    const snapshot = project(
      { "size-option": '<label><input type="radio" name="size"> S</label>' },
      {
        "index.html":
          "<size-option></size-option><size-option></size-option><size-option></size-option>",
      },
    );
    expect(sharedNameGroups("size-option", snapshot)).toEqual([]);
  });

  it("does not warn for a radio tied to a form elsewhere by its form attribute", () => {
    const source =
      '<input type="radio" name="size" form="order"><input type="radio" name="size" form="order">';
    const snapshot = project(
      { "size-picker": source },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("reads type and name the way a browser does: any case, any quoting, and ignores an empty name", () => {
    const source = [
      "<INPUT TYPE=Radio NAME=size>",
      "<input type='RADIO' name='size'>",
      '<input type="radio" name="">',
      '<input type="radio" name="">',
      '<input type="checkbox" name="extras"><input type="checkbox" name="extras">',
    ].join("\n");
    const snapshot = project(
      { "size-picker": source },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
    );
    const found = sharedNameGroups("size-picker", snapshot);
    expect(
      found.map((d) => String(d.message).match(/name="[^"]*"/)?.[0]),
    ).toEqual(['name="size"']);
    expect(found[0].range.start).toEqual({ line: 0, character: 18 });
  });

  it("ignores radios in comments, scripts and textareas", () => {
    const source = [
      '<!-- <input type="radio" name="size"><input type="radio" name="size"> -->',
      '<script>const t = `<input type="radio" name="size"><input type="radio" name="size">`;</script>',
      '<textarea><input type="radio" name="size"><input type="radio" name="size"></textarea>',
    ].join("\n");
    const snapshot = project(
      { "size-picker": source },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("warns for an exclusive <details> group in a component used twice, with the prop fix only", () => {
    const source = [
      '<details name="faq"><summary>Shipping</summary>Two days.</details>',
      '<details name="faq"><summary>Returns</summary>Thirty days.</details>',
    ].join("\n");
    const snapshot = project(
      { "faq-list": source },
      { "index.html": "<faq-list></faq-list>\n<faq-list></faq-list>" },
    );
    const found = sharedNameGroups("faq-list", snapshot);
    expect(found).toHaveLength(1);
    const message = String(found[0].message);
    expect(message).toContain("one exclusive accordion");
    expect(message).toContain('data-bascik-attr-name="');
    expect(message).not.toContain("<form>");
  });

  it("does not warn for one <details name> per component: an accordion built from one component per item", () => {
    const snapshot = project(
      {
        "accordion-item":
          '<details name="faq"><summary><span data-bascik-slot="question"></span></summary><span data-bascik-slot></span></details>',
      },
      {
        "index.html":
          "<accordion-item></accordion-item><accordion-item></accordion-item><accordion-item></accordion-item>",
      },
    );
    expect(sharedNameGroups("accordion-item", snapshot)).toEqual([]);
  });

  it("warns for a <map name> in a component used twice: the copies declare one map name", () => {
    const source = [
      '<img src="/plan.png" alt="Floor plan" usemap="#plan">',
      '<map name="plan"><area shape="rect" coords="0,0,10,10" href="/a" alt="A"></map>',
    ].join("\n");
    const snapshot = project(
      { "floor-plan": source },
      { "index.html": "<floor-plan></floor-plan><floor-plan></floor-plan>" },
    );
    const found = sharedNameGroups("floor-plan", snapshot);
    expect(found).toHaveLength(1);
    const message = String(found[0].message);
    expect(message).toContain('name="plan"');
    expect(message).toContain("usemap");
  });

  it("counts instances through nesting: once in a wrapper the page uses twice is twice", () => {
    const snapshot = project(
      {
        "size-picker": RADIOS,
        "product-card":
          "<article><h2>Card</h2><size-picker></size-picker></article>",
      },
      {
        "index.html":
          "<product-card></product-card><product-card></product-card>",
      },
    );
    const found = sharedNameGroups("size-picker", snapshot);
    expect(found).toHaveLength(1);
    expect(String(found[0].message)).toContain("2 times");
  });

  it("does not loop on components that use each other", () => {
    const snapshot = project(
      {
        "size-picker": `${RADIOS}<loop-a></loop-a>`,
        "loop-a": "<loop-b></loop-b><size-picker></size-picker>",
        "loop-b": "<loop-a></loop-a>",
      },
      { "index.html": "<loop-a></loop-a>" },
    );
    expect(() => sharedNameGroups("size-picker", snapshot)).not.toThrow();
  });

  it("does not count usages in page comments or in a component's own file", () => {
    const snapshot = project(
      { "size-picker": RADIOS },
      {
        "index.html":
          "<!-- <size-picker></size-picker> --><size-picker></size-picker>",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("follows unsaved text in an open page", () => {
    const snapshot = project(
      { "size-picker": RADIOS },
      { "index.html": "<size-picker></size-picker>" },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
    expect(
      sharedNameGroups("size-picker", snapshot, [
        {
          fsPath: `${PAGES}/index.html`,
          text: "<size-picker></size-picker><size-picker></size-picker>",
        },
      ]),
    ).toHaveLength(1);
  });

  it("is off when the project opts in to name scoping, which gives each instance its own names", () => {
    const snapshot = project(
      { "size-picker": RADIOS },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
      { scopesName: true },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("is silenced by bascik-ignore on the line above", () => {
    const source = `<!-- bascik-ignore shared-name-group -->\n${RADIOS.replace("<fieldset>\n  <legend>Size</legend>\n", "")}`;
    const snapshot = project(
      { "size-picker": source.replace("</fieldset>", "") },
      {
        "index.html": "<size-picker></size-picker><size-picker></size-picker>",
      },
    );
    expect(sharedNameGroups("size-picker", snapshot)).toEqual([]);
  });

  it("does not apply to pages, which are not repeated", () => {
    const snapshot = project({}, { "index.html": RADIOS });
    const file = `${PAGES}/index.html`;
    const found = createDiagnostics(
      TextDocument.create(`file://${file}`, "html", 1, RADIOS),
      file,
      snapshot,
    ).filter((diagnostic) => diagnostic.code === "shared-name-group");
    expect(found).toEqual([]);
  });
});

describe("parseScopesName", () => {
  it("reads scoping.attributes.name, off unless set to true", () => {
    expect(parseScopesName(undefined)).toBe(false);
    expect(parseScopesName("export default {}")).toBe(false);
    expect(
      parseScopesName(
        "export default { scoping: { attributes: { name: true } } }",
      ),
    ).toBe(true);
    expect(
      parseScopesName(
        "export default { scoping: { attributes: { class: false, id: true, name: false } } }",
      ),
    ).toBe(false);
    expect(
      parseScopesName(
        "export default { scoping: {\n  attributes: {\n    id: true,\n    name: true, // per instance\n  },\n} }",
      ),
    ).toBe(true);
    // A `name` key elsewhere in the config is not the scoping toggle.
    expect(
      parseScopesName(
        "export default { site: { name: true }, scoping: { attributes: { class: true } } }",
      ),
    ).toBe(false);
  });
});
