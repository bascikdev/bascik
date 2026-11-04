import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderMd } from "./md-renderer.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(DOCS_ROOT, rel), "utf8");
const ANIMATION = "/assets/demos/returning-tags@2x.webp";
const STILL = "/assets/demos/returning-tags-still@2x.webp";

describe("Returning component tags recording", () => {
  const markdown = read("content/scripts.md");
  const start = markdown.indexOf("## Returning component tags");
  const end = markdown.indexOf("\n## ", start + 1);
  const section = markdown.slice(start, end === -1 ? undefined : end);

  it("shows the recorded result directly after the copyable server-script example", () => {
    expect(section).toMatch(
      /```html[\s\S]*?<\/script>\n```\s+!\[[^\]]+\]\(\/assets\/demos\/returning-tags@2x\.webp\)/,
    );
  });

  it("has the animated recording and its reduced-motion still", () => {
    expect(read("scripts/capture-demos.ts")).toContain(
      '"returning-tags": returningTags',
    );
    expect(existsSync(path.join(DOCS_ROOT, `src/pages${ANIMATION}`))).toBe(
      true,
    );
    expect(existsSync(path.join(DOCS_ROOT, `src/pages${STILL}`))).toBe(true);
  });

  it("renders a reduced-motion source for the animation", async () => {
    const html = await renderMd("./content/scripts.md");
    expect(html).toContain(
      `<source media="(prefers-reduced-motion: reduce)" srcset="${STILL.replaceAll("@", "%40")}?v=`,
    );
    expect(html).toContain(ANIMATION.replaceAll("@", "%40"));
  });
});
