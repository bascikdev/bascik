import { afterEach, describe, it, expect, vi } from "vitest";
import {
  splitDistPageIntoSegments,
  pageAliasesFor,
  isPublicAssetPath,
  detectPublicCollisions,
  readSiteGraph,
} from "./site-graph.ts";
import { emitServerlessArtifacts } from "./serverless-artifacts.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { SIDECAR_SCHEMA_VERSION } from "./server-sidecar.ts";
import { privateDirFor } from "./private-dir.ts";

describe("splitDistPageIntoSegments", () => {
  it("splits placeholder HTML into static text and script ids in document order", () => {
    const html =
      `<p>a</p><script type="text/bascik-server" data-bascik-server-id="s1"></script><p>b</p>` +
      `<script type="text/bascik-server" data-bascik-server-id="s2" data-bascik-stream></script><p>c</p>`;
    const result = splitDistPageIntoSegments(html);
    expect(result.segments).toEqual([
      { kind: "static", text: "<p>a</p>" },
      { kind: "script", id: "s1" },
      { kind: "static", text: "<p>b</p>" },
      { kind: "script", id: "s2" },
      { kind: "static", text: "<p>c</p>" },
    ]);
    expect(result.scriptIds).toEqual(["s1", "s2"]);
  });

  it("returns a single static segment and no ids for a plain page", () => {
    const result = splitDistPageIntoSegments("<p>static</p>");
    expect(result.scriptIds).toEqual([]);
    expect(result.segments).toEqual([
      { kind: "static", text: "<p>static</p>" },
    ]);
  });

  it("matches the type attribute as a whole name, any quote style or case, and only with an empty body", () => {
    const html =
      `<script TYPE='Text/Bascik-Server' data-bascik-server-id="a"></script>` +
      `<script data-type="text/bascik-server" data-bascik-server-id="b"></script>` +
      `<script type="text/bascik-server" data-bascik-server-id="c">body()</script>` +
      `<script type="text/bascik-server" data-note="a > b" data-bascik-server-id="d">\n</script >`;
    const { segments, scriptIds } = splitDistPageIntoSegments(html);
    expect(scriptIds).toEqual(["a", "d"]);
    expect(segments).toEqual([
      { kind: "script", id: "a" },
      {
        kind: "static",
        text:
          `<script data-type="text/bascik-server" data-bascik-server-id="b"></script>` +
          `<script type="text/bascik-server" data-bascik-server-id="c">body()</script>`,
      },
      { kind: "script", id: "d" },
    ]);
  });

  it("accepts every end tag spelling the browser accepts, case-insensitively", () => {
    const ends = [
      "</script>",
      "</SCRIPT>",
      "</Script >",
      "</script/>",
      "</script\t\n bar>",
    ];
    const html = ends
      .map(
        (end, i) =>
          `<p>${i}</p><script type="text/bascik-server" data-bascik-server-id="e${i}">${end}`,
      )
      .join("");
    expect(splitDistPageIntoSegments(html).scriptIds).toEqual([
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    const lookalike =
      '<script type="text/bascik-server" data-bascik-server-id="x"></scripts><p>after</p>';
    expect(splitDistPageIntoSegments(lookalike)).toEqual({
      segments: [{ kind: "static", text: lookalike }],
      scriptIds: [],
    });
  });

  it("reads unquoted type and id values", () => {
    expect(
      splitDistPageIntoSegments(
        "<script type=text/bascik-server data-bascik-server-id=u></script>",
      ).scriptIds,
    ).toEqual(["u"]);
  });

  it("leaves a placeholder without an id in the static text and keeps scanning after it", () => {
    const html =
      '<p>a</p><script type="text/bascik-server"></script><p>b</p><script type="text/bascik-server" data-bascik-server-id="s"></script>';
    expect(splitDistPageIntoSegments(html)).toEqual({
      segments: [
        {
          kind: "static",
          text: '<p>a</p><script type="text/bascik-server"></script><p>b</p>',
        },
        { kind: "script", id: "s" },
      ],
      scriptIds: ["s"],
    });
  });

  it("reassembles the page exactly from its static segments and placeholders", () => {
    const placeholder = (id: string) =>
      `<script type="text/bascik-server" data-bascik-server-id="${id}"></script>`;
    const html = `<p>a</p>${placeholder("s1")}${placeholder("s2")}<p>b</p><script>client()</script>${placeholder("s3")}`;
    const rebuilt = splitDistPageIntoSegments(html)
      .segments.map((segment) =>
        segment.kind === "static" ? segment.text : placeholder(segment.id!),
      )
      .join("");
    expect(rebuilt).toBe(html);
  });

  it(
    "stays linear on many placeholders and many unterminated placeholder open tags",
    () => {
      const many = (n: number) =>
        '<p>a</p><script type="text/bascik-server" data-bascik-server-id="s"></script>'.repeat(
          n,
        );
      const unterminated = (n: number) =>
        '<script type="text/bascik-server" data-bascik-server-id="s">'.repeat(
          n,
        );
      expect(splitDistPageIntoSegments(many(50_000)).scriptIds).toHaveLength(
        50_000,
      );
      expect(splitDistPageIntoSegments(unterminated(50_000)).scriptIds).toEqual(
        [],
      );
      for (const [label, input] of [
        ["placeholders", many],
        ["unterminated open tags", unterminated],
      ] as const)
        expectLinearTime(input, 50_000, splitDistPageIntoSegments, { label });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each([
    ["a bare end tag", "</script>", ["p"]],
    ["whitespace before the end tag", " \n\t</script>", ["p"]],
    ["whitespace inside the end tag", "</script \t>", ["p"]],
    ["a slash inside the end tag", "</script/>", ["p"]],
    ["an uppercase end tag", "</SCRIPT>", ["p"]],
    ["a body before the end tag", "x</script>", []],
    ["a longer tag name", "</scriptx>", []],
    ["an unterminated end tag", "</script ", []],
    ["a truncated end tag", "</scri", []],
  ])("matches the placeholder end tag for %s", (_case, tail, expected) => {
    const html = `<script type="text/bascik-server" data-bascik-server-id="p">${tail}`;
    expect(splitDistPageIntoSegments(html).scriptIds).toEqual(expected);
  });

  it(
    "stays linear on long whitespace runs and repeated unterminated end tags",
    () => {
      const open =
        '<script type="text/bascik-server" data-bascik-server-id="s">';
      const cases = [
        [(n: number) => `${open}${" ".repeat(n)}x`, 200_000, []],
        [(n: number) => `${open}${"</script\t".repeat(n)}`, 50_000, []],
        [(n: number) => `${open}${" ".repeat(n)}</script>`, 200_000, ["s"]],
      ] as const;
      for (const [input, size, ids] of cases) {
        const label = input(2).slice(open.length);
        expect(splitDistPageIntoSegments(input(size)).scriptIds, label).toEqual(
          ids,
        );
        expectLinearTime(input, size, splitDistPageIntoSegments, { label });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "stays fast on many repeated type attributes in an unterminated tag",
    () => {
      const html = (n: number) =>
        `<script ${'type="text/bascik-server"'.repeat(n)}`;
      expect(splitDistPageIntoSegments(html(20_000)).scriptIds).toEqual([]);
      expectLinearTime(html, 20_000, splitDistPageIntoSegments);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it("preserves multi-byte text exactly", () => {
    const html = `日本 🚀<script type="text/bascik-server" data-bascik-server-id="x"></script>ünï`;
    const { segments } = splitDistPageIntoSegments(html);
    expect(segments[0]).toEqual({ kind: "static", text: "日本 🚀" });
    expect(segments[2]).toEqual({ kind: "static", text: "ünï" });
  });
});

describe("pageAliasesFor", () => {
  it("lists every request spelling the Node server accepts for a page", () => {
    expect(pageAliasesFor("/", "/")).toEqual(["/", "/index", "/index.html"]);
    expect(pageAliasesFor("/about", "/")).toEqual([
      "/about",
      "/about/",
      "/about.html",
    ]);
    expect(pageAliasesFor("/blog/", "/")).toEqual([
      "/blog/",
      "/blog",
      "/blog/index",
      "/blog/index.html",
    ]);
  });

  it("prefixes the base path", () => {
    expect(pageAliasesFor("/about", "/docs/")).toEqual([
      "/docs/about",
      "/docs/about/",
      "/docs/about.html",
    ]);
    expect(pageAliasesFor("/", "/docs/")).toEqual([
      "/docs/",
      "/docs",
      "/docs/index",
      "/docs/index.html",
    ]);
  });
});

describe("isPublicAssetPath", () => {
  it.each([
    [".bascik/manifest.json", false],
    [".bascik/server-scripts.json", false],
    ["assets/app.js.map", false],
    ["style.css.br", false],
    ["style.css.gz", false],
    ["style.css.br.bmeta", false],
    [".hidden", false],
    ["dir/.env", false],
    [".well-known/security.txt", true],
    [".well-known/agent-skills/index.json", true],
    ["blog/.well-known/security.txt", false],
    [".well-known/.env", false],
    ["style.css", true],
    ["img/logo.png", true],
    ["about.html", true],
    ["_headers", true],
    ["_redirects", true],
  ])("%s -> public %s", (path, expected) => {
    expect(isPublicAssetPath(path)).toBe(expected);
  });
});

describe("detectPublicCollisions", () => {
  it("rejects authored files that would shadow control files supplied by adapter", () => {
    const problems = detectPublicCollisions({
      publicPaths: ["_worker.js", "img/a.png", "_routes.json"],
      apiRoutePaths: [],
      controlFiles: ["_worker.js", "_routes.json"],
    });
    expect(problems).toEqual([
      expect.stringContaining("_routes.json"),
      expect.stringContaining("_worker.js"),
    ]);
  });

  it("rejects a static API route path that a public file also occupies", () => {
    const problems = detectPublicCollisions({
      publicPaths: ["api/health"],
      apiRoutePaths: ["/api/health", "/api/users/[id]"],
      controlFiles: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/api/health");
  });
});

describe("readSiteGraph", () => {
  it("reads dist/ and sidecar, builds host-neutral SiteGraph", async () => {
    const testDir = join(tmpdir(), `bascik-site-graph-test-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = privateDirFor(distDir);
    const srcApiDir = join(testDir, "src/api");
    await mkdir(bascikHiddenDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(srcApiDir, { recursive: true });

    // 1. static page
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    // 2. custom 404
    await writeFile(join(distDir, "404.html"), "<h1>Not Found</h1>", "utf8");
    // 3. custom 500
    await writeFile(join(distDir, "500.html"), "<h1>Server Error</h1>", "utf8");
    // 4. dynamic page with inline and src= script jobs
    await writeFile(
      join(distDir, "dynamic.html"),
      `<p>Hi</p><script type="text/bascik-server" data-bascik-server-id="job-inline"></script>` +
        `<p>Stream</p><script type="text/bascik-server" data-bascik-server-id="job-src" data-bascik-stream></script>`,
      "utf8",
    );
    // sidecar
    const sidecar = {
      schema: SIDECAR_SCHEMA_VERSION,
      scripts: {
        "job-inline": {
          mode: "server",
          source: 'console.log("inline");',
          sourceFile: "src/pages/dynamic.html",
          sourceLine: 2,
        },
        "job-src": {
          mode: "stream",
          modulePath: "./helper.ts",
          sourceFile: "src/pages/dynamic.html",
          sourceLine: 4,
        },
      },
    };
    await writeFile(
      join(bascikHiddenDir, "server-scripts.json"),
      JSON.stringify(sidecar),
      "utf8",
    );
    // A sidecar with page entries needs the component manifest a build
    // writes beside it (prompt 157).
    await writeFile(
      join(bascikHiddenDir, "components.json"),
      JSON.stringify({
        schema: 1,
        identifiers: true,
        minifyHtml: true,
        base: "/",
        inheritAttributes: true,
        components: {},
      }),
      "utf8",
    );

    // helper file for src=
    await mkdir(join(testDir, "src/pages"), { recursive: true });
    await writeFile(
      join(testDir, "src/pages/helper.ts"),
      "export default () => 'streamed';",
      "utf8",
    );

    // static asset
    await mkdir(join(distDir, "css"), { recursive: true });
    await writeFile(
      join(distDir, "css/main.css"),
      "body { color: red; }",
      "utf8",
    );

    // API route
    await writeFile(
      join(srcApiDir, "hello.ts"),
      "export const GET = () => new Response('world');",
      "utf8",
    );

    try {
      const graph = await readSiteGraph({
        projectRoot: testDir,
        distDir,
        version: "1.0.0",
        base: "/",
      });

      expect(graph.publicFiles).toContain("index.html");
      expect(graph.publicFiles).toContain("404.html");
      expect(graph.publicFiles).toContain("css/main.css");
      // dynamic.html has server scripts so it must NEVER be listed as public
      expect(graph.publicFiles).not.toContain("dynamic.html");

      expect(graph.custom500).toBe("<h1>Server Error</h1>");
      expect(graph.pages["/dynamic"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-inline"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-inline"].source.kind).toBe(
        "inline",
      );
      expect(graph.pages["/dynamic"].jobs["job-src"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-src"].source.kind).toBe(
        "module",
      );

      expect(graph.apiRoutes).toHaveLength(1);
      expect(graph.apiRoutes[0].path).toBe("/api/hello");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

/**
 * Prompt 157: readSiteGraph validates `.bascik/dist/components.json` the way
 * the production boot does. A dist with page-owned server or stream entries
 * and no compatible manifest is a stale build; a static dist never needs one.
 */
describe("readSiteGraph and the component manifest (prompt 157)", () => {
  const placeholderPage = `<p>Hi</p><script type="text/bascik-server" data-bascik-server-id="job-inline"></script>`;
  const sidecarWithPageEntry = {
    schema: SIDECAR_SCHEMA_VERSION,
    scripts: {
      "job-inline": {
        mode: "server",
        source: 'console.log("inline");',
        sourceFile: "src/pages/dynamic.html",
        sourceLine: 2,
      },
    },
  };
  const manifest = (schema: number) => ({
    schema,
    identifiers: true,
    minifyHtml: true,
    base: "/",
    inheritAttributes: true,
    components: {},
  });

  const withDist = async (
    files: Record<string, string>,
    run: (testDir: string, distDir: string) => Promise<void>,
  ) => {
    const testDir = join(
      tmpdir(),
      `bascik-site-graph-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const distDir = join(testDir, "dist");
    await mkdir(privateDirFor(distDir), { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(join(testDir, "src/api"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await writeFile(
        rel.startsWith(".bascik/")
          ? join(privateDirFor(distDir), rel.slice(".bascik/".length))
          : join(distDir, rel),
        content,
        "utf8",
      );
    }
    try {
      await run(testDir, distDir);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  };

  it("fails with the rebuild message when page entries exist but components.json is missing", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": JSON.stringify(sidecarWithPageEntry),
      },
      async (testDir, distDir) => {
        const read = () =>
          readSiteGraph({ projectRoot: testDir, distDir, version: "1.0.0" });
        await expect(read()).rejects.toThrow(/components\.json/);
        await expect(read()).rejects.toThrow(/bascik --build/);
      },
    );
  });

  it("fails the same way on an incompatible components.json schema", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": JSON.stringify(sidecarWithPageEntry),
        ".bascik/components.json": JSON.stringify(manifest(99)),
      },
      async (testDir, distDir) => {
        const read = () =>
          readSiteGraph({ projectRoot: testDir, distDir, version: "1.0.0" });
        await expect(read()).rejects.toThrow(/schema 99/);
        await expect(read()).rejects.toThrow(/bascik --build/);
      },
    );
  });

  it("reads a dist with page entries and a compatible manifest", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": JSON.stringify(sidecarWithPageEntry),
        ".bascik/components.json": JSON.stringify(manifest(1)),
      },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.pages["/dynamic"].jobs["job-inline"]).toBeDefined();
        expect(graph.publicFiles).not.toContain(".bascik/components.json");
      },
    );
  });

  it("is a no-op for a static dist: no manifest required, no components section, with or without an empty sidecar", async () => {
    await withDist(
      { "index.html": "<h1>Home</h1>" },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.publicFiles).toEqual(["index.html"]);
        expect((graph as { components?: unknown }).components).toBeUndefined();
      },
    );
    await withDist(
      {
        "index.html": "<h1>Home</h1>",
        ".bascik/server-scripts.json": JSON.stringify({
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: {},
        }),
      },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.publicFiles).toEqual(["index.html"]);
        expect((graph as { components?: unknown }).components).toBeUndefined();
      },
    );
  });
});

/**
 * Prompt 157, phase 3: the site graph carries the component manifest and the
 * component jobs (`SiteGraph.components = { manifest, jobs }`) so an adapter
 * can render component tags from script output at request time. The section
 * exists exactly when the manifest does; component jobs are never attached
 * to a page. `emitServerlessArtifacts` stages component inline sources like
 * page jobs and warns, naming the adapter, when the manifest has components
 * but the adapter's build result does not declare `components: true`.
 */
describe("SiteGraph.components and the serverless artifacts (prompt 157)", () => {
  const SRV_JOB_ID = `component_script_${Buffer.from("srv-card::1").toString("hex")}`;
  const outputScope = encodeURIComponent(
    JSON.stringify({
      classes: { line: "bascik__srv-card__line" },
      elements: {},
    }),
  );
  const placeholderPage = `<p>Hi</p><script type="text/bascik-server" data-bascik-server-id="job-inline"></script>`;
  const pageEntry = {
    mode: "server",
    source: "export default () => '<srv-card></srv-card>';",
    sourceFile: "src/pages/dynamic.html",
    sourceLine: 2,
  };
  const componentEntry = {
    mode: "server",
    source: "export default () => '<p class=\"line\">from component</p>';",
    sourceFile: "src/components/srv-card.html",
    sourceLine: 2,
    outputScope,
  };
  const sidecar = (scripts: Record<string, unknown>) =>
    JSON.stringify({ schema: SIDECAR_SCHEMA_VERSION, scripts });
  const srvCard = (jobId: string) => ({
    name: "srv-card",
    filePath: "src/components/srv-card.html",
    template: {
      instanceId: "rsentinel",
      tokenCount: 1,
      steps: [],
      fileContent: {
        parts: [
          `<div class="bascik__srv-card__wrap" data-rid="`,
          `"><script type="text/bascik-server" data-bascik-server-id="${jobId}"></script></div>`,
        ],
        tokens: [0],
      },
      size: 0,
    },
    css: null,
    jobs: [
      {
        id: jobId,
        mode: "server",
        ordinal: 1,
        sourceFile: "src/components/srv-card.html",
        sourceLine: 2,
        outputScope,
      },
    ],
    cspStable: { style: true, script: true },
    scriptHashes: [],
  });
  const manifest = (components: Record<string, unknown>) =>
    JSON.stringify({
      schema: 1,
      identifiers: false,
      minifyHtml: false,
      base: "/",
      inheritAttributes: true,
      components,
    });

  const withDist = async (
    files: Record<string, string>,
    run: (testDir: string, distDir: string) => Promise<void>,
  ) => {
    const testDir = join(
      tmpdir(),
      `bascik-site-graph-components-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const distDir = join(testDir, "dist");
    await mkdir(privateDirFor(distDir), { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(join(testDir, "src/api"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await writeFile(
        rel.startsWith(".bascik/")
          ? join(privateDirFor(distDir), rel.slice(".bascik/".length))
          : join(distDir, rel),
        content,
        "utf8",
      );
    }
    try {
      await run(testDir, distDir);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readSiteGraph attaches components = { manifest, jobs } when the manifest exists, with component jobs off the pages", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({
          "job-inline": pageEntry,
          [SRV_JOB_ID]: componentEntry,
        }),
        ".bascik/components.json": manifest({
          "srv-card": srvCard(SRV_JOB_ID),
        }),
      },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.components).toBeDefined();
        expect(graph.components?.manifest.schema).toBe(1);
        expect(
          graph.components?.manifest.components["srv-card"].jobs[0].id,
        ).toBe(SRV_JOB_ID);
        expect(graph.components?.jobs[SRV_JOB_ID]).toEqual({
          id: SRV_JOB_ID,
          mode: "server",
          source: {
            kind: "inline",
            code: expect.stringContaining("from component"),
            stagedPath: "",
          },
          owner: expect.stringContaining("src/components/srv-card.html"),
          // The sidecar entry's scope travels with the job (phase 4), so an
          // adapter styles the component's script output as Node does.
          outputScope,
        });
        expect(Object.keys(graph.components?.jobs ?? {})).toEqual([SRV_JOB_ID]);
        expect(Object.keys(graph.pages["/dynamic"].jobs)).toEqual([
          "job-inline",
        ]);
        // A page-level script has no scope, and no `outputScope` key at all.
        expect(graph.pages["/dynamic"].jobs["job-inline"]).not.toHaveProperty(
          "outputScope",
        );
      },
    );
  });

  it("a page job from a component placed statically carries the component's output scope", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({
          "job-inline": { ...pageEntry, outputScope },
        }),
        ".bascik/components.json": manifest({}),
      },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.pages["/dynamic"].jobs["job-inline"].outputScope).toBe(
          outputScope,
        );
      },
    );
  });

  it("an empty manifest attaches an empty components section", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({ "job-inline": pageEntry }),
        ".bascik/components.json": manifest({}),
      },
      async (testDir, distDir) => {
        const graph = await readSiteGraph({
          projectRoot: testDir,
          distDir,
          version: "1.0.0",
        });
        expect(graph.components?.manifest.components).toEqual({});
        expect(graph.components?.jobs).toEqual({});
      },
    );
  });

  it("fails like the production boot when the manifest names a job the sidecar lacks", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({ "job-inline": pageEntry }),
        ".bascik/components.json": manifest({
          "srv-card": srvCard(SRV_JOB_ID),
        }),
      },
      async (testDir, distDir) => {
        const read = () =>
          readSiteGraph({ projectRoot: testDir, distDir, version: "1.0.0" });
        await expect(read()).rejects.toThrow(SRV_JOB_ID);
        await expect(read()).rejects.toThrow(/srv-card/);
        await expect(read()).rejects.toThrow(/bascik --build/);
      },
    );
  });

  it("emitServerlessArtifacts warns, naming the adapter, when the manifest has components and the adapter result lacks components: true", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({
          "job-inline": pageEntry,
          [SRV_JOB_ID]: componentEntry,
        }),
        ".bascik/components.json": manifest({
          "srv-card": srvCard(SRV_JOB_ID),
        }),
      },
      async (testDir, distDir) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const result = await emitServerlessArtifacts(
          resolve(import.meta.dirname, "__fixtures__/reference-adapter.ts"),
          { version: "1.0.0", projectRoot: testDir, distDir },
        );
        expect(result.adapter).toBe("reference");
        const warnings = warn.mock.calls.map((call) => call.join(" "));
        const about = warnings.filter((w) => /component/i.test(w));
        expect(about).toHaveLength(1);
        expect(about[0]).toContain("reference");
        expect(about[0]).toMatch(/srv-card|components\.json|component tags/);
      },
    );
  });

  it("stages component inline sources like page jobs and stays silent for an adapter that declares components: true", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({
          "job-inline": pageEntry,
          [SRV_JOB_ID]: componentEntry,
        }),
        ".bascik/components.json": manifest({
          "srv-card": srvCard(SRV_JOB_ID),
        }),
      },
      async (testDir, distDir) => {
        await writeFile(
          join(testDir, "inspect-adapter.mjs"),
          `
          import { readFile } from "node:fs/promises";
          export default {
            name: "inspect",
            async build(context) {
              const job = context.graph.components.jobs[${JSON.stringify(SRV_JOB_ID)}];
              const content = await readFile(job.source.stagedPath, "utf8");
              globalThis.__bascik_component_staged = { stagedPath: job.source.stagedPath, content };
              return { publicDir: context.outDir, components: true };
            }
          };
          `,
          "utf8",
        );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await emitServerlessArtifacts("./inspect-adapter.mjs", {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        });
        const staged = (
          globalThis as {
            __bascik_component_staged?: { stagedPath: string; content: string };
          }
        ).__bascik_component_staged;
        delete (globalThis as { __bascik_component_staged?: unknown })
          .__bascik_component_staged;
        expect(staged?.stagedPath).toContain(".staging");
        expect(staged?.content).toContain("from component");
        // Staging is cleaned up after the build, like page jobs.
        await expect(readFile(staged!.stagedPath, "utf8")).rejects.toThrow();
        expect(
          warn.mock.calls
            .map((call) => call.join(" "))
            .filter((w) => /component/i.test(w)),
        ).toEqual([]);
      },
    );
  });

  it("stays silent for an empty manifest with an adapter that does not declare components", async () => {
    await withDist(
      {
        "dynamic.html": placeholderPage,
        ".bascik/server-scripts.json": sidecar({ "job-inline": pageEntry }),
        ".bascik/components.json": manifest({}),
      },
      async (testDir, distDir) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await emitServerlessArtifacts(
          resolve(import.meta.dirname, "__fixtures__/reference-adapter.ts"),
          { version: "1.0.0", projectRoot: testDir, distDir },
        );
        expect(
          warn.mock.calls
            .map((call) => call.join(" "))
            .filter((w) => /component/i.test(w)),
        ).toEqual([]);
      },
    );
  });
});

/**
 * Security toggles reach the Worker through the graph (Collin 2026-10-29):
 * the resolved response headers, hideDotfiles, stripAnsi and renderLimits,
 * from the build's config or the options (the same pattern as
 * contentSecurityPolicy).
 */
describe("readSiteGraph: security settings for the host", () => {
  const makeDist = async () => {
    const testDir = join(
      tmpdir(),
      `bascik-site-graph-security-${process.pid}-${Date.now()}`,
    );
    const distDir = join(testDir, "dist");
    await mkdir(privateDirFor(distDir), { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    await writeFile(join(distDir, ".nojekyll"), "", "utf8");
    await writeFile(join(privateDirFor(distDir), "server-scripts.json"), "{}");
    await mkdir(join(testDir, "src/api"), { recursive: true });
    return { testDir, distDir };
  };

  it("defaults: the resolved headers, HSTS one year, dotfiles hidden, ANSI stripped, today's render limits", async () => {
    const { testDir, distDir } = await makeDist();
    try {
      const graph = (await readSiteGraph({
        projectRoot: testDir,
        distDir,
        version: "1.0.0",
        base: "/",
      })) as unknown as Record<string, any>;
      expect(graph.responseSecurity).toEqual({
        headers: {
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "strict-origin-when-cross-origin",
          "cross-origin-opener-policy": "same-origin-allow-popups",
          "cross-origin-resource-policy": "cross-origin",
        },
        hsts: "max-age=31536000",
        privateDynamicPages: true,
      });
      expect(graph.hideDotfiles).toBe(true);
      expect(graph.stripAnsi).toBe(true);
      expect(graph.renderLimits).toEqual({
        maxInstances: 1000,
        maxOutputLength: 4 * 1024 * 1024,
        maxNestedScripts: 64,
        maxDepth: 4,
        rescanFactor: 16,
        rescanBase: 32 * 1024 * 1024,
      });
      expect(graph.publicFiles).not.toContain(".nojekyll");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("options carry the config: headers off, hsts off, dynamic cache off, dotfiles shown, ANSI kept, a render limit", async () => {
    const { testDir, distDir } = await makeDist();
    try {
      const graph = (await readSiteGraph({
        projectRoot: testDir,
        distDir,
        version: "1.0.0",
        base: "/",
        security: {
          headers: { "x-frame-options": "DENY", "referrer-policy": false },
          hsts: false,
          privateDynamicPages: false,
          hideDotfiles: false,
        },
        stripAnsi: false,
        renderLimits: { maxInstances: 5 },
      } as never)) as unknown as Record<string, any>;
      expect(graph.responseSecurity.headers["x-frame-options"]).toBe("DENY");
      expect(graph.responseSecurity.headers).not.toHaveProperty(
        "referrer-policy",
      );
      expect(graph.responseSecurity.hsts).toBeNull();
      expect(graph.responseSecurity.privateDynamicPages).toBe(false);
      expect(graph.hideDotfiles).toBe(false);
      expect(graph.stripAnsi).toBe(false);
      expect(graph.renderLimits.maxInstances).toBe(5);
      expect(graph.renderLimits.maxDepth).toBe(4);
      // The dotfile deploys; the private .bascik folder never does.
      expect(graph.publicFiles).toContain(".nojekyll");
      expect(
        graph.publicFiles.some((f: string) => f.startsWith(".bascik/")),
      ).toBe(false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
