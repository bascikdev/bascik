import { describe, expect, it } from "vitest";
import {
  createContentShield,
  maskElementContents,
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
});