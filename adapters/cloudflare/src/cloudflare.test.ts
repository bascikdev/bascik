/**
 * Prompt 134: the emitted Cloudflare bundle executes in local workerd with the
 * original source tree unavailable, static requests bypass compute, dynamic
 * routes cannot bypass execution, and bindings/cookies/cache/errors have
 * tested contracts.
 *
 * The first test is the fault-injection control: the invocation routes are
 * replaced with an empty list so a dynamic page falls through to assets. That
 * MUST 404 (the template is private), proving the "raw static fallback looks
 * like success" failure mode is impossible by construction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildServerlessFixture,
  cleanupServerlessFixture,
  componentScriptId,
  createServerlessFixture,
} from "./serverless-fixture.test-helper.ts";
import {
  createCloudflareWorker,
  createGraphJobRunner,
  type ComponentManifest,
  type GraphPage,
  type GraphScriptJob,
  type SiteGraph,
} from "./runtime.ts";
import {
  createGate,
  startHarness,
  type Harness,
  type DeployTarget,
} from "./cloudflare-harness.test-helper.ts";

const TARGETS: DeployTarget[] = ["cloudflare-pages", "cloudflare-workers"];

describe.each(TARGETS)("cloudflare adapter in local workerd (%s)", (target) => {
  let root: string;
  let harness: Harness;
  const gate = createGate();

  beforeAll(async () => {
    root = await createServerlessFixture(`adapter-${target}`);
    await buildServerlessFixture(root, target);
    // The source tree is gone before the worker ever starts: only the
    // deployment folder and dist/ remain.
    await rm(join(root, "src"), { recursive: true, force: true });
    await rename(join(root, "node_modules"), join(root, "node_modules.hidden"));
    harness = await startHarness({
      projectRoot: root,
      target,
      bindings: { GREETING: "kv-hello" },
      gate,
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.dispose();
    if (root) await cleanupServerlessFixture(root);
  });

  it("control: a dynamic page that bypasses the worker is a 404, never an inert placeholder document", async () => {
    const bypass = await startHarness({
      projectRoot: root,
      target,
      invocationRoutes: ["/never-matches"],
    });
    try {
      const res = await bypass.fetch("/account");
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("text/bascik-server");
      expect(text).not.toContain("account-greeting");
    } finally {
      await bypass.dispose();
    }
  });

  it("static requests are served by the asset layer with the built bytes", async () => {
    const res = await harness.fetch("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-testid="static-heading"');
    const css = await harness.fetch("/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const asset = await harness.fetch("/assets/logo.txt");
    expect(await asset.text()).toBe("logo bytes\n");
  });

  it("an unknown path is the authored 404 page from assets", async () => {
    const res = await harness.fetch("/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('data-testid="not-found"');
  });

  it("a buffered server page composes per request, reads the binding, and derives remoteIp from the platform header only", async () => {
    const res = await harness.fetch("/account", {
      headers: { "x-display-name": "Jane", "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain("Hello Jane via cloudflare (kv-hello)");
    expect(html).not.toContain("9.9.9.9");
    expect(html).not.toContain("text/bascik-server");
    // Every alias reaches the same composition.
    for (const alias of ["/account/", "/account.html"]) {
      const aliased = await harness.fetch(alias, {
        headers: { "x-display-name": "Alias" },
      });
      expect(aliased.status, alias).toBe(200);
      expect(await aliased.text()).toContain("Hello Alias");
    }
  });

  it("per-request isolation: concurrent requests never see each other's headers", async () => {
    const names = ["A", "B", "C", "D", "E", "F"];
    const bodies = await Promise.all(
      names.map((n) =>
        harness
          .fetch("/account", { headers: { "x-display-name": n } })
          .then((r) => r.text()),
      ),
    );
    bodies.forEach((body, i) =>
      expect(body).toContain(`Hello ${names[i]} via`),
    );
  });

  it("HEAD on a dynamic page returns headers with content-length and no body", async () => {
    const res = await harness.fetch("/account", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("a non GET/HEAD method on a page is 405 with Allow", async () => {
    const res = await harness.fetch("/account", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("a mixed server + stream page streams the shell before the gated job resolves, then the rest in order", async () => {
    const streamed = await harness.streamed("/dashboard");
    expect(streamed.status).toBe(200);
    expect(streamed.headers["content-length"]).toBeUndefined();
    expect(streamed.headers["cache-control"]).toBe("private, no-store");
    const first = await streamed.first();
    expect(first.text).toContain('data-testid="shell"');
    expect(first.text).toContain("Shell 日本 🚀");
    // Everything before the gated job flows while it is still pending: the
    // src= server job (relative import + @/ alias + transitive helper) and the
    // fast stream fragment. Wait for the fast fragment on a bounded watchdog.
    const prefix = await streamed.until("fast-fragment");
    expect(prefix).toContain('data-testid="header-job"');
    expect(prefix).toContain("<label>hdr</label>");
    expect(prefix).toContain("<em>/dashboard</em>");
    expect(prefix).toContain('data-testid="alias-job"');
    expect(prefix).toContain("<label>alias</label>");
    expect(prefix).not.toContain("slow-fragment");
    gate.release();
    const chunks = await streamed.all();
    const body = chunks.map((c) => c.text).join("");
    expect(body.indexOf("fast-fragment")).toBeLessThan(
      body.indexOf("slow-fragment"),
    );
    expect(body.indexOf("slow-fragment")).toBeLessThan(
      body.indexOf('data-testid="tail"'),
    );
    expect(body).toContain("slow ünï");
    expect(body).not.toContain("text/bascik-server");
  });

  it("a stream job that fails after commit yields an empty slot and the document completes", async () => {
    const res = await harness.fetch("/broken-stream");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="before"');
    expect(html).toContain('data-testid="after"');
    expect(html).not.toContain("failed on purpose");
  });

  it("a server job that fails before commit is the authored 500 page with no detail leaked", async () => {
    const res = await harness.fetch("/broken-server");
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('data-testid="server-error"');
    expect(html).not.toContain("SECRET_DETAIL");
  });

  describe("API routes", () => {
    it("static and dynamic routes dispatch with params and the platform context", async () => {
      const health = await harness.fetch("/api/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const user = await harness.fetch("/api/users/42");
      expect(await user.json()).toMatchObject({
        id: "42",
        platform: "cloudflare",
      });
    });

    it("method policy: 405 + Allow, auto OPTIONS 204 without CORS, derived HEAD", async () => {
      const put = await harness.fetch("/api/users/1", { method: "PUT" });
      expect(put.status).toBe(405);
      expect(put.headers.get("allow")).toBe("DELETE, GET, HEAD, OPTIONS");
      const options = await harness.fetch("/api/users/1", {
        method: "OPTIONS",
      });
      expect(options.status).toBe(204);
      expect(options.headers.get("allow")).toBe("DELETE, GET, HEAD, OPTIONS");
      expect(options.headers.get("access-control-allow-origin")).toBeNull();
      const head = await harness.fetch("/api/users/1", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const del = await harness.fetch("/api/users/1", { method: "DELETE" });
      expect(del.status).toBe(204);
    });

    it("POST bodies round-trip and multiple Set-Cookie headers survive", async () => {
      const res = await harness.fetch("/api/echo", {
        method: "POST",
        body: "payload ünï",
      });
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("payload ünï");
      expect(res.headers.getSetCookie()).toEqual([
        "a=1; Path=/",
        "b=2; Path=/",
      ]);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("a streamed API body arrives as chunks", async () => {
      const streamed = await harness.streamed("/api/stream");
      const chunks = await streamed.all();
      expect(chunks.map((c) => c.text).join("")).toBe(
        "chunk1\nchunk2\nchunk3\n",
      );
    });

    it("a thrown handler is a generic 500 with nothing leaked", async () => {
      const res = await harness.fetch("/api/boom");
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("Internal Server Error");
      expect(text).not.toContain("SECRET_DETAIL");
    });

    it("an unknown API path is a 404 and never falls through to a static file", async () => {
      const res = await harness.fetch("/api/missing");
      expect(res.status).toBe(404);
    });
  });

  it("private artifacts are unreachable: metadata, sidecar, and worker code never come back", async () => {
    for (const path of [
      "/.bascik/server-scripts.json",
      "/.bascik/manifest.json",
      "/_worker.js",
      "/_routes.json",
      "/worker.js",
      "/wrangler.jsonc",
    ]) {
      const res = await harness.fetch(path);
      expect(res.status, path).not.toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain("createCloudflareWorker");
      expect(text, path).not.toContain('"scripts"');
    }
    // A dynamic page alias is the worker's, never a public file.
    const alias = await harness.fetch("/dashboard.html", {
      headers: { "x-display-name": "x" },
    });
    expect(alias.status).toBe(200);
    expect(await alias.text()).not.toContain("text/bascik-server");
  });

  it("traversal and hidden paths never reach private files", async () => {
    // The WHATWG URL parser inside the Worker normalizes `%2e%2e` before the
    // handler runs (a browser does the same), so an encoded traversal is just
    // the normalized path: it can resolve a page, never a private artifact.
    const normalized = await harness.streamed(
      "/api/%2e%2e/.bascik/server-scripts.json",
    );
    expect(normalized.status).not.toBe(200);
    const raw = await harness.streamed("/..%2f.bascik/manifest.json");
    expect(raw.status).not.toBe(200);
    expect((await harness.fetch("/.env")).status).toBe(404);
    expect((await harness.fetch("/.bascik/")).status).toBe(404);
  });

  it("serves the RFC 8615 /.well-known/ directory and keeps its dot children private", async () => {
    const res = await harness.fetch("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Contact: mailto:security@example.com\n");
    const hidden = await harness.fetch("/.well-known/.private/secret.txt");
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("well-known private marker");
  });
});

describe("cloudflare adapter: missing binding diagnostics", () => {
  it("a page that reads an absent binding still renders with the documented fallback", async () => {
    const root = await createServerlessFixture("no-binding");
    let harness: Harness | undefined;
    try {
      await buildServerlessFixture(root, "cloudflare-pages");
      harness = await startHarness({
        projectRoot: root,
        target: "cloudflare-pages",
      });
      const res = await harness.fetch("/account");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("(none)");
    } finally {
      await harness?.dispose();
      await cleanupServerlessFixture(root);
    }
  }, 120_000);
});

// ─── Request-time components (prompt 157) ───────────────────────────────────

const LIVE_ID = componentScriptId("product-card-live");
const STOCK_SCOPE = encodeURIComponent(
  JSON.stringify({
    classes: { stock: "bascik__product-card-live__stock" },
    elements: {},
  }),
);
const EMPTY_MANIFEST: ComponentManifest = {
  schema: 1,
  identifiers: false,
  minifyHtml: false,
  base: "/",
  inheritAttributes: true,
  components: {},
};

const job = (
  id: string,
  handler: unknown,
  extra: Partial<GraphScriptJob> = {},
): GraphScriptJob => ({
  id,
  mode: "server",
  load: async () => ({ default: handler }),
  ...extra,
});

const unitGraph = (
  overrides: Partial<SiteGraph> & {
    componentJobs?: Record<string, GraphScriptJob>;
  } = {},
): SiteGraph => {
  const { componentJobs, ...rest } = overrides;
  return {
    base: "/",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    pages: {},
    apiRoutes: [],
    release: "test",
    ...(componentJobs
      ? { components: { manifest: EMPTY_MANIFEST, jobs: componentJobs } }
      : {}),
    ...rest,
  };
};

const unitPage = (jobs: Record<string, GraphScriptJob> = {}): GraphPage => ({
  path: "/catalog",
  is404: false,
  segments: [],
  jobs,
});

const runnerFor = (
  graph: SiteGraph,
  page: GraphPage = unitPage(),
  log: (message: string) => void = () => {},
) =>
  createGraphJobRunner(
    page,
    graph,
    new Request("https://example.test/catalog"),
    {
      remoteIp: "",
      platform: { name: "cloudflare", env: {}, waitUntil: () => {} },
    },
    log,
  );

describe("createGraphJobRunner: component jobs (prompt 157)", () => {
  it("resolves a component job on a page whose own jobs are empty and applies its output scope", async () => {
    const run = runnerFor(
      unitGraph({
        componentJobs: {
          [LIVE_ID]: job(LIVE_ID, () => '<p class="stock">in stock</p>', {
            outputScope: STOCK_SCOPE,
          }),
        },
      }),
    );
    await expect(run(LIVE_ID, new AbortController().signal)).resolves.toBe(
      '<p class="bascik__product-card-live__stock">in stock</p>',
    );
  });

  it("applies the output scope a page job carries too (a component placed statically), as Node does", async () => {
    const pageJob = job("server_script_x", () => '<p class="stock">s</p>', {
      outputScope: STOCK_SCOPE,
    });
    const run = runnerFor(unitGraph(), unitPage({ server_script_x: pageJob }));
    await expect(
      run("server_script_x", new AbortController().signal),
    ).resolves.toBe('<p class="bascik__product-card-live__stock">s</p>');
  });

  it("a component job runs under the graph's script deadline", async () => {
    const run = runnerFor(
      unitGraph({
        scriptTimeoutMs: 40,
        componentJobs: {
          [LIVE_ID]: job(LIVE_ID, () => new Promise(() => {})),
        },
      }),
    );
    await expect(run(LIVE_ID, new AbortController().signal)).rejects.toThrow(
      /Handler timed out after 40ms/,
    );
  });

  it("policy: a throwing component job rejects under error, logs and yields empty under warn, yields empty silently under ignore", async () => {
    const throwing = {
      [LIVE_ID]: job(LIVE_ID, () => {
        throw new Error("nested failed on purpose");
      }),
    };
    await expect(
      runnerFor(unitGraph({ componentJobs: throwing }))(
        LIVE_ID,
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      /server script error at "\/catalog"[\s\S]*nested failed on purpose/,
    );

    const warned: string[] = [];
    await expect(
      runnerFor(
        unitGraph({ onServerScriptError: "warn", componentJobs: throwing }),
        unitPage(),
        (m) => warned.push(m),
      )(LIVE_ID, new AbortController().signal),
    ).resolves.toBe("");
    expect(warned).toEqual([
      expect.stringContaining("nested failed on purpose"),
    ]);

    const ignored: string[] = [];
    await expect(
      runnerFor(
        unitGraph({ onServerScriptError: "ignore", componentJobs: throwing }),
        unitPage(),
        (m) => ignored.push(m),
      )(LIVE_ID, new AbortController().signal),
    ).resolves.toBe("");
    expect(ignored).toEqual([]);
  });

  it("misuse: a component script without a default export names its job id, like a page job", async () => {
    const run = runnerFor(
      unitGraph({
        componentJobs: {
          [LIVE_ID]: {
            id: LIVE_ID,
            mode: "server",
            load: async () => ({ render: () => "x" }) as never,
          },
        },
      }),
    );
    await expect(run(LIVE_ID, new AbortController().signal)).rejects.toThrow(
      `Server script "${LIVE_ID}" does not export a default function.`,
    );
  });

  it("strips ANSI escapes from page and component job output, before the output scope, as runServerScriptJob does on Node", async () => {
    const run = runnerFor(
      unitGraph({
        componentJobs: {
          [LIVE_ID]: job(
            LIVE_ID,
            () => '<p class="stock">\u001b[31mred\u001b[0m</p>',
            { outputScope: STOCK_SCOPE },
          ),
        },
      }),
      unitPage({
        server_script_x: job(
          "server_script_x",
          () => "\u001b]0;title\u0007plain \u001b[1mbold\u001b[22m\u001bM",
        ),
      }),
    );
    const signal = new AbortController().signal;
    await expect(run(LIVE_ID, signal)).resolves.toBe(
      '<p class="bascik__product-card-live__stock">red</p>',
    );
    await expect(run("server_script_x", signal)).resolves.toBe("plain bold");
  });

  it("misuse: a failing component job's message names its component file (the bundled stack never does): a throw, a timeout and a missing default export, under error and warn", async () => {
    const OWNER =
      "server script in src/components/product-card-live/product-card-live.html:25";
    const located =
      /\n {4}in the server script in src\/components\/product-card-live\/product-card-live\.html:25$/;
    const failing: Array<[string, GraphScriptJob, RegExp]> = [
      [
        "throw",
        job(
          LIVE_ID,
          () => {
            throw new Error("nested failed on purpose");
          },
          { owner: OWNER },
        ),
        /nested failed on purpose/,
      ],
      [
        "timeout",
        job(LIVE_ID, () => new Promise(() => {}), { owner: OWNER }),
        /Handler timed out after 30ms/,
      ],
      [
        "no default export",
        {
          id: LIVE_ID,
          mode: "server",
          owner: OWNER,
          load: async () => ({ render: () => "x" }) as never,
        },
        new RegExp(
          `Server script "${LIVE_ID}" does not export a default function\\.`,
        ),
      ],
    ];
    for (const [label, failingJob, cause] of failing) {
      const graph = {
        scriptTimeoutMs: 30,
        componentJobs: { [LIVE_ID]: failingJob },
      };
      const error = await runnerFor(unitGraph(graph))(
        LIVE_ID,
        new AbortController().signal,
      ).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message, label).toMatch(cause);
      expect(error?.message, label).toMatch(located);
      const warned: string[] = [];
      await runnerFor(
        unitGraph({ ...graph, onServerScriptError: "warn" }),
        unitPage(),
        (m) => warned.push(m),
      )(LIVE_ID, new AbortController().signal);
      expect(warned, label).toEqual([expect.stringMatching(located)]);
    }
    // A page job has no owner in the graph: its message is as before.
    const pageError = await runnerFor(
      unitGraph(),
      unitPage({
        server_script_x: job("server_script_x", () => {
          throw new Error("page failed");
        }),
      }),
    )("server_script_x", new AbortController().signal).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(pageError?.message).toMatch(/page failed/);
    expect(pageError?.message).not.toContain("in the server script in");
  });

  it("misuse: an already aborted request yields an empty component output, never a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = runnerFor(
      unitGraph({
        componentJobs: { [LIVE_ID]: job(LIVE_ID, () => "never") },
      }),
    );
    await expect(run(LIVE_ID, controller.signal)).resolves.toBe("");
  });

  it("misuse: an id in neither the page nor the components section still throws the deployment-graph message", async () => {
    for (const graph of [
      unitGraph(),
      unitGraph({ componentJobs: { [LIVE_ID]: job(LIVE_ID, () => "") } }),
    ]) {
      await expect(
        runnerFor(graph)("component_script_typo", new AbortController().signal),
      ).rejects.toThrow(
        '[bascik] server script job "component_script_typo" is missing from the deployment graph.',
      );
    }
  });
});

/**
 * The Worker handler in-process, with the manifest a real build wrote and
 * hand-made jobs, so a test can hold a nested job open, abort the request
 * under it, and measure the budget it was given.
 */
