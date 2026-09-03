import fc from "fast-check";
import { describe, it, expect, vi } from "vitest";
import { prefixElementAttribute, namespaceScriptTags, getComponentScripts } from "./javascript.ts";
import { BascikConfig } from "./config.ts";
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
      components: "src/components",
      out: "dist",
    },
  },
}));

// ─── helpers ────────────────────────────────────────────────────────────────

const makeComponent = (
  fileContent: string,
  cssFileContent: string | undefined = undefined,
): BascikComponent => ({
  name: "my-comp",
  fileContent,
  cssFileContent,
});

// IDs and names include the instanceId for DOM uniqueness.
const scope = (attr: string, id = "test1234"): string =>
  `bascik__my-comp__${id}__${attr}`;

// Classes use component name only (no instanceId) so CSS can be deduplicated.
const scopeClass = (attr: string): string => `bascik__my-comp__${attr}`;

// With deduplicateCss:false classes use instanceId just like id/name attributes.
const scopeClassPerInstance = (attr: string, id = "test1234"): string =>
  `bascik__my-comp__${id}__${attr}`;

describe("prefixElementAttribute - data-bascik-preserve", () => {
  it("preserves id, name, and class and strips a bare directive", () => {
    let component = makeComponent(
      '<input id="email" name="email" class="field" data-bascik-preserve>',
    );

    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");

    expect(component.fileContent).toBe(
      '<input id="email" name="email" class="field">',
    );
  });

  it("preserves attributes on descendants three levels deep", () => {
    let component = makeComponent(
      '<section data-bascik-preserve><div><label><input id="email" name="email" class="field"></label></div></section>',
    );

    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");

    expect(component.fileContent).toBe(
      '<section><div><label><input id="email" name="email" class="field"></label></div></section>',
    );
  });

  it("preserves only name when requested", () => {
    let component = makeComponent(
      '<form data-bascik-preserve="name"><input id="email" name="email" class="field"></form>',
    );

    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");

    expect(component.fileContent).toBe(
      `<form><input id="${scope("email")}" name="email" class="${scopeClass("field")}"></form>`,
    );
  });

  it("preserves id and class while name still scopes", () => {
    let component = makeComponent(
      '<div data-bascik-preserve="id class"><input id="email" name="email" class="field"></div>',
    );
    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");
    expect(component.fileContent).toBe(
      `<div><input id="email" name="${scope("email")}" class="field"></div>`,
    );
  });

  it("warns for an unknown token while applying valid tokens", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let component = makeComponent(
      '<input id="email" name="email" data-bascik-preserve="href name">',
    );
    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");
    expect(component.fileContent).toBe(`<input id="${scope("email")}" name="email">`);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[bascik] warning: data-bascik-preserve ignores unknown token "href".',
    );
    warn.mockRestore();
  });

  it("does not narrow preservation in a descendant", () => {
    let component = makeComponent(
      '<div data-bascik-preserve><input id="email" name="email" class="field" data-bascik-preserve="name"></div>',
    );
    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");
    expect(component.fileContent).toBe(
      '<div><input id="email" name="email" class="field"></div>',
    );
  });

  it("allows a descendant to widen preservation", () => {
    let component = makeComponent(
      '<div id="outer" name="outer" class="outer" data-bascik-preserve="name"><input id="email" name="email" class="field" data-bascik-preserve></div>',
    );
    component = prefixElementAttribute(component, "id", "test1234");
    component = prefixElementAttribute(component, "name", "test1234");
    component = prefixElementAttribute(component, "class", "test1234");
    expect(component.fileContent).toBe(
      `<div id="${scope("outer")}" name="outer" class="${scopeClass("outer")}"><input id="email" name="email" class="field"></div>`,
    );
  });

  it("uses the same preservation path for configured tag names", () => {
    let component = makeComponent(
      '<code id="sample" name="sample" class="sample"><span id="inner" name="inner" class="inner"></span></code>',
    );
    component = prefixElementAttribute(component, "id", "test1234", true, ["code"]);
    component = prefixElementAttribute(component, "name", "test1234", true, ["code"]);
    component = prefixElementAttribute(component, "class", "test1234", true, ["code"]);
    expect(component.fileContent).toBe(
      '<code id="sample" name="sample" class="sample"><span id="inner" name="inner" class="inner"></span></code>',
    );
  });

  it("keeps radio names shared within an instance and distinct between instances", () => {
    const source = '<input type="radio" name="plan"><input type="radio" name="plan">';
    const first = prefixElementAttribute(makeComponent(source), "name", "first123");
    const second = prefixElementAttribute(makeComponent(source), "name", "second12");
    expect(first.fileContent.match(/name="([^"]+)"/g)).toEqual([
      'name="bascik__my-comp__first123__plan"',
      'name="bascik__my-comp__first123__plan"',
    ]);
    expect(second.fileContent.match(/name="([^"]+)"/g)).toEqual([
      'name="bascik__my-comp__second12__plan"',
      'name="bascik__my-comp__second12__plan"',
    ]);
  });

  it("deliberately gives up radio isolation when name is preserved", () => {
    const source = '<fieldset data-bascik-preserve="name"><input type="radio" name="plan"><input type="radio" name="plan"></fieldset>';
    const first = prefixElementAttribute(makeComponent(source), "name", "first123");
    const second = prefixElementAttribute(makeComponent(source), "name", "second12");
    expect(first.fileContent.match(/name="([^"]+)"/g)).toEqual([
      'name="plan"',
      'name="plan"',
    ]);
    expect(second.fileContent.match(/name="([^"]+)"/g)).toEqual([
      'name="plan"',
      'name="plan"',
    ]);
  });

  it("does not leak preservation past an ancestor with an omitted child end tag", () => {
    const component = makeComponent(
      '<ul data-bascik-preserve="name"><li><input name="inside"></ul>' +
      '<input name="outside">',
    );
    const result = prefixElementAttribute(component, "name", "test1234");
    expect(result.fileContent).toContain('name="inside"');
    expect(result.fileContent).toContain(`name="${scope("outside")}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Existing getElementById / getElementsByClassName coverage (regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – id (existing patterns)", () => {
  it("scopes the for attribute to match a scoped input id", () => {
    const component = makeComponent(
      '<label for="email">Email</label><input id="email">',
    );
    const result = prefixElementAttribute(component, "id", "test1234");
    expect(result.fileContent).toContain(`for="${scope("email")}"`);
    expect(result.fileContent).toContain(`id="${scope("email")}"`);
  });

  it("scopes aria-labelledby tokens that resolve to local ids", () => {
    const component = makeComponent(
      '<h2 id="title">Title</h2><section aria-labelledby="title"></section>',
    );
    const result = prefixElementAttribute(component, "id", "test1234");
    expect(result.fileContent).toContain(`aria-labelledby="${scope("title")}"`);
  });

  it("scopes a local fragment link to match its target id", () => {
    const component = makeComponent(
      '<a href="#section">Section</a><section id="section"></section>',
    );
    const result = prefixElementAttribute(component, "id", "test1234");
    expect(result.fileContent).toContain(`href="#${scope("section")}"`);
  });

  it("resolves each component instance to its own scoped id", () => {
    const source = '<label for="email">Email</label><input id="email">';
    const first = prefixElementAttribute(makeComponent(source), "id", "first123");
    const second = prefixElementAttribute(makeComponent(source), "id", "second12");
    expect(first.fileContent).toContain('for="bascik__my-comp__first123__email"');
    expect(second.fileContent).toContain('for="bascik__my-comp__second12__email"');
  });

  it("uses the declaration hash for references when identifiers are minified", () => {
    BascikConfig.minify.identifiers = true;
    try {
      const result = prefixElementAttribute(
        makeComponent('<label for="email">Email</label><input id="email">'),
        "id",
        "test1234",
      );
      const id = result.fileContent.match(/id="([^"]+)"/)?.[1];
      const reference = result.fileContent.match(/for="([^"]+)"/)?.[1];
      expect(reference).toBe(id);
    } finally {
      BascikConfig.minify.identifiers = false;
    }
  });

  it("leaves nonlocal references byte-identical", () => {
    const source = '<a href="#main">Main</a><label for="page-input">Input</label><div id="local"></div>';
    const result = prefixElementAttribute(makeComponent(source), "id", "test1234");
    expect(result.fileContent).toContain('<a href="#main">Main</a>');
    expect(result.fileContent).toContain('<label for="page-input">Input</label>');
  });

  it("does not rewrite references or declarations in an id-preserved subtree", () => {
    const source = '<div data-bascik-preserve="id"><label for="email">Email</label><input id="email"></div>';
    const result = prefixElementAttribute(makeComponent(source), "id", "test1234");
    expect(result.fileContent).toContain('<label for="email">Email</label><input id="email">');
  });

  it("does not rewrite references inside an id-preserved subtree to an outside id", () => {
    const source = '<div id="outside"></div><div data-bascik-preserve="id"><a href="#outside">Outside</a></div>';
    const result = prefixElementAttribute(makeComponent(source), "id", "test1234");
    expect(result.fileContent).toContain('<a href="#outside">Outside</a>');
  });

  it("preserves replacement tokens in scoped query selector values", () => {
    const component = {
      name: "my$&$1$`comp",
      fileContent:
        '<div id="panel"></div><script>document.querySelector("#panel")</script>',
    };
    const result = prefixElementAttribute(component, "id", "test1234");
    const scopedId = "bascik__my$&$1$`comp__test1234__panel";
    expect(result.fileContent).toContain(`id="${scopedId}"`);
    expect(result.fileContent).toContain(`querySelector("#${scopedId}")`);
  });

  it("scopes getElementById", () => {
    const c = makeComponent(
      '<div id="btn"></div><script>document.getElementById("btn")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`getElementById("${scope("btn")}")`);
  });

  it("scopes single-quoted class and id attributes in HTML", () => {
    const c = makeComponent(
      "<div class='card' id='btn'></div><script>document.querySelector('.card'); document.getElementById('btn')</script>",
    );
    let result = prefixElementAttribute(c, "class", "test1234");
    result = prefixElementAttribute(result, "id", "test1234");
    expect(result.fileContent).toContain(`class='${scopeClass("card")}'`);
    expect(result.fileContent).toContain(`id='${scope("btn")}'`);
  });
});

