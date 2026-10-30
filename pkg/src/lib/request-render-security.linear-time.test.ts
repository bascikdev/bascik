/**
 * Request-time component rendering, attacker lens (prompt 157 security
 * audit, 2026-10-28). The baseline is documented: a server or stream
 * script's output is HTML, and its author escapes every visitor value
 * (server-scripts.md, "Escaping and injection"). What is new is that tags in
 * that output expand into components. Each test here plays a visitor who
 * controls one value `q` that a script escapes into a prop, a slot or an
 * attribute of a returned component tag, and asserts the SAFE outcome:
 *
 * - the DOM a browser builds (parse5, scripting on) has the same shape
 *   (elements and attribute names) whatever `q` is, the same script and
 *   style texts, and no event-handler attribute, script URL or `srcdoc`
 *   markup that the benign render does not have;
 * - the build-time loop gives the same answer for the same usage written in
 *   a page;
 * - tags, markers and placeholders an attacker can spell stay text, and
 *   budgets bound what an injected tag can make the server do.
 *
 * A test that fails here is a finding, not a flake: it names a value that an
 * author who followed the documented escaping cannot stop.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

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
import { expandComponents } from "./component-expansion-core.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { deriveInstanceId, getAttributeNameHash } from "./names.ts";
import {
  type ExecutionPlan,
  type ScriptJobRunner,
} from "./request-execution.ts";
import {
  REQUEST_RENDER_LIMITS,
  RequestRenderError,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import {
  clearScopingTemplates,
  scopeComponentInstance,
} from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectCostRatio,
  expectLinearTime,
  expectLinearTimeAsync,
  measureCostRatioAsync,
  spliceCopies,
  type CalibratedRatio,
} from "./linear-time.test-helper.ts";
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
const HTTP_PATH = "/search";

const serverPlan = (...ids: string[]): ExecutionPlan => ({
  segments: ids.map((id) => ({
    kind: "script" as const,
    mode: "server" as const,
    id,
  })),
  firstStreamIndex: -1,
});

const runnerOf = (output: string): ScriptJobRunner => vi.fn(async () => output);

type TestHost = RenderHost & {
  runComponentJob: Mock<
    (id: string, signal: AbortSignal, timeoutMs: number) => Promise<string>
  >;
  warnOnce: Mock<(key: string, message: string) => void>;
};

const makeHost = (
  manifest: ComponentManifest,
  overrides: Partial<RenderHost> = {},
): TestHost =>
  ({
    manifest,
    hashName: manifest.identifiers ? getAttributeNameHash : identity,
    hashHex: sha256hex,
    httpPath: HTTP_PATH,
    timeoutMs: 1000,
    runComponentJob: vi.fn(async () => ""),
    warnOnce: vi.fn(),
    externalTags: createExternalTagMatcher([]),
    ...overrides,
  }) as TestHost;

const build = async (list: ComponentList): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(list, BascikConfig);
};

/** What `bascik --server` / the Worker send for one server job's output. */
const renderAtRequest = async (
  manifest: ComponentManifest,
  output: string,
  overrides: Partial<RenderHost> = {},
): Promise<{ html: string; host: TestHost }> => {
  const host = makeHost(manifest, overrides);
  const wrapped = wrapRunner(runnerOf(output), serverPlan("a"), host);
  return { html: await wrapped("a", new AbortController().signal), host };
};

/** What the build makes of the same usage written in a page. */
const renderAtBuild = (
  list: ComponentList,
  html: string,
  warn: (message: string) => void = () => {},
): string => {
  clearScopingTemplates();
  const issuedIds = new Set<string>();
  return expandComponents(html, list, {
    scope: scopeComponentInstance,
    mintId: (name, ordinal) =>
      deriveInstanceId("src/pages/search.html", name, ordinal, issuedIds),
    injectAttrProps: "before-scope",
    numberSourceUrls: false,
    inheritAttributes: true,
    instanceState: { ordinalMap: new Map(), issuedIds },
    limits: BUILD_EXPANSION_LIMITS,
    onError: (component, stage, error) => {
      throw new Error(`<${component.name}> failed during ${stage}: ${error}`);
    },
    warn,
  }).transpiledHtmlBody;
};

