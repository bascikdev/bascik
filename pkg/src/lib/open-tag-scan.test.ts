import { describe, expect, it } from "vitest";
import {
  extractNamedSlotContent,
  replaceDefaultSlots,
} from "./component-slots.ts";
import { getFirstComponent, mayContainComponent } from "./component-tags.ts";
import { injectProps } from "./component-props.ts";
import { shieldElementContents } from "./shielding.ts";
import { htmlHasServerScripts } from "./server-scripts.ts";
import { __manifestScansForTests } from "./component-manifest.ts";
import { __companionScriptTagsForTests } from "./components.ts";
import { scanRequestScripts, scriptDirectiveFinder } from "./html-patterns.ts";
import { __checkScansForTests } from "./check.ts";
import { __cspRegexFallbackForTests } from "./csp-hashes.ts";
import type { ComponentList } from "./types.ts";

// The scans find exactly what the regexes found (differential fuzzing against
// the regexes found no difference). These pin the cases where that is least
// obvious, each a way an author or a visitor can get the markup wrong.
describe("open-tag scans keep the regexes' answers on malformed markup", () => {
  it("takes the first slot marker a lazy attribute chain reaches", () => {
    expect(
      extractNamedSlotContent(
        `<div data-bascik-slot="a" data-bascik-slot="b">x</div>`,
      ),
    ).toEqual({ a: "x" });
  });

  it("skips a slot marker inside another attribute's quoted value", () => {
    expect(
      extractNamedSlotContent(
        `<div title=" data-bascik-slot=a" data-bascik-slot="b">x</div>`,
      ),
    ).toEqual({ b: "x" });
  });

  it("finds no slot wrapper whose attributes never close", () => {
    const html = `<div data-bascik-slot="a" title='>x</div>`;
    expect(extractNamedSlotContent(html)).toEqual({});
    expect(replaceDefaultSlots(`<div data-bascik-slot '>x</div>`, "D")).toBe(
      `<div data-bascik-slot '>x</div>`,
    );
  });

  it("matches a component name only as the whole tag name, `:` included", () => {
    const list = {
      a: { fileContent: "A" },
      "a:b": { fileContent: "AB" },
    } as unknown as ComponentList;
    expect(getFirstComponent("<a:b></a:b>", list).name).toBe("a:b");
    // A browser reads `<a:c>` as the tag `a:c`, never as `a` (browser-tag-names.test.ts).
    expect(getFirstComponent("<a:c></a>", list).name).toBeUndefined();
    expect(mayContainComponent("<a:c>", list)).toBe(false);
    expect(mayContainComponent("<a-b>", list)).toBe(false);
  });

  it("strips an unfilled marker from a tag whose quote never closes", () => {
    expect(injectProps(`<a data-bascik-prop-t x='`, {})).toBe(`<a x='`);
  });

  it("reads no placeholder whose type has mismatched quotes, as a browser reads none", () => {
    // The double quote never closes, so a browser's type value runs on past
    // `>` and the tag never ends: there is no placeholder to resolve.
    const html = `<script type="text/bascik-server' x>body</script>`;
    expect(scanRequestScripts(html, true)).toHaveLength(0);
    expect(
      htmlHasServerScripts(`<script data-bascik-server-id="1"></script>`),
    ).toBe(false);
  });

  it("inlines the first src a lazy attribute chain reaches, quotes as written", () => {
    const seen: string[] = [];
    __companionScriptTagsForTests(
      `<script src="a.js' src='b.js'></script>`,
      (_match, _pre, src) => {
        seen.push(src);
        return "";
      },
    );
    expect(seen).toEqual(["a.js"]);
  });

  it("masks a preserved subtree under the shorter name the closer names", () => {
    // `x-data-bascik-preserve` is one name, but the regex also read `<x` as
    // the tag with `-data-bascik-preserve` as its attributes, closed by `</x>`.
    expect(
      __checkScansForTests.maskPreservedSubtrees(
        `<x-data-bascik-preserve>secret</x>`,
      ),
    ).toBe(`<x-data-bascik-preserve>      </x>`);
  });

  it("keeps a `*` preserve entry's content across a mismatched closer", () => {
    const { html, restore } = shieldElementContents(
      `<vendor-a>secret</vendor-b>`,
      ["vendor-*"],
    );
    expect(html).not.toContain("secret");
    expect(restore(html)).toBe(`<vendor-a>secret</vendor-b>`);
  });

  it("finds a directive only on a script tag, never past its `>`", () => {
    const find = scriptDirectiveFinder(["data-bascik-build"]);
    expect(find(`<script x> data-bascik-build`)).toBe(-1);
    expect(find(`<script title="a > b" data-bascik-build>`)).toBe(0);
    expect(find(`<script data-bascik-build-once>`)).toBe(-1);
  });
});
