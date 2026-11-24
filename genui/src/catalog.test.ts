import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogPrompt,
  describeComponent,
  readCatalog,
  signature,
} from "./catalog.ts";

const BOOK_CARD = `<!-- @bascik
One book. Mention data-bascik-prop-ignored here: prose is not a prop.
-->
<article>
  <h3 data-bascik-prop-title>Untitled</h3>
  <p data-bascik-prop-author></p>
  <a data-bascik-attr-href="link" data-bascik-attr-title="title">More</a>
  <span data-bascik-slot></span>
</article>`;

describe("describeComponent", () => {
  it("reads the name, description, props, and slot from the file", () => {
    expect(
      describeComponent("/abs/src/genui/book-card.html", BOOK_CARD),
    ).toEqual({
      name: "book-card",
      description:
        "One book. Mention data-bascik-prop-ignored here: prose is not a prop.",
      props: ["title", "author", "link"],
      slot: true,
    });
  });

  it("reports no slot for a component that only has named slots or none", () => {
    const entry = describeComponent(
      "bar-row.html",
      `<li data-bascik-prop-label></li><div data-bascik-slot-name="x"></div>`,
    );
    expect(entry?.slot).toBe(false);
  });

  it("refuses a file whose name is not a component tag", () => {
    expect(describeComponent("index.html", "<p></p>")).toBeNull();
    expect(describeComponent("Book-Card.html", "<p></p>")).toBeNull();
  });
});

describe("readCatalog", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads flat files and folder components, sorted by name", async () => {
    directory = await mkdtemp(join(tmpdir(), "genui-catalog-"));
    await writeFile(join(directory, "stat-tile.html"), "<dl></dl>");
    await mkdir(join(directory, "book-card"));
    await writeFile(join(directory, "book-card", "book-card.html"), BOOK_CARD);
    await writeFile(join(directory, "book-card", "book-card.css"), "");
    await writeFile(join(directory, "notes.md"), "");
    const catalog = await readCatalog(directory);
    expect([...catalog.keys()]).toEqual(["book-card", "stat-tile"]);
  });
});

describe("catalogPrompt", () => {
  it("lists each component as a line a model can copy", () => {
    const entry = describeComponent("book-card.html", BOOK_CARD)!;
    const leaf = describeComponent(
      "bar-row.html",
      `<li data-bascik-prop-label></li>`,
    )!;
    expect(signature(entry)).toBe(
      `<book-card title="…" author="…" link="…">content</book-card>`,
    );
    expect(signature(leaf)).toBe(`<bar-row label="…" />`);
    const prompt = catalogPrompt(new Map([[entry.name, entry]]));
    expect(prompt).toContain(signature(entry));
    expect(prompt).toContain("  One book.");
    expect(catalogPrompt(new Map([[entry.name, entry]]))).toBe(prompt);
  });
});
