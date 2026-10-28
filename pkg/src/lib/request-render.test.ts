/**
 * Request-time component rendering (prompt 157, D4): `wrapRunner` wraps a
 * host's `ScriptJobRunner` so that a server or stream script's output is
 * expanded by the compiler's own loop with the build-time manifest as its
 * scope, nested component jobs run with the parent's remaining budget, and
 * the component CSS is emitted in the body before the first instance.
 *
 * The module under test is portable (serverless-contract.test.ts bundles it
 * for the Web); this test builds real manifests with `buildComponentManifest`
 * and renders through a host whose component-job runner is a spy. The build
 * loop (`expandComponents` with the build's scope and the request id minter)
 * is the oracle for everything the request path must reproduce byte for
 * byte; every semantic test runs with `minify.identifiers` on and off, since a
 * substitution renderer passes in dev config and breaks only in built output.
 *
 * Misuse lens: wrong tag spellings, typo'd tags, unsupported components,
 * escaped and attribute-valued tags, marker-shaped and prototype-named props,
 * guessed placeholders, runaway budgets, over-deep nesting, aborted and
 * over-budget nested jobs. Each is pinned to verbatim passthrough, a located
 * `RequestRenderError`, or a once-per-(page, tag) dev log.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    minify: { identifiers: true, html: false, css: false, js: false },
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
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import {
  ComponentExpansionLimitError,
  expandComponents,
} from "./component-expansion-core.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import { rewriteHtmlBasePaths } from "./base-path.ts";
import { minifyHtml } from "./html-minifier.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { deriveInstanceId, getAttributeNameHash } from "./names.ts";
import {
  composeBufferedResponse,
  streamComposedResponse,
  type ExecutionPlan,
  type ExecutionSegment,
  type ScriptJobRunner,
  type StreamWriter,
} from "./request-execution.ts";
import {
  RequestRenderError,
  expandByUsage,
  requestRoutePath,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import {
  clearScopingTemplates,
  scopeComponentInstance,
} from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ComponentList } from "./types.ts";

type MutableConfig = {
  base: string;
  minify: { identifiers: boolean; html: boolean };
  scoping: { deduplicateCss: boolean; inheritAttributes: boolean };
};
const config = BascikConfig as unknown as MutableConfig;

const identity = (input: string): string => input;
const sha256hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");
const hex = (text: string): string => Buffer.from(text).toString("hex");
const componentScriptId = (name: string, ordinal: number): string =>
  `component_script_${hex(`${name}::${ordinal}`)}`;

const PAGE_PATH = "src/pages/catalog.html";
const HTTP_PATH = "/catalog";
/** The request id shape (D2): `r` + 7 hex, disjoint from the build's 8 hex. */
const REQUEST_ID = /^r[0-9a-f]{7}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const staticSeg = (text: string): ExecutionSegment => ({
  kind: "static",
  bytes: enc.encode(text),
});
const scriptSeg = (
  id: string,
  mode: "server" | "stream",
): ExecutionSegment => ({ kind: "script", mode, id });
const planOf = (...segments: ExecutionSegment[]): ExecutionPlan => ({
  segments,
  firstStreamIndex: segments.findIndex(
    (s) => s.kind === "script" && s.mode === "stream",
  ),
});
/** A plan with one server job per id, for direct runner calls. */
const serverPlan = (...ids: string[]): ExecutionPlan =>
  planOf(...ids.map((id) => scriptSeg(id, "server")));

type Deferred = {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};
const deferred = (): Deferred => {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A page-job runner answering each id with a string, a promise or a thunk. */
const runnerFrom = (
  table: Record<string, string | Deferred | (() => Promise<string>)>,
): ScriptJobRunner =>
  vi.fn(async (id: string) => {
    const target = table[id];
    if (target === undefined) throw new Error(`unrouted job ${id}`);
    if (typeof target === "string") return target;
    if (typeof target === "function") return target();
    return target.promise;
  });

const collectingWriter = () => {
  const writes: string[] = [];
  const writer: StreamWriter = {
    write: vi.fn(async (chunk: Uint8Array) => {
      writes.push(dec.decode(chunk));
    }),
  };
  return { writes, writer, text: () => writes.join("") };
};

type TestHost = RenderHost & {
  runComponentJob: Mock<
    (id: string, signal: AbortSignal, timeoutMs: number) => Promise<string>
  >;
  warnOnce: Mock<(key: string, message: string) => void>;
};

// Cast: an override may replace a spy with a plain function (or drop
// `warnOnce` for the production case), which the spread widens to the
// `RenderHost` member type; the tests that read a spy never override it.
const makeHost = (
  manifest: ComponentManifest | null,
  overrides: Partial<RenderHost> = {},
): TestHost =>
  ({
    manifest,
    hashName: manifest?.identifiers ? getAttributeNameHash : identity,
    hashHex: sha256hex,
    httpPath: HTTP_PATH,
    timeoutMs: 1000,
    runComponentJob: vi.fn(async () => ""),
    warnOnce: vi.fn(),
    externalTags: createExternalTagMatcher([]),
    ...overrides,
  }) as TestHost;

const signalOf = () => new AbortController().signal;

/**
 * The fixture components: props, named and default slots, attr bindings onto
 * text and id-reference targets, scoped ids, a class-only client script,
 * nested usages with a forwarded default slot, server and stream scripts,
 * per-instance CSS, a component without a stylesheet, and an unsupported one.
 */
const cards = (): ComponentList => ({
  "server-card": {
    fileName: "src/components/server-card.html",
    fileContent:
      `<article class="card" id="root" title="old" data-bascik-attr-title="t">` +
      `<h2 class="name" data-bascik-prop-name>Untitled</h2>` +
      `<a class="link" href="/default" data-bascik-attr-href="link">go</a>` +
      `<div class="body" data-bascik-slot>default body</div>` +
      `<footer class="foot" data-bascik-slot="foot">no foot</footer>` +
      `<script>document.querySelector(".card").classList.add("ready");</script></article>`,
    cssFileContent:
      ".card { padding: 1px } .name { color: red } .link { color: blue }",
  },
  "plain-card": {
    fileName: "src/components/plain-card.html",
    fileContent: `<section class="plain"><span class="t" data-bascik-prop-t>none</span><div data-bascik-slot="x">dx</div></section>`,
    cssFileContent: ".plain { color: green } .t { font-weight: bold }",
  },
  "slots-card": {
    fileName: "src/components/slots-card.html",
    fileContent: `<section class="s"><div data-bascik-slot="a">a</div><div data-bascik-slot="b">b</div><div data-bascik-slot="c">c</div><div data-bascik-slot="d">d</div></section>`,
    cssFileContent: ".s { color: green }",
  },
  "bare-card": {
    fileName: "src/components/bare-card.html",
    fileContent: `<p class="bare" data-bascik-prop-t>bare</p>`,
  },
  "srv-card": {
    fileName: "src/components/srv-card.html",
    fileContent: `<div class="wrap"><script data-bascik-server>\nexport default () => '<p class="line">from server</p>';\n</script></div>`,
    cssFileContent: ".wrap { margin: 0 } .line { color: red }",
  },
  "stream-card": {
    fileName: "src/components/stream-card.html",
    fileContent: `<div class="wrap"><script data-bascik-stream>export default async () => '<p class="line">streamed</p>';</script><script data-bascik-server>export default () => '<b class="line">second</b>';</script></div>`,
    cssFileContent: ".wrap { margin: 0 } .line { color: red }",
  },
  "ring-card": {
    fileName: "src/components/ring-card.html",
    fileContent: `<svg><clipPath id="ring"></clipPath><circle class="dot"></circle></svg>`,
    cssFileContent: ".dot { clip-path: url(#ring) }",
  },
  "nest-parent": {
    fileName: "src/components/nest-parent.html",
    fileContent: `<section class="outer"><nest-child data-bascik-prop-l="one"></nest-child><nest-child data-bascik-prop-l="two"><div data-bascik-slot>fwd</div></nest-child></section>`,
    cssFileContent: ".outer { color: red }",
  },
  "nest-child": {
    fileName: "src/components/nest-child.html",
    fileContent: `<p id="c" class="c"><span data-bascik-prop-l></span><i data-bascik-slot>fallback</i></p>`,
    cssFileContent: ".c { color: blue } #c { margin: 0 }",
  },
  "bad-id": {
    fileName: "src/components/bad-id.html",
    fileContent: `<div class="w"><span data-bascik-attr-id="v">x</span></div>`,
    cssFileContent: ".w { color: red }",
  },
});

const build = async (
  list: ComponentList = cards(),
): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(list, BascikConfig);
};

const freshState = () => ({
  ordinalMap: new Map<string, number>(),
  issuedIds: new Set<string>(),
});

/**
 * The request id minter (D4): `r` + 7 hex of
 * `httpPath::job:<jobId>::<name>::<ordinal>`, salted like `deriveInstanceId`
 * against the ids already issued for the request.
 */
const mintRequestId = (
  hashHex: (input: string) => string,
  httpPath: string,
  jobId: string,
  name: string,
  ordinal: number,
  issued: Set<string>,
): string => {
  let attempt = 0;
  while (true) {
    const base = `${httpPath}::job:${jobId}::${name}::${ordinal}`;
    const input = attempt === 0 ? base : `${base}::salt:${attempt}`;
    const id = `r${hashHex(input).slice(0, 7)}`;
    if (!issued.has(id)) {
      issued.add(id);
      return id;
    }
    attempt++;
  }
};
const requestId = (jobId: string, name: string, ordinal: number): string =>
  mintRequestId(sha256hex, HTTP_PATH, jobId, name, ordinal, new Set());

/** The style blocks a job's output carries, once per used component with a stylesheet, in use order. */
const styleBlocks = (manifest: ComponentManifest, used: string[]): string => {
  let blocks = "";
  for (const name of [...new Set(used)]) {
    const css = manifest.components[name]?.css;
    if (css && "text" in css) blocks += `<style>${css.text}</style>`;
  }
  return blocks;
};

