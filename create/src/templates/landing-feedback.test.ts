import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "../scaffold.ts";
import { LANDING_TEMPLATE } from "./landing.ts";

const root = resolve(import.meta.dirname, "../../..");
const files = new Map(
  LANDING_TEMPLATE.files({ siteName: "landing" }).map(([path, text]) => [
    path,
    String(text),
  ]),
);
const header = files.get("src/components/site-header/site-header.html")!;
const css = files.get("src/pages/css/styles.css")!;

describe("landing feedback regressions", () => {
  it("provides an icon-only accessible theme button with persisted state", () => {
    expect(header).toMatch(
      /<button[^>]*aria-label="Toggle dark mode"[^>]*aria-pressed="false"[^>]*data-testid="site-header-theme-toggle"[^>]*hidden>/,
    );
    expect(header).toContain('aria-hidden="true"');
    expect(header).toContain("localStorage.setItem");
    expect(header).toContain("theme-switching");
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("initializes saved theme in the head before any visible content", () => {
    const head = files.get("src/components/site-head/site-head.html")!;
    expect(head).toContain("localStorage.getItem");
    expect(head).toContain("prefers-color-scheme: dark");
    expect(head).not.toContain("startViewTransition");
  });

  it("has no initial hero entrances or root view-transition fades", () => {
    const hero = files.get("src/components/home-hero/home-hero.html")!;
    expect(hero).not.toMatch(/animation\s*:|opacity\s*:\s*0\b/);
    expect(css).toMatch(
      /::view-transition-old\(root\)[\s\S]*?::view-transition-new\(root\)[\s\S]*?animation:\s*none/,
    );
    expect(css).toContain("::view-transition-group(root)");
    expect(css).toContain("::view-transition-image-pair(root)");
    expect(css).toContain("button:active, .btn:active { scale: 0.97; }");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("inlines the global stylesheet using assets.inlineStyles", () => {
    expect(files.get("bascik.config.ts")).toMatch(
      /assets:\s*\{\s*inlineStyles:\s*\["src\/pages\/css\/styles\.css"\]/,
    );
    expect(files.get("src/components/site-head/site-head.html")).not.toMatch(
      /<link[^>]*rel="stylesheet"/,
    );
  });

  it("uses the supplied slug as the only source of product branding", () => {
    const content = [...files]
      .filter(([path]) => !/\.(?:test|spec)\.ts$/.test(path))
      .map(([, text]) => text)
      .join("\n");
    expect(content).not.toMatch(/fieldnote/i);
    expect(files.get("src/lib/site.ts")).toContain('name: "landing"');
    expect(files.get("src/components/home-hero/home-hero.html")).toContain(
      'from "@/lib/site.ts"',
    );
  });

  it("deliberately styles navigation without list-link underlines", () => {
    expect(header).toContain(".menu a { text-decoration: none; }");
    expect(header).toContain(".menu .cta { color: var(--accent)");
  });

  it("scaffolds unchanged canonical Bascik icons in every format", async () => {
    const temp = await mkdtemp(
      join(tmpdir(), "bascik-feedback-landing-source-"),
    );
    try {
      expect(dirname(temp)).toBe(tmpdir());
      await scaffold("landing", temp, { template: LANDING_TEMPLATE });
      for (const path of [
        "favicon.ico",
        "assets/favicon-32x32.png",
        "assets/apple-touch-icon.png",
        "assets/favicon.svg",
      ]) {
        const icon = await readFile(join(temp, "landing/src/pages", path));
        const canonical = await readFile(join(root, "docs/src/pages", path));
        expect(icon.equals(canonical), path).toBe(true);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
