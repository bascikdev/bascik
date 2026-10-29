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
import { manifestCspHashes } from "./component-manifest-file.ts";
import { expandComponents } from "./component-expansion-core.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { deriveInstanceId, getAttributeNameHash } from "./names.ts";
import {
  composeBufferedResponse,
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
const enc = new TextEncoder();
const dec = new TextDecoder();

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
const renderAtBuild = (list: ComponentList, html: string): string => {
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
    warn: () => {},
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

/**
 * The visitor's value made no difference to what the browser runs: same
 * elements and attribute names, same script and style texts, no sink the
 * benign render lacks.
 */
const expectSameBrowserView = (
  benign: string,
  attacked: string,
  label: string,
): void => {
  const a = view(benign);
  const b = view(attacked);
  expect(b.shape, `${label}: element/attribute shape`).toEqual(a.shape);
  expect(b.scripts, `${label}: script texts`).toEqual(a.scripts);
  expect(b.styles, `${label}: style texts`).toEqual(a.styles);
  expect(
    b.sinks.filter((sink) => !a.sinks.includes(sink)),
    `${label}: new executable sinks`,
  ).toEqual([]);
};

// ─── Escapers an author may use ─────────────────────────────────────────────

/** server-scripts.md's escaper (all five characters). */
const escapeFull = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** The escaper in server-scripts.md's "Render a card per search result". */
const escapeCatalog = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
/** A correct escaper for a single-quoted attribute value (& and '). */
const escapeSingleQuoted = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("'", "&#39;");

/** Visitor values that try to leave every context a prop can land in. */
const PAYLOADS = [
  `<script>alert('xss')</script>`,
  `"><img src=x onerror=alert('xss')>`,
  `'><svg onload=alert('xss')>`,
  `</textarea><script>alert('xss')</script>`,
  `</style><script>alert('xss')</script>`,
  `</script><script>alert('xss')</script>`,
  `</title><img src=x onerror=alert('xss')>`,
  `</noscript><img src=x onerror=alert('xss')>`,
  `</xmp><img src=x onerror=alert('xss')>`,
  `</iframe><img src=x onerror=alert('xss')>`,
  `--><img src=x onerror=alert('xss')>`,
  `--!><img src=x onerror=alert('xss')>`,
  `]]><img src=x onerror=alert('xss')>`,
  `<![CDATA[<img src=x onerror=alert('xss')>]]>`,
  `&lt;img src=x onerror=alert('xss')&gt;`,
  `&#60;img src=x onerror=alert('xss')&#62;`,
  `&quot; onmouseover=&quot;alert('xss')`,
  `x' onmouseover='alert(1)`,
  `x" onmouseover="alert(1)`,
  ` x onmouseover=alert('xss') `,
  `<sec-text data-bascik-prop-v="smuggled"></sec-text>`,
  `<!--__BASCIK_NESTED_COMPONENT_0__-->`,
  `<script type="text/bascik-server" data-bascik-job="00000000000000000000000000000000:0"></script>`,
  `$&$'$1$$`,
  `}</style><style>*{background:url(//xss.example)}`,
  `alert('xss')`,
  `alert(document.domain)`,
  `\u0000<scr\u0000ipt>alert(1)</script>`,
];

/**
 * One component per place a prop or a slot can land, each with a root
 * element of class `r` for inheritance.
 */
const SINK_COMPONENTS: ComponentList = Object.fromEntries(
  Object.entries({
    "sec-text": `<p class="r" data-bascik-prop-v>fallback</p>`,
    "sec-title": `<div class="r"><title data-bascik-prop-v>t</title></div>`,
    "sec-textarea": `<div class="r"><textarea data-bascik-prop-v>t</textarea></div>`,
    "sec-noscript": `<div class="r"><noscript data-bascik-prop-v>n</noscript></div>`,
    "sec-xmp": `<div class="r"><xmp data-bascik-prop-v>x</xmp></div>`,
    "sec-iframe-text": `<div class="r"><iframe data-bascik-prop-v>i</iframe></div>`,
    "sec-noembed": `<div class="r"><noembed data-bascik-prop-v>e</noembed></div>`,
    "sec-option": `<select class="r"><option data-bascik-prop-v>o</option></select>`,
    "sec-style-recv": `<div class="r"><style data-bascik-prop-v>.r { color: red }</style></div>`,
    "sec-script-recv": `<div class="r"><script data-bascik-prop-v>var a = 1;</script></div>`,
    "sec-svg-text": `<svg class="r"><text data-bascik-prop-v>s</text></svg>`,
    "sec-svg-style": `<svg class="r"><style data-bascik-prop-v>text { fill: red }</style></svg>`,
    "sec-svg-title": `<svg class="r"><title data-bascik-prop-v>s</title></svg>`,
    "sec-math": `<math class="r"><mi data-bascik-prop-v>m</mi></math>`,
    "sec-template": `<div class="r"><template><p data-bascik-prop-v>t</p></template></div>`,
    "sec-attr-title": `<p class="r" title="d" data-bascik-attr-title="v">x</p>`,
    "sec-attr-data": `<p class="r" data-bascik-attr-data-x="v">x</p>`,
    "sec-attr-alt": `<img class="r" src="/i.png" alt="d" data-bascik-attr-alt="v">`,
    "sec-attr-value": `<input class="r" value="d" data-bascik-attr-value="v">`,
    "sec-attr-in-noscript": `<div class="r"><noscript><p data-bascik-attr-title="v">x</p></noscript></div>`,
    "sec-attr-in-textarea-title": `<div class="r"><title><p data-bascik-attr-title="v">x</p></title></div>`,
    "sec-slot": `<div class="r"><div data-bascik-slot>fallback</div></div>`,
    "sec-slot-named": `<div class="r"><b data-bascik-slot="s">fallback</b></div>`,
    "sec-slot-textarea": `<div class="r"><textarea data-bascik-slot>fallback</textarea></div>`,
    "sec-slot-title": `<div class="r"><title data-bascik-slot>fallback</title></div>`,
    "sec-slot-before-child": `<div class="r"><div data-bascik-slot>fb</div><sec-text data-bascik-prop-v="child"></sec-text></div>`,
    "sec-forward": `<div class="r"><sec-text data-bascik-attr-data-bascik-prop-v="v"></sec-text></div>`,
  }).map(([name, fileContent]) => [
    name,
    { fileName: `src/components/${name}.html`, fileContent },
  ]),
);

/** The usage a script writes for `q`, in every attribute and slot position. */
const usagesFor = (
  name: string,
  q: string,
  escape: (value: string) => string,
): Record<string, string> => ({
  "double-quoted prop": `<${name} data-bascik-prop-v="${escape(q)}"></${name}>`,
  "single-quoted prop": `<${name} data-bascik-prop-v='${escapeFull(q)}'></${name}>`,
  "default slot text": `<${name}>${escape(q)}</${name}>`,
  "named slot text": `<${name}><i data-bascik-slot="s">${escape(q)}</i></${name}>`,
  "inherited attribute": `<${name} title="${escape(q)}" data-extra="${escape(q)}"></${name}>`,
  "inherited class": `<${name} class="${escape(q)}"></${name}>`,
});

beforeEach(() => {
  config.base = "/";
  config.minify.identifiers = true;
  config.minify.html = false;
  config.scoping.deduplicateCss = true;
  config.scoping.inheritAttributes = true;
  serverSidecarRegistry.clear();
  clearScopingTemplates();
});

// ─── A. prop and slot values in every escaping position ─────────────────────

describe.each([
  ["escapeFull (server-scripts.md)", escapeFull],
  ["escapeCatalog (& < \" only, the docs' search example)", escapeCatalog],
] as const)(
  "A. an escaped visitor value never becomes markup: %s",
  (_label, escape) => {
    describe.each([true, false])("identifiers %s", (identifiers) => {
      beforeEach(() => {
        config.minify.identifiers = identifiers;
      });

      it.each(Object.keys(SINK_COMPONENTS))(
        "<%s>: every payload in every usage position renders the benign shape at request time and at build time",
        async (name) => {
          const manifest = await build(SINK_COMPONENTS);
          const failures: string[] = [];
          for (const [position, benign] of Object.entries(
            usagesFor(name, "ok", escape),
          )) {
            const benignRequest = (await renderAtRequest(manifest, benign))
              .html;
            const benignBuild = renderAtBuild(SINK_COMPONENTS, benign);
            for (const payload of PAYLOADS) {
              const usage = usagesFor(name, payload, escape)[position];
              const label = `<${name}> ${position} ${JSON.stringify(payload)}`;
              for (const [host, before, after] of [
                [
                  "request",
                  benignRequest,
                  (await renderAtRequest(manifest, usage)).html,
                ],
                ["build", benignBuild, renderAtBuild(SINK_COMPONENTS, usage)],
              ] as const) {
                try {
                  expectSameBrowserView(before, after, `${host} ${label}`);
                } catch (error) {
                  failures.push(
                    `${host} ${label}\n    rendered: ${after.replace(/\s+/g, " ").slice(0, 400)}\n    ${String((error as Error).message).split("\n")[0]}`,
                  );
                }
              }
            }
          }
          expect(failures, failures.slice(0, 6).join("\n")).toEqual([]);
        },
      );
    });
  },
);

describe("A. inherited attributes keep their quoting when moved onto the root", () => {
  // HTML lets `"` stand raw in a single-quoted value and `'` in a
  // double-quoted one; an escaper that is correct for the usage's quote need
  // not encode the other. The root element must not change the quote.
  const list: ComponentList = {
    "sq-root": {
      fileName: "src/components/sq-root.html",
      fileContent: `<div class='r' title='t'>x</div>`,
    },
    "dq-root": {
      fileName: "src/components/dq-root.html",
      fileContent: `<div class="r">x</div>`,
    },
  };
  const benignOf = (name: string) =>
    `<${name} title="ok" class="ok"></${name}>`;

  it("a single-quoted usage attribute with a raw double quote (escaped correctly for its quote) adds no attribute to the root", async () => {
    const manifest = await build(list);
    const q = `x" onmouseover="alert(1)`;
    const usage = `<dq-root title='${escapeSingleQuoted(q)}' class='${escapeSingleQuoted(q)}'></dq-root>`;
    const benign = (await renderAtRequest(manifest, benignOf("dq-root"))).html;
    const request = (await renderAtRequest(manifest, usage)).html;
    expectSameBrowserView(benign, request, `request ${request}`);
    expectSameBrowserView(
      renderAtBuild(list, benignOf("dq-root")),
      renderAtBuild(list, usage),
      `build ${renderAtBuild(list, usage)}`,
    );
  });

  it("a double-quoted usage class with a raw single quote (the docs' search escaper) adds no attribute to a single-quoted root class", async () => {
    const manifest = await build(list);
    const q = `x' onmouseover='alert(1)`;
    const usage = `<sq-root class="${escapeCatalog(q)}"></sq-root>`;
    const benign = (await renderAtRequest(manifest, benignOf("sq-root"))).html;
    const request = (await renderAtRequest(manifest, usage)).html;
    expectSameBrowserView(benign, request, `request ${request}`);
    expectSameBrowserView(
      renderAtBuild(list, benignOf("sq-root")),
      renderAtBuild(list, usage),
      `build ${renderAtBuild(list, usage)}`,
    );
  });

  it("misuse: an unquoted usage attribute (documented as never) is author error: the escaper cannot stop a space", async () => {
    const manifest = await build(list);
    const usage = `<dq-root title=${escapeFull("x onmouseover=alert(1)")}></dq-root>`;
    const out = (await renderAtRequest(manifest, usage)).html;
    // Pinned so a change shows up: the handler reaches the root, as it
    // would reach any element the author wrote with an unquoted attribute.
    expect(view(out).sinks).toEqual(["div onmouseover=alert(1)"]);
  });
});

// ─── B. props bound into URL attributes ─────────────────────────────────────

describe("B. a prop bound with data-bascik-attr-* into a URL attribute", () => {
  const list: ComponentList = Object.fromEntries(
    Object.entries({
      "url-a-href": `<a class="r" href="/d" data-bascik-attr-href="u">go</a>`,
      "url-area-href": `<map class="r" name="m"><area href="/d" data-bascik-attr-href="u"></map>`,
      "url-img-src": `<img class="r" src="/d.png" data-bascik-attr-src="u">`,
      "url-iframe-src": `<iframe class="r" data-bascik-attr-src="u"></iframe>`,
      "url-form-action": `<form class="r" data-bascik-attr-action="u"><button>go</button></form>`,
      "url-button-formaction": `<button class="r" data-bascik-attr-formaction="u">go</button>`,
      "url-svg-xlink": `<svg class="r"><a data-bascik-attr-xlink:href="u"><text>go</text></a></svg>`,
      "url-svg-href": `<svg class="r"><a data-bascik-attr-href="u"><text>go</text></a></svg>`,
      "url-img-srcset": `<img class="r" src="/d.png" data-bascik-attr-srcset="u">`,
      "url-video-poster": `<video class="r" data-bascik-attr-poster="u"></video>`,
      "url-object-data": `<object class="r" data-bascik-attr-data="u"></object>`,
      "url-embed-src": `<embed class="r" data-bascik-attr-src="u">`,
      "url-srcdoc": `<iframe class="r" data-bascik-attr-srcdoc="u"></iframe>`,
      "url-onclick": `<button class="r" data-bascik-attr-onclick="u">go</button>`,
      "url-style": `<p class="r" data-bascik-attr-style="u">x</p>`,
    }).map(([name, fileContent]) => [
      name,
      { fileName: `src/components/${name}.html`, fileContent },
    ]),
  );
  const URLS = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " \t javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript&colon;alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "/ok, javascript:alert(1) 2x",
  ];

  it.each(Object.keys(list))(
    "<%s>: no URL a visitor can type (escaped with the documented escaper) becomes a script URL, handler or srcdoc markup",
    async (name) => {
      const manifest = await build(list);
      const entry = manifest.components[name];
      const failures: string[] = [];
      for (const url of URLS) {
        const usage = `<${name} data-bascik-prop-u="${escapeFull(url)}"></${name}>`;
        for (const [host, out] of [
          [
            entry.unsupported
              ? `request (unsupported: ${entry.unsupported.reason})`
              : "request",
            (await renderAtRequest(manifest, usage)).html,
          ],
          ["build", renderAtBuild(list, usage)],
        ] as const) {
          const sinks = view(out).sinks;
          if (sinks.length > 0)
            failures.push(
              `${host} ${JSON.stringify(url)} -> ${sinks.join(" | ")}`,
            );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    },
  );

  it('a fragment href ("#root") only ever resolves to an id of the same instance, and an unknown fragment is left as written', async () => {
    const card: ComponentList = {
      "frag-card": {
        fileName: "src/components/frag-card.html",
        fileContent: `<div class="r"><p id="root">x</p><a href="#" data-bascik-attr-href="u">go</a></div>`,
      },
    };
    const manifest = await build(card);
    const out = (
      await renderAtRequest(
        manifest,
        `<frag-card data-bascik-prop-u="#root"></frag-card><frag-card data-bascik-prop-u="#elsewhere"></frag-card>`,
      )
    ).html;
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const hrefs = [...out.matchAll(/ href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs[0]).toBe(`#${ids[0]}`);
    expect(hrefs[1]).toBe("#elsewhere");
  });
});

// ─── C. script gadgets under a hash-only CSP ────────────────────────────────

describe("C. what an injected component tag gains under generate.cspHashes", () => {
  const list: ComponentList = {
    "gadget-card": {
      fileName: "src/components/gadget-card.html",
      fileContent:
        `<div class="g" data-bascik-attr-data-cfg="cfg"><span class="n" data-bascik-prop-n>n</span>` +
        `<div data-bascik-slot>s</div></div>` +
        `<script>document.querySelectorAll(".g").forEach((el) => el.classList.add("ready"));</script>`,
      cssFileContent: ".g { color: red } .n { color: blue }",
    },
    "plain-card": {
      fileName: "src/components/plain-card.html",
      fileContent: `<p class="p" data-bascik-prop-n>n</p>`,
      cssFileContent: ".p { color: green }",
    },
  };
  const page = async (manifest: ComponentManifest, output: string) => {
    const plan: ExecutionPlan = {
      segments: [
        { kind: "static", bytes: enc.encode("<!doctype html><html><body>") },
        { kind: "script", mode: "server", id: "a" },
        { kind: "static", bytes: enc.encode("</body></html>") },
      ],
      firstStreamIndex: -1,
    };
    const host = makeHost(manifest);
    const wrapped = wrapRunner(runnerOf(output), plan, host);
    return dec.decode(await composeBufferedResponse(plan, wrapped));
  };

  it("every inline script and style a request renders is one the route's widened hashes list, and no prop, slot or id the attacker picks changes any of their texts", async () => {
    const manifest = await build(list);
    const allowed = manifestCspHashes(manifest);
    // An author who forgot to escape: the visitor writes the tags.
    const injected =
      `<gadget-card data-bascik-prop-cfg="{&quot;evil&quot;:1}" data-bascik-prop-n="</script><script>alert(1)</script>" id="steer" class="steer">` +
      `<script>alert('raw')</script><style>*{x:y}</style></gadget-card>` +
      `<plain-card data-bascik-prop-n="${"x".repeat(50)}"></plain-card>`;
    const out = await page(manifest, injected);
    const hashes = computePageCspHashes(out);
    // The raw <script> and <style> the visitor wrote are NOT listed: a
    // hash-only policy blocks them, as it does without components.
    const unlisted = {
      scripts: hashes.scripts.filter((h) => !allowed.scripts.includes(h)),
      styles: hashes.styles.filter((h) => !allowed.styles.includes(h)),
    };
    expect(unlisted.scripts).toHaveLength(1);
    expect(unlisted.styles).toHaveLength(1);
    // What the injection gains is exactly the site's own listed component
    // code, with the same text as for a benign usage.
    const benign = await page(
      manifest,
      `<gadget-card data-bascik-prop-n="ok"></gadget-card><plain-card></plain-card>`,
    );
    const benignHashes = computePageCspHashes(benign);
    for (const hash of benignHashes.scripts)
      expect(hashes.scripts).toContain(hash);
    expect(
      hashes.scripts.filter(
        (h) => allowed.scripts.includes(h) && !benignHashes.scripts.includes(h),
      ),
    ).toEqual([]);
  });

  it("request-time instance ids depend on the route, job and ordinal only: props, slots and inherited attributes cannot steer the minted ids", async () => {
    const anchored: ComponentList = {
      "anchor-card": {
        fileName: "src/components/anchor-card.html",
        fileContent: `<div class="g"><p id="anchor" data-bascik-prop-n>a</p></div>`,
      },
    };
    const manifest = await build(anchored);
    const scopedIds = async (output: string) =>
      [
        ...(await renderAtRequest(manifest, output)).html.matchAll(
          /<p id="([^"]+)"/g,
        ),
      ].map((m) => m[1]);
    const a = await scopedIds(
      `<anchor-card data-bascik-prop-n="a"></anchor-card><anchor-card></anchor-card>`,
    );
    const b = await scopedIds(
      `<anchor-card data-bascik-prop-n="r0000000" id="r0000000" data-bascik-instance="r0000000">r0000000</anchor-card>` +
        `<anchor-card class="r1111111" data-bascik-prop-anchor="x"></anchor-card>`,
    );
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
    expect(b.join(" ")).not.toMatch(/r0000000|r1111111/);
  });

  it("the job-marker nonce never reaches the response: a component with a nested server script leaves no data-bascik-job and no nonce", async () => {
    const nested: ComponentList = {
      "srv-card": {
        fileName: "src/components/srv-card.html",
        fileContent: `<div class="w"><script data-bascik-server>export default () => "<b>live</b>";</script></div>`,
      },
    };
    const manifest = await build(nested);
    const { html, host } = await renderAtRequest(
      manifest,
      `<srv-card></srv-card><srv-card></srv-card>`,
      { runComponentJob: vi.fn(async () => "<b>live</b>") },
    );
    expect(host.runComponentJob).toHaveBeenCalledTimes(2);
    expect(html).not.toContain("data-bascik-job");
    expect(html).not.toMatch(/[0-9a-f]{32}/);
  });
});

// ─── D. nested server jobs ──────────────────────────────────────────────────

describe("D. nested component jobs an injected tag can start", () => {
  const list: ComponentList = {
    "srv-card": {
      fileName: "src/components/srv-card.html",
      fileContent: `<div class="w"><script data-bascik-server>export default (request) => new URL(request.url).pathname;</script></div>`,
    },
  };

  it("a nested job receives only its staged id, the render signal and the remaining budget: no prop, slot or attribute of the usage", async () => {
    const manifest = await build(list);
    const { host } = await renderAtRequest(
      manifest,
      `<srv-card data-bascik-prop-url="http://169.254.169.254/" data-url="http://169.254.169.254/">http://169.254.169.254/</srv-card>`,
    );
    expect(host.runComponentJob).toHaveBeenCalledTimes(1);
    const args = host.runComponentJob.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(args[0]).toMatch(/^component_script_[0-9a-f]+$/);
    expect(JSON.stringify(args[0])).not.toContain("169.254");
    expect(args[1]).toBeInstanceOf(AbortSignal);
    expect(typeof args[2]).toBe("number");
  });

  it("1000 injected tags with a nested script start no job at all: the 64-job budget is checked before any runs", async () => {
    const manifest = await build(list);
    const output = "<srv-card></srv-card>".repeat(1000);
    const host = makeHost(manifest);
    const wrapped = wrapRunner(runnerOf(output), serverPlan("a"), host);
    await expect(wrapped("a", new AbortController().signal)).rejects.toThrow(
      RequestRenderError,
    );
    expect(host.runComponentJob).not.toHaveBeenCalled();
  });

  it(`at most ${REQUEST_RENDER_LIMITS.maxNestedJobs} nested jobs per response, each with what is left of the page budget`, async () => {
    const manifest = await build(list);
    const output = "<srv-card></srv-card>".repeat(
      REQUEST_RENDER_LIMITS.maxNestedJobs,
    );
    const { host } = await renderAtRequest(manifest, output, {
      timeoutMs: 50,
    });
    expect(host.runComponentJob).toHaveBeenCalledTimes(
      REQUEST_RENDER_LIMITS.maxNestedJobs,
    );
    for (const call of host.runComponentJob.mock.calls)
      expect(call[2]).toBeLessThanOrEqual(50);
  });
});

// ─── E. tag smuggling ───────────────────────────────────────────────────────

describe("E. tags an attacker can spell in escaped or raw-text positions stay text", () => {
  const list: ComponentList = {
    "srv-card": {
      fileName: "src/components/srv-card.html",
      fileContent: `<div class="w"><script data-bascik-server>export default () => "<b>live</b>";</script></div>`,
    },
    "x-card": {
      fileName: "src/components/x-card.html",
      fileContent: `<p class="x" data-bascik-prop-v>x</p><div data-bascik-slot>s</div>`,
    },
  };
  const SMUGGLED = [
    "<srv-card></srv-card>",
    "<SRV-CARD></SRV-CARD>",
    "<srv-card/>",
    "<srv\u0000-card></srv\u0000-card>",
    "<srv-card\u0000></srv-card>",
    "&lt;srv-card&gt;&lt;/srv-card&gt;",
    "&#60;srv-card&#62;",
    "<!--<srv-card></srv-card>-->",
    "<![CDATA[<srv-card></srv-card>]]>",
    `<script type="text/bascik-server" data-bascik-server-id="component_script_${Buffer.from("srv-card::1").toString("hex")}"></script>`,
    `<script type="text/bascik-server" data-bascik-job="${"0".repeat(32)}:0"></script>`,
    "<!--bascik-job:0-->",
  ];

  it("escaped into a prop or slot of a rendered component, no smuggled tag, marker or placeholder ever runs a job or expands", async () => {
    const manifest = await build(list);
    for (const q of SMUGGLED) {
      const output =
        `<x-card data-bascik-prop-v="${escapeCatalog(q)}">${escapeCatalog(q)}</x-card>` +
        `<x-card data-bascik-prop-v="${escapeFull(q)}"><i data-bascik-slot>${escapeFull(q)}</i></x-card>`;
      const { html, host } = await renderAtRequest(manifest, output);
      expect(host.runComponentJob, q).not.toHaveBeenCalled();
      expect(
        view(html).shape.filter((s) => /srv|script/i.test(s)),
        q,
      ).toEqual([]);
    }
  });

  it.each([
    ["textarea", "<textarea>", "</textarea>"],
    ["style", "<style>", "</style>"],
    ["script", "<script>", "</script>"],
    ["comment", "<!--", "-->"],
    ["attribute value", `<p title="`, `">x</p>`],
  ])(
    "author error (raw tag) inside a %s: Bascik does not expand it and runs no job",
    async (_where, open, close) => {
      const manifest = await build(list);
      const output = `${open}<srv-card></srv-card>${close}`;
      const { html, host } = await renderAtRequest(manifest, output);
      expect(host.runComponentJob).not.toHaveBeenCalled();
      expect(html).toBe(output);
    },
  );

  it.each([
    ["title", "<title>", "</title>"],
    ["noscript", "<noscript>", "</noscript>"],
    ["xmp", "<xmp>", "</xmp>"],
    ["iframe", "<iframe>", "</iframe>"],
    ["noembed", "<noembed>", "</noembed>"],
    ["noframes", "<noframes>", "</noframes>"],
    ["template", "<template>", "</template>"],
    ["svg", "<svg>", "</svg>"],
    ["math", "<math>", "</math>"],
  ])(
    "author error (raw tag) inside a %s: whatever Bascik expands, the browser runs no visitor markup from it",
    async (_where, open, close) => {
      const manifest = await build(list);
      const output = `${open}<x-card data-bascik-prop-v="&lt;img src=x onerror=alert(1)&gt;"></x-card>${close}`;
      const { html } = await renderAtRequest(manifest, output);
      expect(view(html).sinks).toEqual([]);
    },
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
  const nested = (size: number) =>
    `<my-card>${padded("<x-p><a ", size)}</my-card>`;
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
    "<my-card> + fill('<x-p><a ') + </my-card> settles (rendered or a RequestRenderError) in linear time",
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
  // bounds the usage count, and `maxOutputChars` the length: 998 usages in a
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

// ─── F. other request-time surfaces ─────────────────────────────────────────

describe("F. prototype keys, replacement patterns and response framing", () => {
  const list: ComponentList = {
    "p-card": {
      fileName: "src/components/p-card.html",
      fileContent:
        `<div class="p"><b data-bascik-prop-__proto__>a</b><i data-bascik-prop-constructor>b</i>` +
        `<u data-bascik-slot="__proto__">c</u><s data-bascik-slot="hasOwnProperty">d</s>` +
        `<a href="/x" data-bascik-attr-href="toString">e</a></div>`,
    },
  };

  it("props and slots named after Object.prototype members are plain data: no pollution, no native code, no throw", async () => {
    const manifest = await build(list);
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const { html } = await renderAtRequest(
      manifest,
      `<p-card data-bascik-prop-__proto__="P" data-bascik-prop-constructor="C" data-bascik-prop-polluted="Z">` +
        `<u data-bascik-slot="__proto__">S</u><s data-bascik-slot="hasOwnProperty">H</s></p-card><p-card></p-card>`,
    );
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(html).not.toContain("[native code]");
    expect(html).not.toContain("[object Object]");
  });

  it("CR, LF and header-shaped text in a script's output stay in the body: the renderer returns a string, never headers", async () => {
    const manifest = await build(list);
    const q = "\r\nSet-Cookie: pwned=1\r\nVary: *\r\n\r\n<h1>split</h1>";
    const { html } = await renderAtRequest(
      manifest,
      `<p-card data-bascik-prop-constructor="${escapeFull(q)}">${escapeFull(q)}</p-card>`,
    );
    expect(html).toContain("Set-Cookie: pwned=1");
    expect(view(html).shape.filter((s) => s.startsWith("h1"))).toEqual([]);
  });
});
