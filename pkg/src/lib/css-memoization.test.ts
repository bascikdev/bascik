import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scoping: {
      deduplicateCss: true,
      scriptBlocks: true,
      inheritAttributes: true,
    },
    minify: {
      identifiers: false,
    },
    directory: { out: "dist", pages: "src/pages", components: "src/components" },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { prefixElementAttribute, clearScopedCssCache } from "./javascript.ts";
import * as stylesModule from "./styles.ts";
import { BascikConfig } from "./config.ts";
import type { BascikComponent } from "./types.ts";

describe("Prompt 35: CSS scoping memoization", () => {
  beforeEach(() => {
    clearScopedCssCache();
    (BascikConfig as any).scoping.deduplicateCss = true;
  });

  it("runs the full CSS scoping pipeline once per component type when deduplicateCss is true", () => {
    const keyframesSpy = vi.spyOn(stylesModule, "prefixKeyframes");

    const cssContent = `
      .card { color: red; }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    `;

    // Process 50 instances of the same component with deduplicateCss: true
    for (let i = 0; i < 50; i++) {
      const comp: BascikComponent = {
        name: "test-card",
        fileContent: `<div class="card">Hello</div>`,
        cssFileContent: cssContent,
      };
      prefixElementAttribute(comp, "class", "instance_" + i);
    }

    // With memoization, prefixKeyframes should run once instead of 50 times
    expect(keyframesSpy).toHaveBeenCalledTimes(1);
    keyframesSpy.mockRestore();
  });

  it("produces separate scoped outputs per instance when deduplicateCss is false", () => {
    (BascikConfig as any).scoping.deduplicateCss = false;

    const cssContent = `.box { background: blue; }`;

    const comp1: BascikComponent = {
      name: "custom-box",
      fileContent: `<div class="box">1</div>`,
      cssFileContent: cssContent,
    };
    const res1 = prefixElementAttribute(comp1, "class", "inst1");

    const comp2: BascikComponent = {
      name: "custom-box",
      fileContent: `<div class="box">2</div>`,
      cssFileContent: cssContent,
    };
    const res2 = prefixElementAttribute(comp2, "class", "inst2");

    expect(res1.cssFileContent).toContain("bascik__custom-box__inst1__box");
    expect(res2.cssFileContent).toContain("bascik__custom-box__inst2__box");
    expect(res1.fileContent).toContain("bascik__custom-box__inst1__box");
    expect(res2.fileContent).toContain("bascik__custom-box__inst2__box");
  });
});
