import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  extractCustomTags,
  checkProject,
  formatFindingsHuman,
  formatFindingsJson,
} from "./check.ts";

const { listPagesMock, listComponentsMock, deepReadDirFlatMock } = vi.hoisted(() => ({
  listPagesMock: vi.fn(),
  listComponentsMock: vi.fn(),
  deepReadDirFlatMock: vi.fn(),
}));

const { userConfigMock, modeOverridesMock } = vi.hoisted(() => ({
  userConfigMock: {} as Record<string, unknown>,
  modeOverridesMock: {} as Record<string, unknown>,
}));

type MutableBascikConfigForTest = {
  directory: typeof BascikConfig.directory;
};

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  // Spread into a fresh, writable object — the module namespace is frozen.
  return {
    BascikConfig: {
      ...original.BascikConfig,
      scoping: {
        ...original.BascikConfig?.scoping,
        preserve: ["code"],
      },
    },
  };
});

vi.mock("./file-system.js", () => ({
  listPages: listPagesMock,
  getRelativePath: (filePath: string) => filePath,
  deepReadDirFlat: deepReadDirFlatMock,
}));

vi.mock("./components.js", () => ({
  listComponents: listComponentsMock,
}));

vi.mock("./userConfig.js", () => ({
  config: userConfigMock,
  modeOverrides: modeOverridesMock,
}));

describe("extractCustomTags", () => {
  it("extracts hyphenated tag names, lowercased", () => {
    const tags = extractCustomTags(
      '<My-Card></My-Card><site-nav /><input type="text"><br>',
    );
    expect([...tags]).toEqual(["my-card", "site-nav"]);
  });

  it("ignores non-hyphenated tags and closing-only matches", () => {
    const tags = extractCustomTags("<div><span>hi</span></div>");
    expect(tags.size).toBe(0);
  });

  it("ignores tags inside HTML comments", () => {
    const tags = extractCustomTags("<!-- <ghost-tag> --><real-tag></real-tag>");
    expect([...tags]).toEqual(["real-tag"]);
  });

  it("ignores tags inside raw-text element content", () => {
    // Script/style/textarea bodies are stripped even when they contain raw
    // markup or `<` characters (JS comparisons, demo strings, etc.).
    const html =
      '<script type="module">const s = "<demo-tag>"; if (a < b) {}</script>' +
      '<style media="all">.x { color: red; }</style>' +
      '<code class="demo">&lt;example-tag&gt;</code>';
    expect(extractCustomTags(html).size).toBe(0);
  });

  it("ignores escaped markup inside skipTranspilingElementContents (code) elements", () => {
    const html =
      '<code class="demo">use &lt;example-tag&gt; here</code><used-tag></used-tag>';
    expect([...extractCustomTags(html)]).toEqual(["used-tag"]);
  });

  it("ignores raw markup inside <code> (strip is not limited to escaped samples)", () => {
    const html =
      '<code class="demo"><example-tag></example-tag></code><used-tag></used-tag>';
    expect([...extractCustomTags(html)]).toEqual(["used-tag"]);
  });
});

