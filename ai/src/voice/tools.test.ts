import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "../catalog.ts";
import { SHOW_TOOL, voicePrompt, voiceTools } from "./tools.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<!-- @bascik One book. --><article><h3 data-bascik-prop-title></h3><span data-bascik-slot></span></article>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

describe("what the show markup may hold", () => {
  const prompt = voicePrompt(catalog, {
    elements: ["table", "tr", "td"],
    fences: { mermaid: "A diagram." },
  });

  it("allows what the format offers for code, tables and diagrams", () => {
    expect(prompt).not.toContain("components only");
    expect(prompt).toContain(
      "holds only components, fences and the elements the format lists: no sentences of its own",
    );
    const show = voiceTools([]).find((tool) => tool.name === SHOW_TOOL)!;
    expect(JSON.stringify(show.inputSchema)).toContain(
      "Components, fences and the elements the format lists",
    );
  });

  it("says after the format that its prose is spoken, not written", () => {
    const format = prompt.indexOf("introduce it in at most one short sentence");
    const spoken = prompt.indexOf(
      "prose and the one sentence that introduces a component are spoken, never written in the markup",
    );
    expect(format).toBeGreaterThan(-1);
    expect(spoken).toBeGreaterThan(format);
  });
});