// ─── The browser's view (parse5, scripting on) ──────────────────────────────

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const isElement = (node: Node): node is Element => "tagName" in node;

/** Attributes whose value the browser navigates to or fetches as a URL. */
const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
  "cite",
  "ping",
  "codebase",
]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

/**
 * A URL as the URL parser reads its scheme: leading and trailing C0 controls
 * and spaces stripped, every tab and newline removed, ASCII lowercased.
 */
const urlScheme = (value: string): string =>
  value
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
    .replace(/[\t\n\r]/g, "")
    .toLowerCase();

const isScriptUrl = (value: string, navigates: boolean): boolean => {
  const url = urlScheme(value);
  return (
    url.startsWith("javascript:") ||
    url.startsWith("vbscript:") ||
    (navigates && url.startsWith("data:"))
  );
};

const attrName = (attr: { name: string; prefix?: string }): string =>
  attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;

const textOf = (node: ParentNode): string =>
  node.childNodes
    .map((child) =>
      child.nodeName === "#text"
        ? (child as DefaultTreeAdapterTypes.TextNode).value
        : "",
    )
    .join("");

interface BrowserView {
  /** Element tag names (with namespace) and sorted attribute names, in order. */
  shape: string[];
  /** Text of every `<script>` (HTML or SVG), in order. */
  scripts: string[];
  /** Text of every `<style>`, in order. */
  styles: string[];
  /** Executable sinks: event handlers, script URLs, `srcdoc` markup. */
  sinks: string[];
}

