/**
 * The Node host for request-time component rendering (prompt 157, D4):
 * `request-render-node.ts` supplies the name hash (`getAttributeNameHash`
 * when the manifest was built with `minify.identifiers`, identity otherwise),
 * a `node:crypto` hex hash for ids, ONE `ScriptJob` per component job id
 * built from the sidecar at manifest load (so a component script is one
 * module with shared state, never one per request), and a component-job
 * runner that goes through `runServerScriptJob` with the parent's remaining
 * budget and the configured `scripts.onServerScriptError` policy.
 * `server-scripts.ts` wires it in: `executeServerScriptPlan` and
 * `streamServerScripts` take the manifest and wrap the runner, and
 * `runServerScriptJob` applies a job's output scope.
 *
 * Real component scripts run here through the ScriptRegistry (as in
 * server-scripts.test.ts); the manifests are built from fixture components.
 *
 * Misuse lens: a nested job that throws, returns undefined or a number, hangs
 * past the budget, is aborted mid-flight, or is named by the manifest but
 * missing from the sidecar (a stale dist); each pins a located message or the
 * documented empty slot, never a placeholder marker in the response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    minify: { identifiers: false, html: false, css: false, js: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    scripts: {
      cache: { enabled: true },
      onBuildScriptError: "error",
      onServerScriptError: "error",
      timeout: 30000,
    },
    components: { external: [] },
  },
  shouldLog: vi.fn(() => true),
}));

// Counts the page scans `minify.html` needs; the real scan still runs.
vi.mock("./html-minifier.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./html-minifier.ts")>();
  return { ...actual, fragmentContexts: vi.fn(actual.fragmentContexts) };
});

import { BascikConfig } from "./config.ts";
import { ServerScriptError } from "./build-error.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import { fragmentContexts } from "./html-minifier.ts";
import { getAttributeNameHash } from "./names.ts";
import { decodeOutputScope } from "./output-scope.ts";
import {
  createNodeRenderHost,
  hashHex,
  hashNameFor,
  loadComponentJobs,
} from "./request-render-node.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import { scriptRegistry } from "./script-registry.ts";
import {
  executeServerScriptPlan,
  planServerScripts,
  streamServerScripts,
} from "./server-scripts.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ComponentList } from "./types.ts";

type MutableConfig = {
  directory: { out: string };
  minify: { identifiers: boolean };
  scripts: { onServerScriptError: "error" | "warn" | "ignore" };
  components: { external: string[] };
};
const config = BascikConfig as unknown as MutableConfig;

const hex = (text: string): string => Buffer.from(text).toString("hex");
const componentScriptId = (name: string, ordinal: number): string =>
  `component_script_${hex(`${name}::${ordinal}`)}`;
const PAGE_FILE = "src/pages/catalog.html";
const request = () => new Request("http://localhost/catalog?q=1");
const context = { remoteIp: "127.0.0.1" };
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A component whose only script is `body`, on line 2 of the file. */
const scripted = (
  name: string,
  tag: string,
  className: string,
  body: string,
  directive = "server",
) => ({
  fileName: `src/components/${name}.html`,
  fileContent: `<${tag} class="${className}">\n<script data-bascik-${directive}>\n${body}\n</script></${tag}>`,
  cssFileContent: `.${className} { margin: 0 } .line { color: red } b { font-weight: bold }`,
});

const cards = (): ComponentList => ({
  "srv-card": scripted(
    "srv-card",
    "div",
    "wrap",
    `export default () => '<b>bold</b><p class="line">from server</p>';`,
  ),
  "count-card": scripted(
    "count-card",
    "i",
    "n",
    `let n = 0;\nexport default () => String(++n);`,
  ),
  "throw-card": scripted(
    "throw-card",
    "div",
    "wrap",
    `export default () => {\n  throw new Error("nested boom");\n};`,
  ),
  "undef-card": scripted(
    "undef-card",
    "p",
    "u",
    `export default () => undefined;`,
  ),
  "num-card": scripted("num-card", "p", "num", `export default () => 42;`),
  // Settles only after the abort it is told about, like the hung-script
  // fixture in server-scripts.test.ts: once the deadline has fired, the
  // timeout is the outcome however the handler settles afterwards.
  "wait-card": scripted(
    "wait-card",
    "div",
    "wait",
    `export default async (request, context, { signal }) => { await new Promise((resolve) => { signal.addEventListener("abort", resolve); }); return "late"; };`,
  ),
  "abort-card": scripted(
    "abort-card",
    "div",
    "ab",
    `export default (request, context, { signal }) => { globalThis.__bascikNestedStarted = true; return new Promise((resolve) => { signal.addEventListener("abort", () => { globalThis.__bascikNestedAborted = true; resolve(""); }); }); };`,
  ),
  "echo-card": scripted(
    "echo-card",
    "div",
    "echo",
    `export default () => '<plain-card data-bascik-prop-t="deep"></plain-card>';`,
  ),
  "plain-card": {
    fileName: "src/components/plain-card.html",
    fileContent: `<section class="plain"><span class="t" data-bascik-prop-t>none</span></section>`,
    cssFileContent: ".plain { color: green } .t { font-weight: bold }",
  },
});

