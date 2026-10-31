/**
 * The id-class injection (addIdClassesInHtml) finds `id` attributes naming a converted id.
 * Its marker regex held the instance's scoped id, so a new regex was compiled for every
 * component instance, most of a build's id scoping time (prompt 158 R2-09). For plain
 * names a scanner answers instead; these tests hold it to the regex it replaces.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { propertyBounds } from "./property-runs.test-helper.ts";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: { attributes: { class: true, id: true }, deduplicateCss: true },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
  },
}));

const { addIdClassesInHtml, createIdMarkerTest, idMarkerPattern } =
  await import("./styles.ts");

/** Every offset where the marker regex matches (sticky), the reference answer. */
const regexAnswers = (
  html: string,
  idName: string,
  scopedId?: string,
): number[] => {
  const marker = new RegExp(idMarkerPattern(idName, scopedId), "iy");
  const found: number[] = [];
  for (let at = 0; at <= html.length; at++) {
    marker.lastIndex = at;
    if (marker.test(html)) found.push(at);
  }
  return found;
};

const scannerAnswers = (
  html: string,
  idName: string,
  scopedId?: string,
): number[] => {
  const test = createIdMarkerTest(idName, scopedId);
  if (!test) throw new Error(`no scanner for ${idName} / ${scopedId}`);
  const found: number[] = [];
  for (let at = 0; at <= html.length; at++) if (test(html, at)) found.push(at);
  return found;
};

describe("createIdMarkerTest agrees with the id marker regex", () => {
  const scopedId = "bascik__my-card__inst1__panel-0";

  it.each([
    ["a scoped id", `<div id="${scopedId}">`],
    ["the unscoped id", '<div id="panel-0">'],
    ["any prefix ending in __", '<div id="other__panel-0">'],
    ["a prefix without __", '<div id="xpanel-0">'],
    ["a single underscore prefix", '<div id="a_panel-0">'],
    ["another case (the regex is case-insensitive)", '<DIV ID="PANEL-0">'],
    ["single quotes", "<div id='panel-0'>"],
    ["an unclosed quote", '<div id="panel-0>'],
    ["spaces around =", '<div id = "panel-0">'],
    ["a non-breaking space before id", '<div id="panel-0">'],
    ["an unquoted value before >", "<div id=panel-0>"],
    ["an unquoted value before />", "<div id=panel-0/>"],
    ["an unquoted value before a space", "<div id=panel-0 class=x>"],
    ["an unquoted value at the end of input", "<div id=panel-0"],
    ["an unquoted value before a quote", '<div id=panel-0"x">'],
    ["an unquoted prefix with __", "<div id=a__panel-0>"],
    ["an unquoted value running past the name", "<div id=panel-01>"],
    ["an unquoted slash inside the value", "<div id=a/b__panel-0>"],
    ["a longer name", '<div id="panel-01">'],
    ["a data attribute ending in id", '<div data-id="panel-0">'],
    ["no whitespace before id", '<div x="1"id="panel-0">'],
    ["a non-ASCII letter that upper-cases to ASCII", '<div ıd="panel-0">'],
    ["a non-ASCII value", '<div id="pаnel-0">'],
    ["empty input", ""],
  ])("%s", (_label, html) => {
    expect(scannerAnswers(html, "panel-0", scopedId)).toEqual(
      regexAnswers(html, "panel-0", scopedId),
    );
    expect(scannerAnswers(html, "panel-0")).toEqual(
      regexAnswers(html, "panel-0"),
    );
  });

  const MARKUP_BOUNDS = propertyBounds(3000);
  it(
    "on generated markup",
    () => {
      const piece = fc.constantFrom(
        " ",
        "\t",
        " ",
        " ",
        "id",
        "ID",
        "Id",
        "=",
        '"',
        "'",
        "/",
        ">",
        "<",
        "`",
        "__",
        "_",
        "panel-0",
        "PANEL-0",
        "bascik__card__i1__panel-0",
        "b1A2b3C4d5E6",
        "x",
        "ı",
        "K",
      );
      fc.assert(
        fc.property(
          fc.array(piece, { maxLength: 14 }).map((parts) => parts.join("")),
          fc.constantFrom(
            undefined,
            "bascik__card__i1__panel-0",
            "b1A2b3C4d5E6",
          ),
          (html, scoped) => {
            expect(scannerAnswers(html, "panel-0", scoped)).toEqual(
              regexAnswers(html, "panel-0", scoped),
            );
          },
        ),
        MARKUP_BOUNDS.options,
      );
    },
    MARKUP_BOUNDS.timeoutMs,
  );

  it("declines names the scanner does not cover, so the regex stays in charge", () => {
    // Characters with a role in the marker, and non-ASCII names (the `i`
    // flag's case folding beyond ASCII).
    expect(createIdMarkerTest("a=b")).toBeUndefined();
    expect(createIdMarkerTest("a/b")).toBeUndefined();
    expect(createIdMarkerTest("a<b")).toBeUndefined();
    expect(createIdMarkerTest("a`b")).toBeUndefined();
    expect(createIdMarkerTest("café")).toBeUndefined();
    expect(
      createIdMarkerTest("panel", "bascik__kärtchen__i1__panel"),
    ).toBeUndefined();
    expect(createIdMarkerTest("")).toBeUndefined();
    expect(
      createIdMarkerTest("panel-0", "bascik__card__i1__panel-0"),
    ).toBeTypeOf("function");
  });
});

describe("addIdClassesInHtml", () => {
  const ids = [{ idName: "panel", className: "b_id_card_panel" }];

  it("injects the id class for every spelling the marker accepts", () => {
    const html = [
      '<section id="bascik__card__i1__panel"></section>',
      "<p ID='PANEL'></p>",
      "<i id=x__panel/>",
      '<b data-id="panel"></b>',
      '<u id="xpanel"></u>',
    ].join("");
    const out = addIdClassesInHtml(html, ids, {
      panel: "bascik__card__i1__panel",
    });
    // The class goes right after the tag name, as for every injected class.
    expect(out).toBe(
      [
        '<section class="b_id_card_panel" id="bascik__card__i1__panel"></section>',
        "<p class=\"b_id_card_panel\" ID='PANEL'></p>",
        '<i class="b_id_card_panel" id=x__panel/>',
        '<b data-id="panel"></b>',
        '<u id="xpanel"></u>',
      ].join(""),
    );
  });

  it("still matches a component name the scanner declines, through the regex", () => {
    const scoped = "bascik__kärtchen__i1__panel";
    const out = addIdClassesInHtml(
      `<div id="${scoped}"></div><div id="other"></div>`,
      [{ idName: "panel", className: "b_id_kärtchen_panel" }],
      { panel: scoped },
    );
    expect(out).toBe(
      `<div class="b_id_kärtchen_panel" id="${scoped}"></div><div id="other"></div>`,
    );
  });
});