/**
 * The oracle: the build loop (the build's scope, attr bindings injected
 * before scoping) with the request minter, plus the style blocks the
 * request path prepends. Only for components without server or stream
 * scripts: the build leaves those as raw script tags.
 */
const expectedRender = (
  manifest: ComponentManifest,
  list: ComponentList,
  html: string,
  jobId: string,
  host: RenderHost,
): string => {
  clearScopingTemplates();
  const state = freshState();
  const { transpiledHtmlBody, usedComponents } = expandComponents(html, list, {
    scope: scopeComponentInstance,
    mintId: (name, ordinal) =>
      mintRequestId(
        host.hashHex,
        host.httpPath,
        jobId,
        name,
        ordinal,
        state.issuedIds,
      ),
    injectAttrProps: "before-scope",
    numberSourceUrls: false,
    inheritAttributes: manifest.inheritAttributes,
    instanceState: state,
    limits: BUILD_EXPANSION_LIMITS,
    onError: (component, stage, error) => {
      throw new Error(
        `<${component.name}> failed during ${stage}: ${String(error)}`,
      );
    },
  });
  return (
    styleBlocks(
      manifest,
      usedComponents.map((c) => c.name),
    ) + transpiledHtmlBody
  );
};

const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;

beforeEach(() => {
  config.base = "/";
  config.minify.identifiers = true;
  config.minify.html = false;
  config.scoping.deduplicateCss = true;
  config.scoping.inheritAttributes = true;
  serverSidecarRegistry.clear();
  clearScopingTemplates();
});