const build = async (): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(cards(), BascikConfig);
};

/**
 * `text` as a JavaScript string literal that is safe inside a <script>
 * element: JSON.stringify leaves "<" and ">" as they are, and a "</script"
 * in the literal would end the element. A "\uXXXX" escape is the same
 * character to the script; the line separators are escaped too, so the
 * literal stays one line for any parser.
 */
const scriptString = (text: string): string =>
  JSON.stringify(text).replace(
    /[<>\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** A page whose one server script returns `body`. */
const serverPage = (body: string): string =>
  `<main><script data-bascik-server>export default () => ${scriptString(body)};</script></main>`;
/** A page whose one stream script returns `body`, after a static head. */
const streamPage = (body: string): string =>
  `<p>head</p><script data-bascik-stream>export default () => ${scriptString(body)};</script><p>tail</p>`;

const render = async (
  html: string,
  manifest: ComponentManifest | null | undefined,
  timeoutMs = 1000,
): Promise<string> =>
  (
    await executeServerScriptPlan(
      planServerScripts(html, PAGE_FILE),
      request(),
      context,
      timeoutMs,
      PAGE_FILE,
      manifest,
    )
  ).toString("utf8");

const makeSink = () => {
  const writes: Buffer[] = [];
  return {
    sink: {
      write: vi.fn(async (b: Buffer) => {
        writes.push(b);
      }),
    },
    text: () => Buffer.concat(writes).toString("utf8"),
  };
};

const stream = async (
  html: string,
  manifest: ComponentManifest | null | undefined,
  signal?: AbortSignal,
  timeoutMs = 1000,
) => {
  const { sink, text } = makeSink();
  const streamer = streamServerScripts(
    planServerScripts(html, PAGE_FILE),
    request(),
    context,
    timeoutMs,
    PAGE_FILE,
    sink,
    signal,
    manifest,
  );
  return { streamer, text };
};

const globals = globalThis as {
  __bascikNestedStarted?: boolean;
  __bascikNestedAborted?: boolean;
};

beforeEach(() => {
  config.directory.out = "dist";
  config.minify.identifiers = false;
  config.scripts.onServerScriptError = "error";
  config.components.external = [];
  serverSidecarRegistry.clear();
  scriptRegistry.clear();
  clearScopingTemplates();
  delete globals.__bascikNestedStarted;
  delete globals.__bascikNestedAborted;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host dependencies", () => {
  it("hashNameFor picks getAttributeNameHash when the manifest was built with identifiers, identity otherwise", async () => {
    const plain = await build();
    expect(plain.identifiers).toBe(false);
    expect(hashNameFor(plain)("bascik__srv-card__wrap")).toBe(
      "bascik__srv-card__wrap",
    );
    config.minify.identifiers = true;
    const hashed = await build();
    expect(hashed.identifiers).toBe(true);
    expect(hashNameFor(hashed)("bascik__srv-card__wrap")).toBe(
      getAttributeNameHash("bascik__srv-card__wrap"),
    );
  });

  it("hashNameFor is one bounded hasher per manifest, never the build's process-wide cache (request ids are in the names it hashes)", async () => {
    config.minify.identifiers = true;
    const hashed = await build();
    const hash = hashNameFor(hashed);
    expect(hash).not.toBe(getAttributeNameHash);
    expect(hashNameFor(hashed)).toBe(hash);
    for (const name of ["bascik__srv-card__wrap", "bascik__x__r1234567__y"])
      expect(hash(name)).toBe(getAttributeNameHash(name));
  });

  it("createNodeRenderHost salts ids with the decoded route: a percent-encoded spelling of a page is the same route", async () => {
    const manifest = await build();
    for (const spelling of ["/c%61talog", "/%63%61talog", "/catalog"]) {
      const host = createNodeRenderHost(manifest, {
        request: new Request(`http://localhost${spelling}?q=1`),
        context,
        timeoutMs: 1000,
        filePath: PAGE_FILE,
      });
      expect(host.httpPath, spelling).toBe("/catalog");
    }
    // Misuse: a malformed escape is kept as written, never a throw.
    const host = createNodeRenderHost(manifest, {
      request: new Request("http://localhost/c%E0talog"),
      context,
      timeoutMs: 1000,
      filePath: PAGE_FILE,
    });
    expect(host.httpPath).toBe("/c%E0talog");
  });

  it("hashHex is the sha256 hex digest", () => {
    expect(hashHex("abc")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
    expect(hashHex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loadComponentJobs builds one job per component job id from the sidecar, once per manifest", async () => {
    const manifest = await build();
    const jobs = loadComponentJobs(manifest);
    const ids = Object.values(manifest.components)
      .flatMap((entry) => entry.jobs)
      .map((job) => job.id)
      .sort();
    expect(ids).toContain(componentScriptId("srv-card", 1));
    expect(Object.keys(jobs).sort()).toEqual(ids);
    const srv = jobs[componentScriptId("srv-card", 1)];
    expect(srv.mode).toBe("server");
    expect(srv.scriptContent).toContain("from server");
    expect(srv.sourceFile).toBe("src/components/srv-card.html");
    expect(srv.sourceLine).toBe(2);
    expect(srv.placeholderId).toBe(componentScriptId("srv-card", 1));
    // One ScriptJob per id for the manifest's lifetime: module state is shared.
    expect(loadComponentJobs(manifest)).toBe(jobs);
  });

  it("a manifest naming a job the sidecar lacks (stale dist) fails at load with a located message, naming the job, the component file and `bascik --build`", async () => {
    const manifest = await build();
    serverSidecarRegistry.clear();
    const id = componentScriptId("srv-card", 1);
    expect(() => loadComponentJobs(manifest)).toThrow(id);
    expect(() => loadComponentJobs(manifest)).toThrow(
      /\(components\/srv-card\.html/,
    );
    expect(() => loadComponentJobs(manifest)).toThrow(/bascik --build/);
    expect(() => loadComponentJobs(manifest)).toThrow(/components\.json/);
  });

  it("the stale-artifact messages name the configured output directory's private folder, not dist/", async () => {
    config.directory.out = "public-out";
    const manifest = await build();
    serverSidecarRegistry.clear();
    expect(() => loadComponentJobs(manifest)).toThrow(
      ".bascik/public-out/components.json",
    );
    expect(() => loadComponentJobs(manifest)).not.toThrow(/\bdist\//);
    // Production boot passes the directory as it names it in its own messages.
    expect(() => loadComponentJobs(manifest, "build/site")).toThrow(
      "build/.bascik/site/components.json",
    );
  });

  it("the first request against such a manifest fails the same way and never renders a marker or placeholder", async () => {
    const manifest = await build();
    serverSidecarRegistry.clear();
    const pending = render(serverPage(`<srv-card></srv-card>`), manifest);
    await expect(pending).rejects.toThrow(componentScriptId("srv-card", 1));
    await expect(pending).rejects.toThrow(/bascik --build/);
  });

  it("createNodeRenderHost reads the route from the request and the hash from the manifest", async () => {
    const manifest = await build();
    const host = createNodeRenderHost(manifest, {
      request: request(),
      context,
      timeoutMs: 1000,
      filePath: PAGE_FILE,
    });
    expect(host.manifest).toBe(manifest);
    expect(host.httpPath).toBe("/catalog");
    expect(host.timeoutMs).toBe(1000);
    expect(host.hashHex("abc")).toBe(hashHex("abc"));
    expect(host.hashName("bascik__srv-card__wrap")).toBe(
      "bascik__srv-card__wrap",
    );
    expect(host.externalTags("srv-card")).toBe(false);
    const out = await host.runComponentJob(
      componentScriptId("srv-card", 1),
      new AbortController().signal,
      1000,
    );
    // The job's output scope is applied by runServerScriptJob: the class
    // mapping and the element class from the component's stylesheet.
    const scope = decodeOutputScope(
      manifest.components["srv-card"].jobs[0].outputScope,
    )!;
    expect(out).toBe(
      `<b class="${scope.elements.b}">bold</b><p class="${scope.classes.line}">from server</p>`,
    );
  });
});

describe("executeServerScriptPlan and streamServerScripts with a manifest", () => {
  it("renders a component returned by a page server script, with the nested job's output scoped; without the manifest the tag passes through verbatim", async () => {
    const manifest = await build();
    const scope = decodeOutputScope(
      manifest.components["srv-card"].jobs[0].outputScope,
    )!;
    const out = await render(serverPage(`<srv-card></srv-card>`), manifest);
    expect(out.startsWith("<main>")).toBe(true);
    expect(out.endsWith("</main>")).toBe(true);
    expect(out).toContain(`<div class="bascik__srv-card__wrap">`);
    expect(out).toContain(
      `<b class="${scope.elements.b}">bold</b><p class="${scope.classes.line}">from server</p>`,
    );
    expect(out).toContain("<style>");
    expect(out).not.toContain("text/bascik-server");
    expect(out).not.toContain("bascik-job");
    expect(out).not.toContain("<srv-card");

    expect(await render(serverPage(`<srv-card></srv-card>`), undefined)).toBe(
      `<main><srv-card></srv-card></main>`,
    );
    expect(await render(serverPage(`<srv-card></srv-card>`), null)).toBe(
      `<main><srv-card></srv-card></main>`,
    );
  });

  it("the page helpers embed any body intact, a </script> in it included", async () => {
    // serverPage and streamPage write `body` into a <script> element, where
    // a raw "</script>" would end the element and cut the page script short.
    const body = `<p>x</p><script>go("</script >")</script>`;
    expect(await render(serverPage(body), undefined)).toBe(
      `<main>${body}</main>`,
    );
    const { streamer, text } = await stream(streamPage(body), undefined);
    await expect(streamer.ready).resolves.toBeUndefined();
    streamer.commit();
    await streamer.done;
    expect(text()).toBe(`<p>head</p>${body}<p>tail</p>`);
  });

  it("renders a component returned by a page stream script", async () => {
    const manifest = await build();
    const { streamer, text } = await stream(
      streamPage(`<srv-card></srv-card>`),
      manifest,
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    const out = text();
    expect(out.startsWith("<p>head</p>")).toBe(true);
    expect(out.endsWith("<p>tail</p>")).toBe(true);
    expect(out).toContain(`<div class="bascik__srv-card__wrap">`);
    expect(out).toContain(`>from server</p>`);
    expect(out).not.toContain("text/bascik-server");
  });

  it("a component script is one module across requests: its state is shared", async () => {
    const manifest = await build();
    const first = await render(
      serverPage(`<count-card></count-card>`),
      manifest,
    );
    const second = await render(
      serverPage(`<count-card></count-card>`),
      manifest,
    );
    expect(first).toContain(`<i class="bascik__count-card__n">\n1</i>`);
    expect(second).toContain(`<i class="bascik__count-card__n">\n2</i>`);
  });

  it("a nested job's output is rendered again through the same host", async () => {
    const manifest = await build();
    const out = await render(serverPage(`<echo-card></echo-card>`), manifest);
    expect(out).toContain(`<div class="bascik__echo-card__echo">`);
    expect(out).toContain(`<span class="bascik__plain-card__t">deep</span>`);
    expect(out).not.toContain("<plain-card");
  });

  it("the unresolved-tag dev log fires once per (route, tag) across requests, naming the route and the tag, and never for components.external", async () => {
    const manifest = await build();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    config.components.external = ["my-widget"];
    const body = `<server-crad>t</server-crad><my-widget>w</my-widget>`;
    expect(await render(serverPage(body), manifest)).toBe(
      `<main>${body}</main>`,
    );
    expect(await render(serverPage(body), manifest)).toBe(
      `<main>${body}</main>`,
    );
    const messages = warn.mock.calls.map((call) => call.join(" "));
    const unresolved = messages.filter((m) => m.includes("<server-crad>"));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toContain(`"/catalog"`);
    expect(messages.some((m) => m.includes("my-widget"))).toBe(false);
  });

  it("the dev log is once per (route, tag) per manifest: a later publication that still lacks the component, such as one after it was deleted, logs it again", async () => {
    // A tag logged before its component existed must be logged again once
    // the component is deleted; each dev publication builds a new manifest.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = `<late-card>t</late-card>`;
    const unresolved = () =>
      warn.mock.calls
        .map((call) => call.join(" "))
        .filter((m) => m.includes("<late-card>"));

    const before = await build();
    await render(serverPage(body), before);
    await render(serverPage(body), before);
    expect(unresolved()).toHaveLength(1);

    clearScopingTemplates();
    serverSidecarRegistry.clear();
    const withIt = await buildComponentManifest(
      {
        ...cards(),
        "late-card": {
          fileName: "src/components/late-card.html",
          fileContent: `<p class="late">here</p>`,
        },
      },
      BascikConfig,
    );
    const rendered = await render(serverPage(body), withIt);
    expect(rendered).toContain("here");
    expect(rendered).not.toContain("<late-card");
    expect(unresolved()).toHaveLength(1);

    const afterDelete = await build();
    expect(await render(serverPage(body), afterDelete)).toBe(
      `<main>${body}</main>`,
    );
    expect(unresolved()).toHaveLength(2);
    expect(unresolved()[1]).toContain(`"/catalog"`);
  });
});

describe.each(["error", "warn", "ignore"] as const)(
  "nested job outcomes under onServerScriptError %s",
  (policy) => {
    beforeEach(() => {
      config.scripts.onServerScriptError = policy;
    });

    it("returning undefined yields an empty slot and keeps the parent", async () => {
      const manifest = await build();
      const out = await render(
        serverPage(`<undef-card></undef-card>`),
        manifest,
      );
      expect(out).toContain(`<p class="bascik__undef-card__u">\n</p>`);
      expect(out).not.toContain("undefined");
    });

    it("returning a non-string is stringified like a page job", async () => {
      const manifest = await build();
      const out = await render(serverPage(`<num-card></num-card>`), manifest);
      expect(out).toContain(`<p class="bascik__num-card__num">\n42</p>`);
    });

    it("a throwing nested job follows the policy: error rejects the server parent with a message naming the route, the component file and line; warn and ignore keep the parent with an empty slot", async () => {
      const manifest = await build();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const pending = render(serverPage(`<throw-card></throw-card>`), manifest);
      if (policy === "error") {
        await expect(pending).rejects.toThrow(/nested boom/);
        await expect(pending).rejects.toThrow(
          /server script error at "\/catalog"/,
        );
        await expect(pending).rejects.toThrow(
          /src\/components\/throw-card\.html:\d+/,
        );
        return;
      }
      const out = await pending;
      expect(out).toContain(`<div class="bascik__throw-card__wrap">\n</div>`);
      expect(out).not.toContain("nested boom");
      expect(out).not.toContain("text/bascik-server");
      if (policy === "warn") {
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain(`server script error at "/catalog"`);
        expect(message).toMatch(/src\/components\/throw-card\.html:\d+/);
        expect(message).toContain("nested boom");
      } else {
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      }
    });
  },
);

describe("stream parents, budgets and aborts", () => {
  it("a throwing nested job in a stream parent under error yields an empty slot and is logged at error severity, naming the component file", async () => {
    const manifest = await build();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { streamer, text } = await stream(
      streamPage(`<throw-card></throw-card>`),
      manifest,
    );
    await expect(streamer.ready).resolves.toBeUndefined();
    streamer.commit();
    await streamer.done;
    expect(text()).toBe("<p>head</p><p>tail</p>");
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain(`server script error at "/catalog"`);
    expect(message).toMatch(/src\/components\/throw-card\.html:\d+/);
  });

  it("a nested job runs under the parent's remaining budget: started after 40 ms of 50 ms it times out at about 50 ms with the standard timeout error", async () => {
    const manifest = await build();
    config.scripts.onServerScriptError = "warn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = `<main><script data-bascik-server>export default async () => { await new Promise((r) => setTimeout(r, 40)); return '<wait-card></wait-card>'; };</script></main>`;
    const started = performance.now();
    const out = await render(html, manifest, 50);
    const elapsed = performance.now() - started;
    expect(out).toContain(`<div class="bascik__wait-card__wait">\n</div>`);
    expect(out).not.toContain("late");
    expect(elapsed).toBeLessThan(150);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    const budget = /timed out after (\d+)ms/.exec(message);
    expect(budget).not.toBeNull();
    expect(Number(budget![1])).toBeGreaterThanOrEqual(1);
    expect(Number(budget![1])).toBeLessThanOrEqual(12);
    expect(message).toMatch(/src\/components\/wait-card\.html/);
  });

  it("the budget handed to runComponentJob is the one the script runs under", async () => {
    const manifest = await build();
    config.scripts.onServerScriptError = "warn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = createNodeRenderHost(manifest, {
      request: request(),
      context,
      timeoutMs: 1000,
      filePath: PAGE_FILE,
    });
    const out = await host.runComponentJob(
      componentScriptId("wait-card", 1),
      new AbortController().signal,
      1,
    );
    expect(out).toBe("");
    expect(String(warn.mock.calls[0]?.[0])).toContain("timed out after 1ms");
  });

  it("aborting the request aborts a nested job in flight through the runner's own signal", async () => {
    const manifest = await build();
    const abort = new AbortController();
    const { streamer, text } = await stream(
      streamPage(`<abort-card></abort-card>`),
      manifest,
      abort.signal,
    );
    await streamer.ready;
    streamer.commit();
    for (let i = 0; i < 50 && !globals.__bascikNestedStarted; i++) await tick();
    expect(globals.__bascikNestedStarted).toBe(true);
    expect(globals.__bascikNestedAborted).toBeUndefined();
    abort.abort();
    await streamer.done;
    expect(globals.__bascikNestedAborted).toBe(true);
    expect(text()).toBe("<p>head</p>");
  });
});

// A fired deadline wins on Node as it does on the Worker: a page script, a
// stream script or a component script that resolves synchronously inside its
// own abort listener at the deadline is a timeout under the policy, never a
// success with what it returned ("late" must not reach the response). The
// scripts are plain functions returning a native promise, so nothing but the
// rule decides the outcome.
const RESOLVES_ON_ABORT = `export default (request, context, { signal }) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve("late"), { once: true }); });`;

describe.each(["error", "warn", "ignore"] as const)(
  "a fired deadline wins under onServerScriptError %s",
  (policy) => {
    beforeEach(() => {
      config.scripts.onServerScriptError = policy;
    });

    const buildWithYield = async (): Promise<ComponentManifest> => {
      clearScopingTemplates();
      serverSidecarRegistry.clear();
      return buildComponentManifest(
        {
          ...cards(),
          "yield-card": scripted("yield-card", "div", "y", RESOLVES_ON_ABORT),
        },
        BascikConfig,
      );
    };

    const expectTimeoutUnderPolicy = async (
      pending: Promise<string>,
      warn: ReturnType<typeof vi.spyOn>,
      error: ReturnType<typeof vi.spyOn>,
    ): Promise<string | undefined> => {
      if (policy === "error") {
        await expect(pending).rejects.toThrow(/timed out after \d+ms/);
        return undefined;
      }
      const out = await pending;
      expect(out).not.toContain("late");
      if (policy === "warn") {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/timed out after \d+ms/);
      } else {
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      }
      return out;
    };

    it("misuse: a page server script that resolves inside its abort listener at the deadline is a timeout", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = `<main><script data-bascik-server>${RESOLVES_ON_ABORT}</script></main>`;
      const out = await expectTimeoutUnderPolicy(
        render(html, null, 50),
        warn,
        error,
      );
      if (out !== undefined) expect(out).toBe("<main></main>");
    });

    it("misuse: a component job that resolves inside its abort listener at the deadline is a timeout, located at the component", async () => {
      const manifest = await buildWithYield();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const out = await expectTimeoutUnderPolicy(
        render(serverPage(`<yield-card></yield-card>`), manifest, 50),
        warn,
        error,
      );
      if (out !== undefined)
        expect(out).toContain(`<div class="bascik__yield-card__y">\n</div>`);
      if (policy === "warn")
        expect(String(warn.mock.calls[0][0])).toMatch(
          /src\/components\/yield-card\.html/,
        );
    });

    it("misuse: a stream script that resolves its chunk inside its abort listener at the deadline is an empty slot, reported as a timeout", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { streamer, text } = await stream(
        `<p>head</p><script data-bascik-stream>${RESOLVES_ON_ABORT}</script><p>tail</p>`,
        null,
        undefined,
        50,
      );
      await streamer.ready;
      streamer.commit();
      await streamer.done;
      expect(text()).toBe("<p>head</p><p>tail</p>");
      // After commit an error-policy failure is logged at error severity.
      const reported = policy === "error" ? error : warn;
      if (policy === "ignore") {
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } else {
        expect(reported).toHaveBeenCalledTimes(1);
        expect(String(reported.mock.calls[0][0])).toMatch(
          /timed out after \d+ms/,
        );
      }
    });
  },
);

// D4.6: a request-time render failure (an instance, size, depth or nested-job
// budget, or a "failed during <stage>" render failure) is a script failure
// like any other, so `scripts.onServerScriptError` decides it: "error" is a
// 500 for a server script and the stream error behavior for a stream script,
// "warn" and "ignore" are an empty slot, and "warn" logs. The report is the
// located message every server-script error uses (route, component file),
// never a stack of Bascik internals.
describe.each(["error", "warn", "ignore"] as const)(
  "a request-time render failure under onServerScriptError %s",
  (policy) => {
    beforeEach(() => {
      config.scripts.onServerScriptError = policy;
    });

    const withSelfCard = () =>
      buildComponentManifest(
        {
          ...cards(),
          // A component whose script returns itself: the depth budget stops it.
          "self-card": scripted(
            "self-card",
            "div",
            "self",
            `export default () => "<self-card></self-card>";`,
          ),
          "two-card": repeatsSlot("two-card", 2),
          "four-card": repeatsSlot("four-card", 4),
          "wide-card": repeatsSlot("wide-card", 200),
        },
        BascikConfig,
      );
    // Components whose default slot repeats, to multiply the slot content
    // the script passes: twice renders over the 4 MiB limit, four times
    // grows past the loop's tripwire, 200 times passes the engine's string
    // limit while the instance is built (a "failed during" stage failure).
    const repeatsSlot = (name: string, times: number) => ({
      fileName: `src/components/${name}.html`,
      fileContent: `<div class="r">${"<i data-bascik-slot></i>".repeat(times)}</div>`,
    });
    const slotted = (tag: string, length: number) =>
      `${scriptString(`<${tag}>`)} + "x".repeat(${length}) + ${scriptString(`</${tag}>`)}`;
    const LIMIT = 4 * 1024 * 1024;
    const failures: Array<{
      label: string;
      /** The page script's return expression. */
      expr: string;
      message: RegExp;
      /** The component file named, or null when the message names none. */
      file: RegExp | null;
    }> = [
      {
        label: "the instance budget",
        expr: scriptString("<plain-card></plain-card>".repeat(1001)),
        message: /expands to more than 1000 component instances/,
        file: /[ (]components\/plain-card\.html/,
      },
      {
        label: "the depth budget",
        expr: scriptString("<self-card></self-card>"),
        message: /nests component scripts deeper than 4 levels/,
        file: /[ (]components\/self-card\.html/,
      },
      {
        label: "the rendered size budget",
        expr: slotted("two-card", 2_500_000),
        message:
          /rendered to \d+ characters, over the 4 MiB \(4194304 characters\) limit per script output/,
        file: /[ (]components\/two-card\.html/,
      },
      {
        label: "the expansion tripwire",
        expr: slotted("four-card", 2_500_000),
        message: /grew past \d+ characters while expanding components/,
        file: /[ (]components\/four-card\.html/,
      },
      {
        label: "the written size refusal",
        expr: `"x".repeat(${2 * LIMIT + 1}) + ${scriptString("<plain-card></plain-card>")}`,
        message:
          /characters before rendering, over twice the 4 MiB \(4194304 characters\) limit per script output, and has component tags in it/,
        file: null,
      },
      {
        label: "a failed during <stage> render failure",
        expr: slotted("wide-card", 3_000_000),
        message:
          /Rendering <wide-card> \(components\/wide-card\.html\) from (?:server|stream)-script output at "\/catalog" failed during slot resolution: Invalid string length/,
        file: /[ (]components\/wide-card\.html/,
      },
    ];

    /** The report is located and carries no Bascik-internal stack frames. */
    const expectLocated = (message: string, failure: (typeof failures)[0]) => {
      expect(message).toContain(`server script error at "/catalog"`);
      expect(message).toMatch(failure.message);
      if (failure.file) expect(message).toMatch(failure.file);
      else expect(message).not.toMatch(/\(<[a-z-]+>, /);
      expect(message).not.toContain("RequestRenderError");
      expect(message).not.toMatch(/request-render\.(?:ts|js)/);
      expect(message).not.toMatch(/^\s+at /m);
    };

    for (const failure of failures) {
      it(`misuse: a server script output over ${failure.label} follows the policy (500 under error, an empty slot under warn and ignore)`, async () => {
        const manifest = await withSelfCard();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const pending = render(
          `<main><script data-bascik-server>export default () => ${failure.expr};</script></main>`,
          manifest,
        );
        if (policy === "error") {
          const thrown = await pending.then(
            () => undefined,
            (reason: unknown) => reason,
          );
          expect(thrown).toBeInstanceOf(ServerScriptError);
          expectLocated((thrown as Error).message, failure);
          return;
        }
        const out = await pending;
        expect(out).toBe("<main></main>");
        if (policy === "warn") {
          expect(warn).toHaveBeenCalledTimes(1);
          expectLocated(String(warn.mock.calls[0][0]), failure);
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        expect(error).not.toHaveBeenCalled();
      });

      it(`misuse: a stream script output over ${failure.label} leaves its slot empty and reports under the policy like any stream failure`, async () => {
        const manifest = await withSelfCard();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { streamer, text } = await stream(
          `<p>head</p><script data-bascik-stream>export default () => ${failure.expr};</script><p>tail</p>`,
          manifest,
        );
        await expect(streamer.ready).resolves.toBeUndefined();
        streamer.commit();
        await streamer.done;
        expect(text()).toBe("<p>head</p><p>tail</p>");
        const reported =
          policy === "error" ? error : policy === "warn" ? warn : undefined;
        if (reported) {
          expect(reported).toHaveBeenCalledTimes(1);
          expectLocated(String(reported.mock.calls[0][0]), failure);
        }
        if (policy !== "error") expect(error).not.toHaveBeenCalled();
        if (policy !== "warn") expect(warn).not.toHaveBeenCalled();
      });
    }
  },
);

describe("a client abort stays an abort", () => {
  it("misuse: a stream script and a nested job that resolve inside their abort listener when the client goes away yield nothing and log nothing, as on the Worker", async () => {
    const manifest = await buildComponentManifest(
      {
        ...cards(),
        "yield-card": scripted(
          "yield-card",
          "div",
          "y",
          `export default (request, context, { signal }) => { globalThis.__bascikNestedStarted = true; return new Promise((resolve) => { signal.addEventListener("abort", () => resolve("late"), { once: true }); }); };`,
        ),
      },
      BascikConfig,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const abort = new AbortController();
    const { streamer, text } = await stream(
      streamPage(`<yield-card></yield-card>`),
      manifest,
      abort.signal,
    );
    await streamer.ready;
    streamer.commit();
    for (let i = 0; i < 50 && !globals.__bascikNestedStarted; i++) await tick();
    expect(globals.__bascikNestedStarted).toBe(true);
    abort.abort();
    await streamer.done;
    expect(text()).toBe("<p>head</p>");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("the page scan for minify.html", () => {
  /** Calls that scan a whole page (no outer context), not one fragment. */
  const pageScans = () =>
    vi.mocked(fragmentContexts).mock.calls.filter((call) => !call[2]).length;

  it("runs once per stored plan, not once per request, on the buffered and the stream path", async () => {
    const manifest = { ...(await build()), minifyHtml: true };
    for (const html of [
      serverPage(`<srv-card></srv-card>`),
      streamPage(`<srv-card></srv-card>`),
    ]) {
      const plan = planServerScripts(html, PAGE_FILE);
      vi.mocked(fragmentContexts).mockClear();
      const outputs: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (plan.firstStreamIndex === -1) {
          outputs.push(
            (
              await executeServerScriptPlan(
                plan,
                request(),
                context,
                1000,
                PAGE_FILE,
                manifest,
              )
            ).toString("utf8"),
          );
        } else {
          const { sink, text } = makeSink();
          const streamer = streamServerScripts(
            plan,
            request(),
            context,
            1000,
            PAGE_FILE,
            sink,
            undefined,
            manifest,
          );
          await streamer.ready;
          streamer.commit();
          await streamer.done;
          outputs.push(text());
        }
      }
      expect(pageScans()).toBe(1);
      for (const out of outputs) {
        expect(out).toContain(`<div class="bascik__srv-card__wrap">`);
        expect(out).not.toContain("<srv-card");
      }
    }
  });

  it("a different plan for the same text is scanned on its own", async () => {
    const manifest = { ...(await build()), minifyHtml: true };
    vi.mocked(fragmentContexts).mockClear();
    for (let i = 0; i < 2; i++)
      await executeServerScriptPlan(
        planServerScripts(serverPage(`<srv-card></srv-card>`), PAGE_FILE),
        request(),
        context,
        1000,
        PAGE_FILE,
        manifest,
      );
    expect(pageScans()).toBe(2);
  });
});
