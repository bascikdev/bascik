import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("generate-llms-txt", () => {
  it("generates llms.txt following the llms.txt spec", async () => {
    await import("./generate-llms-txt.js");

    const llmsFile = path.resolve(import.meta.dirname, "../dist/llms.txt");
    const content = await fs.readFile(llmsFile, "utf8");

    expect(content).toContain("# Bascik");
    expect(content).toContain("> Bascik is a build tool for HTML components.");
    expect(content).toContain("## Overview");
    expect(content).toContain(
      "- [Getting Started](https://bascik.dev/getting-started):",
    );
    expect(content).toContain("## Components");
    expect(content).toContain("## Scripts & Routing");
    expect(content).toContain("## Reference");
  });

  // Its Markdown is content/deployment/index.md, which the old lookup never tried.
  it("describes a page whose Markdown is a folder's index.md", async () => {
    await import("./generate-llms-txt.js");
    const llmsFile = path.resolve(import.meta.dirname, "../dist/llms.txt");
    const content = await fs.readFile(llmsFile, "utf8");
    expect(content).toMatch(
      /^- \[Overview\]\(https:\/\/bascik\.dev\/deployment\): \S/m,
    );
  });

  it("gives every sidebar page a description", async () => {
    await import("./generate-llms-txt.js");
    const llmsFile = path.resolve(import.meta.dirname, "../dist/llms.txt");
    const content = await fs.readFile(llmsFile, "utf8");
    const bare = content
      .split("\n")
      .filter((line) =>
        /^- \[[^\]]+\]\(https:\/\/bascik\.dev\/[^)]*\)$/.test(line),
      );
    expect(bare).toEqual([]);
  });
});