describe.each([true, false])(
  "request rendering through the manifest (identifiers %s)",
  (identifiers) => {
    const hashName = identifiers ? getAttributeNameHash : identity;
    const scopedClass = (component: string, name: string) =>
      hashName(`bascik__${component}__${name}`);
    const scopedId = (component: string, id: string, name: string) =>
      hashName(`bascik__${component}__${id}__${name}`);

    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    // 17
    it("wrapRunner is the identity for a null or empty manifest, and an output without '<' is returned untouched", async () => {
      const manifest = await build();
      expect(manifest.identifiers).toBe(identifiers);
      const run = runnerFrom({ a: "plain text, no tags" });
      expect(wrapRunner(run, serverPlan("a"), makeHost(null))).toBe(run);
      expect(
        wrapRunner(
          run,
          serverPlan("a"),
          makeHost({ ...manifest, components: {} }),
        ),
      ).toBe(run);

      const host = makeHost(manifest);
      const wrapped = wrapRunner(run, serverPlan("a"), host);
      expect(wrapped).not.toBe(run);
      expect(await wrapped("a", signalOf())).toBe("plain text, no tags");
      expect(host.runComponentJob).not.toHaveBeenCalled();
      expect(host.warnOnce).not.toHaveBeenCalled();

      // Markup without a component tag is the author's text, verbatim.
      const markup = `<p class="x">no &amp; component</p><!-- note --><br>`;
      const passthrough = wrapRunner(
        runnerFrom({ a: markup }),
        serverPlan("a"),
        host,
      );
      expect(await passthrough("a", signalOf())).toBe(markup);
      expect(host.runComponentJob).not.toHaveBeenCalled();
    });

    // 15
    it("absent/present semantics: an absent text prop keeps its fallback, a present empty named slot is empty, an empty default slot keeps its fallback, a forwarded default slot reaches the nested child, an absent attr binding leaves the original attribute", async () => {
      const list = cards();
      const manifest = await build(list);
      const host = makeHost(manifest);
      const cases = [
        `<server-card></server-card>`,
        `<server-card><div data-bascik-slot="foot"></div></server-card>`,
        `<nest-parent>Hello</nest-parent>`,
      ];
      const outputs: string[] = [];
      for (const html of cases) {
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        const out = await wrapped("a", signalOf());
        expect(out).toBe(expectedRender(manifest, list, html, "a", host));
        outputs.push(out);
      }
      const [absent, emptyNamed, forwarded] = outputs;
      expect(absent).toContain(">Untitled</h2>");
      expect(absent).toContain("default body");
      expect(absent).toContain(`title="old"`);
      expect(absent).toContain(`href="/default"`);
      expect(absent).toContain(`class="${scopedClass("server-card", "card")}"`);
      expect(absent).not.toMatch(/data-bascik-(?:attr|prop|slot)/);
      expect(emptyNamed).not.toContain("no foot");
      expect(emptyNamed).not.toContain("<footer");
      expect(forwarded).toContain("Hello");
      expect(count(forwarded, "fallback")).toBe(1);
      expect(host.runComponentJob).not.toHaveBeenCalled();
    });

    it("tag spellings: <SERVER-CARD>, a self-closing <server-card/>, an unclosed <server-card> at the end of the output and props with quotes render as the build would", async () => {
      const list = cards();
      const manifest = await build(list);
      const host = makeHost(manifest);
      const html =
        `<SERVER-CARD data-bascik-prop-name="say &quot;hi&quot; it's">up</SERVER-CARD>` +
        `<server-card data-bascik-prop-name='q"q'/>` +
        `<p>between</p>` +
        `<server-card data-bascik-prop-name="tail">`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());
      expect(out).toBe(expectedRender(manifest, list, html, "a", host));
      expect(count(out, `class="${scopedClass("server-card", "card")}"`)).toBe(
        3,
      );
      expect(out).toContain("<p>between</p>");
      expect(out).not.toMatch(/<\/?server-card/i);
      expect(out).toContain("tail");
      // One style block for the three instances, before the first.
      expect(count(out, "<style>")).toBe(1);
      expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<article"));
    });

    // 19
    it("security: author directive scripts and guessed placeholders are inert text, &lt;server-card is never expanded, a tag inside an attribute value is not expanded", async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      const guessedPage = `server_script_${hex("src/pages/catalog.html::1")}`;
      const guessedComponent = componentScriptId("srv-card", 1);
      const html =
        `<p>a</p><script data-bascik-server>export default () => "<b>ran</b>";</script>` +
        `<script type="text/bascik-server" data-bascik-server-id="${guessedPage}"></script>` +
        `<script type="text/bascik-server" data-bascik-server-id="${guessedComponent}"></script>` +
        `<script data-bascik-stream>export default () => "s";</script>` +
        `&lt;server-card data-bascik-prop-name="x"&gt;&lt;/server-card&gt;` +
        `<div title="<server-card>" data-x='<srv-card></srv-card>'>attr</div>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());
      expect(out).toBe(html);
      expect(host.runComponentJob).not.toHaveBeenCalled();
      expect(out).not.toContain("bascik-job");
      // Supported component names never trigger the unresolved-tag log,
      // wherever they appear in the author's text.
      expect(host.warnOnce).not.toHaveBeenCalled();
    });

    // 16
    it("marker-shaped prop values, $-sequences in slots and prototype-named props and slots are emitted verbatim and never throw", async () => {
      const list = cards();
      const manifest = await build(list);
      const host = makeHost(manifest);
      const markers = [
        "<!--__BASCIK_NESTED_COMPONENT_0__-->",
        "<!--bascik-job:0123456789abcdef0123456789abcdef:0-->",
        "rsentinel",
        "$&",
        "$'",
        "$1",
        "$$",
      ];
      const slotContent = markers.join(" ");
      const html =
        `<server-card data-bascik-prop-name="${markers.join(" ").replace(/"/g, "&quot;")}" ` +
        `data-bascik-prop-__proto__="P" data-bascik-prop-constructor="C" data-bascik-prop-toString="T">` +
        `${slotContent}<div data-bascik-slot="__proto__">proto slot</div><div data-bascik-slot="foot">${slotContent}</div></server-card>` +
        `<nest-parent data-bascik-prop-constructor="C">${slotContent}</nest-parent>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());
      expect(out).toBe(expectedRender(manifest, list, html, "a", host));
      for (const marker of ["$&", "$'", "$1", "$$", "rsentinel"]) {
        expect(out).toContain(marker);
      }
      expect(out).toContain("<!--__BASCIK_NESTED_COMPONENT_0__-->");
      expect(out).toContain(
        "<!--bascik-job:0123456789abcdef0123456789abcdef:0-->",
      );
      expect(host.runComponentJob).not.toHaveBeenCalled();
    });

    it("a template slot or attr binding named after an Object.prototype member keeps its fallback when the usage does not fill it, and takes the usage's value when it does", async () => {
      const list: ComponentList = {
        ...cards(),
        "proto-card": {
          fileName: "src/components/proto-card.html",
          fileContent:
            `<div class="p"><b data-bascik-slot="constructor">c-fallback</b><i data-bascik-slot="toString">t-fallback</i>` +
            `<a class="l" href="/d" data-bascik-attr-href="toString" title="t" data-bascik-attr-title="valueOf">x</a></div>`,
        },
      };
      const manifest = await build(list);
      expect(manifest.components["proto-card"].unsupported).toBeUndefined();
      const host = makeHost(manifest);
      const html =
        `<proto-card></proto-card>` +
        `<proto-card data-bascik-prop-toString="/given"><div data-bascik-slot="toString">given</div></proto-card>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());
      expect(out).not.toContain("[native code]");
      expect(out).toContain("c-fallback");
      expect(out).toContain("t-fallback");
      expect(out).toContain(`href="/d"`);
      expect(out).toContain(`title="t"`);
      expect(out).toContain("given");
      expect(out).toContain(`href="/given"`);
      expect(out).toBe(expectedRender(manifest, list, html, "a", host));
    });

    // 18
    it("ids: the static page instance, the request instance and the nested instance of one component are three distinct ids", async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      host.runComponentJob.mockImplementation(
        async () => `<server-card></server-card>`,
      );
      const html = `<server-card></server-card><srv-card></srv-card>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());

      const staticInstance = deriveInstanceId(PAGE_PATH, "server-card", 1);
      const requestInstance = requestId("a", "server-card", 1);
      // The nested output is keyed by its parent job and marker site.
      const nestedInstance = requestId("a/0", "server-card", 1);
      expect(staticInstance).toMatch(/^[0-9a-f]{8}$/);
      expect(requestInstance).toMatch(REQUEST_ID);
      expect(nestedInstance).toMatch(REQUEST_ID);
      expect(
        new Set([staticInstance, requestInstance, nestedInstance]).size,
      ).toBe(3);
      expect(out).toContain(
        `id="${scopedId("server-card", requestInstance, "root")}"`,
      );
      expect(out).toContain(
        `id="${scopedId("server-card", nestedInstance, "root")}"`,
      );
      expect(host.runComponentJob).toHaveBeenCalledTimes(1);
    });

    it("ids: two runs with reversed job completion order produce identical bytes", async () => {
      const manifest = await build();
      const usage = (label: string) =>
        `<server-card data-bascik-prop-name="${label}"></server-card><server-card data-bascik-prop-name="${label}2"></server-card>`;
      const plan = planOf(
        staticSeg("<p>a</p>"),
        scriptSeg("a", "server"),
        staticSeg("<p>b</p>"),
        scriptSeg("b", "server"),
      );
      const render = async (order: ["a", "b"] | ["b", "a"]) => {
        const table = { a: deferred(), b: deferred() };
        const host = makeHost(manifest);
        const wrapped = wrapRunner(runnerFrom(table), plan, host);
        const pending = composeBufferedResponse(plan, wrapped);
        await tick();
        for (const id of order) {
          table[id].resolve(usage(id));
          await tick();
        }
        return dec.decode(await pending);
      };
      const first = await render(["a", "b"]);
      const second = await render(["b", "a"]);
      expect(first).toBe(second);
      expect(first).toContain(
        `id="${scopedId("server-card", requestId("a", "server-card", 1), "root")}"`,
      );
      expect(first).toContain(
        `id="${scopedId("server-card", requestId("b", "server-card", 2), "root")}"`,
      );
    });

    it("ids: components returned by sibling nested jobs keep their ids whatever order the nested jobs finish in", async () => {
      // Every <srv-card> instance runs the same component script id, so the
      // nested renders are told apart by the parent job and the marker site,
      // never by which nested job settles first.
      const manifest = await build();
      const html = `<srv-card></srv-card><srv-card></srv-card><srv-card></srv-card>`;
      const render = async (order: number[]) => {
        const pending = [deferred(), deferred(), deferred()];
        let call = 0;
        const host = makeHost(manifest);
        host.runComponentJob.mockImplementation(() => pending[call++].promise);
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        const out = wrapped("a", signalOf());
        await tick();
        expect(host.runComponentJob).toHaveBeenCalledTimes(3);
        for (const i of order) {
          pending[i].resolve(
            `<plain-card data-bascik-prop-t="deep ${i}"></plain-card><server-card></server-card>`,
          );
          await tick();
        }
        return out;
      };
      const forward = await render([0, 1, 2]);
      const reverse = await render([2, 1, 0]);
      const middle = await render([1, 2, 0]);
      expect(reverse).toBe(forward);
      expect(middle).toBe(forward);
      const ids = [...forward.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      // The n-th site's nested output is keyed by "<parent job>/<site>".
      for (const n of [0, 1, 2])
        expect(forward).toContain(
          `id="${scopedId("server-card", requestId(`a/${n}`, "server-card", 1), "root")}"`,
        );
    });

    it("requestRoutePath: the pathname, percent-decoded, so every spelling of a route salts the same ids; a malformed escape stays as written", () => {
      expect(requestRoutePath("https://x.test/catalog?q=1")).toBe("/catalog");
      expect(requestRoutePath("https://x.test/c%61talog")).toBe("/catalog");
      expect(requestRoutePath("https://x.test/%63%61TALOG")).toBe("/caTALOG");
      expect(requestRoutePath("https://x.test/sub/caf%C3%A9")).toBe(
        "/sub/café",
      );
      expect(requestRoutePath("https://x.test/a%2Fb")).toBe("/a/b");
      expect(requestRoutePath("https://x.test/c%E0talog")).toBe("/c%E0talog");
    });

    it("ids: concurrent jobs share one issuedIds set, so a colliding host hash is salted across jobs", async () => {
      const manifest = await build();
      // Every unsalted mint collides; only the salt loop tells instances apart.
      const collidingHashHex = (input: string) =>
        input.includes("::salt:") ? sha256hex(input) : "0".repeat(64);
      const host = makeHost(manifest, { hashHex: collidingHashHex });
      const plan = serverPlan("a", "b");
      const usage = `<server-card></server-card><server-card></server-card>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: usage, b: usage }),
        plan,
        host,
      );
      const out = dec.decode(await composeBufferedResponse(plan, wrapped));
      const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(
        ids.filter((id) => id === scopedId("server-card", "r0000000", "root")),
      ).toHaveLength(1);
    });

    // 20
    it("a nested job's output is rendered again: a component returning a component", async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      host.runComponentJob.mockImplementation(async (id: string) =>
        id === componentScriptId("srv-card", 1)
          ? `<plain-card data-bascik-prop-t="deep"></plain-card>`
          : "",
      );
      const html = `<p>lead</p><srv-card></srv-card>`;
      const wrapped = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        host,
      );
      const signal = signalOf();
      const out = await wrapped("a", signal);
      expect(host.runComponentJob).toHaveBeenCalledTimes(1);
      expect(host.runComponentJob).toHaveBeenCalledWith(
        componentScriptId("srv-card", 1),
        // The render's own signal, linked to the runner's (pinned below).
        expect.any(AbortSignal),
        expect.any(Number),
      );
      expect(out).toContain(`<div class="${scopedClass("srv-card", "wrap")}">`);
      expect(out).toContain(
        `<span class="${scopedClass("plain-card", "t")}">deep</span>`,
      );
      expect(out).not.toContain("text/bascik-server");
      expect(out).not.toContain("bascik-job");
      expect(out).not.toContain("plain-card>");
      // One block per component, each before that component's first instance.
      const plainCss = manifest.components["plain-card"].css;
      const srvCss = manifest.components["srv-card"].css;
      expect(plainCss && "text" in plainCss).toBe(true);
      expect(srvCss && "text" in srvCss).toBe(true);
      const plainBlock = `<style>${(plainCss as { text: string }).text}</style>`;
      const srvBlock = `<style>${(srvCss as { text: string }).text}</style>`;
      expect(count(out, plainBlock)).toBe(1);
      expect(count(out, srvBlock)).toBe(1);
      expect(out.indexOf(plainBlock)).toBeLessThan(
        out.indexOf(`<span class="${scopedClass("plain-card", "t")}">`),
      );
      expect(out.indexOf(srvBlock)).toBeLessThan(
        out.indexOf(`<div class="${scopedClass("srv-card", "wrap")}">`),
      );
    });

    it("nesting depth: a chain of four nested component-returning jobs passes; five fails the job with a RequestRenderError naming the component file", async () => {
      const manifest = await build();
      const chain = (componentReturns: number) => {
        let calls = 0;
        return vi.fn(async () =>
          ++calls <= componentReturns ? `<srv-card></srv-card>` : `<p>leaf</p>`,
        );
      };
      const render = async (componentReturns: number) => {
        const host = makeHost(manifest);
        host.runComponentJob = chain(
          componentReturns,
        ) as TestHost["runComponentJob"];
        const wrapped = wrapRunner(
          runnerFrom({ a: `<srv-card></srv-card>` }),
          serverPlan("a"),
          host,
        );
        return { host, out: wrapped("a", signalOf()) };
      };
      const ok = await render(3);
      await expect(ok.out).resolves.toContain("<p>leaf</p>");
      expect(ok.host.runComponentJob).toHaveBeenCalledTimes(4);
      expect(
        count(await ok.out, `class="${scopedClass("srv-card", "wrap")}"`),
      ).toBe(4);

      const deep = await render(4);
      await expect(deep.out).rejects.toBeInstanceOf(RequestRenderError);
      await expect(deep.out).rejects.toThrow(/src\/components\/srv-card\.html/);
      await expect(deep.out).rejects.toThrow(/\/catalog/);
      await expect(deep.out).rejects.toThrow(/depth/i);
    });

    // 24
    it("a stream script inside a server-returned component resolves with its parent: the buffered output has it, ready waits for it, firstStreamIndex stays -1", async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      const streamId = componentScriptId("stream-card", 1);
      const serverId = componentScriptId("stream-card", 2);
      const pendingStream = deferred();
      host.runComponentJob.mockImplementation(async (id: string) => {
        if (id === streamId) return pendingStream.promise;
        if (id === serverId) return `<b>second</b>`;
        throw new Error(`unexpected nested job ${id}`);
      });
      const plan = planOf(
        staticSeg("<p>a</p>"),
        scriptSeg("a", "server"),
        staticSeg("<p>b</p>"),
      );
      expect(plan.firstStreamIndex).toBe(-1);
      const wrapped = wrapRunner(
        runnerFrom({ a: `<stream-card></stream-card>` }),
        plan,
        host,
      );
      const { writes, writer, text } = collectingWriter();
      const streamer = streamComposedResponse(plan, wrapped, writer);
      let readyState = "pending";
      void streamer.ready.then(() => {
        readyState = "resolved";
      });
      await tick();
      await tick();
      expect(host.runComponentJob).toHaveBeenCalledTimes(2);
      expect(readyState).toBe("pending");
      expect(writes).toEqual([]);
      pendingStream.resolve(`<p>streamed</p>`);
      await streamer.ready;
      expect(readyState).toBe("resolved");
      streamer.commit();
      await streamer.done;
      const body = text();
      expect(body.startsWith("<p>a</p>")).toBe(true);
      expect(body.endsWith("<p>b</p>")).toBe(true);
      expect(body).toContain("<p>streamed</p>");
      expect(body).toContain("<b>second</b>");
      expect(body.indexOf("<p>streamed</p>")).toBeLessThan(
        body.indexOf("<b>second</b>"),
      );
      expect(body).not.toContain("text/bascik-server");
      expect(body).not.toContain("bascik-job");
    });

    // 25 (portable half: the host's runner applies the policy itself)
    it("a throwing nested job rejects a server parent's ready, yields an empty slot and onStreamError in a stream parent; an empty nested output keeps the parent", async () => {
      const manifest = await build();
      const srvId = componentScriptId("srv-card", 1);
      const failing = makeHost(manifest);
      failing.runComponentJob.mockImplementation(async () => {
        throw new Error("nested boom");
      });

      const serverPlanned = planOf(
        staticSeg("<p>a</p>"),
        scriptSeg("a", "server"),
      );
      const asServer = wrapRunner(
        runnerFrom({ a: `<srv-card></srv-card>` }),
        serverPlanned,
        failing,
      );
      await expect(
        composeBufferedResponse(serverPlanned, asServer),
      ).rejects.toThrow("nested boom");
      const streamer = streamComposedResponse(
        serverPlanned,
        asServer,
        collectingWriter().writer,
      );
      await expect(streamer.ready).rejects.toThrow("nested boom");

      const streamPlanned = planOf(
        staticSeg("<p>a</p>"),
        scriptSeg("s", "stream"),
        staticSeg("<p>b</p>"),
      );
      const asStream = wrapRunner(
        runnerFrom({ s: `<srv-card></srv-card>` }),
        streamPlanned,
        failing,
      );
      const onStreamError = vi.fn();
      const { writer, text } = collectingWriter();
      const streamed = streamComposedResponse(streamPlanned, asStream, writer, {
        onStreamError,
      });
      await streamed.ready;
      streamed.commit();
      await streamed.done;
      expect(text()).toBe("<p>a</p><p>b</p>");
      expect(onStreamError).toHaveBeenCalledTimes(1);
      expect((onStreamError.mock.calls[0][0] as Error).message).toContain(
        "nested boom",
      );
      expect(onStreamError.mock.calls[0][1]).toBe("s");

      const empty = makeHost(manifest);
      empty.runComponentJob.mockImplementation(async () => "");
      const kept = wrapRunner(
        runnerFrom({ a: `<srv-card></srv-card>` }),
        serverPlanned,
        empty,
      );
      const out = await kept("a", signalOf());
      expect(empty.runComponentJob).toHaveBeenCalledWith(
        srvId,
        expect.any(AbortSignal),
        expect.any(Number),
      );
      expect(out).toContain(
        `<div class="${scopedClass("srv-card", "wrap")}"></div>`,
      );
      expect(out).not.toContain("text/bascik-server");
    });

    // 26
    describe("CSS is emitted once per response per mode, before the first instance in document order", () => {
      const usage = (label: string) =>
        `<server-card data-bascik-prop-name="${label}"></server-card>`;
      const cardClass = () => `class="${scopedClass("server-card", "card")}"`;
      const block = (manifest: ComponentManifest) =>
        `<style>${(manifest.components["server-card"].css as { text: string }).text}</style>`;

      it("slow-then-fast stream job pair using the same component: exactly one style block, before the first instance", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const plan = planOf(
          staticSeg("<p>a</p>"),
          scriptSeg("s1", "stream"),
          staticSeg("<p>b</p>"),
          scriptSeg("s2", "stream"),
          staticSeg("<p>c</p>"),
        );
        const slow = deferred();
        const wrapped = wrapRunner(
          runnerFrom({ s1: slow, s2: usage("fast") }),
          plan,
          host,
        );
        const { writer, text } = collectingWriter();
        const streamer = streamComposedResponse(plan, wrapped, writer);
        await streamer.ready;
        streamer.commit();
        await tick();
        await tick();
        expect(text()).toBe("<p>a</p>");
        slow.resolve(usage("slow"));
        await streamer.done;
        const body = text();
        expect(count(body, "<style>")).toBe(1);
        expect(count(body, block(manifest))).toBe(1);
        expect(body.indexOf("<style>")).toBeLessThan(body.indexOf("<article"));
        expect(body.indexOf(">slow</h2>")).toBeLessThan(
          body.indexOf(">fast</h2>"),
        );
        expect(body.indexOf("<p>b</p>")).toBeLessThan(
          body.indexOf(">fast</h2>"),
        );
        expect(body.endsWith("<p>c</p>")).toBe(true);
      });

      it("three out-of-order stream jobs: one block", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const plan = planOf(
          scriptSeg("s1", "stream"),
          staticSeg("|"),
          scriptSeg("s2", "stream"),
          staticSeg("|"),
          scriptSeg("s3", "stream"),
        );
        const table = { s1: deferred(), s2: deferred(), s3: deferred() };
        const wrapped = wrapRunner(runnerFrom(table), plan, host);
        const { writer, text } = collectingWriter();
        const streamer = streamComposedResponse(plan, wrapped, writer);
        await streamer.ready;
        streamer.commit();
        await tick();
        table.s2.resolve(usage("two"));
        await tick();
        table.s1.resolve(usage("one"));
        await tick();
        table.s3.resolve(usage("three"));
        await streamer.done;
        const body = text();
        expect(count(body, "<style>")).toBe(1);
        expect(count(body, cardClass())).toBe(3);
        expect(body.indexOf("<style>")).toBeLessThan(body.indexOf("<article"));
        expect(body.indexOf(">one</h2>")).toBeLessThan(
          body.indexOf(">two</h2>"),
        );
        expect(body.indexOf(">two</h2>")).toBeLessThan(
          body.indexOf(">three</h2>"),
        );
      });

      it("a failed first stream instance moves the block to the next", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const plan = planOf(
          staticSeg("<p>a</p>"),
          scriptSeg("s1", "stream"),
          staticSeg("<p>b</p>"),
          scriptSeg("s2", "stream"),
        );
        const wrapped = wrapRunner(
          runnerFrom({
            s1: () => Promise.reject(new Error("first failed")),
            s2: usage("second"),
          }),
          plan,
          host,
        );
        const onStreamError = vi.fn();
        const { writer, text } = collectingWriter();
        const streamer = streamComposedResponse(plan, wrapped, writer, {
          onStreamError,
        });
        await streamer.ready;
        streamer.commit();
        await streamer.done;
        const body = text();
        expect(onStreamError).toHaveBeenCalledTimes(1);
        expect(body.startsWith("<p>a</p><p>b</p>")).toBe(true);
        expect(count(body, "<style>")).toBe(1);
        expect(count(body, cardClass())).toBe(1);
        expect(body.indexOf("<style>")).toBeLessThan(body.indexOf("<article"));
        expect(body).toContain(">second</h2>");
      });

      it("a mixed page emits the block once per mode", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const plan = planOf(
          scriptSeg("a", "server"),
          staticSeg("|"),
          scriptSeg("s", "stream"),
        );
        const wrapped = wrapRunner(
          runnerFrom({ a: usage("buffered"), s: usage("streamed") }),
          plan,
          host,
        );
        const { writer, text } = collectingWriter();
        const streamer = streamComposedResponse(plan, wrapped, writer);
        await streamer.ready;
        streamer.commit();
        await streamer.done;
        const body = text();
        expect(count(body, block(manifest))).toBe(2);
        expect(count(body, cardClass())).toBe(2);
        const [first, second] = [...body.matchAll(/<style>/g)].map(
          (m) => m.index,
        );
        const [article1, article2] = [...body.matchAll(/<article/g)].map(
          (m) => m.index,
        );
        expect(first).toBeLessThan(article1);
        expect(article1).toBeLessThan(second);
        expect(second).toBeLessThan(article2);
      });

      it("a perInstance component emits one block per instance, each with its own scoped id", async () => {
        const manifest = await build();
        expect(manifest.components["ring-card"].css).toEqual({
          perInstance: true,
        });
        const host = makeHost(manifest);
        const html = `<ring-card></ring-card><ring-card></ring-card>`;
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        const out = await wrapped("a", signalOf());
        const blocks = [...out.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
          (m) => m[1],
        );
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).not.toBe(blocks[1]);
        const ring1 = scopedId(
          "ring-card",
          requestId("a", "ring-card", 1),
          "ring",
        );
        const ring2 = scopedId(
          "ring-card",
          requestId("a", "ring-card", 2),
          "ring",
        );
        expect(blocks[0]).toContain(`url(#${ring1})`);
        expect(blocks[1]).toContain(`url(#${ring2})`);
        // Both blocks are in the body before the instance they belong to.
        expect(out.indexOf(blocks[0])).toBeLessThan(
          out.indexOf(`id="${ring1}"`),
        );
        expect(out.indexOf(blocks[1])).toBeLessThan(
          out.indexOf(`id="${ring2}"`),
        );
        expect(out.indexOf(`id="${ring1}"`)).toBeLessThan(
          out.indexOf(`id="${ring2}"`),
        );
      });

      it("a component without a stylesheet emits no block", async () => {
        const manifest = await build();
        expect(manifest.components["bare-card"].css).toBeNull();
        const host = makeHost(manifest);
        const wrapped = wrapRunner(
          runnerFrom({ a: `<bare-card data-bascik-prop-t="x"></bare-card>` }),
          serverPlan("a"),
          host,
        );
        const out = await wrapped("a", signalOf());
        expect(out).not.toContain("<style");
        // No stylesheet, so the class is not scoped either (as at build time).
        expect(out).toBe(`<p class="bare">x</p>`);
      });
    });

    // 27
    it("the emitted style bytes are exactly <style> + css.text + </style>, and the composed page's CSP hashes contain css.hash", async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      const css = manifest.components["server-card"].css as {
        text: string;
        hash: string;
      };
      const plan = planOf(
        staticSeg("<!doctype html><html><body>"),
        scriptSeg("a", "server"),
        staticSeg("</body></html>"),
      );
      const wrapped = wrapRunner(
        runnerFrom({ a: `<server-card></server-card>` }),
        plan,
        host,
      );
      const page = dec.decode(await composeBufferedResponse(plan, wrapped));
      expect(page).toContain(`<style>${css.text}</style>`);
      expect(computePageCspHashes(page).styles).toContain(css.hash);
    });

    // 28
    it('base "/docs/" rewrites a bound href and slot links inside the instance, never the author text outside it; base "/" is a no-op', async () => {
      config.base = "/docs/";
      const docs = await build();
      expect(docs.base).toBe("/docs/");
      const html = `<a href="/from-server">x</a><server-card data-bascik-prop-link="/pricing"><a href="/x">in slot</a></server-card>`;
      const underDocs = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        makeHost(docs),
      );
      const out = await underDocs("a", signalOf());
      expect(out).toContain(`href="/docs/pricing"`);
      expect(out).toContain(`href="/docs/x"`);
      expect(out).toContain(`href="/from-server"`);
      expect(out).not.toContain(`href="/pricing"`);

      config.base = "/";
      const root = await build();
      const underRoot = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        makeHost(root),
      );
      const plain = await underRoot("a", signalOf());
      expect(plain).toContain(`href="/pricing"`);
      expect(plain).toContain(`href="/x"`);
      expect(plain).toContain(`href="/from-server"`);
    });

    // 29
    it("minifyHtml true hoists the component's client script to the end of its instance; false keeps it in place; no ?instance=N at request time", async () => {
      const html = `<server-card data-bascik-prop-name="A"></server-card><server-card data-bascik-prop-name="B"></server-card>`;
      config.minify.html = true;
      const minified = await build();
      expect(minified.minifyHtml).toBe(true);
      const hoisting = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        makeHost(minified),
      );
      const out = await hoisting("a", signalOf());
      const positions = (text: string, re: RegExp) =>
        [...text.matchAll(re)].map((m) => m.index);
      const closes = positions(out, /<\/article>/g);
      const scripts = positions(out, /<script>/g);
      const opens = positions(out, /<article/g);
      expect(closes).toHaveLength(2);
      expect(scripts).toHaveLength(2);
      expect(closes[0]).toBeLessThan(scripts[0]);
      expect(scripts[0]).toBeLessThan(opens[1]);
      expect(closes[1]).toBeLessThan(scripts[1]);
      expect(out).not.toContain("?instance=");

      config.minify.html = false;
      const kept = await build();
      const inPlace = wrapRunner(
        runnerFrom({ a: html }),
        serverPlan("a"),
        makeHost(kept),
      );
      const plain = await inPlace("a", signalOf());
      const plainCloses = positions(plain, /<\/article>/g);
      const plainScripts = positions(plain, /<script>/g);
      expect(plainScripts[0]).toBeLessThan(plainCloses[0]);
      expect(plainScripts[1]).toBeLessThan(plainCloses[1]);
      expect(plain).not.toContain("?instance=");
    });

    // 30 and the misuse lens
    describe("unresolved-tag dev log", () => {
      it("a typo'd tag passes through verbatim and warns once per (page, tag), naming the route and the tag", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const html = `<p>x</p><server-crad data-bascik-prop-name="n">t</server-crad><SERVER-CRAD>u</SERVER-CRAD>`;
        const plan = serverPlan("a", "b");
        const wrapped = wrapRunner(
          runnerFrom({ a: html, b: html }),
          plan,
          host,
        );
        expect(await wrapped("a", signalOf())).toBe(html);
        expect(await wrapped("b", signalOf())).toBe(html);
        expect(host.runComponentJob).not.toHaveBeenCalled();
        expect(host.warnOnce).toHaveBeenCalled();
        const keys = new Set(
          host.warnOnce.mock.calls.map(([key]: [string, string]) => key),
        );
        expect(keys.size).toBe(1);
        for (const [key, message] of host.warnOnce.mock.calls) {
          expect(key).toContain(HTTP_PATH);
          expect(key).toContain("server-crad");
          expect(message).toContain(`"${HTTP_PATH}"`);
          expect(message).toContain("<server-crad>");
          expect(message).not.toContain("SERVER-CRAD");
          const logged = /<([^>]+)>/.exec(message)?.[1];
          expect(logged).toMatch(/^[a-z0-9-]+$/);
        }
      });

      it("never fires for components.external names or wildcards, for tags inside script, comment or textarea, or for supported components", async () => {
        const manifest = await build();
        const host = makeHost(manifest, {
          externalTags: createExternalTagMatcher(["my-widget", "ion-*"]),
        });
        const html =
          `<my-widget>w</my-widget><ion-icon name="x"></ion-icon>` +
          `<script>var s = "<server-crad>";</script><!-- <server-crad> --><textarea><server-crad></textarea>` +
          `<script type="application/ld+json">{"t":"<other-crad>"}</script>` +
          `<div title="<server-card>">attr</div>`;
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        expect(await wrapped("a", signalOf())).toBe(html);
        expect(host.warnOnce).not.toHaveBeenCalled();
      });

      it("a typo'd tag first seen inside an attribute value is still logged for its later use in markup", async () => {
        const manifest = await build();
        const host = makeHost(manifest);
        const html = `<div title="<server-crad>"></div><server-crad>x</server-crad>`;
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        expect(await wrapped("a", signalOf())).toBe(html);
        expect(host.warnOnce).toHaveBeenCalledTimes(1);
        expect(host.warnOnce.mock.calls[0][1]).toContain("<server-crad>");
      });

      it("components.external naming a real component: it still expands, as at build time, and an unsupported one is still logged with its reason", async () => {
        // external only silences "no matching component file"
        // (external-components.ts); it never hides a real component.
        const manifest = await build();
        const host = makeHost(manifest, {
          externalTags: createExternalTagMatcher(["server-card", "bad-*"]),
        });
        const html = `<server-card>e</server-card><bad-id data-bascik-prop-v="1">x</bad-id>`;
        const wrapped = wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        );
        const out = await wrapped("a", signalOf());
        expect(out).toContain(`class="${scopedClass("server-card", "card")}"`);
        expect(out).not.toContain("<server-card");
        expect(out).toContain(`<bad-id data-bascik-prop-v="1">x</bad-id>`);
        expect(host.warnOnce).toHaveBeenCalledTimes(1);
        const [key, message] = host.warnOnce.mock.calls[0];
        expect(key).toContain("bad-id");
        expect(message).toContain("attr-binding-to-scoped-attribute");
        expect(message).toContain("src/components/bad-id.html");
      });

      it("an unsupported component passes through verbatim and is logged once with the manifest's reason and file", async () => {
        const manifest = await build();
        const entry = manifest.components["bad-id"];
        expect(entry.unsupported?.reason).toBe(
          "attr-binding-to-scoped-attribute",
        );
        const host = makeHost(manifest);
        const html = `<bad-id data-bascik-prop-v="1">x</bad-id><server-card></server-card>`;
        const plan = serverPlan("a", "b");
        const wrapped = wrapRunner(
          runnerFrom({ a: html, b: html }),
          plan,
          host,
        );
        const out = await wrapped("a", signalOf());
        await wrapped("b", signalOf());
        expect(out).toContain(`<bad-id data-bascik-prop-v="1">x</bad-id>`);
        expect(out).toContain(`class="${scopedClass("server-card", "card")}"`);
        expect(out).not.toContain(`class="${scopedClass("bad-id", "w")}"`);
        const keys = new Set(
          host.warnOnce.mock.calls.map(([key]: [string, string]) => key),
        );
        expect(keys.size).toBe(1);
        const [key, message] = host.warnOnce.mock.calls[0];
        expect(key).toContain(HTTP_PATH);
        expect(key).toContain("bad-id");
        expect(message).toContain(`"${HTTP_PATH}"`);
        expect(message).toContain("<bad-id>");
        expect(message).toContain("attr-binding-to-scoped-attribute");
        expect(message).toContain("src/components/bad-id.html");
        expect(message).toContain(entry.unsupported?.detail ?? "");
      });

      it("a host without warnOnce (production) renders the same bytes and logs nothing", async () => {
        const manifest = await build();
        const host = makeHost(manifest, { warnOnce: undefined });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const html = `<server-crad>t</server-crad><bad-id>x</bad-id><server-card></server-card>`;
          const wrapped = wrapRunner(
            runnerFrom({ a: html }),
            serverPlan("a"),
            host,
          );
          const out = await wrapped("a", signalOf());
          expect(out).toContain(
            `<server-crad>t</server-crad><bad-id>x</bad-id>`,
          );
          expect(out).toContain(
            `class="${scopedClass("server-card", "card")}"`,
          );
          expect(warn).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
      });
    });
  },
);

