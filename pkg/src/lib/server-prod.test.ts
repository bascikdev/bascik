import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mem } from "./mem.ts";
import { startProdServer } from "./server-prod.ts";
import { SIDECAR_SCHEMA_VERSION } from "./server-sidecar.ts";

const { startServerMock } = vi.hoisted(() => ({
  startServerMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./server.js", () => ({
  startServer: startServerMock,
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    get BascikConfig() {
      return {
        ...actual.BascikConfig,
        directory: {
          ...actual.BascikConfig.directory,
          out: join(process.cwd(), "dist"),
        },
      };
    },
  };
});

describe("startProdServer", () => {
  let workDir: string;
  let originalCwd: string;

  it("never installs the dev module graph resolve hook (prompt 138)", async () => {
    // The production server and the build must leave Node's resolver alone:
    // `?bascik-gen` must never appear in production URLs or logs. The dev hook
    // is installed only by the dev server startup path (server-dev.ts), and
    // the graph module itself refuses to install outside development.
    const { installModuleGraphHook, isModuleGraphHookInstalled } =
      await import("./module-graph.ts");
    expect(isModuleGraphHookInstalled()).toBe(false);
    const handle = installModuleGraphHook({
      projectRoot: process.cwd(),
      isDev: false,
    });
    expect(handle.installed).toBe(false);
    expect(isModuleGraphHookInstalled()).toBe(false);
    // The production startup module does not even reference the graph.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const prodSource = await readFile(
      fileURLToPath(new URL("./server-prod.ts", import.meta.url)),
      "utf8",
    );
    expect(prodSource).not.toContain("module-graph");
  });

  beforeEach(async () => {
    startServerMock.mockClear();
    originalCwd = process.cwd();
    workDir = join(
      originalCwd,
      `.server-prod-test-${process.pid}-${Date.now()}`,
    );
    await mkdir(join(workDir, "dist"), { recursive: true });
    await mkdir(join(workDir, ".bascik", "dist"), { recursive: true });
    await writeFile(
      join(workDir, ".bascik", "dist", "build-state.json"),
      JSON.stringify({ format: 1, mode: "build", version: "test" }),
    );
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws a helpful error when dist/ does not exist", async () => {
    await rm(join(workDir, "dist"), { recursive: true, force: true });
    await expect(startProdServer()).rejects.toThrow(
      /could not read dist\/ directory[\s\S]*Run `bascik --build` first/,
    );
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("rejects development output before binding a server", async () => {
    await writeFile(
      join(workDir, ".bascik", "dist", "build-state.json"),
      JSON.stringify({ format: 1, mode: "development", version: "test" }),
    );

    await expect(startProdServer()).rejects.toThrow(
      /requires a completed production build/,
    );
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("warns but still serves when dist/ contains no HTML pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no HTML pages found"),
    );
    expect(startServerMock).toHaveBeenCalledOnce();
    warn.mockRestore();
    log.mockRestore();
  });

  it("loads dist pages into memory and starts the HTTP/2 server", async () => {
    await mkdir(join(workDir, "dist", "blog"));
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(join(workDir, "dist", "about.html"), "<h1>about</h1>");
    await writeFile(
      join(workDir, "dist", "blog", "post.html"),
      "<h1>post</h1>",
    );
    // Non-HTML files must be ignored
    await writeFile(join(workDir, "dist", "styles.css"), "body{}");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();

    const home = mem.getPageExact("/");
    const about = mem.getPageExact("/about");
    const post = mem.getPageExact("/blog/post");
    expect(home?.content.toString("utf8")).toBe("<h1>home</h1>");
    expect(about?.content.toString("utf8")).toBe("<h1>about</h1>");
    expect(post?.content.toString("utf8")).toBe("<h1>post</h1>");

    // dist/ pages record their path in the "pages/..." format
    expect(home?.relativePagePath).toBe("pages/index.html");
    expect(post?.relativePagePath).toBe("pages/blog/post.html");
    // No component tracking at serve time
    expect(about?.usedComponentsSet.size).toBe(0);

    expect(log).toHaveBeenCalledWith("Loaded 3 pages from dist/");
    log.mockRestore();
  });

  it("does not clean existing output when starting the production server", async () => {
    const sentinelPath = join(workDir, "dist", "keep-me.txt");
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(sentinelPath, "preserved");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(sentinelPath, "utf8"),
      ),
    ).resolves.toBe("preserved");
    log.mockRestore();
  });

  it("uses singular 'page' in the log message when exactly one page is loaded", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>only</h1>");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(log).toHaveBeenCalledWith("Loaded 1 page from dist/");
    log.mockRestore();
  });

  it("fails startup with an actionable diagnostic when the sidecar is malformed", async () => {
    await mkdir(join(workDir, ".bascik", "dist"), { recursive: true });
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      "{corrupt",
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(
      /Failed to load server scripts sidecar/,
    );
    // A required runtime artifact that cannot be parsed must never bind.
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup when a present sidecar cannot resolve a placeholder reference", async () => {
    await mkdir(join(workDir, ".bascik", "dist"), { recursive: true });
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(workDir, "dist", "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
    );
    // A present but entry-less sidecar means no script can back the placeholder.
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      JSON.stringify({
        version: "1",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {},
      }),
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(
      /production startup validation failed/,
    );
    await expect(startProdServer()).rejects.toThrow(
      /unresolvable or stale server-script placeholder/,
    );
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup when a placeholder page has no sidecar at all", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(workDir, "dist", "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(
      /production startup validation failed/,
    );
    await expect(startProdServer()).rejects.toThrow(/sidecar .*is missing/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup on an incompatible sidecar schema", async () => {
    await mkdir(join(workDir, ".bascik", "dist"), { recursive: true });
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      JSON.stringify({ version: "1", schema: 99, scripts: {} }),
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(/schema 99/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  // ── Regression: ordinary client scripts must survive `bascik --server` ──
  // The former "defense in depth" strip matched from the FIRST `<script` in
  // the document to the first `</script>` after any mention of the SSE path,
  // so a page that referenced `/bascik-live-reload` in prose, a code sample,
  // or an ordinary client script lost every client script before it.
  it("preserves ordinary inline client scripts that mention the live-reload path", async () => {
    const clientScript = `<script>document.getElementById("b").addEventListener("click", () => { n++; });</script>`;
    const html =
      `<!DOCTYPE html><html><head>${clientScript}</head><body>` +
      `<button id="b">Count: 0</button>` +
      `<p>Dev servers expose <code>/bascik-live-reload</code>.</p>` +
      `<script type="application/ld+json">{"@type":"WebPage","name":"bascik-live-reload docs"}</script>` +
      `</body></html>`;
    await writeFile(join(workDir, "dist", "index.html"), html);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    const served = mem.getPageExact("/")?.content.toString("utf8");
    expect(served).toBe(html);
    expect(served?.match(/<script/g)).toHaveLength(2);
    log.mockRestore();
  });

  it("preserves client scripts that themselves mention the live-reload path", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    const html =
      `<script>console.log("hello")</script>` +
      `<script>fetch("/bascik-live-reload").catch(() => {})</script>` +
      `<script>console.log("after")</script>`;
    await writeFile(join(workDir, "dist", "index.html"), html);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(mem.getPageExact("/")?.content.toString("utf8")).toBe(html);
    log.mockRestore();
  });

  it("strips only the injected dev live-reload script, keeping neighbors intact", async () => {
    const { getLiveReloadScript } = await import("./live-reload.ts");
    const before = `<script>window.before = 1</script>`;
    const after = `<script>window.after = 2</script>`;
    const html = `<body>${before}${getLiveReloadScript("/sub/bascik-live-reload").trim()}${after}</body>`;
    await writeFile(join(workDir, "dist", "index.html"), html);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    const served = mem.getPageExact("/")?.content.toString("utf8");
    expect(served).toBe(`<body>${before}${after}</body>`);
    expect(served).not.toContain("EventSource");
    expect(served).not.toContain("data-bascik-live-reload");
    log.mockRestore();
  });

  it("still serves a genuinely static release with no sidecar", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>static</h1>");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();
    // No sidecar exists, but the release is static and stays valid.
    expect(mem.getPageExact("/")?.content.toString("utf8")).toBe(
      "<h1>static</h1>",
    );
    log.mockRestore();
    error.mockRestore();
  });
});

