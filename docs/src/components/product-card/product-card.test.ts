/**
 * product-card is the card the "Returning component tags" demos render: the server-scripts and stream-scripts
 * Preview panes expand it at build time, and the md source blocks show the same files a reader copies into a
 * new site (scripts/rtc-demos.test.ts checks that the two stay equal).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const dir = join(process.cwd(), "src/components/product-card");
const read = (name: string) => readFile(join(dir, name), "utf8");

describe("product-card component", () => {
  it("documents itself with an @bascik doc comment naming its props and slot", async () => {
    const html = await read("product-card.html");
    const doc = /<!--\s*@bascik[\s\S]*?-->/.exec(html)?.[0];
    expect(doc, "an @bascik doc comment").toBeDefined();
    expect(doc).toMatch(/@prop name\b/);
    expect(doc).toMatch(/@prop price\b/);
    expect(doc).toMatch(/@slot\b/);
  });

  it("receives name and price props with readable fallbacks", async () => {
    const html = await read("product-card.html");
    expect(html).toMatch(
      /<h3 class="name" data-bascik-prop-name>Unnamed product<\/h3>/,
    );
    expect(html).toMatch(
      /<p class="price" data-bascik-prop-price>Price on request<\/p>/,
    );
  });

  it("has a default slot for the badge with a Standard fallback", async () => {
    const html = await read("product-card.html");
    expect(html).toMatch(
      /<span class="badge"><span data-bascik-slot>Standard<\/span><\/span>/,
    );
    // A named slot would not receive the badge the script returns as plain children.
    expect(html).not.toMatch(/data-bascik-slot="[^"]+"/);
  });

  it("has the test hooks the docs e2e tests use", async () => {
    const html = await read("product-card.html");
    expect(html).toContain('<article class="card" data-testid="product-card">');
    expect(html).toMatch(
      // Prettier puts the label on its own line once the attributes wrap.
      /<button[^>]*id="save"[^>]*data-testid="product-card-save"[^>]*>\s*Save\s*<\/button>/,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('<script src="product-card.js"></script>');
  });

  it("ships a companion stylesheet and client script", async () => {
    expect(existsSync(join(dir, "product-card.css"))).toBe(true);
    expect(existsSync(join(dir, "product-card.js"))).toBe(true);
    const css = await read("product-card.css");
    expect(css).toMatch(/\.card\s*\{/);
    expect(css).toMatch(/\.badge\s*\{/);
    const js = await read("product-card.js");
    expect(js).toContain('getElementById("save")');
    expect(js).toContain("aria-pressed");
  });

  it("has no server or stream script, so the docs site stays static", async () => {
    const html = await read("product-card.html");
    expect(html).not.toMatch(/data-bascik-(server|stream)\b/);
  });
});