describe("createCloudflareWorker: components rendered from a built manifest (prompt 157)", () => {
  let root: string;
  let manifest: ComponentManifest;

  beforeAll(async () => {
    root = await createServerlessFixture("components-inprocess", {
      components: true,
    });
    await buildServerlessFixture(root, "cloudflare-pages");
    manifest = JSON.parse(
      await readFile(join(root, "dist/.bascik/components.json"), "utf8"),
    ) as ComponentManifest;
  }, 120_000);

  afterAll(async () => {
    if (root) await cleanupServerlessFixture(root);
  });

  const liveScope = () =>
    manifest.components["product-card-live"].jobs[0].outputScope;

  const workerFor = (
    pageHandler: unknown,
    nested: GraphScriptJob["load"],
    overrides: Partial<SiteGraph> = {},
    log: (message: string) => void = () => {},
  ) =>
    createCloudflareWorker(
      {
        ...unitGraph(overrides),
        pages: {
          "/catalog": {
            path: "/catalog",
            is404: false,
            segments: [
              { kind: "static", text: "<main>" },
              { kind: "script", id: "server_script_page" },
              { kind: "static", text: "</main>" },
            ],
            jobs: {
              server_script_page: job("server_script_page", pageHandler),
            },
          },
        },
        components: {
          manifest,
          jobs: {
            [LIVE_ID]: {
              id: LIVE_ID,
              mode: "server",
              outputScope: liveScope(),
              load: nested,
            },
          },
        },
      },
      { log },
    );

  const ctx = { waitUntil: () => {} };
  // Without minify.html a component's own comments (its `@bascik` usage
  // sample spells the tag) are emitted with each instance, as at build time:
  // author text, not an unrendered tag.
  const markup = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");
  const LIVE_TAG =
    '<product-card-live data-bascik-prop-name="Kettle"></product-card-live>';

  it("wraps the page runner: a returned tag is rendered with its nested job's scoped output", async () => {
    const worker = workerFor(
      () => LIVE_TAG,
      async () => ({
        default: () => '<p class="stock" data-testid="stock">in stock</p>',
      }),
    );
    const res = await worker.fetch(
      new Request("https://example.test/catalog"),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(markup(html)).not.toContain("<product-card-live");
    expect(html).toContain("Kettle");
    expect(html).toContain(
      '<p class="bascik__product-card-live__stock" data-testid="stock">in stock</p>',
    );
  });

  it("misuse: a percent-encoded spelling of the route renders the same ids as the plain one (workerd normalizes, Node does not)", async () => {
    const worker = workerFor(
      () => LIVE_TAG + LIVE_TAG,
      async () => ({ default: () => '<p class="stock">s</p>' }),
    );
    const plain = await (
      await worker.fetch(new Request("https://example.test/catalog"), {}, ctx)
    ).text();
    expect(plain).toMatch(/id="bascik__product-card-live__r[0-9a-f]{7}__tile"/);
    for (const spelling of ["/c%61talog", "/%63%61talog", "/%63%61%74alog"]) {
      const res = await worker.fetch(
        new Request(`https://example.test${spelling}`),
        {},
        ctx,
      );
      expect(res.status, spelling).toBe(200);
      expect(await res.text(), spelling).toBe(plain);
    }
  });

  it("misuse: aborting the request mid nested job aborts the nested job's own signal", async () => {
    let nestedSignal: AbortSignal | undefined;
    let started!: () => void;
    const nestedStarted = new Promise<void>((resolve) => (started = resolve));
    const worker = workerFor(
      () => LIVE_TAG,
      async () => ({
        default: (
          _request: Request,
          _context: unknown,
          { signal }: { signal: AbortSignal },
        ) =>
          new Promise((_resolve, reject) => {
            nestedSignal = signal;
            started();
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    );
    const controller = new AbortController();
    const response = worker.fetch(
      new Request("https://example.test/catalog", {
        signal: controller.signal,
      }),
      {},
      ctx,
    );
    const settled = response.then(
      () => "settled",
      () => "settled",
    );
    expect(
      await Promise.race([nestedStarted.then(() => "started"), settled]),
      "the nested job never started: the returned tag was not rendered",
    ).toBe("started");
    expect(nestedSignal?.aborted).toBe(false);
    controller.abort();
    await response.catch(() => undefined);
    expect(nestedSignal?.aborted).toBe(true);
  });

  it("budget: a nested job gets what is left of the page's deadline, not a fresh one", async () => {
    const worker = workerFor(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return LIVE_TAG;
      },
      async () => ({ default: () => new Promise(() => {}) }),
      { scriptTimeoutMs: 300 },
    );
    const started = Date.now();
    const res = await worker.fetch(
      new Request("https://example.test/catalog"),
      {},
      ctx,
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(500);
    // A fresh 300 ms deadline for the nested job would end near 450 ms.
    expect(elapsed).toBeLessThan(420);
  });

  it.each(["warn", "ignore"] as const)(
    "policy %s: a throwing nested job leaves its slot empty and keeps the parent's card",
    async (policy) => {
      const logged: string[] = [];
      const worker = workerFor(
        () => LIVE_TAG,
        async () => ({
          default: () => {
            throw new Error("nested failed on purpose SECRET_DETAIL");
          },
        }),
        { onServerScriptError: policy },
        (m) => logged.push(m),
      );
      const res = await worker.fetch(
        new Request("https://example.test/catalog"),
        {},
        ctx,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(markup(html)).not.toContain("<product-card-live");
      expect(html).toContain("Kettle");
      expect(html).not.toContain("SECRET_DETAIL");
      expect(logged.some((m) => m.includes("SECRET_DETAIL"))).toBe(
        policy === "warn",
      );
    },
  );

  it("policy error: a throwing nested job is the 500 page", async () => {
    const worker = workerFor(
      () => LIVE_TAG,
      async () => ({
        default: () => {
          throw new Error("nested failed on purpose SECRET_DETAIL");
        },
      }),
    );
    const res = await worker.fetch(
      new Request("https://example.test/catalog"),
      {},
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("SECRET_DETAIL");
  });
});

// The same nested-failure policies end to end in workerd: the bundle carries
// the policy the site was built with.
describe.each(["warn", "ignore"] as const)(
  "cloudflare adapter in local workerd: a nested job that throws under %s (prompt 157)",
  (policy) => {
    let root: string;
    let harness: Harness;

    beforeAll(async () => {
      root = await createServerlessFixture(`components-${policy}`, {
        components: true,
        onServerScriptError: policy,
      });
      await buildServerlessFixture(root, "cloudflare-pages");
      harness = await startHarness({
        projectRoot: root,
        target: "cloudflare-pages",
      });
    }, 180_000);

    afterAll(async () => {
      await harness?.dispose();
      if (root) await cleanupServerlessFixture(root);
    });

    it("a server parent keeps the rendered card and drops only the nested output", async () => {
      const res = await harness.fetch("/components-boom");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("<boom-card");
      expect(html).toContain('data-testid="boom-card"');
      expect(html).toContain('data-testid="after-boom"');
      expect(html).not.toContain("SECRET_DETAIL");
    });

    it("a stream parent keeps the rendered card and the document completes", async () => {
      const res = await harness.fetch("/components-boom-stream");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("<boom-card");
      expect(html).toContain('data-testid="boom-card"');
      expect(html).toContain('data-testid="tail"');
      expect(html).not.toContain("SECRET_DETAIL");
    });
  },
);