/**
 * Prompt 157: `.bascik/dist/components.json` is a required runtime artifact
 * whenever the sidecar has page-owned server or stream entries, validated at
 * boot like the sidecar. A static release (no sidecar, or an empty one) needs
 * no manifest and boots exactly as before.
 */
describe("startProdServer and the component manifest (prompt 157)", () => {
  let workDir: string;
  let originalCwd: string;
  const placeholderPage =
    '<h1>a</h1><script type="text/bascik-server" data-bascik-server-id="s1"></script>';
  const sidecarWithPageEntry = JSON.stringify({
    version: "1",
    schema: SIDECAR_SCHEMA_VERSION,
    scripts: {
      s1: { id: "s1", mode: "server", source: "export default () => 'x';" },
    },
  });
  const manifest = (schema: number) =>
    JSON.stringify({
      schema,
      identifiers: true,
      minifyHtml: true,
      base: "/",
      inheritAttributes: true,
      components: {},
    });

  beforeEach(async () => {
    startServerMock.mockClear();
    originalCwd = process.cwd();
    workDir = join(
      originalCwd,
      `.server-prod-manifest-test-${process.pid}-${Date.now()}`,
    );
    await mkdir(join(workDir, "dist"), { recursive: true });
    await mkdir(join(workDir, ".bascik", "dist"), { recursive: true });
    await writeFile(
      join(workDir, ".bascik", "dist", "build-state.json"),
      JSON.stringify({ format: 1, mode: "build", version: "test" }),
    );
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("fails startup with the rebuild message when page entries exist but components.json is missing", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(workDir, "dist", "index.html"), placeholderPage);
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      sidecarWithPageEntry,
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(/components\.json/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
    log.mockRestore();
  });

  it("fails startup on an incompatible components.json schema", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(workDir, "dist", "index.html"), placeholderPage);
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      sidecarWithPageEntry,
      "utf8",
    );
    await writeFile(
      join(workDir, ".bascik", "dist", "components.json"),
      manifest(99),
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(/schema 99/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
    log.mockRestore();
  });

  it("boots when page entries exist and a compatible components.json is present", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(workDir, "dist", "index.html"), placeholderPage);
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      sidecarWithPageEntry,
      "utf8",
    );
    await writeFile(
      join(workDir, ".bascik", "dist", "components.json"),
      manifest(1),
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();
    expect(mem.getPageExact("/")?.serverScriptPlan).toBeDefined();
    log.mockRestore();
  });

  it("boots a static release whose sidecar is present but empty, with no manifest and no behavior change", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>static</h1>");
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      JSON.stringify({
        version: "1",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {},
      }),
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();
    expect(mem.getPageExact("/")?.content.toString("utf8")).toBe(
      "<h1>static</h1>",
    );
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  // Phase 3: the loaded manifest is attached to the stored pages so the
  // shared server renders component tags from script output, and a manifest
  // whose component job the sidecar lacks is a stale dist that never boots.
  const SRV_JOB_ID = `component_script_${Buffer.from("srv-card::1").toString("hex")}`;
  const outputScope = encodeURIComponent(
    JSON.stringify({
      classes: { line: "bascik__srv-card__line" },
      elements: {},
    }),
  );
  const manifestWithComponent = JSON.stringify({
    schema: 1,
    identifiers: false,
    minifyHtml: false,
    base: "/",
    inheritAttributes: true,
    components: {
      "srv-card": {
        name: "srv-card",
        filePath: "src/components/srv-card.html",
        template: {
          instanceId: "rsentinel",
          tokenCount: 1,
          steps: [],
          fileContent: {
            parts: [
              `<div class="bascik__srv-card__wrap" data-rid="`,
              `"><script type="text/bascik-server" data-bascik-server-id="${SRV_JOB_ID}"></script></div>`,
            ],
            tokens: [0],
          },
          size: 0,
        },
        css: null,
        jobs: [
          {
            id: SRV_JOB_ID,
            mode: "server",
            ordinal: 1,
            sourceFile: "src/components/srv-card.html",
            sourceLine: 2,
            outputScope,
          },
        ],
        cspStable: { style: true, script: true },
        scriptHashes: [],
      },
    },
  });
  const sidecarWithComponentJob = JSON.stringify({
    version: "1",
    schema: SIDECAR_SCHEMA_VERSION,
    scripts: {
      s1: { id: "s1", mode: "server", source: "export default () => 'x';" },
      [SRV_JOB_ID]: {
        id: SRV_JOB_ID,
        mode: "server",
        source: "export default () => '<p class=\"line\">c</p>';",
        sourceFile: "src/components/srv-card.html",
        sourceLine: 2,
        outputScope,
      },
    },
  });

  it("attaches the loaded manifest to every stored page that has a server-script plan", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(workDir, "dist", "index.html"), placeholderPage);
    await writeFile(join(workDir, "dist", "about.html"), "<h1>about</h1>");
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      sidecarWithComponentJob,
      "utf8",
    );
    await writeFile(
      join(workDir, ".bascik", "dist", "components.json"),
      manifestWithComponent,
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();
    const page = mem.getPageExact("/");
    expect(page?.serverScriptPlan).toBeDefined();
    expect(page?.componentManifest?.schema).toBe(1);
    expect(page?.componentManifest?.components["srv-card"].jobs[0].id).toBe(
      SRV_JOB_ID,
    );
    // A page without a plan never renders at request time and carries none.
    expect(mem.getPageExact("/about")?.componentManifest).toBeUndefined();
    log.mockRestore();
  });

  it("fails startup with a located message when components.json names a job the sidecar lacks", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(workDir, "dist", "index.html"), placeholderPage);
    await writeFile(
      join(workDir, ".bascik", "dist", "server-scripts.json"),
      sidecarWithPageEntry,
      "utf8",
    );
    await writeFile(
      join(workDir, ".bascik", "dist", "components.json"),
      manifestWithComponent,
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(startProdServer()).rejects.toThrow(SRV_JOB_ID);
    await expect(startProdServer()).rejects.toThrow(/srv-card/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
    log.mockRestore();
  });
});