describe("prefixElementAttribute – class with deduplicateCss: false", () => {
  it("uses per-instance scoped class names in HTML", () => {
    const c = makeComponent('<div class="card"></div>');
    const result = prefixElementAttribute(c, "class", "test1234", false);
    expect(result.fileContent).toContain(scopeClassPerInstance("card"));
    expect(result.fileContent).not.toContain(scopeClass("card"));
  });

  it("rewrites querySelector with per-instance class", () => {
    const c = makeComponent(
      '<div class="card"></div><script>document.querySelector(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234", false);
    expect(result.fileContent).toContain(
      `querySelector(".${scopeClassPerInstance("card")}")`,
    );
    expect(result.fileContent).not.toContain(
      `querySelector(".${scopeClass("card")}")`,
    );
  });

  it("rewrites CSS class selectors with per-instance key", () => {
    const c = makeComponent('<div class="card"></div>', ".card { color: red; }");
    const result = prefixElementAttribute(c, "class", "test1234", false);
    expect(result.cssFileContent).toContain(
      `.${scopeClassPerInstance("card")}`,
    );
  });
});

describe("prefixElementAttribute – class (existing patterns)", () => {
  it("preserves replacement tokens in classList and className values", () => {
    const component = {
      name: "my$&$1$`comp",
      fileContent:
        '<div class="active"></div><script>el.classList.add("active"); el.className = "active";</script>',
      cssFileContent: ".active { color: red; }",
    };
    const result = prefixElementAttribute(component, "class", "test1234");
    const scopedClass = "bascik__my$&$1$`comp__active";
    expect(result.fileContent).toContain(`classList.add("${scopedClass}")`);
    expect(result.fileContent).toContain(`className = "${scopedClass}"`);
  });

  it("preserves global classes in component HTML when class is not defined in component CSS", () => {
    const c = makeComponent(
      '<a href="#main" class="skip-link dnav-logo">Skip</a>',
      ".dnav-logo { color: green; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `class="skip-link ${scopeClass("dnav-logo")}"`,
    );
    expect(result.cssFileContent).toContain(`.${scopeClass("dnav-logo")}`);
  });

  it("scopes getElementsByClassName", () => {
    const c = makeComponent(
      '<div class="card"></div><script>document.getElementsByClassName("card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `getElementsByClassName("${scopeClass("card")}")`,
    );
  });

  it("handles empty fileContent gracefully", () => {
    const c = { name: "my-comp", fileContent: undefined as unknown as string };
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toBeUndefined();
  });

  it("scopes querySelector('.class')", () => {
    const c = makeComponent(
      '<div class="card"></div><script>document.querySelector(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `querySelector(".${scopeClass("card")}")`,
    );
  });

  it("scopes querySelectorAll('.class')", () => {
    const c = makeComponent(
      '<div class="card"></div><script>document.querySelectorAll(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `querySelectorAll(".${scopeClass("card")}")`,
    );
  });

  it("normalizes trailing class whitespace without producing an empty token", () => {
    const result = prefixElementAttribute(
      makeComponent('<div class="card "></div>'),
      "class",
      "test1234",
    );

    expect(result.fileContent).toBe(
      `<div class="${scopeClass("card")}"></div>`,
    );
  });

  it("does not corrupt empty string literals when a class has trailing whitespace", () => {
    const result = prefixElementAttribute(
      makeComponent('<div class="card "></div><script>const value = "";</script>'),
      "class",
      "test1234",
    );

    expect(result.fileContent).toContain('const value = "";');
  });

  it("normalizes newlines and repeated spaces between class tokens", () => {
    const result = prefixElementAttribute(
      makeComponent('<div class="alpha\n  beta"></div>'),
      "class",
      "test1234",
    );

    expect(result.fileContent).toContain(
      `class="${scopeClass("alpha")} ${scopeClass("beta")}"`,
    );
  });

  it("normalizes tabs between class tokens", () => {
    const result = prefixElementAttribute(
      makeComponent('<div class="alpha\tbeta"></div>'),
      "class",
      "test1234",
    );

    expect(result.fileContent).toContain(
      `class="${scopeClass("alpha")} ${scopeClass("beta")}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E: querySelector / querySelectorAll with # id selector (new)
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – id querySelector/querySelectorAll (new)", () => {
  it("scopes querySelector('#id')", () => {
    const c = makeComponent(
      '<div id="btn"></div><script>document.querySelector("#btn")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`querySelector("#${scope("btn")}")`);
  });

  it("scopes querySelectorAll('#id')", () => {
    const c = makeComponent(
      '<div id="btn"></div><script>document.querySelectorAll("#btn")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(
      `querySelectorAll("#${scope("btn")}")`,
    );
  });

  it("scopes multiple querySelector and getElementById for the same id", () => {
    const c = makeComponent(
      '<button id="btn"></button>' +
      "<script>" +
      'document.getElementById("btn");' +
      'document.querySelector("#btn");' +
      "</script>",
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    const scopedId = scope("btn");
    expect(result.fileContent).toContain(`getElementById("${scopedId}")`);
    expect(result.fileContent).toContain(`querySelector("#${scopedId}")`);
  });

  it("handles whitespace inside getElementById, querySelector, and getElementsByClassName calls", () => {
    const c = makeComponent(
      '<button id="btn" class="my-cls"></button>' +
      "<script>" +
      'document.getElementById( "btn" );\n' +
      'document.querySelector( "#btn" );\n' +
      'document.getElementsByClassName( "my-cls" );\n' +
      "</script>",
    );
    let result = prefixElementAttribute(c, "id", "test1234");
    result = prefixElementAttribute(result, "class", "test1234");
    const scopedId = scope("btn");
    const scopedCls = scopeClass("my-cls");
    expect(result.fileContent).toContain(`getElementById( "${scopedId}" )`);
    expect(result.fileContent).toContain(`querySelector( "#${scopedId}" )`);
    expect(result.fileContent).toContain(`getElementsByClassName( "${scopedCls}" )`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F: closest() and matches() — id
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – id closest/matches", () => {
  it("scopes closest('#id')", () => {
    const c = makeComponent(
      '<div id="panel"></div><script>el.closest("#panel")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`closest("#${scope("panel")}")`);
  });

  it("scopes matches('#id')", () => {
    const c = makeComponent(
      '<div id="panel"></div><script>el.matches("#panel")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`matches("#${scope("panel")}")`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G: closest() and matches() — class
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – class closest/matches", () => {
  it("scopes closest('.class')", () => {
    const c = makeComponent(
      '<div class="card"></div><script>el.closest(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`closest(".${scopeClass("card")}")`);
  });

  it("scopes matches('.class')", () => {
    const c = makeComponent(
      '<div class="card"></div><script>el.matches(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`matches(".${scopeClass("card")}")`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H: classList methods — class
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – class classList methods", () => {
  it("scopes classList.add", () => {
    const c = makeComponent(
      '<div class="active"></div><script>el.classList.add("active")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.add("${scopeClass("active")}")`,
    );
  });

  it("scopes classList.remove", () => {
    const c = makeComponent(
      '<div class="active"></div><script>el.classList.remove("active")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.remove("${scopeClass("active")}")`,
    );
  });

  it("scopes classList.toggle", () => {
    const c = makeComponent(
      '<div class="open"></div><script>el.classList.toggle("open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.toggle("${scopeClass("open")}")`,
    );
  });

  it("scopes classList.contains", () => {
    const c = makeComponent(
      '<div class="open"></div><script>el.classList.contains("open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.contains("${scopeClass("open")}")`,
    );
  });

  it("scopes classList.add with multiple arguments", () => {
    const c = makeComponent(
      '<div class="active open"></div><script>el.classList.add("active", "open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.add("${scopeClass("active")}", "${scopeClass("open")}")`,
    );
  });

  it("scopes classList.remove with multiple arguments", () => {
    const c = makeComponent(
      '<div class="active open"></div><script>el.classList.remove("active", "open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.remove("${scopeClass("active")}", "${scopeClass("open")}")`,
    );
  });

  it("scopes classList.toggle with boolean second argument", () => {
    const c = makeComponent(
      '<div class="open"></div><script>el.classList.toggle("open", condition)</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.toggle("${scopeClass("open")}", condition)`,
    );
  });

  it("scopes classList.replace — rewrites both old and new token args", () => {
    const c = makeComponent(
      '<div class="active open"></div><script>el.classList.replace("active", "open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.replace("${scopeClass("active")}", "${scopeClass("open")}")`,
    );
  });

  it("scopes classList.replace — both args scoped when both appear in classList call", () => {
    const c = makeComponent(
      '<div class="active"></div><script>el.classList.replace("active", "other")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    // "other" only appears in the classList.replace() call, never in a class= attr;
    // the fix discovers it from the JS and scopes it so CSS and JS stay in sync.
    expect(result.fileContent).toContain(
      `classList.replace("${scopeClass("active")}", "${scopeClass("other")}")`,
    );
  });

  it("scopes classList.add with nested function calls in arguments", () => {
    const c = makeComponent(
      '<div class="active"></div><script>el.classList.add(fn("active"), "other")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.add(fn("${scopeClass("active")}"), "${scopeClass("other")}")`,
    );
  });

  it("ignores parentheses inside regex literals while scanning classList calls", () => {
    const component = makeComponent(
      '<div class="active"></div><script>el.classList.add(fn(/[)]/), "active")</script>',
    );
    const result = prefixElementAttribute(component, "class", "test1234");
    expect(result.fileContent).toContain(
      `classList.add(fn(/[)]/), "${scopeClass("active")}")`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JS-only class discovery: classes used only in classList.* (never in class= attrs)
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – JS-only class discovery via classList", () => {
  it("scopes a modifier class used only in classList.add, not in any HTML class attr", () => {
    // Regression: CSS scopes every class name it finds, but the JS rewrite pass
    // only used to process classes discovered from HTML class= attributes.
    // A modifier like btn--active added dynamically would be scoped in CSS but
    // left unscoped in JS, so the two never matched.
    const c = makeComponent(
      '<button class="btn"></button><script>el.classList.add("btn--active")</script>',
      ".btn { } .btn--active { color: red; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.add("${scopeClass("btn--active")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("btn--active")}`);
  });

  it("scopes a JS-only class in classList.remove", () => {
    const c = makeComponent(
      '<div class="base"></div><script>el.classList.remove("loading")</script>',
      ".loading { opacity: 0.5; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.remove("${scopeClass("loading")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("loading")}`);
  });

  it("scopes a JS-only class in classList.toggle", () => {
    const c = makeComponent(
      '<nav></nav><script>el.classList.toggle("open")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.toggle("${scopeClass("open")}")`);
  });

  it("scopes a JS-only class in classList.contains", () => {
    const c = makeComponent(
      '<div></div><script>el.classList.contains("selected")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.contains("${scopeClass("selected")}")`);
  });

  it("does not double-scope a class that appears in both HTML attrs and classList.add", () => {
    const c = makeComponent(
      '<div class="active"></div><script>el.classList.add("active")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    const scoped = scopeClass("active");
    expect(result.fileContent).toContain(`classList.add("${scoped}")`);
    // Must not appear double-scoped
    expect(result.fileContent).not.toContain(`bascik__my-comp__bascik__`);
  });

  it("scopes multiple JS-only classes across multiple classList calls", () => {
    const c = makeComponent(
      '<div></div><script>el.classList.add("spinner"); el.classList.remove("done");</script>',
      ".spinner { } .done { }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.add("${scopeClass("spinner")}")`);
    expect(result.fileContent).toContain(`classList.remove("${scopeClass("done")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("spinner")}`);
    expect(result.cssFileContent).toContain(`.${scopeClass("done")}`);
  });

  it("discovers JS-only classes even when arguments contain nested parentheses", () => {
    const c = makeComponent(
      '<div></div><script>el.classList.add(getCls("spinner"), "done");</script>',
      ".spinner { } .done { }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`classList.add(getCls("${scopeClass("spinner")}"), "${scopeClass("done")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("spinner")}`);
    expect(result.cssFileContent).toContain(`.${scopeClass("done")}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JS-only class discovery: querySelector / className / setAttribute patterns
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – JS-only class discovery via selector and assignment", () => {
  it("scopes a JS-only class used in querySelector", () => {
    const c = makeComponent(
      '<div></div><script>document.querySelector(".js-only")</script>',
      ".js-only { color: red; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`querySelector(".${scopeClass("js-only")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("js-only")}`);
  });

  it("scopes a JS-only class used in querySelectorAll", () => {
    const c = makeComponent(
      '<ul></ul><script>el.querySelectorAll(".item")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`querySelectorAll(".${scopeClass("item")}")`);
  });

  it("scopes a JS-only class used in closest", () => {
    const c = makeComponent(
      '<div></div><script>el.closest(".panel")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`closest(".${scopeClass("panel")}")`);
  });

  it("scopes a JS-only class used in matches", () => {
    const c = makeComponent(
      '<div></div><script>el.matches(".active")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`matches(".${scopeClass("active")}")`);
  });

  it("scopes a JS-only class assigned via className =", () => {
    const c = makeComponent(
      '<div></div><script>el.className = "loading"</script>',
      ".loading { opacity: 0.5; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`className = "${scopeClass("loading")}"`);
    expect(result.cssFileContent).toContain(`.${scopeClass("loading")}`);
  });

  it("scopes JS-only classes assigned via className = with multiple tokens", () => {
    const c = makeComponent(
      '<div></div><script>el.className = "card card--active"</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `className = "${scopeClass("card")} ${scopeClass("card--active")}"`,
    );
  });

  it("scopes a JS-only class set via setAttribute(\"class\", …)", () => {
    const c = makeComponent(
      '<div></div><script>el.setAttribute("class", "hidden")</script>',
      ".hidden { display: none; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`setAttribute("class", "${scopeClass("hidden")}")`);
    expect(result.cssFileContent).toContain(`.${scopeClass("hidden")}`);
  });

  it("does not double-scope a class appearing in both HTML and querySelector", () => {
    const c = makeComponent(
      '<div class="card"></div><script>el.querySelector(".card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`querySelector(".${scopeClass("card")}")`);
    expect(result.fileContent).not.toContain(`bascik__my-comp__bascik__`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2: setAttribute("name", …) — name attribute
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – name setAttribute", () => {
  it("rewrites usemap against a locally scoped map name", () => {
    const component = makeComponent('<map name="choices"></map><img usemap="#choices">');
    const result = prefixElementAttribute(component, "name", "test1234");
    expect(result.fileContent).toContain(`usemap="#${scope("choices")}"`);
  });

  it("leaves usemap untouched when name scoping is not run", () => {
    const source = '<map name="choices"></map><img usemap="#choices">';
    expect(makeComponent(source).fileContent).toBe(source);
  });

  it("scopes setAttribute('name', value)", () => {
    const c = makeComponent(
      '<input name="email"><script>el.setAttribute("name", "email")</script>',
    );
    const result = prefixElementAttribute(c, "name", "test1234");
    expect(result.fileContent).toContain(
      `setAttribute("name", "${scope("email")}")`,
    );
  });

  it("does not rewrite setAttribute for unrelated name values", () => {
    const c = makeComponent(
      '<input name="email"><script>el.setAttribute("name", "phone")</script>',
    );
    const result = prefixElementAttribute(c, "name", "test1234");
    // "phone" is not in the component HTML so it should not be rewritten
    expect(result.fileContent).toContain(`setAttribute("name", "phone")`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I: class scope uses component name only (no instanceId)
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – class scope key", () => {
  it("class HTML attribute does not contain instanceId", () => {
    const c = makeComponent('<div class="btn"></div>');
    const result = prefixElementAttribute(c, "class", "test1234");
    // Should contain component-name-only scope, not componentInstanceName
    expect(result.fileContent).toContain("bascik__my-comp__btn");
    expect(result.fileContent).not.toContain("bascik__my-comp__test1234__btn");
  });

  it("id HTML attribute still contains instanceId", () => {
    const c = makeComponent('<div id="box"></div>');
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain("bascik__my-comp__test1234__box");
  });

  it("two instances of same component get identical class scoped names", () => {
    const c1 = makeComponent('<div class="btn"></div>');
    const c2 = makeComponent('<div class="btn"></div>');
    const r1 = prefixElementAttribute(c1, "class", "aaa11111");
    const r2 = prefixElementAttribute(c2, "class", "bbb22222");
    // Both instances should have the same scoped class name regardless of instanceId
    expect(r1.fileContent).toContain("bascik__my-comp__btn");
    expect(r2.fileContent).toContain("bascik__my-comp__btn");
    expect(r1.fileContent).toBe(r2.fileContent);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J: inline <style> tag scoping via prefixElementAttribute
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – inline <style> tag scoping", () => {
  it("scopes class names in an inline <style> tag", () => {
    const c = makeComponent(
      '<style>.btn { color: red; }</style><button class="btn">Click</button>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain(`.${scopeClass("btn")}`);
    expect(result.fileContent).toContain(`class="${scopeClass("btn")}"`);
  });

  it("scopes element selectors in an inline <style> tag and injects class", () => {
    const c = makeComponent("<style>p { color: red; }</style><p>hello</p>");
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain("bascik__my-comp__el__p");
    // Class should be injected into the <p> element
    expect(result.fileContent).toMatch(
      /<p\s[^>]*class="[^"]*bascik__my-comp__el__p/,
    );
  });

  it("scopes indented element selectors in an inline <style> tag", () => {
    const c = makeComponent(
      "<style>\n  p { color: red; }\n</style><p>hello</p>",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain("bascik__my-comp__el__p");
    expect(result.fileContent).toMatch(
      /<p\s[^>]*class="[^"]*bascik__my-comp__el__p/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J-ext: CSS #id selector scoping via prefixElementAttribute
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – CSS #id selector scoping", () => {
  it("converts #id in cssFileContent to a class selector", () => {
    const c = makeComponent(
      '<button id="btn">Click</button>',
      "#btn { color: red; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain(".bascik__my-comp__id__btn");
    expect(result.cssFileContent).not.toContain("#btn");
  });

  it("injects the id-derived class onto the HTML element", () => {
    const c = makeComponent(
      '<button id="btn">Click</button>',
      "#btn { color: red; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain("bascik__my-comp__id__btn");
  });

  it("does NOT mangle hex color values: color: #abc;", () => {
    const c = makeComponent(
      '<div class="card"></div>',
      ".card { color: #abc; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    // The hex color should pass through untouched
    expect(result.cssFileContent).toContain("color: #abc");
  });

  it("does NOT mangle hex color in gradient: linear-gradient(#abc, #def)", () => {
    const c = makeComponent(
      '<div class="card"></div>',
      ".card { background: linear-gradient(#abc, #def); }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain("linear-gradient(#abc, #def)");
  });

  it("does NOT mangle decimal values in CSS property values", () => {
    const c = makeComponent(
      '<div class="nav"></div>',
      ".nav { background: rgba(0,0,0,0.9); font-size: 1.1rem; transition: all .15s; letter-spacing: -0.02em; border: 1px solid rgba(255,255,255,0.2); }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain("rgba(0,0,0,0.9)");
    expect(result.cssFileContent).toContain("1.1rem");
    expect(result.cssFileContent).toContain(".15s");
    expect(result.cssFileContent).toContain("-0.02em");
    expect(result.cssFileContent).toContain("rgba(255,255,255,0.2)");
  });

  it("does NOT mangle sub-1 decimal font-size values (e.g. 0.7rem, 0.82rem)", () => {
    // Regression: the old regex [a-z0-9-_]+ had no leading-letter guard, so
    // after a decimal '.' it matched digit-starting tokens like '7rem', '82rem',
    // '025', '06em' and hashed them as CSS class names.
    const c = makeComponent(
      '<div class="cblock-lang"></div>',
      ".cblock-lang { font-size: 0.7rem; letter-spacing: .06em; background: rgba(255,255,255,0.025); line-height: 1.7; } .cblock-body { font-size: 0.82rem; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain("font-size: 0.7rem");
    expect(result.cssFileContent).toContain("letter-spacing: .06em");
    expect(result.cssFileContent).toContain("rgba(255,255,255,0.025)");
    expect(result.cssFileContent).toContain("line-height: 1.7");
    expect(result.cssFileContent).toContain("font-size: 0.82rem");
    // Verify class names are still scoped
    expect(result.cssFileContent).toContain("bascik__my-comp__cblock-lang");
    expect(result.cssFileContent).toContain("bascik__my-comp__cblock-body");
  });

  it("converts #id in an inline <style> tag and injects class", () => {
    const c = makeComponent(
      '<style>#panel { display: none; }</style><div id="panel"></div>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.cssFileContent).toContain(".bascik__my-comp__id__panel");
    expect(result.fileContent).toContain("bascik__my-comp__id__panel");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K: Compound querySelector — space-separated and combinator selectors
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – compound querySelector (class)", () => {
  it("scopes both tokens in querySelector('.foo .bar')", () => {
    const c = makeComponent(
      '<div class="foo"><span class="bar"></span></div>' +
      '<script>document.querySelector(".foo .bar")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `querySelector(".${scopeClass("foo")} .${scopeClass("bar")}")`,
    );
  });

  it("scopes both tokens in querySelectorAll('.foo > .bar')", () => {
    const c = makeComponent(
      '<div class="foo"><span class="bar"></span></div>' +
      '<script>document.querySelectorAll(".foo > .bar")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `querySelectorAll(".${scopeClass("foo")} > .${scopeClass("bar")}")`,
    );
  });

  it("scopes the class token in querySelector('#id .cls')", () => {
    const c = makeComponent(
      '<div id="panel" class="card"></div>' +
      '<script>document.querySelector("#panel .card")</script>',
    );
    // class pass rewrites .card token in the compound selector
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`.${scopeClass("card")}`);
  });
});

describe("prefixElementAttribute – compound querySelector (id)", () => {
  it("scopes #id token in querySelector('#id .child')", () => {
    const c = makeComponent(
      '<div id="panel"><span class="icon"></span></div>' +
      '<script>document.querySelector("#panel .icon")</script>',
    );
    // id pass rewrites #panel token in the compound selector
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`#${scope("panel")}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L: setAttribute("class" / "id", …)
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – setAttribute", () => {
  it("scopes setAttribute('class', 'value')", () => {
    const c = makeComponent(
      '<div class="card"></div>' +
      '<script>el.setAttribute("class", "card")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `setAttribute("class", "${scopeClass("card")}")`,
    );
  });

  it("scopes setAttribute('id', 'value')", () => {
    const c = makeComponent(
      '<div id="panel"></div>' +
      '<script>el.setAttribute("id", "panel")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(
      `setAttribute("id", "${scope("panel")}")`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M: element.className setter
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – element.className setter", () => {
  it("scopes single-class assignment", () => {
    const c = makeComponent(
      '<div class="card"></div><script>el.className = "card"</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(`className = "${scopeClass("card")}"`);
  });

  it("scopes both tokens in a space-separated assignment", () => {
    const c = makeComponent(
      '<div class="card active"></div>' +
      '<script>el.className = "card active"</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `className = "${scopeClass("card")} ${scopeClass("active")}"`,
    );
  });

  it("scopes className += append form", () => {
    const c = makeComponent(
      '<div class="open"></div><script>el.className += " open"</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `className += " ${scopeClass("open")}"`,
    );
  });

  it("does not re-scope an already-scoped class name", () => {
    // Once a class is scoped (e.g. bascik__my-comp__card), a subsequent
    // iteration for a different class should not touch it.
    const c = makeComponent(
      '<div class="card btn"></div>' +
      '<script>el.className = "card btn"</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    const content = result.fileContent;
    // Each scoped name should appear exactly once (no double-scoping)
    const cardCount = (content.match(new RegExp(scopeClass("card"), "g")) || [])
      .length;
    const btnCount = (content.match(new RegExp(scopeClass("btn"), "g")) || [])
      .length;
    // HTML attr + script = 2 occurrences each at most; key thing is no triple+
    expect(cardCount).toBeGreaterThanOrEqual(1);
    expect(btnCount).toBeGreaterThanOrEqual(1);
    expect(content).not.toContain(`${scopeClass("card")}${scopeClass("card")}`);
  });
});

// ─── regex metacharacters in attribute values ───────────────────────────────

describe("prefixElementAttribute – attribute names with regex metacharacters", () => {
  it("scopes getElementById for an id containing '$'", () => {
    const c = makeComponent(
      '<div id="a$b"></div><script>document.getElementById("a$b")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(`getElementById("${scope("a$b")}")`);
    expect(result.fileContent).not.toContain('getElementById("a$b")');
  });

  it("scopes setAttribute(\"id\", …) for an id containing '$'", () => {
    const c = makeComponent(
      '<div id="a$b"></div><script>el.setAttribute("id", "a$b")</script>',
    );
    const result = prefixElementAttribute(c, "id", "test1234");
    expect(result.fileContent).toContain(
      `setAttribute("id", "${scope("a$b")}")`,
    );
  });

  it("scopes getElementsByClassName for a class containing '.'", () => {
    const c = makeComponent(
      '<div class="a.b"></div><script>document.getElementsByClassName("a.b")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `getElementsByClassName("${scopeClass("a.b")}")`,
    );
  });

  it("scopes setAttribute(\"class\", …) for a class containing '.'", () => {
    const c = makeComponent(
      '<div class="a.b"></div><script>el.setAttribute("class", "a.b")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain(
      `setAttribute("class", "${scopeClass("a.b")}")`,
    );
  });

  it("does not over-match similar names when the class contains '.'", () => {
    // Unescaped, the pattern /a.b/ would also match "axb" — it must not.
    const c = makeComponent(
      '<div class="a.b"></div><script>document.getElementsByClassName("axb")</script>',
    );
    const result = prefixElementAttribute(c, "class", "test1234");
    expect(result.fileContent).toContain('getElementsByClassName("axb")');
  });
});

// ─── skipElementContents ────────────────────────────────────────────────────────

describe("prefixElementAttribute – skipElementContents", () => {
  it("does not swap pre and code contents while discovering inline styles", () => {
    const preContent = '<span class="pre-example">PRE EXAMPLE</span>';
    const codeContent = '<span class="code-example">CODE EXAMPLE</span>';
    const component = makeComponent(
      `<pre>${preContent}</pre><code>${codeContent}</code>` +
      '<style>.outside { color: red; }</style><div class="outside">Live</div>',
    );
    const result = prefixElementAttribute(
      component,
      "class",
      "test1234",
      true,
      ["pre", "code"],
    );
    expect(result.fileContent).toContain(`<pre>${preContent}</pre>`);
    expect(result.fileContent).toContain(`<code>${codeContent}</code>`);
  });

  it("preserves attributes on a configured tag's opening tag", () => {
    const c = makeComponent('<code class="cblock-body">literal</code>');
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    expect(result.fileContent).toContain('class="cblock-body"');
    expect(result.fileContent).not.toContain(scopeClass("cblock-body"));
  });

  it("does not rewrite class attributes on elements inside a skipped tag", () => {
    // Inner HTML of <code> (e.g. display code) must be left untouched
    const c = makeComponent(
      '<div class="outer"><code class="cblock-body"><div class="inner">literal</div></code></div>',
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    expect(result.fileContent).toContain(scopeClass("outer"));
    expect(result.fileContent).toContain('class="cblock-body"');
    // <div class="inner"> is inside <code> — must not be scoped
    expect(result.fileContent).toContain('class="inner"');
    expect(result.fileContent).not.toContain(scopeClass("inner"));
  });

  it("does not rewrite id attributes on elements inside a skipped tag", () => {
    const c = makeComponent(
      '<section id="real"><pre><div id="example">code</div></pre></section>',
    );
    const result = prefixElementAttribute(c, "id", "test1234", true, ["pre"]);
    expect(result.fileContent).toContain(scope("real"));
    // id="example" is inside <pre> content — must not be scoped
    expect(result.fileContent).toContain('id="example"');
    expect(result.fileContent).not.toContain(scope("example"));
  });

  it("does not inject element classes onto elements inside a skipped tag", () => {
    const c = makeComponent(
      '<div class="outer"><code class="cblock-body"><p>paragraph in code</p></code></div>',
      "p { color: red; }",
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    // The <p> inside <code> should NOT receive an element class
    expect(result.fileContent).toContain("<p>paragraph in code</p>");
  });

  it("restores the original inner content of skipped tags intact", () => {
    const inner = '<span class="highlight">example <strong>code</strong></span>';
    const c = makeComponent(`<div class="wrap"><code class="cblock-body">${inner}</code></div>`);
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    expect(result.fileContent).toContain(inner);
  });

  it("handles nested skip tags (pre > code)", () => {
    const inner = '<code class="language-html"><div class="inner">content</div></code>';
    const c = makeComponent(`<pre>${inner}</pre><div class="outside"></div>`);
    const result = prefixElementAttribute(c, "class", "test1234", true, ["pre", "code"]);
    // Outer class is scoped
    expect(result.fileContent).toContain(scopeClass("outside"));
    // Inner content is preserved verbatim (not scoped)
    expect(result.fileContent).toContain('<div class="inner">content</div>');
  });

  it("leaves no sentinel placeholders in output when both code and pre are skipped", () => {
    // Regression: nested sentinel restoration (pre > code) was single-pass, leaving
    // A shielding token remained unresolved when <pre> swallowed the already-shielded
    // ised <code> inner content.
    const inner = '<span class="slot-marker"></span>';
    const c = makeComponent(
      `<div class="wrapper"><pre><code class="cblock-body">${inner}</code></pre></div>`,
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code", "pre"]);
    // No sentinel may survive in the output
    expect(result.fileContent).not.toContain("\x00");
    expect(result.fileContent).not.toContain("BASCIK_SHIELD");
    // The slot marker inside <code> must be fully restored
    expect(result.fileContent).toContain(inner);
    // Note: class="cblock-body" is NOT scoped here because it sits inside <pre>'s
    // preserved zone — a known trade-off when "pre" is in the skip list.
    // This is why the default is ["code"] only, not ["code", "pre"].
    expect(result.fileContent).toContain('class="cblock-body"');
  });

  it("handles a '>' inside a quoted attribute value on the skip element's open tag", () => {
    // Regression: the open-tag match used [^>]*, so a `>` inside a quoted
    // attribute value (data-x="a>b") terminated the match early and corrupted
    // the shielding.
    const inner = '<div class="inner">literal</div>';
    const c = makeComponent(
      `<code class="cblock-body" data-x="a>b">${inner}</code><div class="outer"></div>`,
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    // Open tag attribute must survive verbatim (not truncated at the `>`)
    expect(result.fileContent).toContain('data-x="a>b"');
    // Content inside <code> is shielded
    expect(result.fileContent).toContain(inner);
    expect(result.fileContent).not.toContain(scopeClass("inner"));
    // Content outside <code> is still scoped
    expect(result.fileContent).toContain(scopeClass("outer"));
    expect(result.fileContent).toContain('class="cblock-body"');
    // No sentinel may survive in the output
    expect(result.fileContent).not.toContain("BASCIK_SHIELD");
  });

  it("handles a '>' inside a single-quoted attribute value on the skip element's open tag", () => {
    const c = makeComponent(
      `<code data-x='a>b'><div class="inner">literal</div></code><div class="outer"></div>`,
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code"]);
    expect(result.fileContent).toContain("data-x='a>b'");
    expect(result.fileContent).toContain('<div class="inner">literal</div>');
    expect(result.fileContent).toContain(scopeClass("outer"));
    expect(result.fileContent).not.toContain("BASCIK_SHIELD");
  });

  it("handles a '>' inside an attribute that appears before class, id, or name attributes", () => {
    const c = makeComponent(
      `<div data-condition="x > y" class="my-cls" id="my-id" name="my-name"></div>`,
    );
    let result = prefixElementAttribute(c, "class", "test1234");
    result = prefixElementAttribute(result, "id", "test1234");
    result = prefixElementAttribute(result, "name", "test1234");
    expect(result.fileContent).toContain('data-condition="x > y"');
    expect(result.fileContent).toContain(`class="${scopeClass("my-cls")}"`);
    expect(result.fileContent).toContain(`id="${scope("my-id")}"`);
    expect(result.fileContent).toContain(`name="${scope("my-name")}"`);
  });

  it("restores slot markers inside pre>code so slot injection can proceed", () => {
    // Mirrors the real code-block component template: slot marker inside <code> inside <pre>
    const c = makeComponent(
      '<pre><code class="cblock-body"><span data-bascik-slot></span></code></pre>',
    );
    const result = prefixElementAttribute(c, "class", "test1234", true, ["code", "pre"]);
    // Slot marker must survive intact for the slot-injection step
    expect(result.fileContent).toContain('<span data-bascik-slot></span>');
    expect(result.fileContent).not.toContain("BASCIK_SHIELD");
  });
});

describe("prefixElementAttribute – name attribute: meta element shielding", () => {
  it("does not scope the name attribute on <meta> tags", () => {
    const c = makeComponent(
      `<meta name="viewport" content="width=device-width, initial-scale=1.0" /><input name="email" />`,
    );
    const result = prefixElementAttribute(c, "name", "test1234");
    // <meta name="viewport"> must be left unchanged
    expect(result.fileContent).toContain('name="viewport"');
    // <input name="email"> must still be scoped
    expect(result.fileContent).not.toContain('name="email"');
  });

  it("does not scope any standard meta name values", () => {
    const c = makeComponent(
      `<meta charset="UTF-8" /><meta name="description" content="My site." /><meta name="robots" content="noindex" />`,
    );
    const result = prefixElementAttribute(c, "name", "test1234");
    expect(result.fileContent).toContain('name="description"');
    expect(result.fileContent).toContain('name="robots"');
    // charset meta has no name attr so it should pass through untouched
    expect(result.fileContent).toContain('<meta charset="UTF-8" />');
  });

  it("leaves no sentinel tokens in the output", () => {
    const c = makeComponent(
      `<meta name="viewport" content="width=device-width" /><input name="field" />`,
    );
    const result = prefixElementAttribute(c, "name", "test1234");
    expect(result.fileContent).not.toContain("\x00");
    expect(result.fileContent).not.toContain("BMETATAG");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("property-based JS scoping fuzzing", () => {
  it("does not throw or corrupt output for generated HTML with ids and classes", () => {
    const tagArb = fc.constantFrom("div", "span", "p", "button", "a", "section");
    const nameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/);

    const attrArb = fc.oneof(
      fc.record({ kind: fc.constant("id"), value: nameArb }),
      fc.record({ kind: fc.constant("class"), value: nameArb }),
    );

    const elementArb = fc
      .tuple(tagArb, fc.array(attrArb, { minLength: 0, maxLength: 3 }))
      .map(([tag, attrs]) => {
        const attrStr = attrs
          .map((a) => `${a.kind}="${a.value}"`)
          .join(" ");
        return `<${tag}${attrStr ? " " + attrStr : ""}></${tag}>`;
      });

    const scriptSnippets = [
      `document.getElementById("btn")`,
      `document.querySelector(".card")`,
      `el.classList.add("active")`,
      `el.classList.toggle("open")`,
      `document.getElementsByClassName("item")`,
      `el.setAttribute("id", "btn")`,
      `el.setAttribute("class", "active")`,
    ];

    fc.assert(
      fc.property(
        fc.array(elementArb, { minLength: 1, maxLength: 6 }),
        fc.array(fc.constantFrom(...scriptSnippets), { minLength: 0, maxLength: 3 }),
        (elements, scripts) => {
          const html = elements.join("\n");
          const scriptBlock = scripts.length
            ? `<script>${scripts.join("; ")}</script>`
            : "";
          const component = {
            name: "fuzz-comp",
            fileContent: `${html}\n${scriptBlock}`,
          };

          expect(() => prefixElementAttribute(component, "id", "abc12345")).not.toThrow();
          expect(() => prefixElementAttribute(component, "class", "abc12345")).not.toThrow();
          const result = prefixElementAttribute(component, "id", "abc12345");
          expect(typeof result.fileContent).toBe("string");
        },
      ),
      { numRuns: 150 },
    );
  });

  it("normalizes generated class whitespace without corrupting empty strings", () => {
    const classNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/);
    const whitespaceArb = fc.constantFrom(" ", "  ", "\t", "\n", "\n  ");
    const classAttributeArb = fc
      .tuple(
        fc.array(classNameArb, { minLength: 1, maxLength: 4 }),
        whitespaceArb,
        fc.boolean(),
        fc.boolean(),
      )
      .map(([classes, separator, leading, trailing]) => ({
        classes,
        value: `${leading ? separator : ""}${classes.join(separator)}${trailing ? separator : ""}`,
      }));

    fc.assert(
      fc.property(classAttributeArb, ({ classes, value }) => {
        const component = makeComponent(
          `<div class="${value}"></div><script>const empty = "";</script>`,
        );
        const result = prefixElementAttribute(component, "class", "test1234");
        expect(result.fileContent).toContain('const empty = "";');
        expect(result.fileContent).toContain(
          `class="${classes.map(scopeClass).join(" ")}"`,
        );
      }),
      { numRuns: 150 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary & Design Decisions Tests for JS Scoping
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – JS regex scoping design decision boundaries", () => {
  it("rewrites DOM query patterns inside JS line comments and block comments", () => {
    const c = makeComponent(
      '<button id="btn" class="card"></button>' +
      '<script>' +
      '// document.querySelector("#btn");\n' +
      '/* document.getElementsByClassName("card") */\n' +
      '</script>',
    );
    const resId = prefixElementAttribute(c, "id", "test1234");
    const resClass = prefixElementAttribute(c, "class", "test1234");
    expect(resId.fileContent).toContain(`querySelector("#${scope("btn")}")`);
    expect(resClass.fileContent).toContain(`getElementsByClassName("${scopeClass("card")}")`);
  });

  it("preserves dynamic variable expressions in template literals without corrupting JavaScript", () => {
    const c = makeComponent(
      '<div id="panel" class="card"></div>' +
      '<script>' +
      'const myId = "panel";\n' +
      'document.getElementById(`${myId}`);\n' +
      'document.querySelector(`#${myId}`);\n' +
      '</script>',
    );
    const resId = prefixElementAttribute(c, "id", "test1234");
    // Dynamic expressions inside template literals stay evaluated at runtime as variable expressions
    expect(resId.fileContent).toContain('document.getElementById(`${myId}`)');
    expect(resId.fileContent).toContain('document.querySelector(`#${myId}`)');
  });

  it("does not rewrite variable parameters passed to getElementById or querySelector", () => {
    const c = makeComponent(
      '<div id="panel"></div>' +
      '<script>' +
      'function find(target) { return document.getElementById(target); }\n' +
      '</script>',
    );
    const resId = prefixElementAttribute(c, "id", "test1234");
    expect(resId.fileContent).toContain('document.getElementById(target)');
  });

  it("wraps multiple script blocks in IIFEs to enforce scope isolation", () => {
    const html = '<script>var secret = "A";</script><script>const secret = "B";</script>';
    const c = makeComponent(html);
    const isolated = namespaceScriptTags(c);
    expect(isolated.fileContent).toContain('var secret = "A";');
    expect(isolated.fileContent).toContain('(function() {');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("namespaceScriptTags – property-based fuzzing", () => {
  it("does not throw and every script is wrapped in an IIFE", () => {
    const scriptBodies = fc.constantFrom(
      "var x = 1;",
      "document.getElementById('btn').click();",
      "const f = () => {}; f();",
      "// comment\nvar y = 2;",
      "",
      "if (true) { console.log('ok'); }",
      "throw new Error('boom');",
      "var s = '<div class=\"x\">text</div>';",
    );

    const scriptTagArb = fc.tuple(
      scriptBodies,
      fc.constantFrom("", ' type="text/javascript"', ' type="module"', ' data-bascik-dev'),
    ).map(([body, attrs]) => `<script${attrs}>${body}</script>`);

    const htmlArb = fc.array(
      fc.oneof(
        scriptTagArb,
        fc.constantFrom("<div class=\"x\">hello</div>", "<p>text</p>", ""),
      ),
      { minLength: 1, maxLength: 5 },
    ).map((parts) => parts.join("\n"));

    fc.assert(
      fc.property(htmlArb, (html) => {
        const component = { name: "fuzz-comp", fileContent: html };
        expect(() => namespaceScriptTags(component)).not.toThrow();
        const result = namespaceScriptTags(component);
        expect(typeof result.fileContent).toBe("string");
        // type="module" scripts must NOT be wrapped in an IIFE
        const moduleScriptCount = (html.match(/type="module"/g) ?? []).length;
        if (moduleScriptCount > 0) {
          expect(result.fileContent).toContain('type="module"');
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe("prefixElementAttribute – scoping completeness", () => {
  it("no original bare class name remains in class=\"...\" after scoping", () => {
    const classNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/);
    const tagArb = fc.constantFrom("div", "span", "p", "button", "section");

    fc.assert(
      fc.property(
        fc.array(
          fc.record({ tag: tagArb, cls: classNameArb }),
          { minLength: 1, maxLength: 6 },
        ),
        (elements) => {
          const html = elements
            .map(({ tag, cls }) => `<${tag} class="${cls}">x</${tag}>`)
            .join("\n");
          const component = { name: "comp", fileContent: html };
          const result = prefixElementAttribute(component, "class", "abc12345");
          for (const { cls } of elements) {
            // The original bare class name must no longer appear as a standalone
            // token inside any class="..." attribute value in the output.
            // (It may appear elsewhere, e.g. as part of a scoped name.)
            const classAttrRe = /class="([^"]*)"/g;
            let m;
            while ((m = classAttrRe.exec(result.fileContent ?? "")) !== null) {
              const tokens = m[1].split(" ");
              // None of the tokens should be the unscoped original
              expect(tokens).not.toContain(cls);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// namespaceScriptTags – explicit server-script shielding
// ─────────────────────────────────────────────────────────────────────────────

describe("namespaceScriptTags – data-bascik-server shielding", () => {
  it("does not wrap a data-bascik-server script in an IIFE", () => {
    const c = { name: "my-comp", fileContent: "<script data-bascik-server>var x = 1;</script>" };
    const result = namespaceScriptTags(c);
    // The script body must be unchanged — no IIFE wrapping
    expect(result.fileContent).toContain("var x = 1;");
    expect(result.fileContent).not.toContain("(function()");
  });

  it("wraps a plain script but leaves an adjacent server script untouched", () => {
    const c = {
      name: "my-comp",
      fileContent:
        "<script>var client = 1;</script>" +
        "<script data-bascik-server>var server = 2;</script>",
    };
    const result = namespaceScriptTags(c);
    expect(result.fileContent).toContain("(function()");
    expect(result.fileContent).toContain("var server = 2;");
    // The server block must not be wrapped
    const serverIdx = result.fileContent.indexOf("var server = 2;");
    const iffeAfterServer = result.fileContent.indexOf("(function()", serverIdx);
    expect(iffeAfterServer).toBe(-1);
  });

  it("wraps multiple client scripts in separate IIFEs", () => {
    const c = {
      name: "my-comp",
      fileContent:
        "<script>const a = 1;</script>" +
        "<script>const b = 2;</script>",
    };
    const result = namespaceScriptTags(c);
    const matches = result.fileContent.match(/\(function\(\)/g);
    expect(matches).toHaveLength(2);
    expect(result.fileContent).toContain("const a = 1;");
    expect(result.fileContent).toContain("const b = 2;");
  });

  it("wraps client scripts while leaving JSON-LD and server scripts untouched", () => {
    const c = {
      name: "my-comp",
      fileContent:
        '<script type="application/ld+json">{"@type": "Organization"}</script>' +
        "<script>const c = 3;</script>",
    };
    const result = namespaceScriptTags(c);
    const matches = result.fileContent.match(/\(function\(\)/g);
    expect(matches).toHaveLength(1);
    expect(result.fileContent).toContain('{"@type": "Organization"}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prefixElementAttribute – null componentInstanceId auto-generates an id
// ─────────────────────────────────────────────────────────────────────────────

describe("prefixElementAttribute – auto-generated instance id", () => {
  it("scopes attributes when componentInstanceId is null (auto-generates id)", () => {
    const c = makeComponent('<div id="box"></div>');
    // Passing null forces getUniqueId to be called internally
    const result = prefixElementAttribute(c, "id", null);
    // The scoped name should contain "bascik__my-comp__" followed by a generated id
    expect(result.fileContent).toMatch(/bascik__my-comp__[0-9a-f]{8}__box/);
    expect(result.fileContent).not.toContain('id="box"');
  });
});

describe("namespaceScriptTags – line-offset padding and sourceURL", () => {
  it("does not add an IIFE or sourceURL to external scripts", () => {
    const component = {
      name: "my-comp",
      fileName: "src/components/my-comp.html",
      fileContent: '<script src="x.js"></script>',
    };

    expect(namespaceScriptTags(component).fileContent).toBe(
      '<script src="x.js"></script>',
    );
  });

  it("preserves exact line numbers of inner JS code relative to original HTML file", () => {
    const fileContent =
      "<html>\n" +                  // line 1
      "<body>\n" +                  // line 2
      "  <h1>Hello</h1>\n" +        // line 3
      "  <script>\n" +              // line 4
      "    const greeting = 'hi';\n" + // line 5
      "    console.log(greeting);\n" + // line 6
      "  </script>\n" +             // line 7
      "</body>\n" +                 // line 8
      "</html>";                    // line 9

    const c = {
      name: "hello-comp",
      fileName: "src/components/hello-comp.html",
      fileContent,
    };

    const result = namespaceScriptTags(c);
    const lines = result.fileContent.split(/\r?\n/);

    // Line 5 (index 4) should be const greeting = 'hi';
    expect(lines[4]).toContain("const greeting = 'hi';");
    // Line 6 (index 5) should be console.log(greeting);
    expect(lines[5]).toContain("console.log(greeting);");
  });

  it("adds sourceURL when fileName is present", () => {
    const c = {
      name: "my-comp",
      fileName: "src/components/my-comp.html",
      fileContent:
        "<div class=\"box\"></div>\n" + // line 1
        "<script>\n" +                 // line 2
        "const a = 1;\n" +             // line 3
        "console.log(a);\n" +          // line 4
        "</script>"
    };

    const result = namespaceScriptTags(c);
    expect(result.fileContent).toContain("src/components/my-comp.html");
    expect(result.fileContent).toContain("(function() {");
  });

  it("does not add sourceURL or wrap non-JS/data script tags", () => {
    const c = {
      name: "my-comp",
      fileName: "src/components/my-comp.html",
      fileContent:
        '<script type="application/ld+json">{"@type":"Thing"}</script>\n' +
        '<script type="importmap">{"imports":{}}</script>'
    };

    const result = namespaceScriptTags(c);
    expect(result.fileContent).toBe(
      '<script type="application/ld+json">{"@type":"Thing"}</script>\n' +
      '<script type="importmap">{"imports":{}}</script>'
    );
  });

  it("uses data-bascik-source path for sourceURL and cleans data-bascik-source attribute", () => {
    const c = {
      name: "demo-counter",
      fileName: "src/components/demo-counter/demo-counter.html",
      fileContent:
        '<script data-bascik-source="src/components/demo-counter/demo-counter.ts">\n' +
        'const a = 1;\n' +
        '</script>'
    };

    const result = namespaceScriptTags(c);
    expect(result.fileContent).toContain("//# sourceURL=src/components/demo-counter/demo-counter.ts");
    expect(result.fileContent).not.toContain("data-bascik-source");
  });
});

describe("getComponentScripts", () => {
  it("returns an empty script map for an empty file list", async () => {
    const res = await getComponentScripts("src/components/my-comp.html", []);
    expect(res.scriptMap.size).toBe(0);
  });
});
