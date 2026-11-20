import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scaffold } from "../scaffold.js";
import { CORPORATE_TEMPLATE } from "./corporate.js";

const root = resolve(import.meta.dirname, "../../..");
const verification = resolve(root, "create/dist/corporate-verification");
const site = resolve(verification, "corporate");
const sources = new Map(CORPORATE_TEMPLATE.files({ siteName: "corporate" }));
const source = (path: string): string => sources.get(path) as string;

// A fresh real scaffold and production build, retained only in ignored dist/.
beforeAll(async () => {
  await rm(verification, { recursive: true, force: true });
  await mkdir(verification, { recursive: true });
  await scaffold("corporate", verification, { template: CORPORATE_TEMPLATE });
  await mkdir(resolve(site, "node_modules/@bascik"), { recursive: true });
  await symlink(
    resolve(root, "pkg"),
    resolve(site, "node_modules/@bascik/bascik"),
  );
  execFileSync(
    process.execPath,
    [resolve(root, "pkg/bin/bascik.js"), "--build"],
    {
      cwd: site,
      env: {
        ...process.env,
        BASCIK_SITE_URL: "https://example.com",
        NO_COLOR: "1",
      },
      stdio: "pipe",
      timeout: 90_000,
    },
  );
}, 120_000);

describe("corporate feedback regressions", () => {
  it("inlines global CSS through assets.inlineStyles without a blocking link", async () => {
    expect(source("bascik.config.ts")).toContain(
      'inlineStyles: ["src/pages/css/styles.css"]',
    );
    const output = await readFile(resolve(site, "dist/index.html"), "utf8");
    expect(output).not.toMatch(/<link[^>]+styles\.css/);
    expect(output).toContain("--brand:");
  });

  it("ships an icon-only named theme button and a synchronous head initializer", () => {
    const toggle = source("src/components/theme-toggle/theme-toggle.html");
    expect(
      toggle,
      "corporate must generate a theme-toggle component",
    ).toBeDefined();
    expect(toggle).toContain('data-testid="theme-toggle-button"');
    expect(toggle).toContain('aria-label="Toggle dark mode"');
    expect(toggle).toContain('aria-hidden="true"');
    expect(toggle).not.toMatch(/>\s*(?:Light|Dark|Theme)\s*</);
    expect(source("src/components/site-head/site-head.html")).toContain(
      "<theme-init />",
    );
  });

  it("does not animate the hero or enable initial view transitions", () => {
    expect(source("src/components/home-hero/home-hero.html")).not.toMatch(
      /animation\s*:|@keyframes/,
    );
    for (const [path, text] of sources) {
      if (!path.endsWith(".test.ts") && !path.startsWith("e2e/")) {
        expect(text, path).not.toMatch(
          /@view-transition|view-transition-name|startViewTransition/,
        );
      }
    }
  });

  it("uses a borderless adjacent services disclosure and a fine-pointer hover bridge", () => {
    const css = source("src/components/site-header/site-header.css");
    const caret = /\.caret \{([^}]+)\}/.exec(css)![1];
    expect(caret).toContain("border: 0;");
    expect(css).toContain(".submenu::before");
    expect(source("src/components/site-header/site-header.ts")).toContain(
      "(hover: hover) and (pointer: fine)",
    );
  });

  it("preserves the canonical Bascik SVG and corporate slug brand", async () => {
    const favicon = await readFile(
      resolve(site, "src/pages/assets/favicon.svg"),
      "utf8",
    );
    expect(favicon).toContain('points="10,3 28,3 23,29 4,29"');
    expect(favicon).toContain('fill="#d3ff8d"');
    expect(favicon).toContain('fill="#0e0f10"');
    expect(await readFile(resolve(site, "src/lib/site.ts"), "utf8")).toContain(
      'SITE_NAME: string = "corporate"',
    );
  });
});
