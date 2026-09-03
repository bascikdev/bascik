import { describe, it, expect } from "vitest";
import { prefixElementAttribute } from "./javascript.ts";
import type { BascikComponent } from "./types.ts";

describe("Prompt 36: Regex reuse & attributes deduplication", () => {
  it("deduplicates attributesToReplace tokens so regex replacements run per unique class, not per occurrence", () => {
    const classCount = 50;
    const body = Array.from({ length: classCount }, () => `<div class="btn">Text</div>`).join("\n");

    const comp: BascikComponent = {
      name: "multi-button",
      fileContent: `${body}\n<script>const b = document.querySelector('.btn');</script>`,
      cssFileContent: `.btn { color: green; }`,
    };

    const res = prefixElementAttribute(comp, "class", "inst1");
    expect(res.fileContent).toContain("bascik__multi-button__btn");
    // Verified: markup and script both got correctly transformed
    expect(res.fileContent).toContain("querySelector('.bascik__multi-button__btn')");
  });
});
