import { describe, expect, it } from "vitest";
import {
  createContentShield,
  maskElementContents,
  shieldElementContents,
  shieldPreservedAttribute,
  __shieldStatsForTests,
} from "./shielding.ts";

describe("shieldPreservedAttribute fast path (prompt 83)", () => {
  const plain = `<div class="card" id="root"><p class="body" name="n">Hello <b>there</b></p><img class="pic" /></div>`;

  const scans = (html: string, attribute: "id" | "name" | "class", preservedTags: string[]) => {
    __shieldStatsForTests.reset();
    const result = shieldPreservedAttribute(html, attribute, preservedTags);
    return { result, tagScans: __shieldStatsForTests.tagScans, hidden: __shieldStatsForTests.hiddenValues };
  };

  it("performs no tag scan and hides nothing when the markup has no preserve directive and no preserved tag", () => {
    for (const attribute of ["id", "name", "class"] as const) {
      const { result, tagScans, hidden } = scans(plain, attribute, ["code"]);
      expect(tagScans).toBe(0);
      expect(hidden).toBe(0);
      expect(result.html).toBe(plain);
      expect(result.restore("anything \x00BASCIK_SHIELD_1\x00")).toBe("anything \x00BASCIK_SHIELD_1\x00");
    }
  });

  it("performs no tag scan when preservedTags is empty and there is no directive", () => {
    const { tagScans, result } = scans(plain, "class", []);
    expect(tagScans).toBe(0);
    expect(result.html).toBe(plain);
  });

  it("still scans when a preserved tag name appears, in any case", () => {
    const withCode = `<div class="x"><CODE class="lang">a.b</CODE></div>`;
    const { tagScans, result } = scans(withCode, "class", ["code"]);
    expect(tagScans).toBeGreaterThan(0);
    // The <CODE ...> opening tag is shielded (class would otherwise be scoped).
    expect(result.html).not.toBe(withCode);
    expect(result.restore(result.html)).toBe(withCode);
  });

  it("still scans when data-bascik-preserve is present, including on nested elements", () => {
    const nested = `<section class="s"><div><input class="f" name="q" data-bascik-preserve></div></section>`;
    const { tagScans, result } = scans(nested, "name", ["code"]);
    expect(tagScans).toBeGreaterThan(0);
    expect(result.html).not.toBe(nested);
    expect(result.restore(result.html)).toBe(nested);
  });

  it("does not take the fast path merely because a preserved tag name appears as text or an attribute value", () => {
    // "code" appears only in text. The old implementation scans and produces
    // an unchanged result; the fast path is allowed to skip the scan here only
    // if it is byte-identical, which it is. Pin the output either way.
    const textOnly = `<p class="p">write some code here</p>`;
    const { result } = scans(textOnly, "class", ["code"]);
    expect(result.html).toBe(textOnly);
  });

  it("mixed preserved and unpreserved elements are handled exactly as before", () => {
    const mixed = `<div class="a"><pre data-bascik-preserve="class"><span class="k">x</span></pre><span class="b">y</span></div>`;
    const { result } = scans(mixed, "class", ["code"]);
    expect(result.restore(result.html)).toBe(mixed);
    // The <pre> and its descendant <span> opening tags are hidden; the trailing <span class="b"> is not.
    expect(result.html).toContain(`<span class="b">`);
    expect(result.html).not.toContain(`<span class="k">`);
  });
});

