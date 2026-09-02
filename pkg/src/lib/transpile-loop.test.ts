import { describe, it, expect, vi, beforeEach } from "vitest";
import { recursivelyTranspile } from "./processing.ts";
import * as componentsModule from "./components.ts";
import type { ComponentList } from "./types.ts";

describe("Prompt 34: Transpile loop performance & operation count guard", () => {
  it("bounds full-document scanning operations linearly with component instances", () => {
    let maskCallsOnDocument = 0;
    const origMask = componentsModule.maskRawTextContent;
    const maskSpy = vi.spyOn(componentsModule, "maskRawTextContent").mockImplementation((str) => {
      console.log("caller:", new Error().stack?.split("\n")[3]);
      if (str.length > 500) {
        maskCallsOnDocument++;
      }
      return origMask(str);
    });

    const componentList: ComponentList = {
      "item-card": {
        fileContent: `<div class="card"><p data-bascik-prop-title></p></div>`,
      },
    };

    // Construct a page with 300 instances
    const instanceCount = 300;
    const body = Array.from(
      { length: instanceCount },
      (_, i) => `<item-card title="Item ${i}"></item-card>`,
    ).join("\n");

    const result = recursivelyTranspile(body, componentList);
    expect(result.transpiledHtmlBody).toContain('class="bascik__item-card__card');
    expect(result.usedComponents).toHaveLength(instanceCount);

    // Initial mask on full document = 1 call. Incremental splice avoids 300 full document re-masks.
    expect(maskCallsOnDocument).toBeLessThanOrEqual(5);

    maskSpy.mockRestore();
  });

  it("falsification check: re-masks properly when a component introduces raw text tags (<script>/<style>/comments)", () => {
    const componentList: ComponentList = {
      "code-viewer": {
        fileContent: `<div class="box"><script>const x = '<fake-comp></fake-comp>';</script><p>Text</p></div>`,
      },
      "fake-comp": {
        fileContent: `<span class="fake">Should not be resolved inside script</span>`,
      },
      "item-card": {
        fileContent: `<div class="card"><code-viewer></code-viewer></div>`,
      },
    };

    const body = `<item-card></item-card>`;
    const result = recursivelyTranspile(body, componentList);
    expect(result.transpiledHtmlBody).toContain("const x = '<fake-comp></fake-comp>';");
    expect(result.transpiledHtmlBody).not.toContain("Should not be resolved inside script");
  });
});

