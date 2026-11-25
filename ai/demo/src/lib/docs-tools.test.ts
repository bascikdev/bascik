import { describe, expect, it } from "vitest";
import { docsTools, searchDocs } from "./docs-tools.ts";

const tool = (name: string) =>
  docsTools.find((candidate) => candidate.name === name)!;

describe("searchDocs", () => {
  it("finds the page a question is about, with a URL on the docs site", async () => {
    const hits = await searchDocs("stream script yield rows");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.route).toBe("/scripts/stream");
    for (const hit of hits) {
      expect(hit.url.startsWith("https://bascik.dev/")).toBe(true);
    }
  });

  it("returns nothing for a query with no words in it", async () => {
    expect(await searchDocs("?? !!")).toEqual([]);
  });
});

describe("read_doc", () => {
  it("reads a page by its route", async () => {
    const markdown = await tool("read_doc").run!(
      { route: "/scripts/stream#yield-rows-as-they-arrive" },
      {},
    );
    expect(markdown.startsWith("# Stream Scripts")).toBe(true);
  });

  it.each([
    "../../package.json",
    "/etc/passwd",
    "/scripts/../../../README",
    "C:\\Windows",
    "/nope",
  ])("refuses %s, which is not a docs route", async (route) => {
    await expect(async () =>
      tool("read_doc").run!({ route }, {}),
    ).rejects.toThrow(/No page/);
  });
});
