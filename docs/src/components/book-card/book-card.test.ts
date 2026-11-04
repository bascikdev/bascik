/**
 * book-card is the card the "Returning component tags" demos render: the server-scripts and stream-scripts
 * Preview panes expand it at build time, and the md source blocks show the same files a reader copies into a
 * new site (scripts/rtc-demos.test.ts checks that the two stay equal).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const dir = join(process.cwd(), "src/components/book-card");
const read = (name: string) => readFile(join(dir, name), "utf8");

describe("book-card component", () => {
  it("documents itself with an @bascik doc comment naming its props and slot", async () => {
    const html = await read("book-card.html");
    const doc = /<!--\s*@bascik[\s\S]*?-->/.exec(html)?.[0];
    expect(doc, "an @bascik doc comment").toBeDefined();
    expect(doc).toMatch(/@prop title\b/);
    expect(doc).toMatch(/@prop author\b/);
    expect(doc).toMatch(/@slot\b/);
  });

  it("receives title and author props with readable fallbacks", async () => {
    const html = await read("book-card.html");
    expect(html).toMatch(
      /<h3 class="title" data-bascik-prop-title>Untitled book<\/h3>/,
    );
    expect(html).toMatch(
      /<p class="author" data-bascik-prop-author>Unknown author<\/p>/,
    );
  });

  it("has a default slot for the badge with a Paperback fallback", async () => {
    const html = await read("book-card.html");
    expect(html).toMatch(
      /<span class="badge"><span data-bascik-slot>Paperback<\/span><\/span>/,
    );
    // A named slot would not receive the badge the script returns as plain children.
    expect(html).not.toMatch(/data-bascik-slot="[^"]+"/);
  });

  it("has the test hooks the docs e2e tests use", async () => {
    const html = await read("book-card.html");
    expect(html).toContain('<article class="card" data-testid="book-card">');
    expect(html).toMatch(
      // Prettier puts the label on its own line once the attributes wrap.
      /<button[^>]*class="save"[^>]*data-testid="book-card-save"[^>]*>\s*Save\s*<\/button>/,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('<script src="book-card.js"></script>');
  });

  it("ships a companion stylesheet and client script", async () => {
    expect(existsSync(join(dir, "book-card.css"))).toBe(true);
    expect(existsSync(join(dir, "book-card.js"))).toBe(true);
    const css = await read("book-card.css");
    expect(css).toMatch(/\.card\s*\{/);
    expect(css).toMatch(/\.badge\s*\{/);
    const js = await read("book-card.js");
    expect(js).toContain('closest(".save")');
    expect(js).toContain("aria-pressed");
  });

  it("has the same script text in every instance, so one CSP hash covers cards rendered at request time", async () => {
    // A scoped id (getElementById on the card's own id) would put the
    // instance id in the script text: /how-to/content-security-policy.
    const html = await read("book-card.html");
    const js = await read("book-card.js");
    expect(html).not.toMatch(/\sid="/);
    expect(js).not.toContain("getElementById");
  });

  it("has no server or stream script, so the docs site stays static", async () => {
    const html = await read("book-card.html");
    expect(html).not.toMatch(/data-bascik-(server|stream)\b/);
  });
});
