import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("global design tokens & breakpoint CSS variables (styles.css)", () => {
  const cssPath = join(process.cwd(), "src/css/styles.css");

  it("defines standard responsive breakpoint screen width variables according to 2026 guidelines", async () => {
    const css = await readFile(cssPath, "utf8");

    // Standard breakpoint values: sm=640px, md=768px, lg=1024px, xl=1280px, 2xl=1536px. Spacing after the colon
    // is the formatter's business, so it is not part of the check.
    const breakpoints = {
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    };
    for (const prefix of ["bp", "screen", "breakpoint"]) {
      for (const [size, value] of Object.entries(breakpoints)) {
        expect(css).toMatch(new RegExp(`--${prefix}-${size}:\\s*${value};`));
      }
    }
  });
});
