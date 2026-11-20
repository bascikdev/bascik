import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TEMPLATE,
  FAVICON_SVG,
  MY_COUNTER_CSS,
  MY_COUNTER_HTML,
  SITE_HEADER_HTML,
  STYLES_CSS,
  indexPage,
} from "./scaffold.js";
import {
  FAVICON_ICO_B64,
  FAVICON_32_PNG_B64,
  APPLE_TOUCH_ICON_PNG_B64,
} from "./default-icons.js";

describe("default starter feedback", () => {
  it("welcomes the project name instead of a product slogan", () => {
    expect(indexPage("default")).toContain(
      "<h1>Welcome to <span>default</span></h1>",
    );
  });
  it("provides an accessible icon-only theme control", () => {
    expect(SITE_HEADER_HTML).toContain(
      'data-testid="site-header-theme-toggle"',
    );
    expect(SITE_HEADER_HTML).toContain('aria-label="Toggle dark mode"');
    expect(SITE_HEADER_HTML).toContain("<svg");
    expect(STYLES_CSS).toContain(':root[data-theme="dark"]');
  });
  it("inlines global CSS with the native asset configuration", () => {
    const config = DEFAULT_TEMPLATE.files({ siteName: "default" }).find(
      ([path]) => path === "bascik.config.ts",
    );
    expect(config?.[1]).toContain("inlineStyles");
    expect(config?.[1]).toContain("src/pages/css/styles.css");
  });
  it("lets scoped CSS monitor the reflected raw numeric counter value", () => {
    expect(MY_COUNTER_HTML).toContain('data-value="0"');
    expect(MY_COUNTER_HTML).toContain("val.dataset.value = String(count)");
    expect(MY_COUNTER_CSS).toContain(".value[data-value^='-']");
    expect(MY_COUNTER_CSS).toContain("color: var(--error)");
    expect(MY_COUNTER_HTML).not.toContain("val.style");
    expect(MY_COUNTER_HTML).not.toContain("dataset.state");
    expect(MY_COUNTER_HTML).not.toContain("count < 0");
    expect(indexPage("default")).toContain(
      "CSS monitors the reflected numeric",
    );
  });
  it("ships the canonical SVG without recoloring the brand", () => {
    expect(FAVICON_SVG.replace(/\s+/g, " ").trim()).toBe(
      readFileSync(
        new URL("../../docs/src/pages/assets/favicon.svg", import.meta.url),
        "utf8",
      )
        .replace(/\s+/g, " ")
        .replace(" >", ">")
        .trim(),
    );
  });
  it("preserves canonical raster favicon bytes", () => {
    for (const [name, data] of [
      ["../favicon.ico", FAVICON_ICO_B64],
      ["favicon-32x32.png", FAVICON_32_PNG_B64],
      ["apple-touch-icon.png", APPLE_TOUCH_ICON_PNG_B64],
    ]) {
      expect(
        Buffer.from(data, "base64").equals(
          readFileSync(
            new URL(`../../docs/src/pages/assets/${name}`, import.meta.url),
          ),
        ),
        name,
      ).toBe(true);
    }
  });
  it("does not opt into root view-transition entrances", () => {
    expect(STYLES_CSS).not.toContain("@view-transition");
    expect(STYLES_CSS).not.toContain("@keyframes");
  });
});
