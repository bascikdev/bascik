import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A CDN URL with no exact version (`https://unpkg.com/alpinejs`) answers with a redirect to the latest
 * release, so the browser pays a round trip before the real file starts loading, and the page silently picks
 * up new major versions. Every page script loaded from a CDN names an exact version and file.
 */
const PINNED_UNPKG =
  /^https:\/\/unpkg\.com\/(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\/[\w./-]+\.js$/;

async function pageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The `src` of every `<script src>` tag in an HTML string. */
function scriptSources(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi),
  ].map((match) => match[1]);
}

describe("third-party page scripts", () => {
  it("recognizes pinned and unpinned unpkg URLs", () => {
    expect(PINNED_UNPKG.test("https://unpkg.com/alpinejs")).toBe(false);
    expect(PINNED_UNPKG.test("https://unpkg.com/alpinejs@3")).toBe(false);
    expect(PINNED_UNPKG.test("https://unpkg.com/alpinejs@3.17.5")).toBe(false);
    expect(
      PINNED_UNPKG.test("https://unpkg.com/alpinejs@3.17.5/dist/cdn.min.js"),
    ).toBe(true);
    expect(
      PINNED_UNPKG.test("https://unpkg.com/@scope/pkg@1.2.3/dist/pkg.iife.js"),
    ).toBe(true);
    expect(
      scriptSources(
        '<script src="https://unpkg.com/a@1.0.0/a.js" defer></script><script>x</script>',
      ),
    ).toEqual(["https://unpkg.com/a@1.0.0/a.js"]);
  });

  it("every unpkg script a page loads names an exact version and file", async () => {
    const pagesDir = join(process.cwd(), "src/pages");
    const unpinned: string[] = [];
    let unpkgScripts = 0;
    for (const file of await pageFiles(pagesDir)) {
      for (const src of scriptSources(await readFile(file, "utf8"))) {
        if (!src.startsWith("https://unpkg.com/")) continue;
        unpkgScripts++;
        if (!PINNED_UNPKG.test(src))
          unpinned.push(`${file.slice(pagesDir.length + 1)}: ${src}`);
      }
    }
    // The /libraries demos load petite-vue and Alpine.js from unpkg.
    expect(unpkgScripts).toBeGreaterThanOrEqual(2);
    expect(unpinned).toEqual([]);
  });
});
