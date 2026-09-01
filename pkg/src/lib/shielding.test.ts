import { describe, expect, it } from "vitest";
import { createContentShield, maskElementContents } from "./shielding.ts";

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