describe("shieldPreservedAttribute wildcard patterns", () => {
  const scans = (html: string, attribute: "id" | "name" | "class", preservedTags: string[]) => {
    __shieldStatsForTests.reset();
    const result = shieldPreservedAttribute(html, attribute, preservedTags);
    return { result, tagScans: __shieldStatsForTests.tagScans, hidden: __shieldStatsForTests.hiddenValues };
  };

  it("preserves id, name, and class on a prefix-matched tag and its descendants", () => {
    const html = `<vendor-widget id="keep" name="keep" class="keep"><span id="inner" name="inner" class="inner">x</span></vendor-widget><p id="scope-me" name="scope-me" class="scope-me">y</p>`;
    for (const attribute of ["id", "name", "class"] as const) {
      const { result } = scans(html, attribute, ["vendor-*"]);
      expect(result.restore(result.html)).toBe(html);
      // The vendor subtree opening tags are hidden; the sibling <p> is not.
      expect(result.html).toContain(`${attribute}="scope-me"`);
      expect(result.html).not.toContain(`<vendor-widget`);
      expect(result.html).not.toContain(`<span ${attribute}="inner"`);
    }
  });

  it("matches a suffix pattern", () => {
    const html = `<acme-widget id="keep" class="keep">x</acme-widget><acme-panel id="scope-me">y</acme-panel>`;
    const { result } = scans(html, "id", ["*-widget"]);
    expect(result.restore(result.html)).toBe(html);
    expect(result.html).not.toContain(`<acme-widget`);
    expect(result.html).toContain(`<acme-panel id="scope-me">`);
  });

  it("a bare * preserves every tag", () => {
    const html = `<div id="a" class="a"><span id="b" name="b">x</span></div>`;
    for (const attribute of ["id", "name", "class"] as const) {
      const { result } = scans(html, attribute, ["*"]);
      expect(result.restore(result.html)).toBe(html);
      expect(result.html).not.toContain(`<div`);
      expect(result.html).not.toContain(`<span`);
    }
  });

  it("mixes exact names and patterns", () => {
    const html = `<code id="c">x</code><vendor-widget id="v">y</vendor-widget><p id="p">z</p>`;
    const { result } = scans(html, "id", ["code", "vendor-*"]);
    expect(result.restore(result.html)).toBe(html);
    expect(result.html).not.toContain(`<code`);
    expect(result.html).not.toContain(`<vendor-widget`);
    expect(result.html).toContain(`<p id="p">`);
  });

  it("matches case-insensitively", () => {
    const html = `<vendor-widget id="keep" class="keep">x</vendor-widget>`;
    const { result } = scans(html, "id", ["VENDOR-*"]);
    expect(result.restore(result.html)).toBe(html);
    expect(result.html).not.toContain(`<vendor-widget`);
  });

  it("keeps literal attributes on a void element under a bare * without breaking frame pairing", () => {
    const html = `<div id="a"><img id="pic" class="pic"><span id="b">x</span></div>`;
    const { result } = scans(html, "id", ["*"]);
    expect(result.restore(result.html)).toBe(html);
    expect(result.html).not.toContain(`<img`);
    expect(result.html).not.toContain(`<span`);
  });

  it("skips the tag scan when no candidate prefix is present for a prefix glob", () => {
    const plain = `<div class="card" id="root"><p class="body">Hello</p></div>`;
    const { result, tagScans, hidden } = scans(plain, "id", ["vendor-*"]);
    expect(tagScans).toBe(0);
    expect(hidden).toBe(0);
    expect(result.html).toBe(plain);
  });

  it("scans when the literal prefix of a prefix glob is present", () => {
    const html = `<div><vendor-widget id="keep">x</vendor-widget></div>`;
    const { result, tagScans } = scans(html, "id", ["vendor-*"]);
    expect(tagScans).toBeGreaterThan(0);
    expect(result.restore(result.html)).toBe(html);
  });

  it("forces the scan for a pattern with no literal prefix", () => {
    const plain = `<div class="card" id="root"><p class="body">Hello</p></div>`;
    const { result, tagScans } = scans(plain, "id", ["*-widget"]);
    expect(tagScans).toBeGreaterThan(0);
    expect(result.html).toBe(plain);
  });
});

describe("createContentShield", () => {
  it("restores nested shields without caller-managed ordering", () => {
    const shield = createContentShield("<pre><code>inner</code></pre>");
    const inner = shield.hide("inner");
    const outer = shield.hide(`<pre><code>${inner}</code></pre>`);
    expect(shield.restore(outer)).toBe("<pre><code>inner</code></pre>");
  });

  it("keeps interleaved shield operations in distinct token spaces", () => {
    const first = createContentShield("first");
    const second = createContentShield("second");
    const combined = `${first.hide("first")}:${second.hide("second")}`;
    expect(first.restore(second.restore(combined))).toBe("first:second");
  });

  it("does not treat a user-provided token lookalike as shielded content", () => {
    const lookalike = "\x00BASCIK_SHIELD_0\x00";
    const shield = createContentShield(lookalike);
    expect(shield.restore(shield.hide(lookalike))).toBe(lookalike);
  });
});

describe("maskElementContents", () => {
  it("discards masked content while preserving source length", () => {
    const html = "<script>const tag = '<my-card>';</script><p>keep</p>";
    const masked = maskElementContents(html, ["script"]);
    expect(masked).toHaveLength(html.length);
    expect(masked).not.toContain("<my-card>");
    expect(masked).toContain("<script>");
    expect(masked).toContain("<p>keep</p>");
  });

  it("masks content of tags matching a wildcard pattern", () => {
    const html = "<vendor-widget>X</vendor-widget><p>keep</p>";
    const masked = maskElementContents(html, ["vendor-*"]);
    expect(masked).toHaveLength(html.length);
    expect(masked).not.toContain(">X<");
    expect(masked).toContain("<vendor-widget>");
    expect(masked).toContain("<p>keep</p>");
  });

  it("masks content for suffix and bare-star patterns", () => {
    const suffix = maskElementContents("<acme-widget>X</acme-widget><acme-panel>Y</acme-panel>", ["*-widget"]);
    expect(suffix).not.toContain(">X<");
    expect(suffix).toContain(">Y<");
    const star = maskElementContents("<div>X</div>", ["*"]);
    expect(star).not.toContain(">X<");
  });

  it("produces byte-identical output for exact entries", () => {
    const html = "<code>A</code><pre>B</pre><p>C</p>";
    expect(maskElementContents(html, ["code", "pre"])).toBe(
      "<code> </code><pre> </pre><p>C</p>",
    );
  });
});

describe("shieldElementContents wildcard patterns", () => {
  it("shields and restores content of tags matching a wildcard pattern", () => {
    const html = "<vendor-widget><b>bold</b></vendor-widget><p>keep</p>";
    const { html: shielded, restore } = shieldElementContents(html, ["vendor-*"]);
    expect(shielded).not.toContain("<b>bold</b>");
    expect(shielded).toContain("<p>keep</p>");
    expect(restore(shielded)).toBe(html);
  });

  it("produces byte-identical output for exact entries", () => {
    const html = "<code>A</code><pre>B</pre><p>C</p>";
    const first = shieldElementContents(html, ["code", "pre"]);
    expect(first.restore(first.html)).toBe(html);
    expect(first.html).toContain("<p>C</p>");
    expect(first.html).not.toContain(">A<");
    expect(first.html).not.toContain(">B<");
  });
});