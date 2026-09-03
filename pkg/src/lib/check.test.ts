import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  extractCustomTags,
  checkProject,
  formatFindingsHuman,
  formatFindingsJson,
  type CheckFindings,
} from "./check.ts";

const { listPagesMock, listComponentsMock } = vi.hoisted(() => ({
  listPagesMock: vi.fn(),
  listComponentsMock: vi.fn(),
}));

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
}));

vi.mock("./components.js", () => ({
  listComponents: listComponentsMock,
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

  const setupProject = async (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(workDir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    workDir = join(originalCwd, `.check-test-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    process.chdir(workDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
});
