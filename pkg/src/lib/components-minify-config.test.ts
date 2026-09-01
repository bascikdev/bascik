import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  deepReadDirFlat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./file-system.js", () => ({ deepReadDirFlat: mocks.deepReadDirFlat }));
vi.mock("./styles.js", () => ({
  getComponentCss: vi.fn(async () => undefined),
  extractInlineStyles: vi.fn((html: string) => ({ html, css: "" })),
  resolveCssImports: vi.fn(async (css: string) => css),
}));
vi.mock("./javascript.js", () => ({
  getComponentScripts: vi.fn(async () => ({ scripts: "", scriptMap: new Map() })),
}));
vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn(async (html: string) => html),
}));
vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { components: "src/components" },
    minify: { html: false },
  },
}));

import { invalidateComponentListCache, listComponents } from "./components.ts";

describe("listComponents – minify.html gating", () => {
  beforeEach(() => {
    invalidateComponentListCache();
    mocks.readFile.mockReset();
    mocks.deepReadDirFlat.mockReset();
  });

  it("leaves component whitespace and structure unchanged when HTML minification is disabled", async () => {
    const source = "<section>\n  <p>content</p>\n</section>";
    mocks.deepReadDirFlat.mockResolvedValue(["src/components/my-card.html"]);
    mocks.readFile.mockResolvedValue(Buffer.from(source));

    const components = await listComponents();

    expect(components["my-card"].fileContent).toBe(source);
  });
});