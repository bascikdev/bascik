/**
 * The HTML markers the JS minifier keeps in comments, checked against parse5, a
 * spec-compliant HTML parser. Test-only.
 *
 * `HTML_SCRIPT_MARKER` in `js-minifier.ts` lists the text inside a `<script>` that the
 * HTML tokenizer acts on once a `<!--` is in it: `<!--`, `-->`, `<script` and `</script`.
 * A comment holding one is kept, because removing it could move the `</script>` that ends
 * the element. CodeQL's js/bad-tag-filter (alert 237) reports that the pattern misses
 * `--!>`. That is the end of an HTML comment, not of a script's escaped text: the
 * "script data escaped dash dash state" in the HTML standard leaves the escape only on
 * `-->` (https://html.spec.whatwg.org/multipage/parsing.html#script-data-escaped-dash-dash-state),
 * and Chromium parses `<script><!--<script>--!></script>X</script>` with `</script>X` inside
 * the script. These tests keep that decision checked instead of remembered: for any comment,
 * the minified script must end where the source script ends.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { propertyBounds } from "./property-runs.test-helper.ts";
import { minifyJs } from "./js-minifier.ts";

type Node = DefaultTreeAdapterMap["node"];

const TAIL = "TAIL_AFTER_SCRIPT";

/** The text of every `<script>` parse5 builds for `js` followed by `</script>TAIL</script>`. */
const scriptTexts = (js: string): string[] => {
  const texts: string[] = [];
  const walk = (node: Node): void => {
    if ("tagName" in node && node.tagName === "script") {
      texts.push(
        node.childNodes
          .map((child) => ("value" in child ? child.value : ""))
          .join(""),
      );
    }
    if ("childNodes" in node) node.childNodes.forEach(walk);
    if ("content" in node) walk(node.content);
  };
  walk(parse(`<!doctype html><script>${js}</script>${TAIL}</script>`));
  return texts;
};

/** Whether the first `</script>` after `js` ends the element (else the tail is script text). */
const endsAtOwnEndTag = (js: string): boolean =>
  !scriptTexts(js).some((text) => text.includes(TAIL));

/** Whether parse5 reads all of `js` as one script element that its own end tag ends. */
const isWholeScript = (js: string): boolean => {
  const texts = scriptTexts(js);
  return texts.length === 1 && texts[0] === js;
};

describe("minifyJs – HTML markers in comments, checked against parse5", () => {
  it("parse5 reads <!--<script> as opening an escape that only --> leaves", () => {
    // The oracle itself: the cases the minifier's rule rests on.
    expect(endsAtOwnEndTag("<!--<script>-->")).toBe(true);
    expect(endsAtOwnEndTag("<!--<script>")).toBe(false);
    expect(endsAtOwnEndTag("<!--<script>--!>")).toBe(false);
    expect(endsAtOwnEndTag("<!--<script>--!>-->")).toBe(true);
  });

  it("removes a comment holding --!>, which the HTML parser does not act on", () => {
    const source = "const s = '<!--<script>'\nlog.push(1) // --!>\nlog.push(2)";
    const minified = minifyJs(source);
    expect(minified).not.toContain("--!>");
    expect(endsAtOwnEndTag(minified)).toBe(endsAtOwnEndTag(source));
  });

  it.each([
    ["-->", "const s = '<!--<script>'\nlog.push(1) // -->\nlog.push(2)"],
    ["<script", "const s = '<!--'\nlog.push(1) /* <script> */\nlog.push(2)"],
    [
      "</script",
      "const s = '<!--<script>'\nlog.push(1) /* </script */\nlog.push(2)",
    ],
    ["<!--", "const s = '<!--'\nlog.push(1) /* <!-- */\nlog.push(2)"],
  ])("keeps a comment holding %s", (marker, source) => {
    const minified = minifyJs(source);
    expect(minified).toContain(marker);
    expect(endsAtOwnEndTag(minified)).toBe(endsAtOwnEndTag(source));
  });

  it("keeps a <!-- comment that reopens the escape a later </script> relies on", () => {
    // `-->` closes the first escape, the comment's `<!--` opens another, and in it
    // `<script>` makes the inner `</script>` script text. Without the comment, that
    // `</script>` ends the element.
    const source =
      "const s = '<!--' + '-->'\n/* <!-- */\nconst t = '<script></script>-->'\nlog.push(s, t)";
    expect(isWholeScript(source)).toBe(true);
    expect(isWholeScript(source.replace("/* <!-- */", ""))).toBe(false);
    expect(isWholeScript(minifyJs(source))).toBe(true);
  });

  // Comment bodies built from the pieces of every marker, so near misses (`--!>`, `- ->`,
  // `< script`, `</ script`) and real markers split across tokens both come up.
  const piece = fc.constantFrom(
    "<",
    "!",
    "-",
    "--",
    ">",
    "/",
    " ",
    "x",
    "script",
    "SCRIPT",
    "<!--",
    "-->",
    "--!>",
    "<script",
    "</script",
    "\t",
  );
  const body = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join(""));
  // Strings around the comments: a `-->` before one closes the escape and a `<script` after
  // one opens the double escape, so a `<!--` in the comment between them decides the end.
  const marker = fc.constantFrom(
    "",
    "'<!--'",
    "'-->'",
    "'<!--<script>'",
    "'<!-- <script'",
    "'<!--' + '-->'",
    "'<script>'",
    "'<script></script>-->'",
  );
  const comment = fc.oneof(
    body.map((text) => `// ${text}\n`),
    body.map((text) => `/* ${text} */`),
  );

  const MARKER_BOUNDS = propertyBounds(400, "HTML_MARKER_RUNS");
  it(
    "ends the minified script at the same </script> as the source",
    () => {
      fc.assert(
        fc.property(
          marker,
          fc.array(comment, { minLength: 1, maxLength: 3 }),
          marker,
          (before, comments, after) => {
            const source = `const s = ${before || "1"}\nlet a = 1\n${comments
              .map((text) => `a = a + 1 ${text}`)
              .join("\n")}\nconst t = ${after || "2"}\nlog.push(a, s, t)`;
            // Only text an inline `<script>` can hold: the HTML parser reads all of it as one
            // element that its own `</script>` ends. (Inlined TypeScript gets there by
            // writing `</script` as `<\/script`; see page-typescript.ts.)
            fc.pre(isWholeScript(source));
            const minified = minifyJs(source);
            expect(isWholeScript(minified), minified).toBe(true);
          },
        ),
        MARKER_BOUNDS.options,
      );
    },
    MARKER_BOUNDS.timeoutMs,
  );
});