/**
 * The renderer expands a script output one top-level usage at a time
 * (`expandByUsage`), so the loop never re-scans a multi-megabyte page per
 * instance. The bytes must be the loop's own: same usage extents on the
 * same mask, same expansion order, same ordinals and ids.
 */
describe.each([true, false])(
  "expandByUsage equals the whole-output loop (identifiers %s)",
  (identifiers) => {
    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    const buildOptions = (state: ReturnType<typeof freshState>) => ({
      scope: scopeComponentInstance,
      mintId: (name: string, ordinal: number) =>
        mintRequestId(
          sha256hex,
          HTTP_PATH,
          "a",
          name,
          ordinal,
          state.issuedIds,
        ),
      injectAttrProps: "before-scope" as const,
      numberSourceUrls: false,
      inheritAttributes: true,
      instanceState: state,
      limits: BUILD_EXPANSION_LIMITS,
      onError: (component: { name: string }, stage: string, error: unknown) => {
        throw new Error(
          `<${component.name}> failed during ${stage}: ${String(error)}`,
        );
      },
    });

    it("text between usages, masked usages, nesting, every tag spelling and an unclosed usage at the end are byte-identical, in the same order", () => {
      const list = cards();
      const html =
        `<p>lead</p>` +
        `<server-card data-bascik-prop-name="one"><div data-bascik-slot="foot">f</div>body</server-card>` +
        `<!-- <server-card data-bascik-prop-name="in comment"></server-card> -->` +
        `<textarea><server-card></server-card></textarea>` +
        `<script>var s = "<plain-card data-bascik-prop-t='x'></plain-card>";</script>` +
        `<div title="<server-card>">attr</div>` +
        `<nest-parent>Hello</nest-parent>` +
        `<SERVER-CARD data-bascik-prop-name="two">UP</SERVER-CARD>` +
        `<plain-card data-bascik-prop-t="self"/>` +
        `<p>between</p>` +
        `<server-card data-bascik-prop-name="tail">`;
      clearScopingTemplates();
      const wholeState = freshState();
      const wholeUsed: { name: string }[] = [];
      const whole = expandComponents(
        html,
        list,
        buildOptions(wholeState),
        wholeUsed as never,
      ).transpiledHtmlBody;
      clearScopingTemplates();
      const chunkedState = freshState();
      const chunkedUsed: { name: string }[] = [];
      const chunked = expandByUsage(
        html,
        list,
        buildOptions(chunkedState),
        chunkedUsed as never,
      );
      expect(chunked).toBe(whole);
      expect(chunkedUsed.map((c) => c.name)).toEqual(
        wholeUsed.map((c) => c.name),
      );
      expect(chunkedUsed.map((c) => c.name)).toEqual([
        "server-card",
        "nest-parent",
        "nest-child",
        "nest-child",
        "server-card",
        "plain-card",
        "server-card",
      ]);
      expect([...chunkedState.issuedIds]).toEqual([...wholeState.issuedIds]);
      // The masked usages are the author's text in both.
      expect(chunked).toContain(
        `<!-- <server-card data-bascik-prop-name="in comment"></server-card> -->`,
      );
      expect(chunked).toContain(
        `<textarea><server-card></server-card></textarea>`,
      );
      expect(chunked).toContain(`<div title="<server-card>">attr</div>`);
    });

    it("an unclosed raw-text element in the author's text is read the same way by both (the mask is the loop's own)", () => {
      const list = cards();
      const html = `<bare-card data-bascik-prop-t="a"></bare-card><textarea><bare-card data-bascik-prop-t="b"></bare-card>`;
      clearScopingTemplates();
      const whole = expandComponents(
        html,
        list,
        buildOptions(freshState()),
      ).transpiledHtmlBody;
      clearScopingTemplates();
      const chunked = expandByUsage(html, list, buildOptions(freshState()));
      expect(chunked).toBe(whole);
    });

    it("counts the substitution limit across usages, like one loop over the whole output", () => {
      const list = cards();
      const usage = `<bare-card data-bascik-prop-t="n"></bare-card>`;
      const within = {
        ...buildOptions(freshState()),
        limits: { maxSubstitutions: 4, maxOutputBytes: 1 << 20 },
      };
      expect(count(expandByUsage(usage.repeat(3), list, within), "bare")).toBe(
        3,
      );
      const over = {
        ...buildOptions(freshState()),
        limits: { maxSubstitutions: 4, maxOutputBytes: 1 << 20 },
      };
      expect(() => expandByUsage(usage.repeat(4), list, over)).toThrow(
        ComponentExpansionLimitError,
      );
    });

    it("output without a usage is returned as the same string", () => {
      const html = `<p>no components</p><!-- <bare-card> -->`;
      expect(expandByUsage(html, cards(), buildOptions(freshState()))).toBe(
        html,
      );
    });
  },
);