const view = (html: string): BrowserView => {
  const result: BrowserView = { shape: [], scripts: [], styles: [], sinks: [] };
  const visit = (parent: ParentNode, where: string): void => {
    for (const node of parent.childNodes) {
      if (!isElement(node)) continue;
      const ns = node.namespaceURI.endsWith("svg")
        ? "svg:"
        : node.namespaceURI.endsWith("MathML")
          ? "math:"
          : "";
      const tag = `${ns}${node.tagName}`;
      const names = node.attrs.map(attrName).sort();
      result.shape.push(`${where}${tag}[${names.join(",")}]`);
      if (node.tagName === "script") result.scripts.push(textOf(node));
      if (node.tagName === "style") result.styles.push(textOf(node));
      const navigates = [
        "a",
        "area",
        "form",
        "button",
        "input",
        "iframe",
        "object",
        "embed",
        "base",
        "frame",
      ].includes(node.tagName);
      for (const attr of node.attrs) {
        const name = attrName(attr).toLowerCase();
        if (name.startsWith("on"))
          result.sinks.push(`${tag} ${name}=${attr.value}`);
        if (URL_ATTRIBUTES.has(name) && isScriptUrl(attr.value, navigates))
          result.sinks.push(`${tag} ${name}=${attr.value}`);
        if (SRCSET_ATTRIBUTES.has(name)) {
          for (const candidate of attr.value.split(","))
            if (isScriptUrl(candidate.trim().split(/\s+/)[0] ?? "", false))
              result.sinks.push(`${tag} ${name}=${attr.value}`);
        }
        if (name === "srcdoc") {
          const inner = view(attr.value);
          // Any element in a srcdoc is markup the visitor may have written.
          for (const entry of inner.shape)
            result.shape.push(`${where}srcdoc>${entry}`);
          for (const sink of inner.sinks) result.sinks.push(`srcdoc> ${sink}`);
          for (const script of inner.scripts)
            result.sinks.push(`srcdoc> <script>${script}`);
        }
        if (
          name === "style" &&
          /javascript:|expression\(|url\(/i.test(attr.value)
        )
          result.sinks.push(`${tag} style=${attr.value}`);
      }
      if ("content" in node && node.tagName === "template")
        visit(
          (node as DefaultTreeAdapterTypes.Template).content,
          `${where}template>`,
        );
      visit(node, where);
    }
  };
  visit(
    parse(`<!doctype html><html><head></head><body>${html}</body></html>`),
    "",
  );
  return result;
};

beforeEach(() => {
  config.base = "/";
  config.minify.identifiers = true;
  config.minify.html = false;
  config.scoping.deduplicateCss = true;
  config.scoping.inheritAttributes = true;
  serverSidecarRegistry.clear();
  clearScopingTemplates();
});

// ─── B. usage attributes inherited onto the root ────────────────────────────

describe("B. a usage attribute that becomes a URL only on the root's real tag gets the URL check; every other one is inherited as written", () => {
  const list: ComponentList = Object.fromEntries(
    Object.entries({
      "inh-object": `<object class="r" type="text/html" width="300" height="100"></object>`,
      "inh-set": `<set attributeName="href" begin="0s"></set>`,
      "inh-animate": `<animate attributeName="href" dur="1s"></animate>`,
      "inh-iframe": `<iframe class="r" title="t"></iframe>`,
      "inh-a": `<a class="r">go</a>`,
      "inh-form": `<form class="r"><button>go</button></form>`,
      "inh-div": `<div class="r">x</div>`,
      "inh-meta": `<meta name="m"><div class="r">x</div>`,
      "my-button": `<button class="btn" type="button">go</button>`,
    }).map(([name, fileContent]) => [
      name,
      { fileName: `src/components/${name}.html`, fileContent },
    ]),
  );

  it(
    "many inherited attributes on one usage are judged in linear time",
    () => {
      // Names of one width (three letters name 17,576 handlers): names that
      // grow with the count made the input itself grow about 8 times for 4
      // times the count, and CI read that as a growth of 8.3.
      const letters = (i: number): string =>
        [676, 26, 1]
          .map((place) =>
            String.fromCharCode(97 + (Math.floor(i / place) % 26)),
          )
          .join("");
      const usage = (count: number): string => {
        let attrs = "";
        for (let i = 0; i < count; i++)
          attrs += ` on${letters(i)}="x" data-u${i}="javascript:${i}" data-k${i}="v"`;
        return `<inh-object${attrs} data="${" ".repeat(count)}javascript:x" style="${"background:url(javascript:x);".repeat(count)}"></inh-object>`;
      };
      expectLinearTime(usage, 4000, (input) => renderAtBuild(list, input));
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "many usages with inherited script URLs and handlers are judged in linear time in their count",
    async () => {
      const manifest = await build(list);
      const unit = `<inh-object data="data:text/html,x" onload="x" class="k"></inh-object><inh-iframe src="javascript:x" srcdoc="x"></inh-iframe>`;
      await expectLinearTimeAsync(
        (count) => unit.repeat(count),
        200,
        async (input) => (await renderAtRequest(manifest, input)).html,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("B. a class or style merged onto the root never reads text an earlier inherited value carries", () => {
  const list: ComponentList = Object.fromEntries(
    Object.entries({
      "x-badge": `<span>badge</span>`,
      "x-sty": `<button class="b">go</button>`,
      "scroll-list": `<ul class="list">x</ul>`,
      "status-dot": `<span class="dot"></span>`,
    }).map(([name, fileContent]) => [
      name,
      { fileName: `src/components/${name}.html`, fileContent },
    ]),
  );

  it(
    "a merge after many values spelling class= and style=, and a style of many image-set() strings, are judged in linear time",
    () => {
      const usage = (count: number): string => {
        let attrs = "";
        for (let i = 0; i < count; i++)
          attrs += ` data-k${i}=" class=x style=y class='z'"`;
        return `<x-badge${attrs} class="big" style="${"--a: image-set('x.png' 1x, url(y.png) 2x".repeat(count)}"></x-badge>`;
      };
      expectLinearTime(usage, 4000, (input) => renderAtBuild(list, input));
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

// ─── G. work an echoed output can make the renderer do ──────────────────────

describe("G. a hostile output settles in time proportional to its size", () => {
  const list: ComponentList = {
    "my-card": {
      fileName: "src/components/my-card.html",
      fileContent: `<div class="c"><div data-bascik-slot>s</div></div>`,
    },
    "x-p": {
      fileName: "src/components/x-p.html",
      fileContent: `<p class="p" data-bascik-prop-v>v</p>`,
    },
  };
  // 999 nested usages (under the instance budget), each opener cut mid-tag
  // at the splice, padded to 400 KB: before a scanning budget this re-masks
  // the whole instance once per nested instance (about 4 s here, about 40 s
  // at 1 MB). Both sizes hold 999 usages, so that cost is linear in the
  // output too, and only the calibrated cost at the cap below fails it. The
  // growth is taken over the same 999 usages with no padding (the
  // baseline), whose fixed cost otherwise held it at 2.7 and hid a quadratic
  // term: it fails a pass quadratic in the padding.
  const SIZE = 400_000;
  const USAGES = 999;
  /** `USAGES` copies of `unit`, padded with text to `size` characters in all. */
  const padded = (unit: string, size: number): string =>
    (
      unit + "x".repeat(Math.max(0, Math.ceil(size / USAGES) - unit.length))
    ).repeat(USAGES);
  // Each `<a>` is a whole tag: after an `<a ` with no `>`, every later
  // `<x-p>` would be part of its attributes, as a browser reads it.
  const nested = (size: number) =>
    `<my-card>${padded("<x-p><a>", size)}</my-card>`;
  /** One request for `html`: rendered, or a RequestRenderError. */
  const settlerOf = async () => {
    const manifest = await build(list);
    config.minify.identifiers = false;
    const host = makeHost(manifest);
    return (html: string) =>
      wrapRunner(
        runnerOf(html),
        serverPlan("a"),
        host,
      )("a", new AbortController().signal).catch((error) => {
        expect(error).toBeInstanceOf(RequestRenderError);
      });
  };

  it(
    "<my-card> + fill('<x-p><a>') + </my-card> settles (rendered or a RequestRenderError) in linear time",
    async () => {
      const settle = await settlerOf();
      await expectLinearTimeAsync(nested, SIZE, settle, {
        baseline: nested(0),
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // Each usage its own fragment: the request's fixed cost is per usage, so
  // the padding hardly moves it (12 ms at 50 KB, 19 ms at 800 KB) and a
  // growth in the padding read 0.8. A pass over the rest of the output per
  // usage is what to fail, and it is quadratic in the usage count: so the
  // count is what grows, from a quarter of `USAGES` to all of them, each
  // padded to 400 characters as above.
  it(
    "fill('<x-p><s') settles (rendered or a RequestRenderError) in linear time in its usage count",
    async () => {
      const settle = await settlerOf();
      const unit = padded("<x-p><s", SIZE).slice(0, Math.ceil(SIZE / USAGES));
      // 996 usages, 249 at a quarter: under the instance budget.
      await expectLinearTimeAsync((count) => unit.repeat(count), 996, settle);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // The nested case is linear in the output at a fixed usage count, but not
  // in the usage count. `<my-card>` holds every usage, so it expands as one
  // fragment (expandByUsage), and each substitution splices the whole
  // fragment and its mask: V8 joins the pieces lazily and copies the whole
  // string the next time it is read (`body.slice` in spliceRawTextMask, the
  // mask's in expandComponents). The cost is usages times fragment length:
  // at 400 bytes per usage, 7 ms for 100 usages, 60 ms for 500, 186 ms for
  // 1000. Only the instance cap (`REQUEST_RENDER_LIMITS.maxInstances`)
  // bounds the usage count, and `maxOutputLength` the length: 998 usages in a
  // 4 MB output took 1.4 s of CPU. So the cost at the cap is pinned, as a
  // ratio to the work it is made of, timed in the same process: one splice
  // of the page and of its mask per substitution, each then read
  // (`spliceCopies`). CPU time on both sides keeps load out of the ratio,
  // and the splices slow down with the machine as the request does; a
  // regression that makes the request more than twice as costly fails it
  // (four runs read 1.24 to 1.25 plain, 2.31 to 2.32 with coverage). The
  // calibration is the highest of four runs on an M-series Mac, with and
  // without coverage (which slows the renderer and not the copying); measure
  // again after a change that makes the request cheaper.
  const CAP_COST: CalibratedRatio = { plain: 1.25, coverage: 2.32 };
  it(
    "costs at most twice its calibrated share at the instance cap",
    async () => {
      expect(REQUEST_RENDER_LIMITS.maxInstances).toBe(1000);
      const output = nested(SIZE);
      const manifest = await build(list);
      config.minify.identifiers = false;
      const host = makeHost(manifest);
      const settle = () =>
        wrapRunner(
          runnerOf(output),
          serverPlan("a"),
          host,
        )("a", new AbortController().signal);
      expect(await settle()).not.toContain("<x-p");
      expectCostRatio(
        await measureCostRatioAsync(settle, () => spliceCopies(output, USAGES)),
        CAP_COST,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
