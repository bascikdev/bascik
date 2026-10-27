import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  extractCustomTags,
  checkProject,
  formatFindingsHuman,
  formatFindingsJson,
  type CheckFindings,
} from "./check.ts";
import type { LanguageServerDiagnostic } from "./check-language-server.ts";
import type { ComponentList } from "./types.ts";

const {
  listPagesMock,
  listComponentsMock,
  deepReadDirFlatMock,
  runLanguageServerCheckMock,
} = vi.hoisted(() => ({
  listPagesMock: vi.fn(),
  listComponentsMock: vi.fn(),
  deepReadDirFlatMock: vi.fn(),
  runLanguageServerCheckMock: vi.fn(),
}));

// These tests are about the project checks. Whether the language server is installed must not change them, so it
// is replaced by a stub that reports it missing, and the cases that want its findings say so.
vi.mock("./check-language-server.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./check-language-server.ts")>()),
  runLanguageServerCheck: runLanguageServerCheckMock,
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
  getProjectPath: (filePath: string) => filePath,
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

  it("blanks content inside tags matching a preserve wildcard", () => {
    const scoping = (BascikConfig as any).scoping;
    const original = scoping.preserve;
    scoping.preserve = ["vendor-*"];
    try {
      // The preserved tag's own open tag is still scanned (same as exact-name
      // preserve today); only its inner content is blanked.
      const html =
        "<vendor-widget><example-tag></example-tag></vendor-widget><used-tag></used-tag>";
      expect([...extractCustomTags(html)]).toEqual([
        "vendor-widget",
        "used-tag",
      ]);
    } finally {
      scoping.preserve = original;
    }
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
    runLanguageServerCheckMock.mockReset();
    runLanguageServerCheckMock.mockResolvedValue({ status: "missing" });
    Object.keys(userConfigMock).forEach((key) => delete userConfigMock[key]);
    Object.keys(modeOverridesMock).forEach(
      (key) => delete modeOverridesMock[key],
    );
    deepReadDirFlatMock.mockResolvedValue([]);
    originalCwd = process.cwd();
    originalSiteUrl = process.env.BASCIK_SITE_URL;
    process.env.BASCIK_SITE_URL = "https://example.com";
    originalDirectory = { ...BascikConfig.directory };
    const mutableConfig = BascikConfig as unknown as MutableBascikConfigForTest;
    mutableConfig.directory = {
      ...BascikConfig.directory,
      pages: "src/pages",
      components: ["src/components"],
      api: "src/api",
    };
    workDir = join(originalCwd, `.check-test-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    process.chdir(workDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(
      findings.items.some((i) => i.message.includes("lonely-widget")),
    ).toBe(true);
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
    expect(findings.items.some((i) => i.message.includes("<ghost-one>"))).toBe(
      true,
    );
    expect(findings.items.some((i) => i.message.includes("<ghost-two>"))).toBe(
      true,
    );
  });

  it("reports all unused components", async () => {
    await setupProject({
      "pages/index.html": "<p>no components used</p>",
      "components/widget-a/widget-a.html": "<div>a</div>",
      "components/widget-b/widget-b.html": "<div>b</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "widget-a": {
        fileName: join(workDir, "components/widget-a/widget-a.html"),
      },
      "widget-b": {
        fileName: join(workDir, "components/widget-b/widget-b.html"),
      },
    });

    const findings = await checkProject();
    expect(findings.errors).toBe(0);
    expect(findings.warnings).toBe(2);
    expect(findings.items.some((i) => i.message.includes("widget-a"))).toBe(
      true,
    );
    expect(findings.items.some((i) => i.message.includes("widget-b"))).toBe(
      true,
    );
  });

  describe("API route table validations (Prompt 49)", () => {
    it("reports error when two route files resolve to the same URL", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/users.ts": "export const GET = () => new Response('users');",
        "src/api/users/index.ts":
          "export const GET = () => new Response('users index');",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      expect(findings.errors).toBeGreaterThan(0);
      expect(findings.items.some((i) => i.category === "route-collision")).toBe(
        true,
      );
    });

    it("reports ambiguous catch-all pairs as route-collision and malformed catch-alls as invalid-catch-all", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/[...a].ts": "export const GET = () => new Response('a');",
        "src/api/[...b].ts": "export const GET = () => new Response('b');",
        "src/api/bad/[...x]/y.ts":
          "export const GET = () => new Response('y');",
        "src/api/ok/[...rest].ts":
          "export const GET = () => new Response('ok');",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const collisions = findings.items.filter(
        (i) => i.category === "route-collision",
      );
      expect(collisions).toHaveLength(1);
      expect(collisions[0].message).toContain("Ambiguous");
      expect(collisions[0].locations).toHaveLength(2);
      const invalid = findings.items.filter(
        (i) => i.category === "invalid-catch-all",
      );
      expect(invalid).toHaveLength(1);
      expect(invalid[0].message).toContain("must be the last segment");
    });

    it("does not judge what a single route file exports: that is the language server's per-file check", async () => {
      await setupProject({
        "pages/index.html": "<p>hello</p>",
        "src/api/invalid.ts": "export const helper = () => {};",
        "src/api/users.ts": "export const get = () => new Response('users');",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      expect(findings.items).toEqual([]);
    });
  });

  describe("Prompt 50 TDD Requirements", () => {
    it("TDD step 1 anchor: unknown tags (<model-viewer>) are warnings not errors, and unused component is detected despite build script", async () => {
      await setupProject({
        "pages/index.html":
          '<model-viewer src="model.gltf"></model-viewer>\n<script data-bascik-build>export default () => "build";</script>',
        "components/unused-card/unused-card.html": "<div>unused</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "unused-card": {
          fileName: join(workDir, "components/unused-card/unused-card.html"),
        },
      });

      const findings = await checkProject();
      // Should have 0 errors and 2 warnings (unmatched model-viewer tag, and unused-card component)
      expect(findings.errors).toBe(0);
      expect(findings.warnings).toBe(2);

      const unmatched = findings.items.find(
        (i) => i.category === "unmatched-tag",
      );
      expect(unmatched).toBeDefined();
      expect(unmatched?.severity).toBe("warning");
      expect(unmatched?.message).toContain("<model-viewer>");

      const unused = findings.items.find(
        (i) => i.category === "unused-component",
      );
      expect(unused).toBeDefined();
      expect(unused?.severity).toBe("warning");
      expect(unused?.message).toContain("unused-card");
    });

    it("omits tags declared in components.external from unmatched-tag findings, exact and wildcard", async () => {
      await setupProject({
        "pages/index.html":
          "<heading-anchors><h2>x</h2></heading-anchors><vendor-chart></vendor-chart><my-typo></my-typo>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({});
      const original = (BascikConfig as any).components;
      (BascikConfig as any).components = {
        external: ["heading-anchors", "vendor-*"],
      };
      try {
        const findings = await checkProject();
        const unmatched = findings.items.filter(
          (i) => i.category === "unmatched-tag",
        );
        expect(unmatched.map((i) => i.message)).toEqual(["<my-typo>"]);
      } finally {
        (BascikConfig as any).components = original;
      }
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
        "pages/gallery.html":
          "<ion-icon></ion-icon>\n<model-viewer></model-viewer>",
      });
      listPagesMock.mockResolvedValue([
        join(workDir, "pages/index.html"),
        join(workDir, "pages/gallery.html"),
      ]);
      listComponentsMock.mockResolvedValue({});

      const findings = await checkProject();
      const ionIcon = findings.items.find((i) =>
        i.message.includes("<ion-icon>"),
      );
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
        "pages/about.html":
          "<my-crd></my-crd><xyz-completely-unrelated></xyz-completely-unrelated>",
        "components/my-card/my-card.html": "<div>card</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/about.html")]);
      listComponentsMock.mockResolvedValue({
        "my-card": {
          fileName: join(workDir, "components/my-card/my-card.html"),
        },
      });

      const findings = await checkProject();
      const myCrd = findings.items.find((i) => i.message.includes("<my-crd>"));
      expect(myCrd?.suggestion).toBe("my-card");

      const unrelated = findings.items.find((i) =>
        i.message.includes("<xyz-completely-unrelated>"),
      );
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
        "dynamic-card": {
          fileName: join(workDir, "components/dynamic-card/dynamic-card.html"),
        },
        "truly-unused": {
          fileName: join(workDir, "components/truly-unused/truly-unused.html"),
        },
      });

      const findings = await checkProject();
      const unusedDynamic = findings.items.find((i) =>
        i.message.includes("dynamic-card"),
      );
      expect(unusedDynamic).toBeUndefined();

      const unusedTruly = findings.items.find((i) =>
        i.message.includes("truly-unused"),
      );
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
      const cfg = findings.items.find(
        (i) => i.category === "config-validation",
      );
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
        (i) =>
          i.category === "config-validation" &&
          i.message.includes("directory.pages"),
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
      const item = findings.items.find(
        (i) => i.category === "missing-site-url",
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain("BASCIK_SITE_URL");
    });

    it("still finds a component named only in a build script after a quoted > on the tag", async () => {
      await setupProject({
        "pages/index.html":
          '<script data-note="x > y" data-bascik-build>\n  const comp = "dynamic-card";\n</script>',
        "components/dynamic-card/dynamic-card.html": "<div>dynamic</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "dynamic-card": {
          fileName: join(workDir, "components/dynamic-card/dynamic-card.html"),
        },
      });

      const findings = await checkProject();
      expect(
        findings.items.find((i) => i.message.includes("dynamic-card")),
      ).toBeUndefined();
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
      const item = findings.items.find(
        (i) => i.category === "duplicate-component-name",
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.locations).toHaveLength(2);
    });

    it("falls back to scanning every configured component root, so <local-card> in a second root is known", async () => {
      await setupProject({
        "pages/index.html":
          "<hello-card></hello-card><local-card></local-card>",
        "shared/components/hello-card.html": "<div>shared</div>",
        "shared/components/dupe-card.html": "<div>a</div>",
        "src/components/local-card.html": "<div>local</div>",
        "src/components/dupe-card.html": "<div>b</div>",
      });
      const mutableConfig =
        BascikConfig as unknown as MutableBascikConfigForTest;
      mutableConfig.directory = {
        ...BascikConfig.directory,
        components: [
          join(workDir, "shared/components"),
          join(workDir, "src/components"),
        ],
      };
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      // listComponents fails on the cross-root duplicate; --check must still
      // discover every other component in every root.
      listComponentsMock.mockRejectedValue(
        new Error(
          "error: two component files both define the tag <dupe-card>\n" +
            `  ${join(workDir, "shared/components/dupe-card.html")}\n` +
            `  ${join(workDir, "src/components/dupe-card.html")}\n\n` +
            "rename one file",
        ),
      );
      deepReadDirFlatMock.mockImplementation(async (dir: string) =>
        dir.replace(/\\/g, "/").endsWith("shared/components")
          ? [
              join(workDir, "shared/components/hello-card.html"),
              join(workDir, "shared/components/dupe-card.html"),
            ]
          : [
              join(workDir, "src/components/local-card.html"),
              join(workDir, "src/components/dupe-card.html"),
            ],
      );

      const findings = await checkProject();
      expect(deepReadDirFlatMock).toHaveBeenCalledTimes(2);
      const unknown = findings.items.filter(
        (i) => i.category === "unmatched-tag",
      );
      expect(unknown.map((i) => i.message)).toEqual([]);
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
      const item = findings.items.find(
        (i) => i.category === "circular-component-reference",
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain(
        "<a-card> -> <b-card> -> <c-card> -> <a-card>",
      );
    });

    it("does not count self-reference inside data-bascik-preserve subtree as a cycle", async () => {
      await setupProject({
        "pages/index.html": "<safe-card></safe-card>",
        "components/safe-card/safe-card.html":
          "<div data-bascik-preserve><safe-card></safe-card></div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "safe-card": {
          fileName: join(workDir, "components/safe-card/safe-card.html"),
        },
      });

      const findings = await checkProject();
      expect(
        findings.items.some(
          (i) => i.category === "circular-component-reference",
        ),
      ).toBe(false);
    });

    it("does not count component-like tags inside script strings as cycle references", async () => {
      await setupProject({
        "pages/index.html": "<script-card></script-card>",
        "components/script-card/script-card.html":
          "<script>const x = '<script-card></script-card>';</script>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "script-card": {
          fileName: join(workDir, "components/script-card/script-card.html"),
        },
      });

      const findings = await checkProject();
      expect(
        findings.items.some(
          (i) => i.category === "circular-component-reference",
        ),
      ).toBe(false);
    });

    it("does not create a false cycle when a page basename matches a component name", async () => {
      await setupProject({
        "pages/safe-card.html": "<safe-card></safe-card>",
        "components/safe-card/safe-card.html": "<div>ok</div>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/safe-card.html")]);
      listComponentsMock.mockResolvedValue({
        "safe-card": {
          fileName: join(workDir, "components/safe-card/safe-card.html"),
        },
      });

      const findings = await checkProject();
      expect(
        findings.items.some(
          (i) => i.category === "circular-component-reference",
        ),
      ).toBe(false);
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
      const cfg = findings.items.filter(
        (i) => i.category === "config-validation",
      );
      expect(
        cfg.some(
          (i) =>
            i.message.includes("pipeline.watchPaths[0]") &&
            i.severity === "warning",
        ),
      ).toBe(true);
      expect(
        cfg.some(
          (i) =>
            i.message.includes("pipeline.exec[0].script") &&
            i.severity === "error",
        ),
      ).toBe(true);
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
      const cfg = findings.items.filter(
        (i) => i.category === "config-validation",
      );
      expect(
        cfg.some(
          (i) =>
            i.message.includes("assets.inlineStyles[0]") &&
            i.severity === "warning",
        ),
      ).toBe(true);
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
      const cfg = findings.items.filter(
        (i) => i.category === "config-validation",
      );
      expect(
        cfg.some(
          (i) =>
            i.message.includes("http.tls.keyFile") && i.severity === "error",
        ),
      ).toBe(true);
      expect(
        cfg.some(
          (i) =>
            i.message.includes("http.tls.certFile") && i.severity === "error",
        ),
      ).toBe(true);
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
        const cfg = findings.items.find(
          (i) => i.category === "config-validation",
        );
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
      const item = findings.items.find(
        (i) => i.category === "duplicate-route-resolution",
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain(
        'Duplicate route output path "/blog/first"',
      );
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
      const item = findings.items.find(
        (i) => i.category === "duplicate-route-resolution",
      );
      expect(item).toBeDefined();
      expect(item?.severity).toBe("error");
      expect(item?.message).toContain(
        'Case-insensitive route output collision between "/blog/First" and "/blog/first"',
      );
      expect(item?.locations).toEqual([
        { filePath: join(workDir, "src/pages/blog/First.html") },
        { filePath: join(workDir, "src/pages/blog/first.html") },
      ]);
    });

    it("does not emit missing-required-prop warnings because the cheap global heuristic is too noisy", async () => {
      await setupProject({
        "pages/index.html": "<card-title></card-title>",
        "components/card-title/card-title.html":
          "<h2 data-bascik-prop-title></h2>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "card-title": {
          fileName: join(workDir, "components/card-title/card-title.html"),
        },
      });

      const findings = await checkProject();
      expect(
        findings.items.some((i) => i.category === "missing-required-prop"),
      ).toBe(false);
    });

    it("clean project reports no findings and exits clean in findings model", async () => {
      await setupProject({
        "pages/index.html":
          '<card-title data-bascik-prop-title="Hello"></card-title>',
        "components/card-title/card-title.html":
          "<style>.x{color:red}</style><h2 data-bascik-prop-title></h2><script>1</script>",
      });
      listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
      listComponentsMock.mockResolvedValue({
        "card-title": {
          fileName: join(workDir, "components/card-title/card-title.html"),
        },
      });

      const findings = await checkProject();
      expect(findings.errors).toBe(0);
      expect(findings.warnings).toBe(0);
      expect(findings.items).toHaveLength(0);
    });

    describe("dist/ HTML spec validation", () => {
      // Each test explicitly sets BascikConfig.directory.out to ensure the
      // dist path matches the workDir, regardless of prior test mutations.
      const setDistOut = (dir: string) => {
        const mutableConfig =
          BascikConfig as unknown as MutableBascikConfigForTest;
        mutableConfig.directory = { ...BascikConfig.directory, out: dir };
      };

      it("sets distHtmlSpecHintNeeded when dist/ exists but parse5 is not installed", async () => {
        setDistOut(join(workDir, "dist"));
        await setupProject({
          "pages/index.html": "<p>ok</p>",
          "dist/index.html":
            "<!DOCTYPE html><html><body><p>ok</p></body></html>",
        });
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});

        // parse5 may or may not be installed in the test environment.
        // This test only verifies the contract: when parse5 IS available,
        // distHtmlChecked is a number; when it is not, distHtmlSpecHintNeeded
        // is true. We cannot force-uninstall parse5 in a unit test, so we
        // assert the invariant that the two flags are mutually exclusive.
        const findings = await checkProject();
        const exactlyOne =
          (findings.distHtmlChecked !== null) !==
          findings.distHtmlSpecHintNeeded;
        expect(
          exactlyOne,
          "distHtmlChecked and distHtmlSpecHintNeeded must be mutually exclusive",
        ).toBe(true);
      });

      it("reports dist-html-spec errors for malformed dist HTML when parse5 is available", async () => {
        // Skip when parse5 is not installed — the unit test cannot install it.
        let parse5Available = false;
        try {
          await import("parse5");
          parse5Available = true;
        } catch {
          /* not installed */
        }
        if (!parse5Available) return;

        setDistOut(join(workDir, "dist"));
        // A script that consumed head elements is the exact corruption pattern
        // from the bug this feature was written to catch.
        const corruptHtml =
          "<!DOCTYPE html><html><head>" +
          "<script>(function(){below is a runtime script;-->" +
          '<meta charset="UTF-8"/></head><body><p>ok</p></body></html>';

        await setupProject({
          "pages/index.html": "<p>ok</p>",
          "dist/index.html": corruptHtml,
        });
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});

        const findings = await checkProject();
        const specErrors = findings.items.filter(
          (i) => i.category === "dist-html-spec",
        );
        expect(specErrors.length).toBeGreaterThan(0);
        expect(specErrors[0].severity).toBe("error");
        expect(specErrors[0].message).toMatch(/^\[.+\]$/); // e.g. [eof-in-element-that-can-contain-only-text]
        expect(findings.errors).toBeGreaterThan(0);
      });

      it("sets distHtmlChecked to file count when parse5 validates dist HTML cleanly", async () => {
        let parse5Available = false;
        try {
          await import("parse5");
          parse5Available = true;
        } catch {
          /* not installed */
        }
        if (!parse5Available) return;

        setDistOut(join(workDir, "dist"));
        await setupProject({
          "pages/index.html": "<p>ok</p>",
          "dist/index.html":
            "<!DOCTYPE html><html><body><p>ok</p></body></html>",
          "dist/about.html":
            "<!DOCTYPE html><html><body><h1>About</h1></body></html>",
        });
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});

        const findings = await checkProject();
        expect(findings.distHtmlChecked).toBe(2);
        expect(findings.distHtmlSpecHintNeeded).toBe(false);
        expect(
          findings.items.some((i) => i.category === "dist-html-spec"),
        ).toBe(false);
      });

      it("sets distHtmlChecked to null and distHtmlSpecHintNeeded to false when dist/ does not exist", async () => {
        setDistOut(join(workDir, "dist"));
        await setupProject({ "pages/index.html": "<p>ok</p>" });
        // No dist/ directory created.
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});

        const findings = await checkProject();
        expect(findings.distHtmlChecked).toBeNull();
        expect(findings.distHtmlSpecHintNeeded).toBe(false);
      });
    });

    describe("per-file checks from the language server", () => {
      const diagnostic = (
        overrides: Partial<LanguageServerDiagnostic> = {},
      ): LanguageServerDiagnostic => ({
        filePath: "src/components/my-form.html",
        line: 3,
        column: 5,
        severity: "error",
        code: "css-id-attribute-selector",
        message: "[id] attribute selectors cannot be scoped.",
        ...overrides,
      });
      const ran = (
        diagnostics: LanguageServerDiagnostic[],
        extra: Record<string, unknown> = {},
      ) => ({
        status: "ran" as const,
        filesChecked: 7,
        fixedFiles: [] as string[],
        diagnostics,
        formatDiagnostic: (d: LanguageServerDiagnostic) =>
          `${d.filePath}:${d.line}:${d.column} ${d.code}`,
        ...extra,
      });

      beforeEach(async () => {
        await setupProject({ "pages/index.html": "<p>ok</p>" });
        listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
        listComponentsMock.mockResolvedValue({});
      });

      it("merges the language server's findings, keeping its rule id, position, and severity", async () => {
        runLanguageServerCheckMock.mockResolvedValue(
          ran([
            diagnostic(),
            diagnostic({
              severity: "warning",
              code: "unknown-bascik-attribute",
              line: 9,
            }),
          ]),
        );

        const findings = await checkProject();
        expect(findings.items.map((i) => i.category)).toEqual([
          "css-id-attribute-selector",
          "unknown-bascik-attribute",
        ]);
        expect(
          findings.items.every((i) => i.source === "language-server"),
        ).toBe(true);
        expect(findings.items[0].locations).toEqual([
          { filePath: "src/components/my-form.html", line: 3, column: 5 },
        ]);
        expect(findings.errors).toBe(1);
        expect(findings.warnings).toBe(1);
        expect(findings.perFileChecked).toBe(7);
        expect(findings.perFileHint).toBeUndefined();
      });

      it("labels a finding with no rule id so it is still grouped and attributed", async () => {
        runLanguageServerCheckMock.mockResolvedValue(
          ran([diagnostic({ code: undefined })]),
        );
        expect((await checkProject()).items[0].category).toBe(
          "language-server",
        );
      });

      it("keeps project findings and per-file findings apart, so neither duplicates the other", async () => {
        await setupProject({ "pages/index.html": "<ghost-tag></ghost-tag>" });
        runLanguageServerCheckMock.mockResolvedValue(ran([diagnostic()]));

        const findings = await checkProject();
        expect(
          findings.items
            .filter((i) => i.source === undefined)
            .map((i) => i.category),
        ).toEqual(["unmatched-tag"]);
        expect(
          findings.items.filter((i) => i.source === "language-server"),
        ).toHaveLength(1);
      });

      it("hands the language server the fix flag, and reports the files it rewrote", async () => {
        runLanguageServerCheckMock.mockResolvedValue(
          ran([], { fixedFiles: ["src/pages/a.html"] }),
        );

        const findings = await checkProject({ fix: true });
        expect(runLanguageServerCheckMock).toHaveBeenCalledWith({ fix: true });
        expect(findings.fixedFiles).toEqual(["src/pages/a.html"]);
      });

      it("does not run --fix itself: with no language server it fails loudly instead of reporting nothing fixed", async () => {
        runLanguageServerCheckMock.mockResolvedValue({ status: "missing" });
        await expect(checkProject({ fix: true })).rejects.toThrow(
          "--fix needs @bascik/language-server to apply fixes",
        );
        await expect(checkProject({ fix: true })).rejects.toThrow(
          "npm install --save-dev @bascik/language-server",
        );
        runLanguageServerCheckMock.mockResolvedValue({ status: "outdated" });
        await expect(checkProject({ fix: true })).rejects.toThrow(
          "needs a newer @bascik/language-server",
        );
      });

      it("still runs the project checks and says what was skipped when the language server is not installed", async () => {
        runLanguageServerCheckMock.mockResolvedValue({ status: "missing" });

        const findings = await checkProject();
        expect(findings.errors).toBe(0);
        expect(findings.perFileChecked).toBeNull();
        expect(findings.perFileHint).toContain("per-file checks skipped");
        expect(findings.perFileHint).toContain(
          "npm install --save-dev @bascik/language-server",
        );
      });

      it("says to update when the installed language server is too old", async () => {
        runLanguageServerCheckMock.mockResolvedValue({ status: "outdated" });
        expect((await checkProject()).perFileHint).toContain("too old");
      });
    });
  });
});

// ─── formatFindingsHuman ──────────────────────────────────────────────────────

describe("formatFindingsHuman — dist/ lines", () => {
  const base = (): CheckFindings => ({
    errors: 0,
    warnings: 0,
    pagesChecked: 5,
    componentsChecked: 3,
    items: [],
    distHtmlChecked: null,
    distHtmlSpecHintNeeded: false,
    perFileChecked: null,
    fixedFiles: [],
  });

  it("shows no dist note when dist was not checked", () => {
    const out = formatFindingsHuman(base());
    expect(out).not.toContain("dist/");
    expect(out).not.toContain("parse5");
  });

  it("appends parse5 install hint when distHtmlSpecHintNeeded is true (clean pass)", () => {
    const out = formatFindingsHuman({
      ...base(),
      distHtmlSpecHintNeeded: true,
    });
    expect(out).toContain("ℹ");
    expect(out).toContain("dist/ HTML not validated");
    expect(out).toContain("install parse5");
  });

  it("appends parse5 install hint in the summary when there are also errors", () => {
    const findings: CheckFindings = {
      ...base(),
      errors: 1,
      distHtmlSpecHintNeeded: true,
      items: [
        {
          category: "unused-component",
          severity: "error",
          message: "old-card",
          locations: [{ filePath: "src/components/old-card/old-card.html" }],
        },
      ],
    };
    const out = formatFindingsHuman(findings);
    expect(out).toContain("install parse5");
  });

  it("shows passing dist line when distHtmlChecked > 0, no errors", () => {
    const out = formatFindingsHuman({ ...base(), distHtmlChecked: 12 });
    expect(out).toContain("✓ 12 dist/ HTML files pass WHATWG spec (parse5)");
    expect(out).not.toContain("install parse5");
  });

  it("uses singular form when distHtmlChecked === 1", () => {
    const out = formatFindingsHuman({ ...base(), distHtmlChecked: 1 });
    expect(out).toContain("✓ 1 dist/ HTML file pass");
  });

  it("shows passing dist note alongside errors in the summary", () => {
    const findings: CheckFindings = {
      ...base(),
      errors: 1,
      distHtmlChecked: 8,
      items: [
        {
          category: "unused-component",
          severity: "error",
          message: "old-card",
          locations: [{ filePath: "src/components/old-card/old-card.html" }],
        },
      ],
    };
    const out = formatFindingsHuman(findings);
    expect(out).toContain("✓ 8 dist/ HTML files pass WHATWG spec (parse5)");
  });

  it("renders dist-html-spec findings with file:line and error code", () => {
    const findings: CheckFindings = {
      ...base(),
      errors: 1,
      distHtmlChecked: 3,
      items: [
        {
          category: "dist-html-spec",
          severity: "error",
          message: "[eof-in-element-that-can-contain-only-text]",
          locations: [{ filePath: "index.html", line: 43 }],
        },
      ],
    };
    const out = formatFindingsHuman(findings);
    expect(out).toContain("dist/ HTML spec violations");
    expect(out).toContain("eof-in-element-that-can-contain-only-text");
    expect(out).toContain("index.html:43");
  });
});

// ─── formatFindingsJson ───────────────────────────────────────────────────────

describe("formatFindingsJson — dist/ fields", () => {
  const base = (): CheckFindings => ({
    errors: 0,
    warnings: 0,
    pagesChecked: 5,
    componentsChecked: 3,
    items: [],
    distHtmlChecked: null,
    distHtmlSpecHintNeeded: false,
    perFileChecked: null,
    fixedFiles: [],
  });

  it("includes distHtmlChecked and distHtmlSpecHintNeeded at the top level", () => {
    const json = JSON.parse(
      formatFindingsJson({ ...base(), distHtmlChecked: 10 }),
    );
    expect(json.distHtmlChecked).toBe(10);
    expect(json.distHtmlSpecHintNeeded).toBe(false);
  });

  it("serializes null distHtmlChecked when dist was not scanned", () => {
    const json = JSON.parse(formatFindingsJson(base()));
    expect(json.distHtmlChecked).toBeNull();
  });

  it("serializes distHtmlSpecHintNeeded: true when parse5 absent", () => {
    const json = JSON.parse(
      formatFindingsJson({ ...base(), distHtmlSpecHintNeeded: true }),
    );
    expect(json.distHtmlSpecHintNeeded).toBe(true);
    expect(json.distHtmlChecked).toBeNull();
  });

  it("includes dist-html-spec errors in the findings array", () => {
    const findings: CheckFindings = {
      ...base(),
      errors: 1,
      distHtmlChecked: 3,
      items: [
        {
          category: "dist-html-spec",
          severity: "error",
          message: "[eof-in-element-that-can-contain-only-text]",
          locations: [{ filePath: "index.html", line: 43 }],
        },
      ],
    };
    const json = JSON.parse(formatFindingsJson(findings));
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].category).toBe("dist-html-spec");
    expect(json.findings[0].locations[0].line).toBe(43);
  });
});

describe("formatFindingsHuman — per-file section and skipped checks", () => {
  const base = (): CheckFindings => ({
    errors: 0,
    warnings: 0,
    pagesChecked: 5,
    componentsChecked: 3,
    items: [],
    distHtmlChecked: null,
    distHtmlSpecHintNeeded: false,
    perFileChecked: null,
    fixedFiles: [],
  });
  const perFileItem = (
    overrides: Partial<CheckFindings["items"][number]> = {},
  ): CheckFindings["items"][number] => ({
    category: "unknown-bascik-attribute",
    severity: "warning",
    message: "Unknown attribute.",
    locations: [{ filePath: "src/pages/b.html", line: 4, column: 2 }],
    source: "language-server",
    ...overrides,
  });

  it("lists per-file findings by file and position under their own heading, apart from project findings", () => {
    const findings: CheckFindings = {
      ...base(),
      warnings: 3,
      perFileChecked: 12,
      items: [
        perFileItem(),
        perFileItem({
          locations: [{ filePath: "src/pages/a.html", line: 9, column: 1 }],
          category: "css-id-attribute-selector",
        }),
        {
          category: "unused-component",
          severity: "warning",
          message: "old-card",
          locations: [{ filePath: "old-card.html" }],
        },
      ],
    };
    const out = formatFindingsHuman(findings);
    expect(out).toContain("Unused components (1)");
    expect(out).toContain("Per-file checks (2)");
    expect(out).toContain("npx bascik-language-server --check");
    expect(out.indexOf("src/pages/a.html:9:1")).toBeLessThan(
      out.indexOf("src/pages/b.html:4:2"),
    );
    expect(out).toContain("(css-id-attribute-selector)");
    expect(out).toContain("✓ 12 files checked by @bascik/language-server");
  });

  it("uses the language server's own formatter when it provides one", () => {
    const findings: CheckFindings = {
      ...base(),
      warnings: 1,
      perFileChecked: 1,
      items: [perFileItem()],
      perFileFormat: (d) => `custom ${d.filePath} ${d.code}`,
    };
    expect(formatFindingsHuman(findings)).toContain(
      "  custom src/pages/b.html unknown-bascik-attribute",
    );
  });

  it("says what was skipped, on a clean project and on one with findings", () => {
    const hint =
      "per-file checks skipped: install @bascik/language-server to run them";
    expect(formatFindingsHuman({ ...base(), perFileHint: hint })).toContain(
      `ℹ  ${hint}`,
    );
    const withFinding: CheckFindings = {
      ...base(),
      warnings: 1,
      perFileHint: hint,
      items: [
        {
          category: "unused-component",
          severity: "warning",
          message: "x",
          locations: [{ filePath: "x.html" }],
        },
      ],
    };
    expect(formatFindingsHuman(withFinding)).toContain(`ℹ  ${hint}`);
  });

  it("reports the files --fix rewrote", () => {
    expect(
      formatFindingsHuman({
        ...base(),
        perFileChecked: 4,
        fixedFiles: ["src/pages/a.html", "src/pages/b.html"],
      }),
    ).toContain("✓ fixed 2 files: src/pages/a.html, src/pages/b.html");
  });

  it("serializes the per-file fields and marks each per-file finding's source", () => {
    const json = JSON.parse(
      formatFindingsJson({
        ...base(),
        perFileChecked: 3,
        fixedFiles: ["a.html"],
        perFileHint: undefined,
        items: [perFileItem()],
      }),
    );
    expect(json.perFileChecked).toBe(3);
    expect(json.perFileHintNeeded).toBe(false);
    expect(json.fixedFiles).toEqual(["a.html"]);
    expect(json.findings[0].source).toBe("language-server");
    expect(json.findings[0].locations[0].column).toBe(2);

    const skipped = JSON.parse(
      formatFindingsJson({ ...base(), perFileHint: "per-file checks skipped" }),
    );
    expect(skipped.perFileChecked).toBeNull();
    expect(skipped.perFileHintNeeded).toBe(true);
  });
});

/**
 * Prompt 157 (D7): `bascik --check` reports the components a server or
 * stream script cannot return (left unexpanded at request time) with the
 * reason and the file, whenever the built sidecar has page-owned entries; with
 * `generate.cspHashes` on it also names the components whose request-time
 * output cannot satisfy a hash-only policy. A project without server scripts
 * gets neither.
 */
describe("checkProject – request-time component rendering (prompt 157)", () => {
  let workDir: string;
  let originalCwd: string;
  let originalDirectory: typeof BascikConfig.directory;
  let originalGenerate: Record<string, unknown>;
  let originalSiteUrl: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const components = (dir: string) => ({
    "bad-card": {
      fileName: join(dir, "src/components/bad-card/bad-card.html"),
      fileContent:
        '<div class="w"><span data-bascik-attr-class="variant">x</span></div>',
      cssFileContent: ".w { color: red }",
    },
    "id-script-card": {
      fileName: join(dir, "src/components/id-script-card/id-script-card.html"),
      fileContent:
        '<div id="root" class="w"><script>document.getElementById("root").hidden = false;</script></div>',
      cssFileContent: ".w { color: red }",
    },
    "plain-card": {
      fileName: join(dir, "src/components/plain-card/plain-card.html"),
      fileContent:
        '<div class="w"><script>document.querySelector(".w").hidden = false;</script></div>',
      cssFileContent: ".w { color: red }",
    },
  });

  const writeDist = async (
    files: Record<string, string>,
    options: { pageEntries: boolean; manifest: boolean },
    list: ComponentList = components(workDir),
  ) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(workDir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    const distDir = join(workDir, "dist");
    await mkdir(join(distDir, ".bascik"), { recursive: true });
    // A doctype keeps the dist/ HTML spec check (parse5) out of the count.
    await writeFile(
      join(distDir, "index.html"),
      options.pageEntries
        ? '<!doctype html><p>a</p><script type="text/bascik-server" data-bascik-server-id="s1"></script>'
        : "<!doctype html><p>a</p>",
    );
    await writeFile(
      join(distDir, ".bascik", "server-scripts.json"),
      JSON.stringify({
        version: "1",
        schema: 3,
        scripts: options.pageEntries
          ? {
              s1: {
                id: "s1",
                mode: "server",
                source: "export default () => 'x';",
              },
            }
          : {},
      }),
    );
    if (options.manifest) {
      // The manifest a build of these components writes: the same builder
      // and writer, so the report reads exactly what `bascik --build` leaves.
      const { buildComponentManifest, writeComponentManifest } =
        await import("./component-manifest.ts");
      const manifest = await buildComponentManifest(list, BascikConfig);
      await writeComponentManifest(distDir, manifest);
    }
  };

  beforeEach(async () => {
    listPagesMock.mockReset();
    listComponentsMock.mockReset();
    deepReadDirFlatMock.mockReset();
    runLanguageServerCheckMock.mockReset();
    runLanguageServerCheckMock.mockResolvedValue({ status: "missing" });
    deepReadDirFlatMock.mockResolvedValue([]);
    Object.keys(userConfigMock).forEach((key) => delete userConfigMock[key]);
    Object.keys(modeOverridesMock).forEach(
      (key) => delete modeOverridesMock[key],
    );
    originalCwd = process.cwd();
    originalSiteUrl = process.env.BASCIK_SITE_URL;
    process.env.BASCIK_SITE_URL = "https://example.com";
    originalDirectory = { ...BascikConfig.directory };
    originalGenerate = { ...(BascikConfig as any).generate };
    workDir = join(originalCwd, `.check-rtc-test-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    process.chdir(workDir);
    const mutableConfig = BascikConfig as unknown as MutableBascikConfigForTest;
    mutableConfig.directory = {
      ...BascikConfig.directory,
      pages: "src/pages",
      // Absolute, as normalizeComponentRoots leaves them in a real run: the
      // report's display paths (`components/...`) depend on it.
      components: [join(workDir, "src/components")],
      api: "src/api",
      out: join(workDir, "dist"),
    };
    (BascikConfig as any).generate = { ...originalGenerate, cspHashes: false };
    listPagesMock.mockResolvedValue([join(workDir, "src/pages/index.html")]);
    listComponentsMock.mockResolvedValue(components(workDir));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalSiteUrl === undefined) delete process.env.BASCIK_SITE_URL;
    else process.env.BASCIK_SITE_URL = originalSiteUrl;
    const mutableConfig = BascikConfig as unknown as MutableBascikConfigForTest;
    mutableConfig.directory = originalDirectory;
    (BascikConfig as any).generate = originalGenerate;
    await rm(workDir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const sources = (dir: string): Record<string, string> => ({
    "src/pages/index.html":
      "<bad-card></bad-card><id-script-card></id-script-card><plain-card></plain-card>" +
      "<script data-bascik-server>export default () => 'x';</script>",
    ...Object.fromEntries(
      Object.entries(components(dir)).map(([name, component]) => [
        `src/components/${name}/${name}.html`,
        component.fileContent,
      ]),
    ),
  });

  it("lists each unsupported component with its reason and file when the sidecar has page entries", async () => {
    await writeDist(sources(workDir), { pageEntries: true, manifest: true });

    const findings = await checkProject();

    const unsupported = findings.items.filter(
      (item) => item.category === "request-render-unsupported",
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].severity).toBe("warning");
    expect(unsupported[0].message).toContain("bad-card");
    expect(unsupported[0].message).toContain(
      "attr-binding-to-scoped-attribute",
    );
    // The manifest's detail follows the reason, so the line says what to
    // change; the location carries the binding's line and the file in the
    // form the rest of the report uses (toDisplay; pinned against the
    // neighboring section below, since this file mocks getRelativePath).
    expect(unsupported[0].message).toContain(
      "its data-bascik-attr-class binding targets an attribute scoping rewrites",
    );
    expect(unsupported[0].locations).toEqual([
      { filePath: expect.stringContaining("bad-card/bad-card.html"), line: 1 },
    ]);
    expect(unsupported[0].locations[0].filePath).not.toMatch(/^src\//);
    expect(findings.errors).toBe(0);
    // With generate.cspHashes off, nothing is said about CSP stability.
    expect(
      findings.items.some(
        (item) => item.category === "request-render-csp-unstable",
      ),
    ).toBe(false);
    const human = formatFindingsHuman(findings);
    expect(human).toContain("bad-card");
    expect(human).toContain(
      `attr-binding-to-scoped-attribute: its data-bascik-attr-class binding targets an attribute scoping rewrites (${unsupported[0].locations[0].filePath}:1)`,
    );
    expect(JSON.parse(formatFindingsJson(findings)).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "request-render-unsupported" }),
      ]),
    );
  });

  it("names the per-instance output scope, not the script body, for a component whose stylesheet uses url(#id); an unused catalog component is not called safe to delete", async () => {
    const list: ComponentList = {
      // The server script body references nothing scoped; the stylesheet's
      // url(#shape) scopes the component's classes per instance.
      "glow-srv": {
        fileName: join(workDir, "src/components/glow-srv/glow-srv.html"),
        fileContent:
          '<div class="w"><svg><defs><g id="shape"></g></defs></svg><script data-bascik-server>export default () => \'<p>x</p>\';</script></div>',
        cssFileContent: ".w { mask: url(#shape) }",
      },
      // Supported and placed on no page: returned only from the page's server
      // script, which is what the design calls a catalog component.
      "catalog-card": {
        fileName: join(
          workDir,
          "src/components/catalog-card/catalog-card.html",
        ),
        fileContent: '<article class="w"><p>card</p></article>',
        cssFileContent: ".w { color: red }",
      },
    };
    listComponentsMock.mockResolvedValue(list);
    await writeDist(
      {
        "src/pages/index.html":
          "<script data-bascik-server>export default () => '<catalog-card></catalog-card>';</script>",
        "src/components/glow-srv/glow-srv.html": list["glow-srv"].fileContent,
        "src/components/catalog-card/catalog-card.html":
          list["catalog-card"].fileContent,
      },
      { pageEntries: true, manifest: true },
      list,
    );

    const findings = await checkProject();

    const unsupported = findings.items.filter(
      (item) => item.category === "request-render-unsupported",
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].message).toContain("glow-srv");
    expect(unsupported[0].message).toContain("instance-scoped-server-script");
    expect(unsupported[0].message).toContain("url(#id)");
    // Both sections display the file the same way.
    const unused = findings.items.filter(
      (item) => item.category === "unused-component",
    );
    expect(unused.map((item) => item.message).sort()).toEqual([
      "catalog-card",
      "glow-srv",
    ]);
    expect(unsupported[0].locations[0].filePath).toBe(
      unused.find((item) => item.message === "glow-srv")!.locations[0].filePath,
    );
    const human = formatFindingsHuman(findings);
    expect(human).toContain(
      "runs its server or stream script with per-instance\n" +
        "  class names (a stylesheet using url(#id), or scoping.deduplicateCss: false),",
    );
    expect(human).toContain(
      "Defined but never referenced. Safe to delete, or referenced only from a\n" +
        "  build, server or stream script, which this check cannot always see.",
    );
  });

  it("does not throw on a hand-edited manifest entry with generate.cspHashes on", async () => {
    await writeDist(sources(workDir), { pageEntries: true, manifest: false });
    (BascikConfig as any).generate = { ...originalGenerate, cspHashes: true };
    await writeFile(
      join(workDir, "dist", ".bascik", "components.json"),
      JSON.stringify({
        schema: 1,
        identifiers: true,
        minifyHtml: false,
        base: "/",
        inheritAttributes: true,
        components: { "a-card": {} },
      }),
    );

    const findings = await checkProject();

    // A malformed manifest is a build problem `bascik --build` reports with
    // the rebuild message; the check says nothing about request-time
    // rendering rather than crashing on the entry.
    expect(
      findings.items.filter((item) =>
        item.category.startsWith("request-render-"),
      ),
    ).toEqual([]);
  });

  it("lists CSP-unstable components only when generate.cspHashes is on", async () => {
    await writeDist(sources(workDir), { pageEntries: true, manifest: true });
    (BascikConfig as any).generate = { ...originalGenerate, cspHashes: true };

    const findings = await checkProject();

    const unstable = findings.items.filter(
      (item) => item.category === "request-render-csp-unstable",
    );
    expect(unstable).toHaveLength(1);
    expect(unstable[0].severity).toBe("warning");
    expect(unstable[0].message).toContain("id-script-card");
    expect(unstable[0].locations[0].filePath).toContain("id-script-card.html");
    expect(
      findings.items.filter(
        (item) => item.category === "request-render-unsupported",
      ),
    ).toHaveLength(1);
    expect(formatFindingsHuman(findings)).toContain("id-script-card");
  });

  it("reports nothing about request-time rendering when the sidecar has no page entries", async () => {
    await writeDist(sources(workDir), { pageEntries: false, manifest: false });
    (BascikConfig as any).generate = { ...originalGenerate, cspHashes: true };

    const findings = await checkProject();

    expect(
      findings.items.filter((item) =>
        item.category.startsWith("request-render-"),
      ),
    ).toEqual([]);
  });
});