describe("budgets (identifiers off)", () => {
  beforeEach(() => {
    config.minify.identifiers = false;
  });

  // D4.6: once one nested fragment fails, the job's slot is decided (a
  // throw, or an empty slot under warn and ignore), so its other nested
  // scripts must not keep running, or log, for output already thrown away.
  for (const outcome of [
    "returns (warn, ignore)",
    "throws (error)",
    "is absent",
  ] as const) {
    it(`misuse: a render failure while sibling nested scripts still run aborts them, and only them, when onRenderError ${outcome}`, async () => {
      const manifest = await build();
      const onRenderError =
        outcome === "returns (warn, ignore)"
          ? vi.fn()
          : outcome === "throws (error)"
            ? vi.fn((error: RequestRenderError) => {
                throw error;
              })
            : undefined;
      const host = makeHost(manifest, onRenderError ? { onRenderError } : {});
      const signals: AbortSignal[] = [];
      host.runComponentJob.mockImplementation(async (_id, signal) => {
        signals.push(signal);
        // The first sibling's output is over the instance budget; the
        // second settles only when it is told to stop.
        if (signals.length === 1)
          return `<bare-card data-bascik-prop-t="n"></bare-card>`.repeat(1001);
        return new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("late"));
        });
      });
      const wrapped = wrapRunner(
        runnerFrom({ a: `<srv-card></srv-card><srv-card></srv-card>` }),
        serverPlan("a"),
        host,
      );
      const request = new AbortController();
      const pending = wrapped("a", request.signal);
      if (outcome === "returns (warn, ignore)") {
        expect(await pending).toBe("");
        expect(onRenderError).toHaveBeenCalledTimes(1);
      } else {
        await expect(pending).rejects.toBeInstanceOf(RequestRenderError);
      }
      expect(signals).toHaveLength(2);
      expect(signals[1].aborted).toBe(true);
      // The request itself is not aborted: other page jobs still run.
      expect(request.signal.aborted).toBe(false);
    });
  }

  it("a request abort still reaches every nested script through the render's own signal", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const signals: AbortSignal[] = [];
    host.runComponentJob.mockImplementation(
      (_id, signal) =>
        new Promise<string>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve(""));
        }),
    );
    const wrapped = wrapRunner(
      runnerFrom({ a: `<srv-card></srv-card><srv-card></srv-card>` }),
      serverPlan("a"),
      host,
    );
    const request = new AbortController();
    const pending = wrapped("a", request.signal);
    await tick();
    expect(signals).toHaveLength(2);
    request.abort();
    await pending;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("misuse: budget and stage messages name the component file through displayFile, as the dev log's other messages do", async () => {
    const manifest = await build({
      ...cards(),
      "wide-card": {
        fileName: "src/components/wide-card.html",
        fileContent: `<div class="w">${`<i data-bascik-slot></i>`.repeat(200)}</div>`,
      },
    });
    const host = makeHost(manifest, {
      displayFile: (path) => path.replace(/^src\//, ""),
    });
    const wrapped = wrapRunner(
      runnerFrom({
        over: `<bare-card data-bascik-prop-t="n"></bare-card>`.repeat(1001),
        // 200 copies of 3 million characters is past the engine's string
        // limit, so slot resolution throws.
        stage: `<wide-card>${"x".repeat(3_000_000)}</wide-card>`,
      }),
      serverPlan("over", "stage"),
      host,
    );
    const over = wrapped("over", signalOf());
    await expect(over).rejects.toThrow(
      /\(<bare-card>, components\/bare-card\.html\)/,
    );
    await expect(over).rejects.not.toThrow(/src\/components/);
    const stage = wrapped("stage", signalOf());
    await expect(stage).rejects.toThrow(
      /Rendering <wide-card> \(components\/wide-card\.html\) from server-script output at "\/catalog" failed during slot resolution: Invalid string length/,
    );
  });

  // 21
  it("1000 instances in one job pass; 1001 fail with a RequestRenderError naming the route and the component", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const usage = `<bare-card data-bascik-prop-t="n"></bare-card>`;
    const plan = serverPlan("ok", "over");
    const wrapped = wrapRunner(
      runnerFrom({ ok: usage.repeat(1000), over: usage.repeat(1001) }),
      plan,
      host,
    );
    const ok = await wrapped("ok", signalOf());
    expect(count(ok, `<p class="bare">n</p>`)).toBe(1000);
    expect(ok).not.toContain("<bare-card");

    const over = wrapped("over", signalOf());
    await expect(over).rejects.toBeInstanceOf(RequestRenderError);
    await expect(over).rejects.toThrow(/\/catalog/);
    await expect(over).rejects.toThrow(/bare-card/);
    await expect(over).rejects.toThrow(/1000/);
  });

  it("a rendered output of exactly 4 MiB passes; one more byte fails with a located RequestRenderError", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const LIMIT = 4 * 1024 * 1024;
    const usage = `<bare-card data-bascik-prop-t="n"></bare-card>`;
    const probePad = 100;
    const probe = wrapRunner(
      runnerFrom({ a: "x".repeat(probePad) + usage }),
      serverPlan("a"),
      host,
    );
    const instanceLength = (await probe("a", signalOf())).length - probePad;
    expect(instanceLength).toBeGreaterThan(0);

    const exact = "x".repeat(LIMIT - instanceLength) + usage;
    const overByOne = "x".repeat(LIMIT - instanceLength + 1) + usage;
    // Over the limit as written, with a usage in it: rendered, then refused
    // on the result (a usage can render smaller than it is written, which
    // is how `exact` above starts over the limit and ends at it).
    const writtenOver = "x".repeat(LIMIT + 1) + usage;
    // Over twice the limit as written: the result could not come back under
    // it, so it is refused before anything is expanded.
    const rawOver = "x".repeat(2 * LIMIT + 1) + usage;
    const plan = serverPlan("exact", "over", "written", "raw");
    const wrapped = wrapRunner(
      runnerFrom({
        exact,
        over: overByOne,
        written: writtenOver,
        raw: rawOver,
      }),
      plan,
      host,
    );
    const ok = await wrapped("exact", signalOf());
    expect(ok.length).toBe(LIMIT);
    expect(ok.endsWith(`<p class="bare">n</p>`)).toBe(true);

    const over = wrapped("over", signalOf());
    await expect(over).rejects.toBeInstanceOf(RequestRenderError);
    await expect(over).rejects.toThrow(/\/catalog/);
    await expect(over).rejects.toThrow(/4 MiB \(4194304 characters\)/);
    await expect(over).rejects.toThrow(/bare-card/);
    await expect(over).rejects.not.toThrow(/bytes/);

    const written = wrapped("written", signalOf());
    await expect(written).rejects.toBeInstanceOf(RequestRenderError);
    await expect(written).rejects.toThrow(
      new RegExp(`rendered to ${LIMIT + 1 + instanceLength} characters`),
    );

    const raw = wrapped("raw", signalOf());
    await expect(raw).rejects.toBeInstanceOf(RequestRenderError);
    await expect(raw).rejects.toThrow(
      new RegExp(
        `is ${2 * LIMIT + 1 + usage.length} characters before rendering`,
      ),
    );
    await expect(raw).rejects.not.toThrow(/rendered to/);
  });

  it("an output over 4 MiB with no component tag in it passes through unchanged on a site that has components", async () => {
    // A big export page or table was never the renderer's business: the
    // limit bounds what expansion produces, not the author's own output.
    const manifest = await build();
    const host = makeHost(manifest);
    const table =
      "<table>" + "<tr><td>row</td></tr>".repeat(262144) + "</table>";
    expect(table.length).toBeGreaterThan(5 * 1024 * 1024);
    const mentions = `<p title="<bare-card>">x</p><!-- <bare-card> -->` + table;
    const plan = serverPlan("table", "mentions");
    const wrapped = wrapRunner(runnerFrom({ table, mentions }), plan, host);
    expect(await wrapped("table", signalOf())).toBe(table);
    expect(await wrapped("mentions", signalOf())).toBe(mentions);
  });

  it("the 4 MiB budget is shared by every usage of one output: a slot-doubling component is refused before the later usages grow", () => {
    // A legitimate "preview + full" card places its default slot twice, so
    // each nesting level doubles the content. Each usage below renders to
    // 2 MiB on its own; three of them would be 6 MiB. The allowance passed
    // to each usage is what is left of the whole output's, so the second
    // usage trips the tripwire part-way and the third is never expanded.
    const list: ComponentList = {
      "dbl-card": {
        fileName: "src/components/dbl-card.html",
        fileContent: `<div class="d"><div data-bascik-slot></div><div data-bascik-slot></div></div>`,
      },
    };
    let one = "x".repeat(128 * 1024);
    for (let level = 0; level < 4; level++) one = `<dbl-card>${one}</dbl-card>`;
    const perUsage = 2 ** 4 - 1;
    const state = freshState();
    const used: { name: string }[] = [];
    const opts = {
      scope: scopeComponentInstance,
      mintId: (name: string, ordinal: number) =>
        mintRequestId(
          sha256hex,
          HTTP_PATH,
          "a",
          name,
          ordinal,
          state.issuedIds,
        ),
      injectAttrProps: "before-scope" as const,
      numberSourceUrls: false,
      inheritAttributes: true,
      instanceState: state,
      limits: { maxSubstitutions: 1001, maxOutputBytes: 4 * 1024 * 1024 },
      onError: () => {
        throw new Error("unexpected stage failure");
      },
    };
    clearScopingTemplates();
    expect(() =>
      expandByUsage(one.repeat(3), list, opts, used as never),
    ).toThrow(ComponentExpansionLimitError);
    expect(used.length).toBeGreaterThanOrEqual(perUsage);
    expect(used.length).toBeLessThan(2 * perUsage);
  });

  it("a slot-doubling nest that would exceed the budget fails the job with a located RequestRenderError", async () => {
    const manifest = await build({
      ...cards(),
      "dbl-card": {
        fileName: "src/components/dbl-card.html",
        fileContent: `<div class="d"><div data-bascik-slot></div><div data-bascik-slot></div></div>`,
      },
    });
    const host = makeHost(manifest);
    let one = "x".repeat(16 * 1024);
    for (let level = 0; level < 9; level++) one = `<dbl-card>${one}</dbl-card>`;
    const wrapped = wrapRunner(
      runnerFrom({ a: one.repeat(2) }),
      serverPlan("a"),
      host,
    );
    const pending = wrapped("a", signalOf());
    await expect(pending).rejects.toBeInstanceOf(RequestRenderError);
    // The tripwire is the limit plus the output's own written size: far
    // below the 8 MiB the first usage alone would reach.
    const tripwire = 4 * 1024 * 1024 + one.length * 2;
    await expect(pending).rejects.toThrow(
      new RegExp(`grew past ${tripwire} characters while expanding components`),
    );
    await expect(pending).rejects.toThrow(/4 MiB \(4194304 characters\)/);
    await expect(pending).rejects.toThrow(/dbl-card/);
  });

  it("64 nested jobs per response pass; 65 fail with a RequestRenderError naming the route and the component", async () => {
    const manifest = await build();
    const usage = `<srv-card></srv-card>`;
    const host = makeHost(manifest);
    host.runComponentJob.mockImplementation(async () => `<p>n</p>`);
    const plan = serverPlan("ok", "over");
    const wrapped = wrapRunner(
      runnerFrom({ ok: usage.repeat(64), over: usage.repeat(65) }),
      plan,
      host,
    );
    const ok = await wrapped("ok", signalOf());
    expect(
      count(ok, `<div class="bascik__srv-card__wrap"><p>n</p></div>`),
    ).toBe(64);
    expect(host.runComponentJob).toHaveBeenCalledTimes(64);

    const over = wrapped("over", signalOf());
    await expect(over).rejects.toBeInstanceOf(RequestRenderError);
    await expect(over).rejects.toThrow(/\/catalog/);
    await expect(over).rejects.toThrow(/srv-card/);
    await expect(over).rejects.toThrow(/64/);
  });

  it("the nested-job budget is per response: two page jobs of 32 pass, 33 + 32 fail", async () => {
    const manifest = await build();
    const usage = `<srv-card></srv-card>`;
    const pass = makeHost(manifest);
    pass.runComponentJob.mockImplementation(async () => `<p>n</p>`);
    const plan = serverPlan("a", "b");
    const within = wrapRunner(
      runnerFrom({ a: usage.repeat(32), b: usage.repeat(32) }),
      plan,
      pass,
    );
    const out = dec.decode(await composeBufferedResponse(plan, within));
    expect(count(out, "<p>n</p>")).toBe(64);

    const fail = makeHost(manifest);
    fail.runComponentJob.mockImplementation(async () => `<p>n</p>`);
    const beyond = wrapRunner(
      runnerFrom({ a: usage.repeat(33), b: usage.repeat(32) }),
      plan,
      fail,
    );
    await expect(composeBufferedResponse(plan, beyond)).rejects.toBeInstanceOf(
      RequestRenderError,
    );
  });

  it("over budget in a server parent rejects ready; in a stream parent it yields an empty slot and onStreamError", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const usage = `<bare-card></bare-card>`.repeat(1001);
    const serverPlanned = planOf(
      staticSeg("<p>a</p>"),
      scriptSeg("a", "server"),
    );
    const asServer = wrapRunner(runnerFrom({ a: usage }), serverPlanned, host);
    const server = streamComposedResponse(
      serverPlanned,
      asServer,
      collectingWriter().writer,
    );
    await expect(server.ready).rejects.toBeInstanceOf(RequestRenderError);

    const streamPlanned = planOf(
      staticSeg("<p>a</p>"),
      scriptSeg("s", "stream"),
      staticSeg("<p>b</p>"),
    );
    const asStream = wrapRunner(runnerFrom({ s: usage }), streamPlanned, host);
    const onStreamError = vi.fn();
    const { writer, text } = collectingWriter();
    const stream = streamComposedResponse(streamPlanned, asStream, writer, {
      onStreamError,
    });
    await stream.ready;
    stream.commit();
    await stream.done;
    expect(text()).toBe("<p>a</p><p>b</p>");
    expect(onStreamError).toHaveBeenCalledTimes(1);
    expect(onStreamError.mock.calls[0][0]).toBeInstanceOf(RequestRenderError);
  });

  // 22
  it("a nested job receives the parent's remaining budget: after 40 ms of a 50 ms budget at most 10 ms, never 0", async () => {
    const manifest = await build();
    const host = makeHost(manifest, { timeoutMs: 50 });
    host.runComponentJob.mockImplementation(async () => `<p>n</p>`);
    const plan = serverPlan("late", "overrun");
    const wrapped = wrapRunner(
      runnerFrom({
        late: async () => {
          await sleep(40);
          return `<srv-card></srv-card>`;
        },
        overrun: async () => {
          await sleep(70);
          return `<srv-card></srv-card>`;
        },
      }),
      plan,
      host,
    );
    await wrapped("late", signalOf());
    expect(host.runComponentJob).toHaveBeenCalledTimes(1);
    const [, , remaining] = host.runComponentJob.mock.calls[0];
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(12);

    await wrapped("overrun", signalOf());
    const [, , floor] = host.runComponentJob.mock.calls[1];
    expect(floor).toBe(1);
  });

  // 23
  it("nested jobs receive a signal linked to the runner's own, and an abort in flight aborts them", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    host.runComponentJob.mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("nested aborted")),
          );
        }),
    );
    const abort = new AbortController();
    const wrapped = wrapRunner(
      runnerFrom({ a: `<srv-card></srv-card>` }),
      serverPlan("a"),
      host,
    );
    const pending = wrapped("a", abort.signal);
    await tick();
    await tick();
    expect(host.runComponentJob).toHaveBeenCalledTimes(1);
    const nestedSignal = host.runComponentJob.mock.calls[0][1];
    expect(nestedSignal.aborted).toBe(false);
    abort.abort();
    expect(nestedSignal.aborted).toBe(true);
    await expect(pending).rejects.toThrow("nested aborted");
  });
});

