import { describe, expect, it } from "vitest";
import {
  extractDefaultSlotContent,
  extractNamedSlotContent,
  injectProps,
} from "./components.ts";

describe("named slots inside nested component usages", () => {
  const names = new Set(["outer-card", "inner-card", "x"]);

  it("leaves a wrapper inside a nested usage to that usage", () => {
    const inner = `<p>top</p><INNER-CARD title="a"><div data-bascik-slot="head">mine</div></INNER-CARD><div data-bascik-slot="head">parent</div>`;
    expect(extractNamedSlotContent(inner, names)).toEqual({ head: "parent" });
    expect(extractDefaultSlotContent(inner, names)).toBe(
      `<p>top</p><INNER-CARD title="a"><div data-bascik-slot="head">mine</div></INNER-CARD>`,
    );
  });

  it("treats a colon-qualified tag as opening its prefix name", () => {
    const inner = `<x:y><div data-bascik-slot="s">in</div></x>`;
    expect(extractNamedSlotContent(inner, names)).toEqual({});
  });

  it("ignores a usage tag written only after the wrapper", () => {
    const inner = `<div data-bascik-slot="s">a</div><inner-card><b>b</b></inner-card>`;
    expect(extractNamedSlotContent(inner, names)).toEqual({ s: "a" });
  });

  it("the same text read with another set of component names is parsed for that set, and a result stays unchanged by later reads", () => {
    // One usage's default and named slots are read from one parse; a read
    // with other names, or of other text, never answers from it.
    const inner = `<inner-card><div data-bascik-slot="head">mine</div></inner-card><div data-bascik-slot="head">parent</div>`;
    const nested = extractNamedSlotContent(inner, names);
    expect(nested).toEqual({ head: "parent" });
    expect(extractDefaultSlotContent(inner, names)).toBe(
      `<inner-card><div data-bascik-slot="head">mine</div></inner-card>`,
    );
    // Without the names, both wrappers are this usage's own.
    expect(extractDefaultSlotContent(inner, new Set())).toBe(
      `<inner-card></inner-card>`,
    );
    expect(extractDefaultSlotContent(inner, names)).toBe(
      `<inner-card><div data-bascik-slot="head">mine</div></inner-card>`,
    );
    expect(extractNamedSlotContent(`${inner} `, names)).toEqual({
      head: "parent",
    });
    expect(nested).toEqual({ head: "parent" });
  });

  it("ignores component tag text inside a script or a quoted attribute", () => {
    const inner = `<script>"<inner-card>"</script><p title="<inner-card>"></p><div data-bascik-slot="s">a</div>`;
    expect(extractNamedSlotContent(inner, names)).toEqual({ s: "a" });
  });
});

describe("injectProps without receivers", () => {
  it("returns a template with no prop markers unchanged, even with props", () => {
    const template = `<!-- note --><div class="a"><script>const p = "x";</script>text</div>`;
    expect(injectProps(template, { title: "Hi", count: "2" })).toBe(template);
  });

  it("still fills an upper-case receiver marker", () => {
    expect(injectProps(`<p DATA-BASCIK-PROP-TITLE></p>`, { title: "Hi" })).toBe(
      `<p>Hi</p>`,
    );
  });

  it("still strips an unfilled receiver when no props are given", () => {
    expect(injectProps(`<p data-bascik-prop-title>x</p>`, {})).toBe(`<p>x</p>`);
  });

  it("leaves an upper-case-only marker alone when no props are given", () => {
    const template = `<p Data-Bascik-Prop-x></p>`;
    expect(injectProps(template, {})).toBe(template);
    expect(injectProps(template, { y: "1" })).toBe(`<p></p>`);
  });
});
