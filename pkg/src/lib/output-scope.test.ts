import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCOPE_ATTRIBUTE,
  applyOutputScope,
  decodeOutputScope,
  encodeOutputScope,
  stripOutputScopeAttribute,
  type OutputScope,
} from "./output-scope.ts";

const scope: OutputScope = {
  classes: { item: "bascik__c__item", wrap: "bascik__c__wrap" },
  elements: { h2: "b_el_c_h2", a: "b_el_c_a" },
};

describe("encodeOutputScope / decodeOutputScope", () => {
  it("round-trips a scope through the attribute value", () => {
    expect(decodeOutputScope(encodeOutputScope(scope))).toEqual(scope);
  });

  it("returns null for a missing or malformed value", () => {
    expect(decodeOutputScope(undefined)).toBeNull();
    expect(decodeOutputScope("")).toBeNull();
    expect(decodeOutputScope("not json")).toBeNull();
    expect(decodeOutputScope("%zz{")).toBeNull();
  });

  it("keeps only string-valued entries, dropping anything malformed", () => {
    const raw = encodeURIComponent(
      JSON.stringify({
        classes: { a: "X", b: 123, c: null },
        elements: { p: "Y", q: {} },
      }),
    );
    expect(decodeOutputScope(raw)).toEqual({
      classes: { a: "X" },
      elements: { p: "Y" },
    });
  });

  it("defaults to empty maps when a side is absent or not an object", () => {
    expect(
      decodeOutputScope(
        encodeURIComponent(JSON.stringify({ classes: "nope" })),
      ),
    ).toEqual({ classes: {}, elements: {} });
    expect(decodeOutputScope(encodeURIComponent(JSON.stringify([])))).toEqual({
      classes: {},
      elements: {},
    });
  });
});

describe("stripOutputScopeAttribute", () => {
  it("removes the annotation with its leading whitespace and quotes", () => {
    const open = `<script data-bascik-build ${OUTPUT_SCOPE_ATTRIBUTE}="${encodeOutputScope(scope)}">`;
    expect(stripOutputScopeAttribute(open)).toBe("<script data-bascik-build>");
  });

  it("removes an unquoted annotation value", () => {
    expect(
      stripOutputScopeAttribute(`<script ${OUTPUT_SCOPE_ATTRIBUTE}=abc>`),
    ).toBe("<script>");
  });

  it("leaves a tag without the annotation unchanged", () => {
    expect(stripOutputScopeAttribute("<script data-bascik-build>")).toBe(
      "<script data-bascik-build>",
    );
  });

  it("removes the annotation after a newline or tab run, keeping the rest of the tag", () => {
    expect(
      stripOutputScopeAttribute(
        `<script\n\t\t${OUTPUT_SCOPE_ATTRIBUTE}="x"\n\tdata-bascik-build>`,
      ),
    ).toBe("<script\n\tdata-bascik-build>");
  });
});

describe("applyOutputScope", () => {
  it("is a no-op for an empty scope or empty html", () => {
    expect(
      applyOutputScope("<p class='item'>x</p>", { classes: {}, elements: {} }),
    ).toBe("<p class='item'>x</p>");
    expect(applyOutputScope("", scope)).toBe("");
  });

  it("scopes a defined class and leaves undefined classes global", () => {
    expect(applyOutputScope('<p class="item global-only">x</p>', scope)).toBe(
      '<p class="bascik__c__item global-only">x</p>',
    );
  });

  it("adds the element class to a styled element and scopes its classes together", () => {
    expect(applyOutputScope('<h2 class="item">y</h2>', scope)).toBe(
      '<h2 class="bascik__c__item b_el_c_h2">y</h2>',
    );
  });

  it("injects an element class when the tag has no class attribute", () => {
    expect(applyOutputScope('<h2 id="t">y</h2>', scope)).toBe(
      '<h2 class="b_el_c_h2" id="t">y</h2>',
    );
  });

  it("does not duplicate an element class already present in the class attribute", () => {
    const withDup: OutputScope = {
      classes: { el: "b_el_c_h2" },
      elements: { h2: "b_el_c_h2" },
    };
    expect(applyOutputScope('<h2 class="el">y</h2>', withDup)).toBe(
      '<h2 class="b_el_c_h2">y</h2>',
    );
  });

  it("normalizes an unquoted class value to a quoted scoped value", () => {
    expect(applyOutputScope("<p class=item>x</p>", scope)).toBe(
      '<p class="bascik__c__item">x</p>',
    );
  });

  it("handles unquoted class on self-closing tags without absorbing the trailing slash", () => {
    expect(applyOutputScope("<img class=item/>", scope)).toBe(
      '<img class="bascik__c__item"/>',
    );
  });

  it("scopes only the first class attribute when one is written twice", () => {
    expect(applyOutputScope('<p class="item" class="wrap">x</p>', scope)).toBe(
      '<p class="bascik__c__item" class="wrap">x</p>',
    );
  });

  it("never rewrites a class name inside another attribute's value", () => {
    const html = '<p title="<a class=item>">z</p>';
    expect(applyOutputScope(html, scope)).toBe(html);
  });

  it("skips markup inside comments, script, style, and textarea content", () => {
    const html =
      '<script>const s = "<a class=\\"item\\">";</script><!-- <a class="item"> --><style>.item{}</style><textarea><a></a></textarea>';
    expect(applyOutputScope(html, scope)).toBe(html);
  });

  it("ends a comment where the browser does: at --!>, and at once for <!--> and <!--->", () => {
    // Markup after these closers is live in the browser, so it is scoped; a
    // later `-->` must not stretch the comment over it.
    for (const comment of ["<!-- a --!>", "<!-->", "<!--->"])
      expect(
        applyOutputScope(`${comment}<p class="item">x</p><!-- b -->`, scope),
      ).toBe(`${comment}<p class="bascik__c__item">x</p><!-- b -->`);
  });

  it("treats an unclosed comment as running to the end, as the browser does", () => {
    const html = '<p class="item">a</p><!-- <p class="item">b</p>';
    expect(applyOutputScope(html, scope)).toBe(
      '<p class="bascik__c__item">a</p><!-- <p class="item">b</p>',
    );
  });

  it("finds the tag the regex grammar finds when an earlier start never closes", () => {
    // A failed start does not rule out a later one that pairs quotes
    // differently: from `<i` the quote around `<p ...>` opens, so it fails at
    // the stray `'`; from `<p` the same quotes close, and it is a tag.
    expect(applyOutputScope(`<i "<p class=item>" '`, scope)).toBe(
      `<i "<p class="bascik__c__item">" '`,
    );
    // A `<` inside a tag is attribute text, so the tag is `<i ...>`.
    expect(applyOutputScope(`<i <p class=item>`, scope)).toBe(
      `<i <p class="bascik__c__item">`,
    );
  });

  it("leaves a tag that is neither styled nor carries a defined class untouched", () => {
    expect(applyOutputScope('<span class="nope">x</span>', scope)).toBe(
      '<span class="nope">x</span>',
    );
  });

  it("is safe against regex replacement tokens in surrounding text", () => {
    expect(applyOutputScope('<p class="item">$1 $& $`</p>', scope)).toBe(
      '<p class="bascik__c__item">$1 $& $`</p>',
    );
  });

  it("preserves the rest of the document around a scoped tag", () => {
    expect(
      applyOutputScope(
        '<section><p class="item">x</p><a href="#">y</a></section>',
        scope,
      ),
    ).toBe(
      '<section><p class="bascik__c__item">x</p><a class="b_el_c_a" href="#">y</a></section>',
    );
  });
});
