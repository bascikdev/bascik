/**
 * listComponents records which components import each stylesheet, against real
 * files in a temp directory. Dev uses this to rebuild the pages of every
 * component that imports an edited, created, or deleted stylesheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const { configState } = vi.hoisted(() => ({
  configState: {
    directory: { pages: "", components: [] as string[], out: "" },
    scoping: { deduplicateCss: true, preserve: [] as string[] },
    minify: { html: false, css: false, js: false, identifiers: false },
    scripts: { cache: { enabled: false } },
    logging: { level: "info" },
    base: "/",
  },
}));

vi.mock("./config.js", () => ({
  BascikConfig: configState,
  shouldLog: () => false,
}));

vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn(async (html: string) => html),
}));

import { componentsImportingStylesheet, invalidateComponentListCache, listComponents } from "./components.ts";
import { prefixElementAttribute } from "./javascript.ts";

let base: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
const components = () => join(base, "src/components");

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-stylesheet-imports-")));
  configState.directory.pages = join(base, "src/pages");
  configState.directory.out = join(base, "dist");
  configState.directory.components = [components()];
  mkdirSync(join(components(), "my-card"), { recursive: true });
  mkdirSync(join(components(), "shared"), { recursive: true });
  mkdirSync(join(base, "src/styles"), { recursive: true });
  invalidateComponentListCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
  warnSpy.mockRestore();
  invalidateComponentListCache();
  rmSync(base, { recursive: true, force: true });
});

describe("componentsImportingStylesheet", () => {
  it("maps companion and inline style imports, nested and missing, to their components", async () => {
    writeFileSync(join(components(), "my-card/my-card.html"), '<div class="card">card</div>');
    writeFileSync(join(components(), "my-card/my-card.css"), '@import "../shared/tokens.css";\n.card { color: red; }');
    writeFileSync(join(components(), "shared/tokens.css"), '@import "../../styles/palette.css";\n.card { gap: 0; }');
    writeFileSync(join(base, "src/styles/palette.css"), ".card { color: blue; }");
    writeFileSync(
      join(components(), "my-nav.html"),
      '<style>@import "./shared/tokens.css"; @import "./shared/later.css";</style><nav class="card"></nav>',
    );

    await listComponents();

    expect(componentsImportingStylesheet(join(components(), "shared/tokens.css")).sort()).toEqual(["my-card", "my-nav"]);
    expect(componentsImportingStylesheet(join(base, "src/styles/palette.css")).sort()).toEqual(["my-card", "my-nav"]);
    expect(componentsImportingStylesheet(join(components(), "shared/later.css"))).toEqual(["my-nav"]);
    expect(componentsImportingStylesheet(join(components(), "my-card/my-card.css"))).toEqual([]);
  });

  it("accepts a path relative to the working directory", async () => {
    writeFileSync(join(components(), "my-card/my-card.html"), '<div class="card">card</div>');
    writeFileSync(join(components(), "my-card/my-card.css"), '@import "../shared/tokens.css";');
    writeFileSync(join(components(), "shared/tokens.css"), ".card { gap: 0; }");

    await listComponents();

    expect(componentsImportingStylesheet(relative(process.cwd(), join(components(), "shared/tokens.css")))).toEqual(["my-card"]);
  });

  it("loads and scopes a stylesheet with a missing import without losing the rules after it", async () => {
    writeFileSync(join(components(), "my-card/my-card.html"), '<div class="card">card</div>');
    writeFileSync(join(components(), "my-card/my-card.css"), '@import "./missing.css";\n.card { color: red; }\n.x { margin: 0; }\n');

    const listed = (await listComponents())["my-card"];
    expect(componentsImportingStylesheet(join(components(), "my-card/missing.css"))).toEqual(["my-card"]);
    warnSpy.mockClear();
    const scoped = prefixElementAttribute({ name: "my-card", ...listed }, "class", "my-card");

    expect(scoped.fileContent).toBe('<div class="bascik__my-card__card">card</div>');
    expect(scoped.cssFileContent).toBe(
      '/* @import "./missing.css" not found */\n.bascik__my-card__card { color: red; }\n.bascik__my-card__x { margin: 0; }\n',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps the last listing across cache invalidation and replaces it on the next listing", async () => {
    const tokens = join(components(), "shared/tokens.css");
    writeFileSync(join(components(), "my-card/my-card.html"), '<div class="card">card</div>');
    writeFileSync(join(components(), "my-card/my-card.css"), '@import "../shared/tokens.css";');
    writeFileSync(tokens, ".card { gap: 0; }");
    await listComponents();

    invalidateComponentListCache();
    expect(componentsImportingStylesheet(tokens)).toEqual(["my-card"]);

    writeFileSync(join(components(), "my-card/my-card.css"), ".card { color: red; }");
    await listComponents();
    expect(componentsImportingStylesheet(tokens)).toEqual([]);
  });
});
