import { describe, it, expect, afterEach } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SiteGraph, SiteGraphJob } from "@bascik/bascik/adapter";
import {
  build,
  buildInvocationRoutes,
  detectControlCollisions,
} from "./build.ts";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  classifyNodeBuiltin,
  formatUnsupportedImport,
  WORKERS_SUPPORTED_NODE_BUILTINS,
} from "./compat.ts";

describe("buildInvocationRoutes", () => {
  it("includes the API prefix and every dynamic page alias, sorted and deduplicated", () => {
    const routes = buildInvocationRoutes({
      base: "/",
      dynamicPagePaths: ["/", "/account"],
      hasApiRoutes: true,
    });
    expect(routes.include).toEqual([
      "/",
      "/_routes.json",
      "/_worker.js",
      "/account",
      "/account.html",
      "/account/",
      "/api/*",
      "/index",
      "/index.html",
    ]);
    expect(routes.exclude).toEqual([]);
    expect(routes.overflowed).toBe(false);
  });

  it("omits the API prefix when there are no API routes", () => {
    const routes = buildInvocationRoutes({
      base: "/",
      dynamicPagePaths: ["/x"],
      hasApiRoutes: false,
    });
    expect(routes.include).not.toContain("/api/*");
  });

  it("always routes the generated control files to the worker so they can never be downloaded", () => {
    const routes = buildInvocationRoutes({
      base: "/docs/",
      dynamicPagePaths: [],
      hasApiRoutes: false,
    });
    expect(routes.include).toEqual(["/docs/_routes.json", "/docs/_worker.js"]);
  });
});

describe("detectControlCollisions", () => {
  it("rejects authored files that would shadow generated control files", () => {
    const problems = detectControlCollisions(
      ["_worker.js", "img/a.png", "_routes.json"],
      "pages",
    );
    expect(problems).toEqual([
      expect.stringContaining("_routes.json"),
      expect.stringContaining("_worker.js"),
    ]);
  });
});