// 31
describe("scaling (identifiers off)", () => {
  beforeEach(() => {
    config.minify.identifiers = false;
  });

  it("a 2 MiB output with 4000 named-slot wrappers, 16000 unclosed opens and 1000 instances renders in under 500 ms", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const instances = 1000;
    const target = 2 * 1024 * 1024;
    // Four named-slot wrappers per usage, each holding four unclosed <i>
    // opens, padded so the whole output is 2 MiB.
    const skeleton = (pad: string) =>
      `<slots-card>` +
      ["a", "b", "c", "d"]
        .map(
          (slot) => `<div data-bascik-slot="${slot}"><i><i><i><i>${pad}</div>`,
        )
        .join("") +
      `</slots-card>`;
    const bare = skeleton("").length;
    const padPerSlot = Math.ceil((target / instances - bare) / 4);
    const html = skeleton("p".repeat(padPerSlot)).repeat(instances);
    expect(html.length).toBeGreaterThanOrEqual(target);
    expect(count(html, "data-bascik-slot=")).toBe(4000);
    expect(count(html, "<i>")).toBe(16000);

    const wrapped = wrapRunner(runnerFrom({ a: html }), serverPlan("a"), host);
    const started = performance.now();
    const out = await wrapped("a", signalOf());
    const elapsed = performance.now() - started;
    expect(count(out, `class="bascik__slots-card__s"`)).toBe(instances);
    expect(out).not.toContain("<slots-card");
    expect(count(out, "<style>")).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });
});

