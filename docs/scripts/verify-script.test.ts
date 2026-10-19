import { describe, expect, it } from "vitest";

interface VerifyScript {
  integratedPerFileChecksCompleted: (output: string) => boolean;
}

const { integratedPerFileChecksCompleted } = (await import(
  new URL("../../skills/bascik/scripts/verify.mjs", import.meta.url).href
)) as VerifyScript;

describe("verify script per-file check detection", () => {
  it("confirms integrated per-file results from the positive check summary", () => {
    expect(
      integratedPerFileChecksCompleted(
        "✓ 1 file checked by @bascik/language-server",
      ),
    ).toBe(true);
    expect(
      integratedPerFileChecksCompleted(
        "✓ 0 files checked by @bascik/language-server",
      ),
    ).toBe(true);
  });

  it("does not infer that checks ran from missing skip output", () => {
    expect(
      integratedPerFileChecksCompleted(
        "✓ 3 pages and 2 components checked — no errors",
      ),
    ).toBe(false);
    expect(integratedPerFileChecksCompleted("per-file checks skipped")).toBe(
      false,
    );
  });
});