describe("node builtin policy for the pinned Cloudflare target", () => {
  it("pins a compatibility date the local runtime harness supports", () => {
    expect(CLOUDFLARE_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("classifies supported builtins as runtime-provided and others as unsupported", () => {
    expect(classifyNodeBuiltin("node:crypto")).toBe("provided");
    expect(classifyNodeBuiltin("crypto")).toBe("provided");
    expect(classifyNodeBuiltin("node:child_process")).toBe("unsupported");
    expect(classifyNodeBuiltin("node:worker_threads")).toBe("unsupported");
    expect(classifyNodeBuiltin("marked")).toBe("not-builtin");
    expect(WORKERS_SUPPORTED_NODE_BUILTINS.has("buffer")).toBe(true);
  });

  it("formats an unsupported import as an authored import-chain diagnostic", () => {
    const message = formatUnsupportedImport({
      specifier: "node:child_process",
      importer: "/proj/src/lib/exec.ts",
      projectRoot: "/proj",
      owners: ["API route /api/run", "server script in src/pages/x.html:12"],
    });
    expect(message).toContain('"node:child_process"');
    expect(message).toContain("src/lib/exec.ts");
    expect(message).toContain("API route /api/run");
    expect(message).toContain("src/pages/x.html:12");
    expect(message).not.toContain("/proj/");
  });
});

// ─── Request-time components in the emitted entry (prompt 157) ──────────────

type Manifest = NonNullable<SiteGraph["components"]>["manifest"];

const LIVE_ID = "component_script_70726f647563742d636172642d6c6976653a3a31"; // hex("product-card-live::1")
const LIVE_SCOPE = encodeURIComponent(
  JSON.stringify({
    classes: { stock: "bascik__product-card-live__stock" },
    elements: {},
  }),
);

/** A recorded template for a card with no tokens: enough to be renderable. */
const TILE_TEMPLATE = {
  instanceId: "bascik-template-instance",
  tokenCount: 1,
  steps: [],
  fileContent: {
    parts: ['<article class="bascik__product-card__tile"></article>'],
    tokens: [],
  },
  cssFileContent: undefined,
  scopedIdNames: undefined,
  requiresPerInstanceCss: undefined,
  size: 53,
};

/**
 * A manifest as the build writes it: a renderable card, and a card whose
 * template was not recorded, with a job.
 */
const manifestFixture = (): Manifest => ({
  schema: 1,
  identifiers: false,
  minifyHtml: false,
  base: "/",
  inheritAttributes: true,
  components: {
    "product-card": {
      name: "product-card",
      filePath: "components/product-card/product-card.html",
      template: TILE_TEMPLATE,
      css: {
        text: ".bascik__product-card__tile{color:rgb(1,2,3)}",
        hash: "sha256-AAAA",
      },
      jobs: [],
      cspStable: { style: true, script: true },
      scriptHashes: [],
    },
    "product-card-live": {
      name: "product-card-live",
      filePath: "components/product-card-live/product-card-live.html",
      template: null,
      css: null,
      jobs: [
        {
          id: LIVE_ID,
          mode: "server",
          ordinal: 1,
          sourceFile: "src/components/product-card-live/product-card-live.html",
          sourceLine: 25,
          outputScope: LIVE_SCOPE,
        },
      ],
      cspStable: { style: true, script: true },
      scriptHashes: [],
    },
  },
});

const PAGE_JOB_ID = "server_script_706167653a3a31"; // hex("page::1")

interface Project {
  root: string;
  distDir: string;
  outDir: string;
  stage: (name: string, code: string) => Promise<string>;
}

const projects: string[] = [];
afterEach(async () => {
  for (const root of projects.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A project with the core's staging dir, as emitServerlessArtifacts hands it over. */
const createProject = async (variant = "pages"): Promise<Project> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-cf-build-components-")),
  );
  projects.push(root);
  const distDir = join(root, "dist");
  const outDir = join(distDir, `.bascik/cloudflare-${variant}`);
  await mkdir(join(outDir, ".staging"), { recursive: true });
  return {
    root,
    distDir,
    outDir,
    stage: async (name, code) => {
      const path = join(outDir, ".staging", `${name}.mjs`);
      await writeFile(path, code, "utf8");
      return path;
    },
  };
};

const inlineJob = (
  id: string,
  stagedPath: string,
  owner: string,
): SiteGraphJob => ({
  id,
  mode: "server",
  source: { kind: "inline", code: "", stagedPath },
  owner,
});

const graphFor = async (
  project: Project,
  components?: SiteGraph["components"],
): Promise<SiteGraph> => {
  const pageJob = await project.stage(
    "page-job",
    `export default () => '<product-card data-bascik-prop-name="Kettle"></product-card>';`,
  );
  return {
    base: "/",
    release: "test-rel",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    publicFiles: [],
    pages: {
      "/catalog": {
        path: "/catalog",
        is404: false,
        segments: [
          { kind: "static", text: "<main>" },
          { kind: "script", id: PAGE_JOB_ID },
          { kind: "static", text: "</main>" },
        ],
        jobs: {
          [PAGE_JOB_ID]: inlineJob(
            PAGE_JOB_ID,
            pageJob,
            "server script in src/pages/catalog.html:3",
          ),
        },
      },
    },
    apiRoutes: [],
    importRoot: project.root,
    ...(components ? { components } : {}),
  };
};

const runBuild = (project: Project, graph: SiteGraph) =>
  build({
    graph,
    distDir: project.distDir,
    outDir: project.outDir,
    projectRoot: project.root,
    variant: "pages",
    log: () => {},
    runtimeEntry: "",
  });

/** The generated entry with the machine-specific paths replaced. */
const readEntry = async (project: Project): Promise<string> =>
  (await readFile(join(project.outDir, ".staging", "worker-entry.mjs"), "utf8"))
    .replace(/"[^"]*\/runtime\.(?:ts|js)"/, '"<runtime>"')
    .replaceAll(project.root, "<root>");

/**
 * The entry HEAD emits for a site without request-time components (prompt
 * 157 must not move one byte of it): the graph literal and nothing else.
 */
const STATIC_ENTRY = [
  'import { createCloudflareWorker } from "<runtime>";',
  "const graph = {",
  '  base: "/",',
  "  scriptTimeoutMs: 1000,",
  "  apiTimeoutMs: 1000,",
  '  onServerScriptError: "error",',
  '  release: "test-rel",',
  '  pages: { "/catalog": { path: "/catalog", is404: false, segments: [{"kind":"static","text":"<main>"},{"kind":"script","id":"server_script_706167653a3a31"},{"kind":"static","text":"</main>"}], jobs: { "server_script_706167653a3a31": { id: "server_script_706167653a3a31", mode: "server", load: () => import("<root>/dist/.bascik/cloudflare-pages/.staging/page-job.mjs") } } } },',
  "  apiRoutes: [  ],",
  "};",
  "export default createCloudflareWorker(graph);",
].join("\n");

// The security toggles, stripAnsi and renderLimits reach the Worker as
// graph fields the build writes into the entry (Collin 2026-10-29).
describe("build: security settings in worker-entry.mjs", () => {
  it("writes responseSecurity, hideDotfiles, stripAnsi and renderLimits into the graph literal", async () => {
    const project = await createProject();
    const responseSecurity = {
      headers: { "x-frame-options": "DENY" },
      hsts: null,
      privateDynamicPages: false,
    };
    const renderLimits = {
      maxInstances: 5,
      maxOutputLength: 4194304,
      maxNestedScripts: 64,
      maxDepth: 4,
      rescanFactor: 16,
      rescanBase: 33554432,
    };
    await runBuild(project, {
      ...(await graphFor(project)),
      responseSecurity,
      hideDotfiles: false,
      stripAnsi: false,
      renderLimits,
    } as SiteGraph);
    const entry = await readEntry(project);
    expect(entry).toContain(
      `  responseSecurity: ${JSON.stringify(responseSecurity)},`,
    );
    expect(entry).toContain("  hideDotfiles: false,");
    expect(entry).toContain("  stripAnsi: false,");
    expect(entry).toContain(`  renderLimits: ${JSON.stringify(renderLimits)},`);
  });

  it("misuse: a header value with </script>, quotes and U+2028 round-trips as data", async () => {
    const project = await createProject();
    const value = "x</script>\"'\u2028\\";
    const result = await runBuild(project, {
      ...(await graphFor(project)),
      responseSecurity: {
        headers: { "referrer-policy": value },
        hsts: "max-age=1",
        privateDynamicPages: true,
      },
    } as SiteGraph);
    const worker = await readFile(result.workerPath!, "utf8");
    expect(worker).toContain("referrer-policy");
    expect(await readEntry(project)).toContain(JSON.stringify(value));
  });
});

describe("build: request-time components in worker-entry.mjs (prompt 157)", () => {
  it("a site without components emits the entry byte for byte as before, with no components note", async () => {
    const project = await createProject();
    const result = await runBuild(project, await graphFor(project));
    expect(await readEntry(project)).toBe(STATIC_ENTRY);
    expect(await readEntry(project)).not.toContain("componentJobs");
    expect(
      result.notes?.some((note) => note.startsWith("component manifest")),
    ).toBe(false);
  });

  it("a site without components bundles a stub for the component host: no renderer, no node:crypto", async () => {
    const plain = await createProject();
    const plainResult = await runBuild(plain, await graphFor(plain));
    const plainWorker = await readFile(plainResult.workerPath!, "utf8");
    expect(plainWorker).not.toContain("RequestRenderError");
    expect(plainWorker).not.toContain("node:crypto");

    // The same site with a component carries the real host.
    const rendered = await createProject();
    const liveJob = await rendered.stage(
      "live-job",
      `export default () => "";`,
    );
    const renderedResult = await runBuild(
      rendered,
      await graphFor(rendered, {
        manifest: manifestFixture(),
        jobs: {
          [LIVE_ID]: inlineJob(LIVE_ID, liveJob, "server script in x.html:1"),
        },
      }),
    );
    const renderedWorker = await readFile(renderedResult.workerPath!, "utf8");
    expect(renderedWorker).toContain("RequestRenderError");
    expect(renderedWorker).toMatch(/from\s*"node:crypto"/);
    expect(renderedResult.bundleBytes).toBeGreaterThan(
      plainResult.bundleBytes! + 50_000,
    );
  });

  it("an empty components section (no component in the manifest) emits the same entry as no section", async () => {
    const project = await createProject();
    const empty = { ...manifestFixture(), components: {} };
    await runBuild(
      project,
      await graphFor(project, { manifest: empty, jobs: {} }),
    );
    expect(await readEntry(project)).toBe(STATIC_ENTRY);
  });

  it("a manifest with nothing renderable (template-less and unsupported entries only) emits the static entry and the stub, as the runtime would render nothing", async () => {
    const project = await createProject();
    const fixture = manifestFixture();
    const unrenderable: Manifest = {
      ...fixture,
      components: {
        "product-card": {
          ...fixture.components["product-card"],
          unsupported: {
            reason: "attr-binding-to-scoped-attribute",
            detail: "id",
          },
        },
        "product-card-live": fixture.components["product-card-live"],
      },
    };
    const liveJob = await project.stage("live-job", `export default () => "";`);
    const result = await runBuild(
      project,
      await graphFor(project, {
        manifest: unrenderable,
        jobs: {
          [LIVE_ID]: inlineJob(LIVE_ID, liveJob, "server script in x.html:1"),
        },
      }),
    );
    expect(await readEntry(project)).toBe(STATIC_ENTRY);
    const worker = await readFile(result.workerPath!, "utf8");
    expect(worker).not.toContain("RequestRenderError");
    expect(worker).not.toContain("node:crypto");
    expect(
      result.notes?.some((note) => note.startsWith("component manifest")),
    ).toBe(false);
    // The core warning stays silent either way: the adapter can render.
    expect(result.components).toBe(true);
  });

  it("a Worker without a renderable manifest still scopes a page job's output, as Node's runServerScriptJob does", async () => {
    // A page job keeps the output scope of a component placed statically on
    // the page (site-graph.ts copies it from the sidecar) even when no
    // component is renderable at request time, e.g. a <site-nav> whose build
    // script reads BASCIK_PAGE_PATH. Node applies that scope on every
    // request, so the stub host must too, or the Worker sends class names
    // the component's stylesheet does not define.
    const project = await createProject();
    const scoped = await project.stage(
      "scoped-page-job",
      `export default () => '<span class="stock">in stock</span>';`,
    );
    const graph = await graphFor(project);
    const page = graph.pages["/catalog"];
    page.jobs[PAGE_JOB_ID] = {
      ...inlineJob(
        PAGE_JOB_ID,
        scoped,
        "server script in src/pages/catalog.html:3",
      ),
      outputScope: LIVE_SCOPE,
    };
    const result = await runBuild(project, graph);
    const worker = await readFile(result.workerPath!, "utf8");
    // The stub path: no renderer in the bundle.
    expect(worker).not.toContain("RequestRenderError");
    const imported = (await import(pathToFileURL(result.workerPath!).href)) as {
      default: {
        fetch: (
          request: Request,
          env: unknown,
          ctx: unknown,
        ) => Promise<Response>;
      };
    };
    const response = await imported.default.fetch(
      new Request("https://example.test/catalog"),
      { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('class="bascik__product-card-live__stock"');
    expect(html).not.toContain('class="stock"');
  });

  it("emits the manifest as a JSON literal and one componentJobs entry per job, with its output scope and loader", async () => {
    const project = await createProject();
    const manifest = manifestFixture();
    const liveJob = await project.stage(
      "live-job",
      `export default () => '<p class="stock">STOCK_MARKER</p>';`,
    );
    await runBuild(
      project,
      await graphFor(project, {
        manifest,
        jobs: {
          [LIVE_ID]: inlineJob(
            LIVE_ID,
            liveJob,
            "server script in src/components/product-card-live/product-card-live.html:25",
          ),
        },
      }),
    );
    const entry = await readEntry(project);
    expect(entry).toContain(JSON.stringify(manifest));
    expect(entry).toContain("componentJobs");
    expect(entry).toContain(
      `${JSON.stringify(LIVE_ID)}: { id: ${JSON.stringify(LIVE_ID)}, mode: "server", outputScope: ${JSON.stringify(LIVE_SCOPE)}, owner: "server script in src/components/product-card-live/product-card-live.html:25", load: () => import("<root>/dist/.bascik/cloudflare-pages/.staging/live-job.mjs") }`,
    );
    // The owner is what a failing component job's log names (the bundled
    // stack never does); page job literals stay as they were.
    expect(entry).not.toContain('owner: "server script in src/pages/');
    // The page literal itself is unchanged: components belong to no page.
    expect(entry).toContain(
      '"/catalog": { path: "/catalog", is404: false, segments:',
    );
  });

  it("misuse: manifest and owner text with </script>, U+2028/U+2029, quotes, backslashes, ${ and */ round-trips through the emitted module", async () => {
    // CodeQL js/bad-code-sanitization flags the JSON.stringify splices. The
    // entry is a standalone ES module that esbuild bundles, never inline HTML,
    // so `</script>` is inert; ES2019 made U+2028/U+2029 legal in string
    // literals; JSON.stringify escapes quotes, backslashes and control
    // characters. Pin that by importing the emitted literals back.
    const hostile =
      "</script><script>x()</script>\u2028\u2029\"'`${a}*/\\\n<!--";
    const project = await createProject();
    const manifest = manifestFixture();
    manifest.components["product-card"].template!.fileContent.parts = [
      `<article class="bascik__product-card__tile">${hostile}</article>`,
    ];
    manifest.components["product-card"].filePath = `components/${hostile}.html`;
    const liveJob = await project.stage("live-job", "export default () => '';");
    await runBuild(
      project,
      await graphFor(project, {
        manifest,
        jobs: { [LIVE_ID]: inlineJob(LIVE_ID, liveJob, `owner ${hostile}`) },
      }),
    );
    const entry = await readFile(
      join(project.outDir, ".staging", "worker-entry.mjs"),
      "utf8",
    );
    const declaration = (name: string): string => {
      const line = entry
        .split("\n")
        .find((candidate) => candidate.startsWith(`const ${name} = `));
      expect(line, name).toBeDefined();
      return line!;
    };
    const probe = join(project.outDir, ".staging", "probe.mjs");
    await writeFile(
      probe,
      `${declaration("componentManifest")}\n${declaration("componentJobs")}\n` +
        "export { componentManifest, componentJobs };",
      "utf8",
    );
    const imported = (await import(probe)) as {
      componentManifest: Manifest;
      componentJobs: Record<string, { owner: string }>;
    };
    expect(imported.componentManifest).toEqual(manifest);
    expect(imported.componentJobs[LIVE_ID].owner).toBe(`owner ${hostile}`);
  });

  it("bundles the component job's staged source and the manifest into the worker", async () => {
    const project = await createProject();
    const liveJob = await project.stage(
      "live-job",
      `export default () => '<p class="stock">STOCK_MARKER</p>';`,
    );
    const result = await runBuild(
      project,
      await graphFor(project, {
        manifest: manifestFixture(),
        jobs: {
          [LIVE_ID]: inlineJob(LIVE_ID, liveJob, "server script in x.html:1"),
        },
      }),
    );
    const worker = await readFile(result.workerPath!, "utf8");
    expect(worker).toContain("STOCK_MARKER");
    expect(worker).toContain(".bascik__product-card__tile{color:rgb(1,2,3)}");
    expect(worker).toContain(LIVE_ID);
  });

  it("declares components: true and reports the manifest's bytes in a note", async () => {
    const project = await createProject();
    const manifest = manifestFixture();
    const liveJob = await project.stage(
      "live-job",
      `export default () => "stock";`,
    );
    const result = await runBuild(
      project,
      await graphFor(project, {
        manifest,
        jobs: {
          [LIVE_ID]: inlineJob(LIVE_ID, liveJob, "server script in x.html:1"),
        },
      }),
    );
    expect(result.components).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
    const note = result.notes?.find((n) => n.startsWith("component manifest"));
    expect(note).toBe(`component manifest: ${bytes} bytes (2 components)`);
  });

  it("is deterministic: two builds of the same component graph emit the same entry", async () => {
    const project = await createProject();
    const liveJob = await project.stage("live-job", `export default () => "";`);
    const graph = await graphFor(project, {
      manifest: manifestFixture(),
      jobs: {
        [LIVE_ID]: inlineJob(LIVE_ID, liveJob, "server script in x.html:1"),
      },
    });
    await runBuild(project, graph);
    const first = await readEntry(project);
    await runBuild(project, graph);
    expect(await readEntry(project)).toBe(first);
  });

  it("misuse: a component script importing an unsupported builtin fails the bundle naming the component file", async () => {
    const project = await createProject();
    const forked = await project.stage(
      "forked-job",
      `import { execFile } from "node:child_process";\nexport default () => typeof execFile;`,
    );
    const owner =
      "server script in src/components/forked-card/forked-card.html:3";
    await expect(
      runBuild(
        project,
        await graphFor(project, {
          manifest: manifestFixture(),
          jobs: { [LIVE_ID]: inlineJob(LIVE_ID, forked, owner) },
        }),
      ),
    ).rejects.toThrow(
      /"node:child_process"[\s\S]*src\/components\/forked-card\/forked-card\.html:3/,
    );
  });

  it("misuse: a component script importing a provided builtin (node:crypto) bundles as an external", async () => {
    const project = await createProject();
    const hashing = await project.stage(
      "hash-job",
      `import { createHash } from "node:crypto";\nexport default () => createHash("sha256").update("x").digest("hex");`,
    );
    const result = await runBuild(
      project,
      await graphFor(project, {
        manifest: manifestFixture(),
        jobs: {
          [LIVE_ID]: inlineJob(LIVE_ID, hashing, "server script in x.html:1"),
        },
      }),
    );
    const worker = await readFile(result.workerPath!, "utf8");
    expect(worker).toMatch(/from\s*"node:crypto"/);
    // The runtime imports createHash from the same builtin (prompt 157), so
    // esbuild may suffix the job's binding (createHash2): the call is the
    // job's own either way.
    expect(worker).toMatch(/createHash\d*\("sha256"\)\.update\("x"\)/);
  });
});

describe("runsWorkerFirst: the authored run_worker_first that sends every request to the Worker", () => {
  it("true, or a list with /* (or the base's /shop/*) and no exclusion", async () => {
    const { runsWorkerFirst } = await import("./build.ts");
    expect(runsWorkerFirst({ run_worker_first: true }, "/")).toBe(true);
    expect(runsWorkerFirst({ run_worker_first: ["/*"] }, "/")).toBe(true);
    expect(runsWorkerFirst({ run_worker_first: ["/shop/*"] }, "/shop/")).toBe(
      true,
    );
  });

  it("anything narrower, absent or malformed leaves the static headers to _headers", async () => {
    const { runsWorkerFirst } = await import("./build.ts");
    expect(runsWorkerFirst(undefined, "/")).toBe(false);
    expect(runsWorkerFirst({}, "/")).toBe(false);
    expect(runsWorkerFirst({ run_worker_first: false }, "/")).toBe(false);
    expect(runsWorkerFirst({ run_worker_first: "true" }, "/")).toBe(false);
    expect(runsWorkerFirst({ run_worker_first: ["/api/*"] }, "/")).toBe(false);
    expect(
      runsWorkerFirst({ run_worker_first: ["/*", "!/assets/*"] }, "/"),
    ).toBe(false);
  });
});