describe("checkProject", () => {
  let workDir: string;
  let originalCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalSiteUrl: string | undefined;
  let originalDirectory: typeof BascikConfig.directory;

  const setupProject = async (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(workDir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
  };

  beforeEach(async () => {
    listPagesMock.mockReset();
    listComponentsMock.mockReset();
    deepReadDirFlatMock.mockReset();
    Object.keys(userConfigMock).forEach((key) => delete userConfigMock[key]);
    Object.keys(modeOverridesMock).forEach((key) => delete modeOverridesMock[key]);
    deepReadDirFlatMock.mockResolvedValue([]);
    originalCwd = process.cwd();
    originalSiteUrl = process.env.BASCIK_SITE_URL;
    process.env.BASCIK_SITE_URL = "https://example.com";
    originalDirectory = { ...BascikConfig.directory };
    const mutableConfig = BascikConfig as unknown as MutableBascikConfigForTest;
    mutableConfig.directory = {
      ...BascikConfig.directory,
      pages: "src/pages",
      components: "src/components",
      api: "src/api",
    };
    workDir = join(originalCwd, `.check-test-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    process.chdir(workDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalSiteUrl === undefined) {
      delete process.env.BASCIK_SITE_URL;
    } else {
      process.env.BASCIK_SITE_URL = originalSiteUrl;
    }
    const mutableConfig = BascikConfig as unknown as MutableBascikConfigForTest;
    mutableConfig.directory = originalDirectory;
    await rm(workDir, { recursive: true, force: true });
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns 0 errors when all tags are known components", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card>",
      "components/my-card/my-card.html": "<div>card</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(0);
  });

  it("reports unknown component tags as warnings (not errors)", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card><ghost-tag></ghost-tag>",
      "components/my-card/my-card.html": "<div>card</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(1);
    const item = findings.items.find((i) => i.message.includes("<ghost-tag>"));
    expect(item).toBeDefined();
    expect(item?.severity).toBe("warning");
  });

  it("warns about unused components", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card>",
      "components/my-card/my-card.html": "<div>card</div>",
      "components/lonely-widget/lonely-widget.html": "<div>widget</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
      "lonely-widget": {
        fileName: join(workDir, "components/lonely-widget/lonely-widget.html"),
      },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(1);
    expect(findings.items.some((i) => i.message.includes("lonely-widget"))).toBe(true);
  });

  it("detects component usage inside other component files", async () => {
    await setupProject({
      "pages/index.html": "<outer-comp></outer-comp>",
      "components/outer-comp/outer-comp.html": "<inner-comp></inner-comp>",
      "components/inner-comp/inner-comp.html": "<div>inner</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "outer-comp": {
        fileName: join(workDir, "components/outer-comp/outer-comp.html"),
      },
      "inner-comp": {
        fileName: join(workDir, "components/inner-comp/inner-comp.html"),
      },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(0);
  });

  it("skips unreadable files without failing the whole check", async () => {
    listPagesMock.mockResolvedValue([join(workDir, "pages/missing.html")]);
    listComponentsMock.mockResolvedValue({});

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
  });

  it("records all unknown tags as separate findings", async () => {
    await setupProject({
      "pages/index.html": "<ghost-one></ghost-one><ghost-two></ghost-two>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({});

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(2);
    expect(findings.items.some((i) => i.message.includes("<ghost-one>"))).toBe(true);
    expect(findings.items.some((i) => i.message.includes("<ghost-two>"))).toBe(true);
  });

  it("reports all unused components", async () => {
    await setupProject({
      "pages/index.html": "<p>no components used</p>",
      "components/widget-a/widget-a.html": "<div>a</div>",
      "components/widget-b/widget-b.html": "<div>b</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "widget-a": { fileName: join(workDir, "components/widget-a/widget-a.html") },
      "widget-b": { fileName: join(workDir, "components/widget-b/widget-b.html") },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(2);
    expect(findings.items.some((i) => i.message.includes("widget-a"))).toBe(true);
    expect(findings.items.some((i) => i.message.includes("widget-b"))).toBe(true);
  });

  describe("API Route Validations (Prompt 49)", () => {
    it("reports error when an API route file exports no recognized method handlers", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/invalid.ts": "export const helper = () => {};",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      expect(findings.errors).toBeGreaterThan(0);
      expect(findings.items.some((i) => i.message.includes("no recognized HTTP method handler"))).toBe(true);
    });

    it("reports error when two route files resolve to the same URL", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/users.ts": "export const GET = () => new Response('users');",
        "src/api/users/index.ts": "export const GET = () => new Response('users index');",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      expect(findings.errors).toBeGreaterThan(0);
      expect(findings.items.some((i) => i.category === "route-collision")).toBe(true);
    });

    it("reports warning when an exported name looks like a method but is not uppercase (e.g. Post or get)", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/users.ts": "export const get = () => new Response('users');\nexport const POST = () => new Response('created');",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      expect(findings.errors).toBe(0);
      expect(findings.warnings).toBeGreaterThan(0);
      expect(findings.items.some((i) => i.message.includes('must be uppercase'))).toBe(true);
    });
  });

  describe("Prompt 50 TDD Requirements", () => {
    it("TDD step 1 anchor: unknown tags (<model-viewer>) are warnings not errors, and unused component is detected despite build script", async () => {
      await setupProject({
        "pages/index.html":
          '<model-viewer src="model.gltf"></model-viewer>\n<script data-bascik-build>console.log("build")</script>',
        "components/unused-card/unused-card.html": "<div>unused</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "unused-card": { fileName: join(workDir, "components/unused-card/unused-card.html") },
      });

      const findings = await checkProject();
      // Should have 0 errors and 2 warnings (unmatched model-viewer tag, and unused-card component)
      expect(findings.errors).toBe(0);
      expect(findings.warnings).toBe(2);

      const unmatched = findings.items.find((i) => i.category === "unmatched-tag");
      expect(unmatched).toBeDefined();
      expect(unmatched?.severity).toBe("warning");
      expect(unmatched?.message).toContain("<model-viewer>");

      const unused = findings.items.find((i) => i.category === "unused-component");
      expect(unused).toBeDefined();
      expect(unused?.severity).toBe("warning");
      expect(unused?.message).toContain("unused-card");
    });

    it("checkProject prints nothing directly to console", async () => {
      await setupProject({
        "pages/index.html": "<model-viewer></model-viewer>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      await checkProject();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("groups findings by category with every location and line number", async () => {
      await setupProject({
        "pages/index.html": "<p>line1</p>\n<ion-icon></ion-icon>",
        "pages/gallery.html": "<ion-icon></ion-icon>\n<model-viewer></model-viewer>",
      });
      listPagesMock.mockResolvedValue([
        join(workDir, "pages/index.html"),
        join(workDir, "pages/gallery.html"),
      ]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const ionIcon = findings.items.find((i) => i.message.includes("<ion-icon>"));
      expect(ionIcon?.locations).toHaveLength(2);
      expect(ionIcon?.locations[0].line).toBe(2);
      expect(ionIcon?.locations[1].line).toBe(1);

      const human = formatFindingsHuman(findings);
      expect(human).toContain("Components with no matching file");
      expect(human).toContain("<ion-icon>");
      expect(human).toContain("<model-viewer>");
    });

    it("provides suggestion for near-miss component names but not unrelated names", async () => {
      await setupProject({
        "pages/about.html": "<my-crd></my-crd><xyz-completely-unrelated></xyz-completely-unrelated>",
        "components/my-card/my-card.html": "<div>card</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/about.html")]);
      listComponentsMock.mockResolvedValue({
        "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
      });

      const findings = await checkProject();
      const myCrd = findings.items.find((i) => i.message.includes("<my-crd>"));
      expect(myCrd?.suggestion).toBe("my-card");

      const unrelated = findings.items.find((i) => i.message.includes("<xyz-completely-unrelated>"));
      expect(unrelated?.suggestion).toBeUndefined();

      const human = formatFindingsHuman(findings);
      expect(human).toContain("did you mean <my-card>?");
    });

    it("narrows build-script exemption: suppresses unused warning when component name appears as string literal in build script", async () => {
      await setupProject({
        "pages/index.html":
          '<script data-bascik-build>\n  const comp = "dynamic-card";\n</script>',
        "components/dynamic-card/dynamic-card.html": "<div>dynamic</div>",
        "components/truly-unused/truly-unused.html": "<div>unused</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "dynamic-card": { fileName: join(workDir, "components/dynamic-card/dynamic-card.html") },
        "truly-unused": { fileName: join(workDir, "components/truly-unused/truly-unused.html") },
      });

      const findings = await checkProject();
      const unusedDynamic = findings.items.find((i) => i.message.includes("dynamic-card"));
      expect(unusedDynamic).toBeUndefined();

      const unusedTruly = findings.items.find((i) => i.message.includes("truly-unused"));
      expect(unusedTruly).toBeDefined();
    });

    it("produces documented JSON schema with formatFindingsJson driven by same data", async () => {
      await setupProject({
        "pages/index.html": "<model-viewer></model-viewer>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const jsonStr = formatFindingsJson(findings);
      const parsed = JSON.parse(jsonStr);

      expect(parsed).toMatchObject({
        errors: 0,
        warnings: 1,
        findings: [
          {
            category: "unmatched-tag",
            severity: "warning",
            message: "<model-viewer>",
          },
        ],
      });
      expect(Array.isArray(parsed.findings[0].locations)).toBe(true);
    });
  });

  describe("Prompt 51 Validations", () => {
    it("reports config validation findings from prompt 05", async () => {
      Object.assign(userConfigMock, {
        http: { prt: 8080 },
      });
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const cfg = findings.items.find((i) => i.category === "config-validation");
      expect(cfg).toBeDefined();
      expect(cfg?.severity).toBe("error");
      expect(cfg?.message).toContain("http.prt");
    });

    it("reports missing directory.pages path as config-validation error with actionable message and config location", async () => {
      Object.assign(userConfigMock, {
        directory: { pages: "src/missing-pages" },
      });
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find(
        (i) => i.category === "config-validation" && i.message.includes("directory.pages"),
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain("src/missing-pages");
      expect(item?.message).toContain("does not exist");
      expect(item?.locations).toEqual([{ filePath: "bascik.config.js" }]);
    });

    it("promotes missing site URL to an error when sitemap/robots features are enabled", async () => {
      delete process.env.BASCIK_SITE_URL;
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "missing-site-url");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain("BASCIK_SITE_URL");
    });

    it("warns for unknown data-bascik-* attributes and lists known attributes", async () => {
      await setupProject({
        "pages/index.html": '<div data-bascik-props="x"></div>',
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "unknown-bascik-attribute");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("warning");
      expect(item?.message).toContain("data-bascik-prop-");
    });

    it("only checks actual open-tag attribute names for unknown data-bascik-*", async () => {
      await setupProject({
        "pages/index.html": [
          '<p>literal data-bascik-not-real text should not be treated as an attribute</p>',
          '<div data-bascik-propps="x"></div>',
        ].join("\n"),
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const unknownAttrs = findings.items.filter((i) => i.category === "unknown-bascik-attribute");
      expect(unknownAttrs).toHaveLength(1);
      expect(unknownAttrs[0].message).toContain('"data-bascik-propps"');
      expect(unknownAttrs[0].locations).toEqual([{ filePath: "pages/index.html", line: 2 }]);
    });

    it("reports data-bascik-build + data-bascik-server conflicts as errors", async () => {
      await setupProject({
        "pages/index.html": '<script data-bascik-build data-bascik-server>console.log(1)</script>',
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "script-mode-conflict");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
    });

    it("reports duplicate component names with both file paths", async () => {
      await setupProject({
        "pages/index.html": "<p>ok</p>",
        "src/components/a/card.html": "<div>a</div>",
        "src/components/b/card.html": "<div>b</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockRejectedValue(
        new Error(
          "error: two component files both define the tag <card>\n" +
          `  ${join(workDir, "src/components/a/card.html")}\n` +
          `  ${join(workDir, "src/components/b/card.html")}\n\n` +
          "rename one file",
        ),
      );
      deepReadDirFlatMock.mockResolvedValue([
        join(workDir, "src/components/a/card.html"),
        join(workDir, "src/components/b/card.html"),
      ]);

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "duplicate-component-name");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.locations).toHaveLength(2);
    });

    it("detects indirect circular component references with a full cycle path", async () => {
      await setupProject({
        "pages/index.html": "<a-card></a-card>",
        "components/a-card/a-card.html": "<b-card></b-card>",
        "components/b-card/b-card.html": "<c-card></c-card>",
        "components/c-card/c-card.html": "<a-card></a-card>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "a-card": { fileName: join(workDir, "components/a-card/a-card.html") },
        "b-card": { fileName: join(workDir, "components/b-card/b-card.html") },
        "c-card": { fileName: join(workDir, "components/c-card/c-card.html") },
      });

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "circular-component-reference");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain("<a-card> -> <b-card> -> <c-card> -> <a-card>");
    });

    it("does not count self-reference inside data-bascik-preserve subtree as a cycle", async () => {
      await setupProject({
        "pages/index.html": "<safe-card></safe-card>",
        "components/safe-card/safe-card.html": '<div data-bascik-preserve><safe-card></safe-card></div>',
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "safe-card": { fileName: join(workDir, "components/safe-card/safe-card.html") },
      });

      const findings = await checkProject();
      expect(findings.items.some((i) => i.category === "circular-component-reference")).toBe(false);
    });

    it("does not count component-like tags inside script strings as cycle references", async () => {
      await setupProject({
        "pages/index.html": "<script-card></script-card>",
        "components/script-card/script-card.html": "<script>const x = '<script-card></script-card>';</script>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "script-card": { fileName: join(workDir, "components/script-card/script-card.html") },
      });

      const findings = await checkProject();
      expect(findings.items.some((i) => i.category === "circular-component-reference")).toBe(false);
    });

    it("does not create a false cycle when a page basename matches a component name", async () => {
      await setupProject({
        "pages/safe-card.html": "<safe-card></safe-card>",
        "components/safe-card/safe-card.html": "<div>ok</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/safe-card.html")]);
      listComponentsMock.mockResolvedValue({
        "safe-card": { fileName: join(workDir, "components/safe-card/safe-card.html") },
      });

      const findings = await checkProject();
      expect(findings.items.some((i) => i.category === "circular-component-reference")).toBe(false);
    });

    it("marks watchPaths as warning and exec script path failures as error for severity parity", async () => {
      Object.assign(userConfigMock, {
        pipeline: {
          watchPaths: ["src/missing"],
          exec: [{ script: "scripts/missing.ts" }],
        },
      });
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const cfg = findings.items.filter((i) => i.category === "config-validation");
      expect(cfg.some((i) => i.message.includes("pipeline.watchPaths[0]") && i.severity === "warning")).toBe(true);
      expect(cfg.some((i) => i.message.includes("pipeline.exec[0].script") && i.severity === "error")).toBe(true);
    });

    it("marks inlineStyles missing paths as warning for severity parity", async () => {
      Object.assign(userConfigMock, {
        assets: {
          inlineStyles: ["src/missing.css"],
        },
      });
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const cfg = findings.items.filter((i) => i.category === "config-validation");
      expect(cfg.some((i) => i.message.includes("assets.inlineStyles[0]") && i.severity === "warning")).toBe(true);
    });

    it("marks unreadable TLS key/cert paths as error for severity parity", async () => {
      Object.assign(userConfigMock, {
        http: {
          tls: {
            enabled: true,
            keyFile: "certs/missing.key",
            certFile: "certs/missing.crt",
          },
        },
      });
      await setupProject({ "pages/index.html": "<p>ok</p>" });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const cfg = findings.items.filter((i) => i.category === "config-validation");
      expect(cfg.some((i) => i.message.includes("http.tls.keyFile") && i.severity === "error")).toBe(true);
      expect(cfg.some((i) => i.message.includes("http.tls.certFile") && i.severity === "error")).toBe(true);
    });

    it("uses explicit --config path as finding location when provided", async () => {
      const originalArgv = [...process.argv];
      try {
        process.argv = [
          originalArgv[0],
          originalArgv[1] ?? "pkg/src/index.ts",
          "--check",
          "--config",
          "configs/custom.config.ts",
        ];
        Object.assign(userConfigMock, {
          http: { prt: 8080 },
        });
        await setupProject({
          "pages/index.html": "<p>ok</p>",
          "configs/custom.config.ts": "export default {};",
        });
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});

        const findings = await checkProject();
        const cfg = findings.items.find((i) => i.category === "config-validation");
        expect(cfg).toBeDefined();
        expect(cfg?.locations[0]?.filePath).toBe("configs/custom.config.ts");
      } finally {
        process.argv = originalArgv;
      }
    });

    it("reports directory.pages as an error when it exists but has no html pages", async () => {
      await mkdir(join(workDir, "src/pages"), { recursive: true });
      listPagesMock.mockResolvedValue([]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "pages-directory");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain("has no HTML pages");
    });

    it("reports exact duplicate page route output paths with prompt 30 wording", async () => {
      await setupProject({
        "src/pages/blog/[slug].html": "<script data-bascik-routes>[]</script>",
      });
      listPagesMock.mockResolvedValue([
        join(workDir, "src/pages/blog/first.html"),
        join(workDir, "src/pages/blog/first.html"),
      ]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "duplicate-route-resolution");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain('Duplicate route output path "/blog/first"');
      expect(item?.locations).toEqual([
        { filePath: join(workDir, "src/pages/blog/first.html") },
        { filePath: join(workDir, "src/pages/blog/first.html") },
      ]);
    });

    it("reports case-insensitive duplicate page route output paths with prompt 30 wording", async () => {
      await setupProject({
        "src/pages/blog/First.html": "<p>A</p>",
        "src/pages/blog/first.html": "<p>B</p>",
      });
      listPagesMock.mockResolvedValue([
        join(workDir, "src/pages/blog/First.html"),
        join(workDir, "src/pages/blog/first.html"),
      ]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const item = findings.items.find((i) => i.category === "duplicate-route-resolution");
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain('Case-insensitive route output collision between "/blog/First" and "/blog/first"');
      expect(item?.locations).toEqual([
        { filePath: join(workDir, "src/pages/blog/First.html") },
        { filePath: join(workDir, "src/pages/blog/first.html") },
      ]);
    });

    it("warns when component templates place script before markup and style after markup", async () => {
      await setupProject({
        "pages/index.html": "<ordered-card></ordered-card>",
        "components/ordered-card/ordered-card.html": "<script>1</script><div>Card</div><style>.x{}</style>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "ordered-card": { fileName: join(workDir, "components/ordered-card/ordered-card.html") },
      });

      const findings = await checkProject();
      const ordering = findings.items.filter((i) => i.category === "component-structure-order");
      expect(ordering.length).toBe(2);
      expect(ordering.every((i) => i.severity === "warning")).toBe(true);
    });

    it("does not emit missing-required-prop warnings because the cheap global heuristic is too noisy", async () => {
      await setupProject({
        "pages/index.html": "<card-title></card-title>",
        "components/card-title/card-title.html": "<h2 data-bascik-prop-title></h2>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "card-title": { fileName: join(workDir, "components/card-title/card-title.html") },
      });

      const findings = await checkProject();
      expect(findings.items.some((i) => i.category === "missing-required-prop")).toBe(false);
    });

    it("clean project reports no findings and exits clean in findings model", async () => {
      await setupProject({
        "pages/index.html": "<card-title data-bascik-prop-title=\"Hello\"></card-title>",
        "components/card-title/card-title.html": "<style>.x{color:red}</style><h2 data-bascik-prop-title></h2><script>1</script>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "card-title": { fileName: join(workDir, "components/card-title/card-title.html") },
      });

      const findings = await checkProject();
      expect(findings.errors).toBe(0);
      expect(findings.warnings).toBe(0);
      expect(findings.items).toHaveLength(0);
    });
  });
});
