/**
 * Find All References for components (Collin 2026-10-28: "standard Find All References, because people already
 * know it (Shift+F12, Peek References, the References panel). No custom Explorer command.").
 *
 * - /tools/vscode-extension has a Find All References section with the animated capture, both ways to start
 *   it, and the source-only limit; the What You Get table links to it.
 * - The language server docs (/tools/linter and lsp/README.md) describe the request and the same limit.
 * - Neither page uses an em-dash; check:spelling covers American spelling.
 * - The capture script has the find-references scene, and its animated WebP and reduced-motion still are
 *   committed.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderMd } from "./md-renderer.ts";

const DOCS = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(DOCS, "..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");

/** The text of one `## ` or `### ` section, from its heading to the next heading of the same or higher level. */
const section = (md: string, heading: string): string => {
  const start = md.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0];
  const rest = md.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
};

const ANIMATION = "/assets/vscode/find-references@2x.webp";

describe("Find All References docs", () => {
  const extensionMd = read("content/tools/vscode-extension.md");
  const references = section(extensionMd, "## Find All References");

  it("the VS Code page has the section, linked from the What You Get table", () => {
    expect(extensionMd).toContain(
      "[Find All References](#find-all-references)",
    );
    expect(references).toContain(ANIMATION);
  });

  it("names both ways to start it, the panel, and the source-only limit", () => {
    expect(references).toContain("Shift+F12");
    expect(references).toContain("**From a usage.**");
    expect(references).toContain("**From the component itself.**");
    expect(references).toContain("<!-- @bascik");
    expect(references).toContain("References panel");
    expect(references).toMatch(
      /build script, a Markdown file, or a server script is not listed/,
    );
  });

  it("renders the animation with its reduced-motion still", async () => {
    const html = await renderMd("./content/tools/vscode-extension.md");
    // The helper emits `@` as `%40`, the form Workers static assets serves without a redirect.
    expect(html).toContain(ANIMATION.replace("@", "%40"));
    expect(html).toContain("/assets/vscode/find-references-still%402x.webp");
  });

  it("the language server docs describe the request and the limit", () => {
    const linter = section(
      read("content/tools/linter.md"),
      "### Find All References",
    );
    expect(linter).toContain("textDocument/references");
    expect(linter).toContain(ANIMATION);
    expect(linter).toMatch(/not listed/);
    const readme = readFileSync(path.join(REPO, "lsp/README.md"), "utf8");
    expect(readme).toContain("Find All References (`textDocument/references`)");
  });

  it("the capture scene exists and its WebP files are committed", () => {
    expect(read("scripts/capture-vscode-screenshots.ts")).toMatch(
      /name: "find-references"/,
    );
    for (const file of [
      "src/pages/assets/vscode/find-references@2x.webp",
      "src/pages/assets/vscode/find-references-still@2x.webp",
    ])
      expect(existsSync(path.join(DOCS, file)), file).toBe(true);
  });

  it("uses no em-dash", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const text of [extensionMd, read("content/tools/linter.md")])
      expect(text).not.toContain(emDash);
  });
});
