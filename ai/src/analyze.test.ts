import { describe, expect, it } from "vitest";
import { analyzeReply } from "./analyze.ts";
import { describeComponent, type Catalog } from "./catalog.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<a data-bascik-prop-title><span data-bascik-slot></span></a>`,
    )!,
    describeComponent(
      "card-grid.html",
      `<div><span data-bascik-slot></span></div>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

describe("analyzeReply", () => {
  it("reports a reply that followed the format as clean", () => {
    const report = analyzeReply(
      `Two picks:\n\n<card-grid>\n<book-card title="A">x</book-card>\n<book-card title="B" />\n</card-grid>\n\n<table><tr><td>1</td></tr></table>`,
      catalog,
      { elements: ["table", "tr", "td"] },
    );
    expect(report).toEqual({
      components: { "card-grid": 1, "book-card": 2 },
      elements: { table: 1, tr: 1, td: 1 },
      unknownTags: {},
      unknownProps: {},
      unclosed: 0,
      clean: true,
    });
  });

  it("names the tags, props, and unclosed elements a model got wrong", () => {
    const report = analyzeReply(
      `<div class="x">hi</div> <book-card title="A" subtitle="B" featured>x</book-card> <card-grid><book-card title="C">`,
      catalog,
    );
    expect(report.unknownTags).toEqual({ div: 1 });
    expect(report.unknownProps).toEqual({
      "book-card.subtitle": 1,
      "book-card.featured": 1,
    });
    expect(report.unclosed).toBe(2);
    expect(report.clean).toBe(false);
  });

  it("does not read words inside a quoted value as attributes", () => {
    const report = analyzeReply(
      `<book-card title="Refactoring the Monolith: a field guide = good">x</book-card>`,
      catalog,
    );
    expect(report.clean).toBe(true);
  });

  it("does not count tags shown as code", () => {
    const report = analyzeReply(
      "Use `<script>` like this:\n\n```html\n<div><script src=x></script></div>\n```\n",
      catalog,
    );
    expect(report.clean).toBe(true);
  });
});
