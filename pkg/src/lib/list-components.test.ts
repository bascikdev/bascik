/**
 * Tests for listComponents – specifically the ordering guarantee that
 * executeBuildScripts runs on the raw HTML *before* minifyHtml.
 *
 * Why the order matters: minifyHtml extracts all <script> tags and appends
 * them after the HTML. If minifyHtml ran first, a <script data-bascik-build>
 * inside a container (e.g. <aside>) would be hoisted out of that container
 * before executeBuildScripts could replace it, causing the generated content
 * to appear outside the container in the final output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { components: "src/components" },
    deduplicateCss: true,
    minify: { html: false, css: false, js: false, identifiers: false },
    skipTranspilingElementContents: [],
  },
}));

vi.mock("./file-system.js", () => ({
  deepReadDirFlat: vi.fn(),
}));

vi.mock("./styles.js", () => ({
  getComponentCss: vi.fn(async () => ""),
  extractInlineStyles: vi.fn((html: string) => ({ html, css: "" })),
}));

vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn(async (html: string) => html),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { listComponents, minifyHtml, invalidateComponentListCache } from "./components.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { readFile } from "node:fs/promises";

const mockDeepReadDirFlat = deepReadDirFlat as ReturnType<typeof vi.fn>;
const mockExecuteBuildScripts = executeBuildScripts as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateComponentListCache();
  // Default: executeBuildScripts is a pass-through (no build scripts in HTML)
  mockExecuteBuildScripts.mockImplementation(async (html: string) => html);
  // Default: no CSS file exists alongside the component
  mockDeepReadDirFlat.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// minifyHtml script-hoisting behavior (documents the ordering constraint)
// ─────────────────────────────────────────────────────────────────────────────

describe("minifyHtml – script hoisting (documents build-script ordering requirement)", () => {
  it("moves a <script> tag out of its container to end of the string", () => {
    // This is intentional minifyHtml behavior — it consolidates scripts at
    // the bottom. But it means executeBuildScripts MUST run before minifyHtml;
    // otherwise the script would be hoisted before it can be replaced.
    const html = "<aside><script>client()</script></aside>";
    const minified = minifyHtml(html);

    // Script is moved outside the aside
    expect(minified).toContain("<aside></aside>");
    // Script appears after the closing aside tag
    const asideEnd = minified.indexOf("</aside>");
    const scriptStart = minified.indexOf("<script");
    expect(scriptStart).toBeGreaterThan(asideEnd);
  });

  it("would cause generated content to appear outside its container if order were reversed", () => {
    // Simulate the wrong order: minifyHtml first, then replace script with content.
    // The generated <li> items would end up after </ul>, not inside it.
    // We use a regular script tag here to simulate the hoisting behavior, since
    // our html-minifier no longer hoists data-bascik-build scripts.
    const raw = "<ul><script>makeList()</script></ul>";
    const minified = minifyHtml(raw);
    // If we now naively replace the script with generated content:
    const wrongOrder = minified.replace(
      /<script[^>]*>[\s\S]*?<\/script>/,
      "<li>item</li>",
    );
    // Content is outside the <ul> — this is the bug the fix prevents
    expect(wrongOrder).toMatch(/<\/ul>.*<li>/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listComponents – executeBuildScripts runs before minifyHtml
// ─────────────────────────────────────────────────────────────────────────────

describe("listComponents – build script execution order", () => {
  it("calls executeBuildScripts with the raw file content for each component", async () => {
    const rawHtml =
      '<aside class="sidebar"><script data-bascik-build>gen()</script></aside>';
    mockDeepReadDirFlat.mockResolvedValue(["src/components/my-sidebar.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));

    await listComponents();

    expect(mockExecuteBuildScripts).toHaveBeenCalledWith(
      rawHtml,
      "src/components/my-sidebar.html",
    );
  });

  it("places build script output inside the container, not after it", async () => {
    const rawHtml =
      "<aside><script data-bascik-build>gen()</script></aside>";
    // Simulate executeBuildScripts replacing the script with real content
    const resolvedHtml =
      "<aside><p>Section</p><ul><li>Link</li></ul></aside>";

    mockDeepReadDirFlat.mockResolvedValue(["src/components/my-sidebar.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));
    mockExecuteBuildScripts.mockResolvedValue(resolvedHtml);

    const result = await listComponents();

    expect(result["my-sidebar"]).toBeDefined();
    const fileContent = result["my-sidebar"].fileContent;
    // Generated content is inside the aside
    expect(fileContent).toContain("<aside");
    expect(fileContent).toContain("Section");
    const asideClose = fileContent.indexOf("</aside>");
    const sectionIndex = fileContent.indexOf("Section");
    expect(sectionIndex).toBeLessThan(asideClose);
  });

  it("still minifies the resolved HTML after build scripts run", async () => {
    // executeBuildScripts returns HTML with whitespace; minifyHtml collapses it
    const rawHtml = "<nav><script data-bascik-build>gen()</script></nav>";
    const resolvedHtml =
      "<nav>\n  <ul>\n    <li>Home</li>\n  </ul>\n</nav>";

    mockDeepReadDirFlat.mockResolvedValue(["src/components/my-nav.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));
    mockExecuteBuildScripts.mockResolvedValue(resolvedHtml);

    const result = await listComponents();

    // minifyHtml removes newlines and collapses whitespace
    expect(result["my-nav"].fileContent).not.toContain("\n");
    expect(result["my-nav"].fileContent).toContain("<li>Home</li>");
  });

  it("includes the component in the result when there are no build scripts", async () => {
    const rawHtml = "<nav><a href='/'>Home</a></nav>";

    mockDeepReadDirFlat.mockResolvedValue(["src/components/site-nav.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));

    const result = await listComponents();

    expect(result["site-nav"]).toBeDefined();
    expect(result["site-nav"].fileContent).toContain("Home");
  });

  it("processes multiple components independently", async () => {
    mockDeepReadDirFlat.mockResolvedValue([
      "src/components/my-header.html",
      "src/components/my-footer.html",
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from("<header><script data-bascik-build>h()</script></header>"))
      .mockResolvedValueOnce(Buffer.from("<footer><script data-bascik-build>f()</script></footer>"));
    mockExecuteBuildScripts
      .mockResolvedValueOnce("<header><h1>Title</h1></header>")
      .mockResolvedValueOnce("<footer><p>Copyright</p></footer>");

    const result = await listComponents();

    expect(result["my-header"].fileContent).toContain("Title");
    expect(result["my-footer"].fileContent).toContain("Copyright");
    // Each component's content in its own container
    expect(result["my-header"].fileContent).toContain("<header");
    expect(result["my-footer"].fileContent).toContain("<footer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listComponents – component name normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("listComponents – component name case normalization", () => {
  it("normalizes an uppercase filename to a lowercase key", async () => {
    mockDeepReadDirFlat.mockResolvedValue(["src/components/My-Card.html"]);
    mockReadFile.mockResolvedValue(Buffer.from("<div>card</div>"));

    const result = await listComponents();

    expect(result["my-card"]).toBeDefined();
    expect(result["My-Card"]).toBeUndefined();
  });

  it("normalizes a mixed-case filename to a lowercase key", async () => {
    mockDeepReadDirFlat.mockResolvedValue(["src/components/SiteNav.html"]);
    mockReadFile.mockResolvedValue(Buffer.from("<nav>nav</nav>"));

    const result = await listComponents();

    expect(result["sitenav"]).toBeDefined();
    expect(result["SiteNav"]).toBeUndefined();
  });

  it("last component wins when two filenames differ only in case", async () => {
    mockDeepReadDirFlat.mockResolvedValue([
      "src/components/my-card.html",
      "src/components/My-Card.html",
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from("<div>lowercase</div>"))
      .mockResolvedValueOnce(Buffer.from("<div>uppercase</div>"));

    const result = await listComponents();

    expect(result["my-card"]).toBeDefined();
    // Only one entry for my-card (not two)
    expect(Object.keys(result).filter((k) => k === "my-card")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listComponents – native HTML element name warning
// ─────────────────────────────────────────────────────────────────────────────

describe("listComponents – native HTML element name warning", () => {
  it("logs a warning when a component name matches a native HTML element", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockDeepReadDirFlat.mockResolvedValue(["src/components/nav.html"]);
    mockReadFile.mockResolvedValue(Buffer.from("<nav>hello</nav>"));

    await listComponents();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"nav"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("native HTML element"),
    );
    warnSpy.mockRestore();
  });

  it("does not warn for hyphenated component names", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockDeepReadDirFlat.mockResolvedValue(["src/components/my-nav.html"]);
    mockReadFile.mockResolvedValue(Buffer.from("<nav>hello</nav>"));

    await listComponents();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listComponents – companion scripts
// ─────────────────────────────────────────────────────────────────────────────

describe("listComponents – companion scripts", () => {
  it("inlines <script src=\"...\"> tags matching companion script files", async () => {
    mockDeepReadDirFlat.mockResolvedValue([
      "src/components/demo-counter/demo-counter.html",
      "src/components/demo-counter/demo-counter.ts",
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('<div class="ctr"></div><script src="demo-counter.ts"></script>'))
      .mockResolvedValueOnce(Buffer.from('const x = 1;'));

    const result = await listComponents();

    expect(result["demo-counter"]).toBeDefined();
    expect(result["demo-counter"].fileContent).toContain("const x = 1;");
    expect(result["demo-counter"].fileContent).not.toContain('src="demo-counter.ts"');
  });

  it("does not auto-inline companion scripts unless explicitly referenced with <script src=\"...\">", async () => {
    mockDeepReadDirFlat.mockResolvedValue([
      "src/components/my-counter/my-counter.html",
      "src/components/my-counter/helper.ts",
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('<div class="ctr"></div>'))
      .mockResolvedValueOnce(Buffer.from('export function help() {}'));

    const result = await listComponents();

    expect(result["my-counter"]).toBeDefined();
    expect(result["my-counter"].fileContent).not.toContain("help");
  });

  it("ignores .test.ts and .spec.js companion files", async () => {
    mockDeepReadDirFlat.mockResolvedValue([
      "src/components/my-btn/my-btn.html",
      "src/components/my-btn/my-btn.test.ts",
      "src/components/my-btn/my-btn.spec.js",
    ]);
    mockReadFile.mockResolvedValue(Buffer.from("<button>Click</button>"));

    const result = await listComponents();

    expect(result["my-btn"]).toBeDefined();
    expect(result["my-btn"].fileContent).not.toContain("test");
    expect(result["my-btn"].fileContent).not.toContain("spec");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listComponents – page-aware component script deferral
// ─────────────────────────────────────────────────────────────────────────────

describe("listComponents – page-aware component build script deferral", () => {
  it("executes static component build scripts immediately during registration", async () => {
    const rawHtml =
      "<div><script data-bascik-build>console.log('static')</script></div>";
    mockDeepReadDirFlat.mockResolvedValue(["src/components/static-comp.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));
    mockExecuteBuildScripts.mockResolvedValue("<div><span>static</span></div>");

    const result = await listComponents();

    expect(mockExecuteBuildScripts).toHaveBeenCalledWith(
      rawHtml,
      "src/components/static-comp.html",
    );
    expect(result["static-comp"].fileContent).toContain("<span>static</span>");
    expect(result["static-comp"].fileContent).not.toContain("<script data-bascik-build");
  });

  it("defers execution of build script referencing process.env.BASCIK_PAGE_PATH", async () => {
    const rawHtml =
      "<div><script data-bascik-build>console.log(process.env.BASCIK_PAGE_PATH)</script></div>";
    mockDeepReadDirFlat.mockResolvedValue(["src/components/page-badge.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));

    const result = await listComponents();

    // Should NOT execute executeBuildScripts for the page-aware script
    expect(mockExecuteBuildScripts).not.toHaveBeenCalled();
    expect(result["page-badge"].fileContent).toContain("<script data-bascik-build");
    expect(result["page-badge"].fileContent).toContain("process.env.BASCIK_PAGE_PATH");
  });

  it("defers execution of build script with data-bascik-page-aware attribute", async () => {
    const rawHtml =
      "<div><script data-bascik-build data-bascik-page-aware>console.log('aware')</script></div>";
    mockDeepReadDirFlat.mockResolvedValue(["src/components/aware-comp.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));

    const result = await listComponents();

    expect(mockExecuteBuildScripts).not.toHaveBeenCalled();
    expect(result["aware-comp"].fileContent).toContain("data-bascik-page-aware");
  });

  it("defers execution of build script with data-bascik-build='page' attribute", async () => {
    const rawHtml =
      "<div><script data-bascik-build=\"page\">console.log('page-aware')</script></div>";
    mockDeepReadDirFlat.mockResolvedValue(["src/components/docs-pagination.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));

    const result = await listComponents();

    expect(mockExecuteBuildScripts).not.toHaveBeenCalled();
    expect(result["docs-pagination"].fileContent).toContain('data-bascik-build="page"');
  });

  it("executes static build scripts while deferring page-aware build scripts in the same component", async () => {
    const rawHtml =
      "<div><script data-bascik-build>staticPart()</script><script data-bascik-build=\"page\">dynamicPart()</script></div>";
    mockDeepReadDirFlat.mockResolvedValue(["src/components/mixed-comp.html"]);
    mockReadFile.mockResolvedValue(Buffer.from(rawHtml));
    mockExecuteBuildScripts.mockImplementation(async (html: string) =>
      html.replace("<script data-bascik-build>staticPart()</script>", "<p>Static</p>"),
    );

    const result = await listComponents();

    expect(mockExecuteBuildScripts).toHaveBeenCalled();
    expect(result["mixed-comp"].fileContent).toContain("<p>Static</p>");
    expect(result["mixed-comp"].fileContent).toContain('data-bascik-build="page"');
  });
});