/**
 * `minify.html` and `base` at request time (items 28 and 29, and the misuse
 * lens): the build rewrites base paths and minifies the whole page once
 * (page-transpile.ts), so whether whitespace and comments inside an instance
 * survive depends on where the instance sits: inside a `<pre>` (in the
 * script's output, in the page around the script, or in a parent template),
 * a table, or an open formatting element. The request path must produce the
 * build's bytes for the instance there, apart from the documented hoisting of
 * client scripts to the end of the outermost rendered instance (D8), which
 * the comparison factors out. The author's text outside instances is kept
 * minify-stable here because the request path never touches it.
 */
describe.each([true, false])(
  "minify.html and base match the build pipeline (identifiers %s)",
  (identifiers) => {
    const list = (): ComponentList => ({
      ...cards(),
      "pre-tok": {
        fileName: "src/components/pre-tok.html",
        fileContent: `<span class="tok">  a   <!-- c -->  b  <i data-bascik-slot>x</i></span>`,
        cssFileContent: ".tok { color: red }",
      },
      "code-box": {
        fileName: "src/components/code-box.html",
        fileContent: `<div class="cb"><pre><code><pre-tok>if  (x)</pre-tok>\n    next   line</code></pre></div>`,
        cssFileContent: ".cb { color: red }",
      },
      "row-card": {
        fileName: "src/components/row-card.html",
        fileContent: `<tr class="r"><!-- note --> <td data-bascik-prop-t>t</td>  <td>2</td></tr>`,
        cssFileContent: ".r { color: red }",
      },
      "blk-card": {
        fileName: "src/components/blk-card.html",
        fileContent: `<div class="k">\n  <p>one</p>\n  <p>two</p>\n</div>`,
        cssFileContent: ".k { color: red }",
      },
      "link-card": {
        fileName: "src/components/link-card.html",
        fileContent:
          `<a class="l" href="/x" data-bascik-attr-href="u">  go  </a><img class="i" src="/img.png" srcset="/a.png 1x, /b.png 2x">` +
          `<div class="s" style="background:url(/bg.png)"></div><script>window.n=(window.n||0)+1</script>`,
        cssFileContent: ".l { background: url(/c.png) }",
      },
    });

    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    /** The build: expand the whole page, rewrite base paths, minify. */
    const viaBuild = (page: string, manifest: ComponentManifest): string => {
      clearScopingTemplates();
      const state = freshState();
      let html = expandComponents(page, list(), {
        scope: scopeComponentInstance,
        mintId: (name, ordinal) =>
          mintRequestId(
            sha256hex,
            HTTP_PATH,
            "a",
            name,
            ordinal,
            state.issuedIds,
          ),
        injectAttrProps: "before-scope",
        numberSourceUrls: false,
        inheritAttributes: manifest.inheritAttributes,
        instanceState: state,
        limits: BUILD_EXPANSION_LIMITS,
        onError: (component, stage, error) => {
          throw new Error(
            `<${component.name}> failed during ${stage}: ${String(error)}`,
          );
        },
      }).transpiledHtmlBody;
      html = rewriteHtmlBasePaths(html, config.base);
      return config.minify.html ? minifyHtml(html) : html;
    };

    /** The request: the page's static segments around one server job. */
    const viaRequest = async (
      before: string,
      output: string,
      after: string,
      manifest: ComponentManifest,
    ): Promise<string> => {
      const plan = planOf(
        staticSeg(before),
        scriptSeg("a", "server"),
        staticSeg(after),
      );
      const wrapped = wrapRunner(
        runnerFrom({ a: output }),
        plan,
        makeHost(manifest),
      );
      return dec
        .decode(await composeBufferedResponse(plan, wrapped))
        .replace(/<style>[\s\S]*?<\/style>/g, "");
    };

    /** Client scripts out of the way, in order: where they go is D8's documented difference. */
    const unhoisted = (html: string) => ({
      html: html.replace(/\n?<script>[\s\S]*?<\/script>/g, ""),
      scripts: [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map(
        (m) => m[0],
      ),
    });

    const cases: Record<string, [string, string, string]> = {
      "a <pre> in the script's output": [
        "<main>",
        "<pre><pre-tok>q  r</pre-tok>\n  tail</pre>",
        "</main>",
      ],
      "a <pre> in a parent template": [
        "<main>",
        "<code-box></code-box>",
        "</main>",
      ],
      "a <pre> in the page around the script": [
        "<main><pre>",
        "<pre-tok>a  b</pre-tok>",
        "</pre></main>",
      ],
      "a table, where a removed comment leaves a separator": [
        "<main>",
        "<table><tbody><row-card data-bascik-prop-t='v'></row-card><row-card></row-card></tbody></table>",
        "</main>",
      ],
      "an open formatting element, which keeps a space between tags": [
        "<main><b>",
        "<blk-card></blk-card>",
        "</b></main>",
      ],
      "bound and slotted links": [
        "<main>",
        `<link-card data-bascik-attr-href="/docs" data-bascik-prop-u="/y"><b>s</b></link-card>`,
        "</main>",
      ],
      "two instances between paragraphs": [
        "<main>",
        "<p>a</p><link-card></link-card><link-card></link-card><p>z</p>",
        "</main>",
      ],
    };

    for (const base of ["/", "/docs/"]) {
      for (const minify of [false, true]) {
        describe(`base ${base}, minify.html ${minify}`, () => {
          let manifest: ComponentManifest;
          beforeEach(async () => {
            config.base = base;
            config.minify.html = minify;
            manifest = await build(list());
          });

          for (const [name, [before, output, after]] of Object.entries(cases)) {
            it(name, async () => {
              const expected = viaBuild(before + output + after, manifest);
              const actual = await viaRequest(before, output, after, manifest);
              if (!minify) {
                expect(actual).toBe(expected);
                return;
              }
              const built = unhoisted(expected);
              const rendered = unhoisted(actual);
              expect(rendered.html).toBe(built.html);
              expect(rendered.scripts).toEqual(built.scripts);
            });
          }
        });
      }
    }

    it("minify.html on: text and comments inside a <pre> keep their spacing wherever the <pre> is", async () => {
      config.minify.html = true;
      const manifest = await build(list());
      const pre = await viaRequest(
        "<main>",
        "<pre><pre-tok>q  r</pre-tok></pre><code-box></code-box>",
        "</main>",
        manifest,
      );
      expect(pre).toContain("  a   <!-- c -->  b  q  r</span>");
      expect(pre).toContain("  a   <!-- c -->  b  if  (x)</span>");
      expect(pre).toContain("\n    next   line");
      // Outside a <pre> the same template is collapsed, as at build time.
      const plain = await viaRequest(
        "<main>",
        "<pre-tok>q  r</pre-tok>",
        "</main>",
        manifest,
      );
      expect(plain).not.toContain("<!-- c -->");
      expect(plain).toContain(" a b q r</span>");
    });

    it("minify.html on: a nested job's output spliced inside a template <pre> keeps its spacing", async () => {
      config.minify.html = true;
      const manifest = await build({
        ...list(),
        "srv-pre": {
          fileName: "src/components/srv-pre.html",
          fileContent: `<pre class="sp"><script data-bascik-server>export default () => "";</script></pre>`,
        },
      });
      const host = makeHost(manifest);
      host.runComponentJob.mockImplementation(
        async () => "<pre-tok>n  m</pre-tok>",
      );
      const wrapped = wrapRunner(
        runnerFrom({ a: "<srv-pre></srv-pre>" }),
        serverPlan("a"),
        host,
      );
      const out = await wrapped("a", signalOf());
      expect(host.runComponentJob).toHaveBeenCalledTimes(1);
      expect(out).toContain("  a   <!-- c -->  b  n  m</span></pre>");
    });

    // Found by the Cloudflare parity test (phase 4): catalog-stream.html's
    // middle batch sits between two other stream scripts, so its segment's
    // context says both neighbors are spans of the PAGE. Those flags must
    // not leak onto the usages inside the output, where index -1 and n+1
    // are not usages: the job threw a TypeError on both hosts and its slot
    // stayed empty.
    it("minify.html on: a job between two adjacent script segments renders its first and last usage", async () => {
      config.minify.html = true;
      const manifest = await build(list());
      const plan = planOf(
        staticSeg("<main>"),
        scriptSeg("a", "stream"),
        scriptSeg("b", "stream"),
        scriptSeg("c", "stream"),
        staticSeg("</main>"),
      );
      const output =
        "<link-card data-bascik-prop-u='/1'></link-card><link-card data-bascik-prop-u='/2'></link-card>";
      const wrapped = wrapRunner(
        runnerFrom({ a: "<p>a</p>", b: output, c: "<p>c</p>" }),
        plan,
        makeHost(manifest),
      );
      const out = await wrapped("b", signalOf());
      expect(out).not.toContain("<link-card");
      expect(count(out, "<a ")).toBe(2);
      expect(out).toContain('href="/1"');
      expect(out).toContain('href="/2"');
    });

    it("minify.html on: an instance inside SVG or MathML is left unminified (the documented safe fallback)", async () => {
      config.minify.html = true;
      const manifest = await build(list());
      const out = await viaRequest(
        "<main>",
        "<svg><foreignObject><pre-tok>q  r</pre-tok></foreignObject></svg>",
        "</main>",
        manifest,
      );
      expect(out).toContain("  a   <!-- c -->  b  q  r</span>");
    });
  },
);
