/**
 * Tests for the build-time component manifest (prompt 157, D3).
 *
 * `buildComponentManifest(componentList, config)` records, per component, a
 * `ScopingTemplate` on a sentinel id (recordScopingRun + buildScopingTemplate,
 * verified with a second id) that a request-time renderer instantiates for a
 * fresh id with the host's name hash, or marks the component unsupported with
 * one of the D7 reasons. The contract pinned here:
 *
 * - The template is the component's own scoping run: nested usages stay in
 *   the template as written (scoped the way the build scopes the parent) and
 *   are expanded by the loop at request time, which is what keeps slot and
 *   prop forwarding, nested ordinals and nested CSS identical to the build.
 *   A template that pre-expanded its children could not forward a usage's
 *   slot content to them (design D4 item 15), so no nested instance token
 *   exists: two usages of a child get two ids from the loop's minter.
 * - Attr bindings to id/name/class/style/fill/stroke/mask/clip-path/filter/
 *   marker-* are unsupported (value-dependent before scoping); every other
 *   binding is injected after scoping, byte-identical to the build order
 *   except id references, restored through `scopedIdNames`.
 * - Build-once and page-independent `data-bascik-build` scripts run once, with
 *   an empty page context, into the template; a page-context reader is
 *   unsupported. Server and stream scripts whose body is stable across two
 *   sentinel ids are staged once as `component_script_<hex(name::ordinal)>`
 *   with their output scope; the template holds only the placeholder.
 * - `css.text` is the page pipeline's exact bytes (dedupe -> base rewrite ->
 *   minifier) and `css.hash` the CSP hash of `<style>text</style>`.
 * - `minify.js` runs on the sentinel output and every token must survive with
 *   the same count; `minify.html` is never applied to the template.
 * - The JSON is deterministic and `readComponentManifest` refuses another
 *   schema with the "Run `bascik --build`" message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { transform } from "esbuild";

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
    scripts: { cache: { enabled: true }, onBuildScriptError: "error" },
    components: { external: [] },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

// Build scripts run in child processes through runDirectiveHandler; the mock
// counts the runs and answers like the runner would, so a build script's
// output lands in the template without spawning Node.
const { runDirectiveHandlerMock } = vi.hoisted(() => ({
  runDirectiveHandlerMock: vi.fn(),
}));
vi.mock("./handler-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handler-runner.ts")>()),
  runDirectiveHandler: runDirectiveHandlerMock,
}));

import { BascikConfig } from "./config.ts";
import {
  clearBuildScriptCaches,
  executeBuildScripts,
} from "./build-scripts.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import {
  buildComponentManifest,
  readComponentManifest,
  startComponentManifest,
  takeComponentManifest,
  writeComponentManifest,
  COMPONENT_MANIFEST_SCHEMA_VERSION,
  type ComponentManifest,
  type ManifestEntry,
} from "./component-manifest.ts";
import {
  expandComponents,
  type ExpandOptions,
} from "./component-expansion-core.ts";
import {
  BUILD_EXPANSION_LIMITS,
  recursivelyTranspile,
} from "./component-expansion.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { installProcessCrashHandlers } from "./crash-net.ts";
import { minifyCss } from "./css-minifier.ts";
import { deriveInstanceId, getAttributeNameHash } from "./names.ts";
import { decodeOutputScope } from "./output-scope.ts";
import { memoizedMinifyJs } from "./js-minifier.ts";
import { minifyScriptTagsInHtml } from "./page-minification.ts";
import { rewriteCssBasePaths } from "./base-path.ts";
import {
  applyScopingResult,
  instantiateTemplate,
  join as joinSegments,
  type ScopingTemplate,
} from "./scoping-instantiate.ts";
import {
  clearScopingTemplates,
  runScopingPipeline,
} from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { deduplicateCss } from "./styles.ts";
import type { BascikComponent, ComponentList } from "./types.ts";
import {
  componentList as coreFixtureList,
  ID_REFS_PAGE,
  PAGE,
  PAGE_PATH,
} from "./__fixtures__/component-expansion-core.fixture.ts";

type MutableConfig = {
  base: string;
  minify: {
    identifiers: boolean;
    html: boolean;
    css: boolean | ((code: string) => string | Promise<string>);
    js: boolean | ((code: string) => string | Promise<string>);
  };
  scoping: { deduplicateCss: boolean; inheritAttributes: boolean };
  scripts: { onBuildScriptError: "error" | "warn" | "ignore" };
};
const config = BascikConfig as unknown as MutableConfig;

const identity = (input: string): string => input;
const hashFor = (identifiers: boolean) =>
  identifiers ? getAttributeNameHash : identity;
const scopedClass = (component: string, name: string, identifiers: boolean) =>
  hashFor(identifiers)(`bascik__${component}__${name}`);

const REQUEST_IDS = ["r1a2b3c4", "r0badf00"] as const;
const hex = (text: string): string => Buffer.from(text).toString("hex");
const componentScriptId = (name: string, ordinal: number): string =>
  `component_script_${hex(`${name}::${ordinal}`)}`;
const sha = (body: string): string =>
  `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;

const BUILT_OUTPUT = '<p class="built">built</p>';
const defaultHandler = async () => ({
  result: BUILT_OUTPUT,
  stdout: "",
  stderr: "",
  readsPageContext: false,
});

/**
 * A per-test nonce keeps the build script cache (on disk, keyed by the
 * script text) from answering for a previous run or an earlier test: each
 * test's scripts are distinct, so the runs it counts are its own. A test that
 * builds twice shares one nonce across both builds.
 */
let nonce = "";
let nonceCounter = 0;

const cards = (): ComponentList => ({
  // Ids, names, classes and a script that references an id: the script body
  // carries an instance token, so its CSP hash is per instance.
  "my-card": {
    fileName: "src/components/my-card.html",
    fileContent: `<div id="root" class="card"><label for="field">L</label><input id="field" name="q"><span data-bascik-prop-t>Untitled</span>
<script>const root = document.getElementById("root"); root.querySelector(".toggle").classList.add("on");</script></div>`,
    cssFileContent: ".card { padding: 0 } .toggle { color: red }",
  },
  // A class-only script: identical text for every instance.
  "plain-card": {
    fileName: "src/components/plain-card.html",
    fileContent: `<article class="plain"><span data-bascik-prop-t>none</span><script>document.querySelector(".plain").classList.add("seen");</script></article>`,
    cssFileContent: ".plain { color: blue } .seen { color: green }",
  },
  "glow-card": {
    fileName: "src/components/glow-card.html",
    fileContent: `<svg><filter id="glow"></filter></svg><div class="box"><style>.box { filter: url(#glow) }</style></div>`,
    cssFileContent: ".box { clip-path: url(#glow) }",
  },
  "bare-card": {
    fileName: "src/components/bare-card.html",
    fileContent: `<p class="bare">no stylesheet, no script</p>`,
  },
  "asset-card": {
    fileName: "src/components/asset-card.html",
    fileContent: `<div class="hero"><a href="/pricing">p</a></div>`,
    cssFileContent:
      ".hero { background: url(/img/hero.png) }\n\n.hero  .x { color: red }",
  },
});

const bindingCards = (): ComponentList => {
  const list: ComponentList = {};
  for (const target of [
    "id",
    "name",
    "class",
    "style",
    "fill",
    "stroke",
    "mask",
    "clip-path",
    "filter",
    "marker-start",
    "marker-end",
    "usemap",
  ]) {
    list[`bad-${target}`] = {
      fileName: `src/components/bad-${target}.html`,
      fileContent: `<div class="w"><span data-bascik-attr-${target}="v">x</span></div>`,
      cssFileContent: ".w { color: red }",
    };
  }
  list["img-src-card"] = {
    fileName: "src/components/img-src-card.html",
    fileContent: `<img data-bascik-attr-src="img" data-bascik-attr-alt="alt">`,
  };
  list["src-build-card"] = {
    fileName: "src/components/src-build-card.html",
    fileContent: `<div class="w"><script data-bascik-build data-bascik-attr-src="entry"></script></div>`,
    cssFileContent: ".w { color: red }",
  };
  list["src-server-card"] = {
    fileName: "src/components/src-server-card.html",
    fileContent: `<div class="w"><script data-bascik-server data-bascik-attr-src="entry"></script></div>`,
    cssFileContent: ".w { color: red }",
  };
  return list;
};

/**
 * Bindings to the id-reference attributes the build rewrites only on some
 * elements (id-references.ts: `for` on label/output, `headers` on td/th,
 * fragment `href` on a/area/use, `xlink:href` on use). The request-time
 * rewrite is per target attribute and never sees the element, so a binding
 * on any other element is refused rather than rewritten where the build
 * would not.
 */
const refCards = (): ComponentList => ({
  "span-for-card": {
    fileName: "src/components/span-for-card.html",
    fileContent: `<div class="w"><span data-bascik-attr-for="f">x</span><input id="x"></div>`,
    cssFileContent: ".w { color: red }",
  },
  "button-href-card": {
    fileName: "src/components/button-href-card.html",
    fileContent: `<div class="w"><button data-bascik-attr-href="h">b</button><i id="x"></i></div>`,
    cssFileContent: ".w { color: red }",
  },
  "div-headers-card": {
    fileName: "src/components/div-headers-card.html",
    fileContent: `<div class="w"><div data-bascik-attr-headers="h">c</div><b id="x"></b></div>`,
    cssFileContent: ".w { color: red }",
  },
  "image-xlink-card": {
    fileName: "src/components/image-xlink-card.html",
    fileContent: `<svg><image data-bascik-attr-xlink:href="h"></image><g id="x"></g></svg>`,
  },
  "label-for-card": {
    fileName: "src/components/label-for-card.html",
    fileContent: `<div class="w"><label data-bascik-attr-for="f">l</label><output data-bascik-attr-for="o"></output><input id="x"></div>`,
    cssFileContent: ".w { color: red }",
  },
  "td-headers-card": {
    fileName: "src/components/td-headers-card.html",
    fileContent: `<table><tr><th id="x">h</th><td data-bascik-attr-headers="h">c</td></tr></table>`,
  },
  "area-href-card": {
    fileName: "src/components/area-href-card.html",
    fileContent: `<div class="w"><a data-bascik-attr-href="h">a</a><map name="m"><area data-bascik-attr-href="h" alt="a"></map><svg><use data-bascik-attr-xlink:href="u" data-bascik-attr-href="h"></use></svg><i id="x"></i></div>`,
    cssFileContent: ".w { color: red }",
  },
});

const scriptCards = (): ComponentList => ({
  "srv-card": {
    fileName: "src/components/srv-card.html",
    fileContent: `<div class="wrap"><script data-bascik-server>
export default () => '<p class="line">from server</p>';
</script></div>`,
    cssFileContent: ".wrap { margin: 0 } .line { color: red }",
  },
  "stream-card": {
    fileName: "src/components/stream-card.html",
    fileContent: `<div class="wrap"><script data-bascik-stream>export default async () => '<p class="line">streamed</p>';</script><script data-bascik-server>export default () => '<b class="line">second</b>';</script></div>`,
    cssFileContent: ".wrap { margin: 0 } .line { color: red }",
  },
  // The body references no name, but the CSS resolves `url(#shape)`, so the
  // component's classes are scoped per instance and the output scope the
  // script's open tag carries embeds the instance id.
  "srv-glow-card": {
    fileName: "src/components/srv-glow-card.html",
    fileContent: `<div class="wrap"><svg><defs><g id="shape"></g></defs></svg><script data-bascik-server>export default () => '<p>x</p>';</script></div>`,
    cssFileContent: ".wrap { mask: url(#shape) } p { color: red }",
  },
  // `id="out"` inside the body is scoped per instance, so the staged source
  // would have to differ per request.
  "srv-id-card": {
    fileName: "src/components/srv-id-card.html",
    fileContent: `<div class="wrap" id="out"><script data-bascik-server>export default () => '<p id="out" class="line">x</p>';</script></div>`,
    cssFileContent: ".wrap { margin: 0 } .line { color: red }",
  },
});

const buildScriptCards = (): ComponentList => ({
  "built-card": {
    fileName: "src/components/built-card.html",
    fileContent: `<div class="shell"><script data-bascik-build>
// ${nonce}
export default () => '<p class="built">built</p>';
</script></div>`,
    cssFileContent: ".shell { margin: 0 } .built { color: red }",
  },
  "once-card": {
    fileName: "src/components/once-card.html",
    fileContent: `<div class="shell"><script data-bascik-build-once>
// ${nonce}
export default () => '<p class="built">built</p>';
</script></div>`,
    cssFileContent: ".shell { margin: 0 } .built { color: red }",
  },
  "ctx-card": {
    fileName: "src/components/ctx-card.html",
    fileContent: `<div class="shell"><script data-bascik-build>
// ${nonce}
export default () => process.env.BASCIK_PAGE_PATH;
</script></div>`,
    cssFileContent: ".shell { margin: 0 }",
  },
});

/** A `data-bascik-build` script that prints `output` and nothing else. */
const printingCard = (name: string, output: string, root = true) => ({
  fileName: `src/components/${name}.html`,
  fileContent: root
    ? `<div class="shell"><script data-bascik-build>\n// ${nonce}\nexport default () => ${JSON.stringify(output)};\n</script></div>`
    : `<script data-bascik-build>\n// ${nonce}\nexport default () => ${JSON.stringify(output)};\n</script>`,
  cssFileContent: ".shell { margin: 0 } .built { color: red }",
});

/**
 * Printed markup the parent's own prop, slot and attr-binding injection
 * would act on at request time (the output is part of the template) but
 * never at page time (it is printed after the usage was injected).
 */
const printedMarkerCards = (): ComponentList => ({
  "printed-prop-card": printingCard(
    "printed-prop-card",
    `<p data-bascik-prop-title>Default title</p>`,
  ),
  "printed-slot-card": printingCard(
    "printed-slot-card",
    `<div data-bascik-slot="x">default x</div>`,
  ),
  "printed-default-slot-card": printingCard(
    "printed-default-slot-card",
    `<div data-bascik-slot>default</div>`,
  ),
  "printed-attr-card": printingCard(
    "printed-attr-card",
    `<a data-bascik-attr-title="t" title="old" href="/l">l</a>`,
  ),
  "printed-preserve-card": printingCard(
    "printed-preserve-card",
    `<pre data-bascik-preserve>kept</pre>`,
  ),
  // A valued prop marker is a nested usage's declaration, which the loop
  // consumes the same way on both paths.
  "printed-nested-card": printingCard(
    "printed-nested-card",
    `<nest-child data-bascik-prop-l="one"></nest-child>`,
  ),
  // The authored marker is declared before the script prints: injected on
  // both paths.
  "authored-prop-card": {
    fileName: "src/components/authored-prop-card.html",
    fileContent: `<div class="shell"><span data-bascik-prop-t>none</span><script data-bascik-build>\n// ${nonce}\nexport default () => '<p class="built">built</p>';\n</script></div>`,
    cssFileContent: ".shell { margin: 0 } .built { color: red }",
  },
});

const nestedCards = (): ComponentList => ({
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
});

const build = (list: ComponentList): Promise<ComponentManifest> =>
  buildComponentManifest(list, BascikConfig);

const entryOf = (manifest: ComponentManifest, name: string): ManifestEntry => {
  const entry = manifest.components[name];
  expect(entry, `manifest entry for <${name}>`).toBeDefined();
  return entry;
};

const templateOf = (
  manifest: ComponentManifest,
  name: string,
): ScopingTemplate => {
  const entry = entryOf(manifest, name);
  expect(entry.unsupported).toBeUndefined();
  expect(entry.template).not.toBeNull();
  return entry.template as ScopingTemplate;
};

/** The instantiated template text for `instanceId`. */
const render = (
  manifest: ComponentManifest,
  name: string,
  instanceId: string,
): string => {
  const result = instantiateTemplate(
    templateOf(manifest, name),
    instanceId,
    hashFor(manifest.identifiers),
  );
  expect(result).not.toBeNull();
  return result!.fileContent;
};

const freshState = () => ({
  ordinalMap: new Map<string, number>(),
  issuedIds: new Set<string>(),
});

/**
 * The request-time id-reference rewrite (D4), per target attribute, over the
 * bare id-reference targets the build rewrites (id-references.ts).
 */
const BARE_ID_TARGET =
  /^(?:for|form|list|popovertarget|commandfor|aria-(?:activedescendant|errormessage|labelledby|describedby|controls|owns|flowto|details)|itemref|headers)$/i;
const requestRewriteIdRefs = (
  target: string,
  value: string,
  scopedIdNames: Record<string, string>,
): string => {
  if (/^(?:xlink:)?href$/i.test(target)) {
    return value.startsWith("#") && scopedIdNames[value.slice(1)]
      ? `#${scopedIdNames[value.slice(1)]}`
      : value;
  }
  if (BARE_ID_TARGET.test(target)) {
    return value
      .split(/(\s+)/)
      .map((part) => scopedIdNames[part] ?? part)
      .join("");
  }
  return value;
};

/**
 * Render a page through the loop with the manifest's templates as the scope,
 * the way a request host does, but with the build's id minter so the output
 * can be compared with `recursivelyTranspile` byte for byte.
 */
const renderWithManifest = (
  html: string,
  list: ComponentList,
  manifest: ComponentManifest,
  pagePath: string,
  overrides: Partial<ExpandOptions> = {},
) => {
  const state = freshState();
  const hashName = hashFor(manifest.identifiers);
  return expandComponents(
    html,
    list,
    {
      scope: (component: BascikComponent, instanceId: string) => {
        const entry = manifest.components[component.name];
        if (!entry?.template) return null;
        const result = instantiateTemplate(
          entry.template,
          instanceId,
          hashName,
        );
        return result && applyScopingResult({ ...component }, result);
      },
      mintId: (name, ordinal) =>
        deriveInstanceId(pagePath, name, ordinal, state.issuedIds),
      injectAttrProps: "after-scope",
      rewriteIdRefs: requestRewriteIdRefs,
      numberSourceUrls: false,
      inheritAttributes: manifest.inheritAttributes,
      instanceState: state,
      limits: BUILD_EXPANSION_LIMITS,
      onError: (component, stage, error) => {
        throw new Error(
          `<${component.name}> failed during ${stage}: ${String(error)}`,
        );
      },
      ...overrides,
    },
    [],
    pagePath,
  );
};

const viaBuild = (html: string, list: ComponentList, pagePath: string) => {
  clearScopingTemplates();
  return recursivelyTranspile(html, list, [], pagePath, freshState());
};

/** Request-time instances carry no `?instance=N` sourceURL suffix (D4). */
const unnumbered = (html: string): string =>
  html.replace(/\?instance=\d+/g, "");

/** The page pipeline's CSS bytes for one scoped component (page-transpile.ts). */
const pipelineCss = async (
  component: BascikComponent,
  base: string,
  minifier: ((css: string) => string | Promise<string>) | null,
): Promise<string> => {
  const combined = rewriteCssBasePaths(deduplicateCss([component], true), base);
  return minifier ? await minifier(combined) : combined;
};

beforeEach(() => {
  nonce = `${process.pid}-${Date.now().toString(36)}-${++nonceCounter}`;
  config.base = "/";
  config.minify.identifiers = true;
  config.minify.html = false;
  config.minify.css = false;
  config.minify.js = false;
  config.scoping.deduplicateCss = true;
  config.scoping.inheritAttributes = true;
  config.scripts.onBuildScriptError = "error";
  serverSidecarRegistry.clear();
  clearScopingTemplates();
  runDirectiveHandlerMock.mockReset();
  runDirectiveHandlerMock.mockImplementation(defaultHandler);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attr-binding classification", () => {
  it.each([
    "id",
    "name",
    "class",
    "style",
    "fill",
    "stroke",
    "mask",
    "clip-path",
    "filter",
    "marker-start",
    "marker-end",
    "usemap",
  ])(
    "a data-bascik-attr-%s binding is unsupported: attr-binding-to-scoped-attribute",
    async (target) => {
      const manifest = await build(bindingCards());
      const entry = entryOf(manifest, `bad-${target}`);
      // The detail names the binding and the line carries the open tag's
      // position, so `bascik --check` can point at it (D7).
      expect(entry.unsupported).toEqual({
        reason: "attr-binding-to-scoped-attribute",
        detail: `its data-bascik-attr-${target} binding targets an attribute scoping rewrites`,
        line: 1,
      });
      expect(entry.template).toBeNull();
      expect(entry.filePath).toBe(`components/bad-${target}.html`);
    },
  );

  it("the recorded line is the binding's open tag, not the file's first line", async () => {
    const manifest = await build({
      "late-card": {
        fileName: "src/components/late-card.html",
        fileContent: `<div class="w">\n  <p>one</p>\n  <!-- data-bascik-attr-id="in a comment" -->\n  <span data-bascik-attr-id="v">x</span>\n</div>`,
        cssFileContent: ".w { color: red }",
      },
    });
    expect(entryOf(manifest, "late-card").unsupported).toEqual({
      reason: "attr-binding-to-scoped-attribute",
      detail:
        "its data-bascik-attr-id binding targets an attribute scoping rewrites",
      line: 4,
    });
  });

  it("bindings to href, title, src, alt, data-*, for and aria-* are supported", async () => {
    const manifest = await build({ ...coreFixtureList(), ...bindingCards() });
    for (const name of ["v-card", "ref-card", "outer-box", "img-src-card"]) {
      const entry = entryOf(manifest, name);
      expect(entry.unsupported, name).toBeUndefined();
      expect(entry.template, name).not.toBeNull();
    }
  });

  it("a bound for, headers, href or xlink:href on an element the build does not rewrite it on is unsupported: attr-binding-to-scoped-attribute", async () => {
    const manifest = await build(refCards());
    for (const [name, target, tag] of [
      ["span-for-card", "for", "span"],
      ["button-href-card", "href", "button"],
      ["div-headers-card", "headers", "div"],
      ["image-xlink-card", "xlink:href", "image"],
    ]) {
      expect(entryOf(manifest, name).unsupported, name).toEqual({
        reason: "attr-binding-to-scoped-attribute",
        detail: `its data-bascik-attr-${target} binding is on a <${tag}>, where the build does not rewrite ${target}`,
        line: 1,
      });
    }
    for (const name of [
      "label-for-card",
      "td-headers-card",
      "area-href-card",
    ]) {
      expect(entryOf(manifest, name).unsupported, name).toBeUndefined();
      expect(entryOf(manifest, name).template, name).not.toBeNull();
    }
  });

  it("data-bascik-attr-src on a build or server script is unsupported: attr-src-on-directive-script", async () => {
    const manifest = await build(bindingCards());
    expect(entryOf(manifest, "src-build-card").unsupported).toEqual({
      reason: "attr-src-on-directive-script",
      detail: "its data-bascik-attr-src binding is on a directive script",
      line: 1,
    });
    expect(entryOf(manifest, "src-server-card").unsupported).toEqual({
      reason: "attr-src-on-directive-script",
      detail: "its data-bascik-attr-src binding is on a directive script",
      line: 1,
    });
    // The script never ran and nothing was staged.
    expect(runDirectiveHandlerMock).not.toHaveBeenCalled();
    expect(
      Object.keys(serverSidecarRegistry.getAllScripts()).filter((id) =>
        id.startsWith("component_script_"),
      ),
    ).toEqual([]);
  });
});

describe.each([true, false])(
  "post-scope attr injection equals the build order (identifiers %s)",
  (identifiers) => {
    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    it("title, src, alt, data-x, a non-fragment href and a forwarded data-bascik-prop-* are byte-identical", async () => {
      const list = coreFixtureList();
      const manifest = await build(list);
      expect(manifest.identifiers).toBe(identifiers);
      const html =
        `<v-card data-bascik-prop-link="/pricing" data-bascik-prop-t="T" data-bascik-prop-dx="1" data-bascik-prop-img="/a.png" data-bascik-prop-alt="pic"></v-card>` +
        `<outer-box data-bascik-prop-title="fwd" data-bascik-prop-link="/x">s</outer-box>`;
      const expected = viaBuild(html, list, PAGE_PATH);
      const actual = renderWithManifest(html, list, manifest, PAGE_PATH);
      expect(expected.transpiledHtmlBody).toContain('href="/pricing"');
      expect(expected.transpiledHtmlBody).toContain("<em>fwd</em>");
      expect(unnumbered(actual.transpiledHtmlBody)).toBe(
        unnumbered(expected.transpiledHtmlBody),
      );
      // Nested usages are expanded by the loop, so the nested children are
      // used components at request time too, in the build's order.
      expect(actual.usedComponents.map((c) => c.name)).toEqual(
        expected.usedComponents.map((c) => c.name),
      );
    });

    it('a bound href="#x" and a label for="x" resolve to the scoped id through scopedIdNames', async () => {
      const list = coreFixtureList();
      const manifest = await build(list);
      const html = `<v-card data-bascik-prop-link="#x" data-bascik-prop-t="T"></v-card>`;
      const expected = viaBuild(html, list, PAGE_PATH);
      const scopedX = expected.usedComponents[0].scopedIdNames?.x;
      expect(scopedX).toBeTruthy();
      expect(expected.transpiledHtmlBody).toContain(`href="#${scopedX}"`);
      expect(expected.transpiledHtmlBody).toContain(
        `<label for="${scopedX}">L</label>`,
      );
      const actual = renderWithManifest(html, list, manifest, PAGE_PATH);
      expect(unnumbered(actual.transpiledHtmlBody)).toBe(
        unnumbered(expected.transpiledHtmlBody),
      );

      const refs = viaBuild(ID_REFS_PAGE, list, PAGE_PATH);
      const refsViaManifest = renderWithManifest(
        ID_REFS_PAGE,
        list,
        manifest,
        PAGE_PATH,
      );
      expect(unnumbered(refsViaManifest.transpiledHtmlBody)).toBe(
        unnumbered(refs.transpiledHtmlBody),
      );
    });

    it("the whole shared fixture page renders byte-identically: nested x3, slots, forwarding, masking traps, per-instance CSS", async () => {
      const list = coreFixtureList();
      const manifest = await build(list);
      const expected = viaBuild(PAGE, list, PAGE_PATH);
      const actual = renderWithManifest(PAGE, list, manifest, PAGE_PATH);
      expect(unnumbered(actual.transpiledHtmlBody)).toBe(
        unnumbered(expected.transpiledHtmlBody),
      );
      expect(
        actual.usedComponents.map((c) => [
          c.name,
          c.cssFileContent,
          c.requiresPerInstanceCss,
          JSON.stringify(c.scopedIdNames),
        ]),
      ).toEqual(
        expected.usedComponents.map((c) => [
          c.name,
          c.cssFileContent,
          c.requiresPerInstanceCss,
          JSON.stringify(c.scopedIdNames),
        ]),
      );
    });
  },
);

describe.each([true, false])(
  "server and stream scripts inside a component (identifiers %s)",
  (identifiers) => {
    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    it("a class-only server script is staged once as component_script_<hex(name::ordinal)> with its output scope", async () => {
      const manifest = await build(scriptCards());
      const entry = entryOf(manifest, "srv-card");
      expect(entry.unsupported).toBeUndefined();
      const id = componentScriptId("srv-card", 1);
      expect(entry.jobs).toEqual([
        {
          id,
          mode: "server",
          ordinal: 1,
          sourceFile: "src/components/srv-card.html",
          sourceLine: expect.any(Number),
          outputScope: expect.any(String),
        },
      ]);
      expect(decodeOutputScope(entry.jobs[0].outputScope)).toEqual({
        classes: {
          wrap: scopedClass("srv-card", "wrap", identifiers),
          line: scopedClass("srv-card", "line", identifiers),
        },
        elements: {},
      });

      const staged = serverSidecarRegistry.getScript(id);
      expect(staged).toMatchObject({
        id,
        mode: "server",
        sourceFile: "src/components/srv-card.html",
        outputScope: entry.jobs[0].outputScope,
      });
      // The source is the class-scoped body, identical for every instance.
      expect(staged?.source).toContain(
        `class="${scopedClass("srv-card", "line", identifiers)}"`,
      );
      expect(staged?.source).not.toContain("data-bascik-output-scope");

      // The template holds the placeholder form and never the source.
      for (const requestId of REQUEST_IDS) {
        const html = render(manifest, "srv-card", requestId);
        expect(html).toContain(
          `<script type="text/bascik-server" data-bascik-server-id="${id}"></script>`,
        );
        expect(html).not.toContain("export default");
        expect(html).not.toContain("data-bascik-server>");
        expect(html).not.toContain("data-bascik-output-scope");
      }
    });

    it("a stream script is staged in stream mode and its placeholder carries the stream marker; ordinals count per component", async () => {
      const manifest = await build(scriptCards());
      const entry = entryOf(manifest, "stream-card");
      const streamId = componentScriptId("stream-card", 1);
      const serverId = componentScriptId("stream-card", 2);
      expect(entry.jobs.map((job) => [job.id, job.mode, job.ordinal])).toEqual([
        [streamId, "stream", 1],
        [serverId, "server", 2],
      ]);
      expect(serverSidecarRegistry.getScript(streamId)?.mode).toBe("stream");
      expect(serverSidecarRegistry.getScript(serverId)?.mode).toBe("server");
      const html = render(manifest, "stream-card", REQUEST_IDS[0]);
      expect(html).toContain(
        `<script type="text/bascik-server" data-bascik-server-id="${streamId}" data-bascik-stream></script>`,
      );
      expect(html).toContain(
        `<script type="text/bascik-server" data-bascik-server-id="${serverId}"></script>`,
      );
    });

    it("building twice stages each component script once", async () => {
      await build(scriptCards());
      await build(scriptCards());
      const ids = Object.keys(serverSidecarRegistry.getAllScripts())
        .filter((id) => id.startsWith("component_script_"))
        .sort();
      expect(ids).toEqual(
        [
          componentScriptId("srv-card", 1),
          componentScriptId("stream-card", 1),
          componentScriptId("stream-card", 2),
        ].sort(),
      );
    });

    it("a server script whose output scope embeds the instance id (per-instance CSS) is unsupported: instance-scoped-server-script", async () => {
      const manifest = await build(scriptCards());
      const entry = entryOf(manifest, "srv-glow-card");
      // The body references nothing scoped, so the detail must point at the
      // stylesheet, not the script.
      expect(entry.unsupported).toEqual({
        reason: "instance-scoped-server-script",
        detail:
          "its server or stream script runs with per-instance class names (a stylesheet using url(#id), or scoping.deduplicateCss: false)",
      });
      expect(entry.jobs).toEqual([]);
      expect(
        serverSidecarRegistry.getScript(componentScriptId("srv-glow-card", 1)),
      ).toBeUndefined();
    });

    it("with scoping.deduplicateCss: false every server and stream script is instance scoped", async () => {
      config.scoping.deduplicateCss = false;
      const manifest = await build(scriptCards());
      for (const name of ["srv-card", "stream-card", "srv-id-card"]) {
        expect(entryOf(manifest, name).unsupported, name).toEqual({
          reason: "instance-scoped-server-script",
          detail:
            "its server or stream script runs with per-instance class names (a stylesheet using url(#id), or scoping.deduplicateCss: false)",
        });
      }
      expect(
        Object.keys(serverSidecarRegistry.getAllScripts()).filter((id) =>
          id.startsWith("component_script_"),
        ),
      ).toEqual([]);
    });

    it("the staged sidecar entry carries the same output scope as the manifest job", async () => {
      const manifest = await build(scriptCards());
      for (const name of ["srv-card", "stream-card"]) {
        for (const job of entryOf(manifest, name).jobs) {
          expect(
            serverSidecarRegistry.getScript(job.id)?.outputScope,
            job.id,
          ).toBe(job.outputScope);
        }
      }
    });

    it("a server script whose body embeds the instance id is unsupported: instance-scoped-server-script", async () => {
      const manifest = await build(scriptCards());
      const entry = entryOf(manifest, "srv-id-card");
      expect(entry.unsupported).toEqual({
        reason: "instance-scoped-server-script",
        detail:
          "its server or stream script body embeds a scoped id or name, which differs per instance",
      });
      expect(entry.template).toBeNull();
      expect(entry.jobs).toEqual([]);
      expect(
        serverSidecarRegistry.getScript(componentScriptId("srv-id-card", 1)),
      ).toBeUndefined();
    });

    it("a server script in a component without a stylesheet is supported: no output scope on the job, css null, style stable", async () => {
      const manifest = await build({
        "nostyle-srv": {
          fileName: "src/components/nostyle-srv.html",
          fileContent: `<nav><script data-bascik-server>export default () => '<p>x</p>';</script></nav>`,
        },
      });
      const entry = entryOf(manifest, "nostyle-srv");
      expect(entry.unsupported).toBeUndefined();
      expect(entry.css).toBeNull();
      expect(entry.cspStable).toEqual({ style: true, script: true });
      expect(entry.jobs).toEqual([
        {
          id: componentScriptId("nostyle-srv", 1),
          mode: "server",
          ordinal: 1,
          sourceFile: "src/components/nostyle-srv.html",
          sourceLine: 1,
        },
      ]);
      expect("outputScope" in entry.jobs[0]).toBe(false);
      expect(render(manifest, "nostyle-srv", REQUEST_IDS[0])).toBe(
        `<nav><script type="text/bascik-server" data-bascik-server-id="${componentScriptId("nostyle-srv", 1)}"></script></nav>`,
      );
    });

    it("jobs[].sourceFile is project-relative and forward-slashed, while filePath takes the form bascik --check prints, when the component was listed by its absolute path", async () => {
      // The manifest is byte-identical across builds (D3 step 8), so it must
      // not carry the checkout directory the way the source stamp does.
      const absolute = join(process.cwd(), "src/components/abs-srv.html");
      const manifest = await build({
        "abs-srv": {
          fileName: absolute,
          fileContent: `<div class="wrap"><script data-bascik-server>export default () => '<p>x</p>';</script></div>`,
          cssFileContent: ".wrap { margin: 0 }",
        },
      });
      const entry = entryOf(manifest, "abs-srv");
      expect(entry.unsupported).toBeUndefined();
      expect(entry.filePath).toBe("components/abs-srv.html");
      expect(entry.jobs).toHaveLength(1);
      expect(entry.jobs[0].sourceFile).toBe("src/components/abs-srv.html");
      expect(JSON.stringify(manifest)).not.toContain(process.cwd());
    });

    it("misuse: a component file no configured root owns keeps its project-relative path, never an absolute one", async () => {
      const stray = join(process.cwd(), "elsewhere/stray-card.html");
      const manifest = await build({
        "stray-card": {
          fileName: stray,
          fileContent: `<div class="s">x</div>`,
          cssFileContent: ".s { margin: 0 }",
        },
      });
      expect(entryOf(manifest, "stray-card").filePath).toBe(
        "elsewhere/stray-card.html",
      );
      expect(JSON.stringify(manifest)).not.toContain(process.cwd());
    });
  },
);

describe("component build scripts", () => {
  it("runs a page-independent data-bascik-build script once, with an empty page context, into the template", async () => {
    const manifest = await build(buildScriptCards());
    const entry = entryOf(manifest, "built-card");
    expect(entry.unsupported).toBeUndefined();
    const runs = runDirectiveHandlerMock.mock.calls.filter(([, , options]) =>
      String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes("built-card"),
    );
    expect(runs).toHaveLength(1);
    const [, kind, options] = runs[0];
    expect(kind).toBe("build");
    expect(options.extraEnv.BASCIK_PAGE_PATH).toBe("");
    expect(options.extraEnv.BASCIK_PAGE_FILE).toBe("");
    expect(options.extraEnv.BASCIK_ROUTE).toBeUndefined();
    // The output is in the template with the component's output scope applied.
    const html = render(manifest, "built-card", REQUEST_IDS[0]);
    expect(html).toContain(
      `<p class="${scopedClass("built-card", "built", true)}">built</p>`,
    );
    expect(html).not.toContain("data-bascik-build");
  });

  it("runs a data-bascik-build-once script once into the template", async () => {
    const manifest = await build(buildScriptCards());
    const runs = runDirectiveHandlerMock.mock.calls.filter(([, , options]) =>
      String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes("once-card"),
    );
    expect(runs).toHaveLength(1);
    const html = render(manifest, "once-card", REQUEST_IDS[1]);
    expect(html).toContain(
      `<p class="${scopedClass("once-card", "built", true)}">built</p>`,
    );
    expect(html).not.toContain("data-bascik-build-once");
  });

  it("a script a page already ran without reading its page context is answered from that run's cache record, not run again", async () => {
    // The page build runs the component's script with the page's context
    // first; its output, proven page-independent, is what the template's
    // empty-context run would print.
    const list = buildScriptCards();
    const built = list["built-card"];
    // The component as a page instance has it: scoped (with a build id).
    const onPage = await executeBuildScripts(
      runScopingPipeline(
        {
          name: "built-card",
          ...built,
          fileContent: stampDirectiveSources(
            built.fileContent,
            built.fileName!,
          ),
        },
        "1a2b3c4d",
      ).fileContent,
      built.fileName,
      null,
      {
        pageFile: "src/pages/index.html",
        pagePath: "/",
        sourceFile: built.fileName,
      },
    );
    expect(onPage).toContain(">built</p>");
    const runsOf = () =>
      runDirectiveHandlerMock.mock.calls.filter(([, , options]) =>
        String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes("built-card"),
      ).length;
    expect(runsOf()).toBe(1);
    // A fresh process (the dev server after a restart) has only the disk.
    clearBuildScriptCaches();
    const manifest = await build({ "built-card": built });
    expect(runsOf()).toBe(1);
    expect(entryOf(manifest, "built-card").unsupported).toBeUndefined();
    expect(render(manifest, "built-card", REQUEST_IDS[0])).toContain(
      `<p class="${scopedClass("built-card", "built", true)}">built</p>`,
    );
  });

  it("misuse: a script that read its page context on a page still runs for the template, and is refused", async () => {
    const list = buildScriptCards();
    const ctx = list["ctx-card"];
    runDirectiveHandlerMock.mockImplementation(async () => ({
      result: "/",
      stdout: "",
      stderr: "",
      readsPageContext: true,
    }));
    await executeBuildScripts(
      runScopingPipeline(
        {
          name: "ctx-card",
          ...ctx,
          fileContent: stampDirectiveSources(ctx.fileContent, ctx.fileName!),
        },
        "1a2b3c4d",
      ).fileContent,
      ctx.fileName,
      null,
      {
        pageFile: "src/pages/index.html",
        pagePath: "/",
        sourceFile: ctx.fileName,
      },
    );
    const manifest = await build({ "ctx-card": ctx });
    expect(runDirectiveHandlerMock).toHaveBeenCalledTimes(2);
    expect(entryOf(manifest, "ctx-card").unsupported?.reason).toBe(
      "build-script-reads-page-context",
    );
  });

  it("a second build is answered by the script cache (sharedKey hit): no further runs", async () => {
    await build(buildScriptCards());
    const after = runDirectiveHandlerMock.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    await build(buildScriptCards());
    expect(runDirectiveHandlerMock.mock.calls.length).toBe(after);
  });

  it.each([
    ["printed-prop-card", "data-bascik-prop-title"],
    ["printed-slot-card", "data-bascik-slot"],
    ["printed-default-slot-card", "data-bascik-slot"],
    ["printed-attr-card", "data-bascik-attr-title"],
    ["printed-preserve-card", "data-bascik-preserve"],
  ])(
    "%s: a prop, slot, attr-binding or preserve marker first printed by a build script is unsupported: scoping-template-unavailable, naming the marker",
    async (name, marker) => {
      const list = { ...printedMarkerCards(), ...nestedCards() };
      const expected = JSON.parse(
        /export default \(\) => (".*?");/.exec(list[name].fileContent)![1],
      ) as string;
      runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) =>
        String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes(name)
          ? {
              result: expected,
              stdout: "",
              stderr: "",
              readsPageContext: false,
            }
          : defaultHandler(),
      );
      const manifest = await build(list);
      expect(entryOf(manifest, name).unsupported).toEqual({
        reason: "scoping-template-unavailable",
        detail: `its build script printed ${marker}, which a usage would be injected into at request time but never at page time`,
      });
      expect(entryOf(manifest, name).template).toBeNull();
    },
  );

  it("a printed nested usage with a valued prop and an authored marker stay supported", async () => {
    const list = { ...printedMarkerCards(), ...nestedCards() };
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) =>
      String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes(
        "printed-nested-card",
      )
        ? {
            result: `<nest-child data-bascik-prop-l="one"></nest-child>`,
            stdout: "",
            stderr: "",
            readsPageContext: false,
          }
        : defaultHandler(),
    );
    const manifest = await build(list);
    expect(
      entryOf(manifest, "printed-nested-card").unsupported,
    ).toBeUndefined();
    expect(entryOf(manifest, "authored-prop-card").unsupported).toBeUndefined();
    const usage = `<printed-nested-card data-bascik-prop-l="two"></printed-nested-card>`;
    const expected = render(manifest, "printed-nested-card", REQUEST_IDS[0]);
    expect(expected).toContain(`<nest-child data-bascik-prop-l="one">`);
    const actual = renderWithManifest(usage, list, manifest, PAGE_PATH);
    expect(actual.transpiledHtmlBody).toContain("one");
    expect(actual.transpiledHtmlBody).not.toContain("two");
  });

  describe("usage attributes inherited onto a printed root", () => {
    const rootless = (): ComponentList => ({
      "script-only-card": printingCard(
        "script-only-card",
        `<p class="built">built</p>`,
        false,
      ),
      "meta-then-script-card": {
        ...printingCard("meta-then-script-card", `<p class="built">built</p>`),
        fileContent: `<style>.built { color: red }</style><script data-bascik-build>\n// ${nonce}\nexport default () => '<p class="built">built</p>';\n</script>`,
      },
    });

    it("a component that is a build script and nothing else is unsupported with scoping.inheritAttributes on: the build inherits onto no element, a template onto the printed root", async () => {
      const manifest = await build({ ...rootless(), ...buildScriptCards() });
      const detail =
        "usage attributes would be inherited onto its printed root at request time, but the build inherits them before the script prints";
      expect(entryOf(manifest, "script-only-card").unsupported).toEqual({
        reason: "scoping-template-unavailable",
        detail,
      });
      expect(entryOf(manifest, "meta-then-script-card").unsupported).toEqual({
        reason: "scoping-template-unavailable",
        detail,
      });
      // A root that precedes the script receives the attributes on both paths.
      expect(entryOf(manifest, "built-card").unsupported).toBeUndefined();
    });

    it("the same component is supported with scoping.inheritAttributes off", async () => {
      config.scoping.inheritAttributes = false;
      const manifest = await build(rootless());
      expect(manifest.inheritAttributes).toBe(false);
      expect(entryOf(manifest, "script-only-card").unsupported).toBeUndefined();
      expect(render(manifest, "script-only-card", REQUEST_IDS[0])).toContain(
        `<p class="${scopedClass("script-only-card", "built", true)}">built</p>`,
      );
    });
  });

  it("a build script that reads BASCIK_PAGE_PATH is unsupported: build-script-reads-page-context", async () => {
    runDirectiveHandlerMock.mockImplementation(
      async (_target, _kind, options) =>
        String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes("ctx-card")
          ? { result: "", stdout: "", stderr: "", readsPageContext: true }
          : defaultHandler(),
    );
    const manifest = await build(buildScriptCards());
    expect(entryOf(manifest, "ctx-card").unsupported).toEqual({
      reason: "build-script-reads-page-context",
      detail:
        "its build script read BASCIK_PAGE_PATH, BASCIK_PAGE_FILE or BASCIK_ROUTE, so its output differs per page",
    });
    expect(entryOf(manifest, "ctx-card").template).toBeNull();
    // Its siblings are unaffected.
    expect(entryOf(manifest, "built-card").unsupported).toBeUndefined();
  });

  it("the on-disk cache record keeps readsPageContext: a build after clearBuildScriptCaches() is answered from disk and still unsupported", async () => {
    // The in-memory memo answers the second run inside one build; only the
    // disk record answers a later build (a fresh `bascik --build` process),
    // so a record that lost the flag would turn the component supported.
    runDirectiveHandlerMock.mockImplementation(
      async (_target, _kind, options) =>
        String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes("ctx-card")
          ? { result: "", stdout: "", stderr: "", readsPageContext: true }
          : defaultHandler(),
    );
    const first = await build(buildScriptCards());
    expect(entryOf(first, "ctx-card").unsupported?.reason).toBe(
      "build-script-reads-page-context",
    );
    const runs = runDirectiveHandlerMock.mock.calls.length;
    expect(runs).toBeGreaterThan(0);
    clearBuildScriptCaches();
    serverSidecarRegistry.clear();
    clearScopingTemplates();
    const second = await build(buildScriptCards());
    expect(runDirectiveHandlerMock.mock.calls.length).toBe(runs);
    expect(entryOf(second, "ctx-card").unsupported?.reason).toBe(
      "build-script-reads-page-context",
    );
    expect(entryOf(second, "built-card").unsupported).toBeUndefined();
  });

  describe("a failing build script", () => {
    const failingCards = (): ComponentList => ({
      "failing-card": {
        fileName: "src/components/failing-card.html",
        fileContent: `<div class="shell"><script data-bascik-build>\n// ${nonce}\nexport default () => { throw new Error("boom from failing-card"); };\n</script></div>`,
        cssFileContent: ".shell { margin: 0 }",
      },
    });
    const failFailingCard = () =>
      runDirectiveHandlerMock.mockImplementation(
        async (_target, _kind, options) => {
          if (
            String(options?.extraEnv?.BASCIK_SOURCE_FILE).includes(
              "failing-card",
            )
          )
            throw new Error("boom from failing-card");
          return defaultHandler();
        },
      );

    it('rejects the build under scripts.onBuildScriptError "error", naming the file and line, as a page that uses the component would', async () => {
      // A component only ever returned from a server script runs its build
      // script nowhere else, so the documented halt must happen here.
      failFailingCard();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        build({ ...failingCards(), ...buildScriptCards() }),
      ).rejects.toThrow(
        /build script error in "src\/components\/failing-card\.html" at \(line 1, column \d+\)/,
      );
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "boom from failing-card",
      );
    });

    it('under "warn" the component is supported with the empty output every page gets, and the warning names the file', async () => {
      config.scripts.onBuildScriptError = "warn";
      failFailingCard();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const manifest = await build(failingCards());
      const entry = entryOf(manifest, "failing-card");
      expect(entry.unsupported).toBeUndefined();
      expect(render(manifest, "failing-card", REQUEST_IDS[0])).toBe(
        `<div class="${scopedClass("failing-card", "shell", true)}"></div>`,
      );
      const warned = warnSpy.mock.calls.flat().join("\n");
      expect(warned).toContain('"src/components/failing-card.html"');
      expect(warned).toContain("boom from failing-card");
    });
  });
});

describe("components are built concurrently, reported in order", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Components a-card..e-card, each with its own build script. */
  const cards = (names = ["a-card", "b-card", "c-card", "d-card", "e-card"]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          fileName: `src/components/${name}.html`,
          fileContent: `<div class="shell"><script data-bascik-build>\n// ${nonce} ${name}\nexport default () => "x";\n</script></div>`,
          cssFileContent: ".shell { margin: 0 }",
        },
      ]),
    ) as ComponentList;
  const sourceOf = (options: { extraEnv?: Record<string, string> }) =>
    /([a-e])-card/.exec(String(options?.extraEnv?.BASCIK_SOURCE_FILE))![1];
  // a-card is the slowest, so a component later in sorted order finishes first.
  const delayOf = (letter: string) => (letter === "a" ? 60 : 5);

  it("more than one component's build script runs at a time", async () => {
    let inFlight = 0;
    let most = 0;
    runDirectiveHandlerMock.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await sleep(20);
      inFlight--;
      return defaultHandler();
    });
    const manifest = await build(cards());
    expect(most).toBeGreaterThan(1);
    expect(Object.keys(manifest.components)).toEqual([
      "a-card",
      "b-card",
      "c-card",
      "d-card",
      "e-card",
    ]);
  });

  it("the result is the same as one at a time: sorted entries, byte-identical", async () => {
    const first = await build(cards());
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      await sleep(delayOf(sourceOf(options)));
      return defaultHandler();
    });
    clearScopingTemplates();
    serverSidecarRegistry.clear();
    const second = await build(cards());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("console output and script stdout come out in component order, not finish order", async () => {
    const order: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      order.push(`warn ${message}`);
    });
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      if (String(chunk).startsWith("stdout ")) {
        order.push(String(chunk));
        return true;
      }
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      await sleep(delayOf(letter));
      console.warn(letter);
      return { ...(await defaultHandler()), stdout: `stdout ${letter}` };
    });
    await build(cards(["a-card", "b-card", "c-card"]));
    // Each component's two runs print (the second is a cache hit, silent).
    expect(order).toEqual([
      "warn a",
      "stdout a",
      "warn b",
      "stdout b",
      "warn c",
      "stdout c",
    ]);
    // Outside a manifest build, output is not held back.
    console.warn("after");
    expect(order.at(-1)).toBe("warn after");
  });

  it("output a component leaves running is written when it comes, once that component's turn is out", async () => {
    const order: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      order.push(String(message));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      if (letter === "a") setTimeout(() => console.warn("late a"), 20);
      else await sleep(80);
      console.warn(letter);
      return defaultHandler();
    });
    await build(cards(["a-card", "b-card"]));
    expect(order).toEqual(["a", "late a", "b"]);
  });

  it('under "error" the first failing component in sorted order is the error, even when a later one fails first, and nothing after it is printed', async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      await sleep(delayOf(letter));
      if (letter === "a" || letter === "c")
        throw new Error(`boom from ${letter}-card`);
      return defaultHandler();
    });
    await expect(build(cards())).rejects.toThrow(/a-card\.html/);
    expect(errors.join("\n")).toContain("boom from a-card");
    expect(errors.join("\n")).not.toContain("boom from c-card");
  });

  // Misuse lens: code in a component's build (a build script handler here,
  // a custom minifier in a project) that uses the console and streams in
  // ways a one-at-a-time build never noticed.
  const settlesWithin = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
      promise.then(
        (value) => ({ settled: true as const, value }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      sleep(ms).then(() => ({ settled: false as const })),
    ]);

  it("misuse: a component that waits for its stdout write callback finishes, while an earlier one is still running", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      encoding?: unknown,
      callback?: unknown,
    ) => {
      written.push(String(chunk));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    }) as typeof process.stdout.write);
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      await sleep(delayOf(letter));
      await new Promise((resolve) =>
        process.stdout.write(`cb ${letter}\n`, resolve),
      );
      return defaultHandler();
    });
    const outcome = await settlesWithin(
      build(cards(["a-card", "b-card", "c-card"])),
      3000,
    );
    expect(outcome).toMatchObject({ settled: true });
    expect("error" in outcome ? outcome.error : undefined).toBeUndefined();
    expect(written.filter((chunk) => chunk.startsWith("cb "))).toEqual([
      "cb a\n",
      "cb b\n",
      "cb c\n",
    ]);
  });

  it("misuse: a write the stream refuses fails inside the component that made it, naming its file, and nothing later is printed", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      printed.push(String(message));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      if (letter === "b") {
        await sleep(5);
        (process.stdout.write as (chunk: unknown) => boolean)(123);
      } else {
        await sleep(letter === "a" ? 30 : 60);
        console.warn(`late ${letter}`);
      }
      return defaultHandler();
    });
    await expect(build(cards())).rejects.toThrow(/b-card\.html/);
    // Components after b were already running; a loop would never have
    // started them, so their output never comes, even once they finish.
    await sleep(250);
    expect(printed).toEqual(["late a"]);
  });

  it('misuse: under "error" the first failure is thrown once the components before it are done, without waiting for later ones', async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      if (letter === "b") throw new Error("boom from b-card");
      if (letter === "c") await sleep(2000);
      return defaultHandler();
    });
    const started = performance.now();
    await expect(build(cards(["a-card", "b-card", "c-card"]))).rejects.toThrow(
      /b-card\.html/,
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("misuse: the first component prints as it runs, so a long one shows its progress before it finishes", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      printed.push(String(message));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      console.warn(`start ${letter}`);
      await sleep(letter === "a" ? 300 : 5);
      console.warn(`end ${letter}`);
      return defaultHandler();
    });
    const pending = build(cards(["a-card", "b-card"]));
    await sleep(100);
    expect(printed).toEqual(["start a"]);
    await pending;
    expect(printed).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      // The second (cached) run of each prints nothing.
    ]);
  });

  it("misuse: an object logged and then changed prints as it was when it was logged", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      printed.push(format(...args));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      const letter = sourceOf(options);
      await sleep(delayOf(letter));
      const state = { n: 1 };
      console.warn(letter, state);
      state.n = 2;
      return defaultHandler();
    });
    await build(cards(["a-card", "b-card", "c-card"]));
    expect(printed).toEqual(["a { n: 1 }", "b { n: 1 }", "c { n: 1 }"]);
  });

  it("misuse: a crash inside a held component prints its fatal message before the process exits", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(format(...args));
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const before = process.listeners("uncaughtException");
    const uninstall = installProcessCrashHandlers();
    const handler = process
      .listeners("uncaughtException")
      .find((listener) => !before.includes(listener))!;
    let seenAtExit: string[] | undefined;
    exit.mockImplementation((() => {
      seenAtExit = [...errors];
    }) as unknown as typeof process.exit);
    try {
      runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
        const letter = sourceOf(options);
        await sleep(delayOf(letter));
        if (letter === "b" && seenAtExit === undefined)
          // What Node does with a throw from a timer the component started:
          // the handler runs in the component's context.
          handler(new Error("crash from b-card"), "uncaughtException");
        return defaultHandler();
      });
      await build(cards(["a-card", "b-card"]));
    } finally {
      uninstall();
    }
    expect(seenAtExit?.join("\n")).toContain(
      "[bascik] Fatal uncaught exception: Error: crash from b-card",
    );
  });

  it("misuse: a component still running after an earlier one failed prints its own fatal message, though its other output is dropped", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(format(...args));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      errors.push(format(...args));
    });
    vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as typeof process.exit,
    );
    const before = process.listeners("uncaughtException");
    const uninstall = installProcessCrashHandlers();
    const handler = process
      .listeners("uncaughtException")
      .find((listener) => !before.includes(listener))!;
    const crashed = Promise.withResolvers<void>();
    try {
      runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
        const letter = sourceOf(options);
        if (letter === "b") throw new Error("boom from b-card");
        if (letter === "c") {
          console.warn("dropped c");
          await sleep(100);
          handler(new Error("crash from c-card"), "uncaughtException");
          crashed.resolve();
        }
        return defaultHandler();
      });
      await expect(
        build(cards(["a-card", "b-card", "c-card"])),
      ).rejects.toThrow(/b-card\.html/);
      await crashed.promise;
    } finally {
      uninstall();
    }
    const printed = errors.join("\n");
    expect(printed).toContain(
      "[bascik] Fatal uncaught exception: Error: crash from c-card",
    );
    expect(printed).not.toContain("dropped c");
  });

  it("output is held until the gate opens, and the result waits for it", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      printed.push(String(message));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      console.warn(sourceOf(options));
      return defaultHandler();
    });
    const gate = Promise.withResolvers<void>();
    const pending = buildComponentManifest(
      cards(["a-card", "b-card"]),
      BascikConfig,
      { gate: gate.promise },
    );
    const early = await settlesWithin(pending, 200);
    expect(early.settled).toBe(false);
    expect(printed).toEqual([]);
    gate.resolve();
    const manifest = await pending;
    expect(printed).toEqual(["a", "b"]);
    expect(Object.keys(manifest.components)).toEqual(["a-card", "b-card"]);
  });

  it("a manifest started early is the one taken, its output written only when it is taken", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      printed.push(String(message));
    });
    let runs = 0;
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      runs++;
      console.warn(sourceOf(options));
      return defaultHandler();
    });
    const list = cards(["a-card", "b-card"]);
    startComponentManifest(list, BascikConfig);
    // A second start (another server page) changes nothing.
    startComponentManifest(list, BascikConfig);
    await sleep(150);
    expect(runs).toBe(2);
    expect(printed).toEqual([]);
    const manifest = await takeComponentManifest(list, BascikConfig);
    expect(printed).toEqual(["a", "b"]);
    expect(runs).toBe(2);
    expect(JSON.stringify(manifest)).toBe(
      JSON.stringify(await build(cards(["a-card", "b-card"]))),
    );
  });

  it("misuse: a manifest started for another list is not taken: the current list is built, and the stale one never prints", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => {
      printed.push(String(message));
    });
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      console.warn(sourceOf(options));
      return defaultHandler();
    });
    startComponentManifest(cards(["a-card", "b-card"]), BascikConfig);
    await sleep(100);
    const manifest = await takeComponentManifest(
      cards(["c-card"]),
      BascikConfig,
    );
    expect(Object.keys(manifest.components)).toEqual(["c-card"]);
    await sleep(100);
    expect(printed).toEqual(["c"]);
  });

  it("misuse: an early manifest that fails reports its error when it is taken, not before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runDirectiveHandlerMock.mockImplementation(async (_t, _k, options) => {
      if (sourceOf(options) === "b") throw new Error("boom from b-card");
      return defaultHandler();
    });
    const list = cards(["a-card", "b-card"]);
    startComponentManifest(list, BascikConfig);
    await sleep(100);
    await expect(takeComponentManifest(list, BascikConfig)).rejects.toThrow(
      /b-card\.html/,
    );
  });

  it("takeComponentManifest builds the manifest when none was started", async () => {
    const manifest = await takeComponentManifest(
      cards(["a-card"]),
      BascikConfig,
    );
    expect(Object.keys(manifest.components)).toEqual(["a-card"]);
  });

  it("stages component scripts in the registry only once the whole manifest is built", async () => {
    const serverCards = (names: string[]) =>
      Object.fromEntries(
        names.map((name) => [
          name,
          {
            fileName: `src/components/${name}.html`,
            fileContent: `<div class="shell"><script data-bascik-server>\n// ${nonce} ${name}\nexport default () => "x";\n</script></div>`,
          },
        ]),
      ) as ComponentList;
    const gate = Promise.withResolvers<void>();
    const pending = buildComponentManifest(
      serverCards(["a-card", "b-card"]),
      BascikConfig,
      { gate: gate.promise },
    );
    await sleep(100);
    expect(Object.keys(serverSidecarRegistry.getAllScripts())).toEqual([]);
    gate.resolve();
    const manifest = await pending;
    const ids = Object.values(manifest.components).flatMap((entry) =>
      entry.jobs.map((job) => job.id),
    );
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(serverSidecarRegistry.getScript(id)?.source).toContain(nonce);
  });
});

describe("css", () => {
  it("css.text equals the page pipeline bytes and css.hash the CSP hash of the emitted style block", async () => {
    const manifest = await build(cards());
    const entry = entryOf(manifest, "my-card");
    const scoped = runScopingPipeline(
      { name: "my-card", ...cards()["my-card"] },
      REQUEST_IDS[0],
    );
    const text = await pipelineCss(scoped, "/", null);
    expect(text).toContain(scopedClass("my-card", "card", true));
    expect(entry.css).toEqual({ text, hash: sha(text) });
    expect(entry.css).toEqual({
      text,
      hash: computePageCspHashes(`<style>${text}</style>`).styles[0],
    });
    expect(entry.cspStable.style).toBe(true);
  });

  it('rewrites base paths inside the CSS with base "/docs/" and applies the configured css minifier', async () => {
    config.base = "/docs/";
    config.minify.css = true;
    const manifest = await build(cards());
    expect(manifest.base).toBe("/docs/");
    const entry = entryOf(manifest, "asset-card");
    const scoped = runScopingPipeline(
      { name: "asset-card", ...cards()["asset-card"] },
      REQUEST_IDS[0],
    );
    const text = await pipelineCss(scoped, "/docs/", minifyCss);
    expect(text).toContain("url(/docs/img/hero.png)");
    expect(text).not.toContain("\n\n");
    expect(entry.css).toEqual({ text, hash: sha(text) });
  });

  it("a url(#id) component gets { perInstance: true } with its CSS segmented in the template", async () => {
    const manifest = await build(cards());
    const entry = entryOf(manifest, "glow-card");
    expect(entry.css).toEqual({ perInstance: true });
    expect(entry.cspStable.style).toBe(false);
    const template = templateOf(manifest, "glow-card");
    expect(template.cssFileContent).toBeDefined();
    for (const id of REQUEST_IDS) {
      const predicted = instantiateTemplate(template, id, getAttributeNameHash);
      const real = runScopingPipeline(
        { name: "glow-card", ...cards()["glow-card"] },
        id,
      );
      expect(real.requiresPerInstanceCss).toBe(true);
      expect(predicted?.cssFileContent).toBe(
        await pipelineCss(real, "/", null),
      );
    }
  });

  it.each([true, false])(
    'per-instance CSS in the template is the page pipeline\'s bytes: base "/docs/" rewritten and the css minifier applied (identifiers %s)',
    async (identifiers) => {
      config.minify.identifiers = identifiers;
      config.base = "/docs/";
      config.minify.css = true;
      const list: ComponentList = {
        "glow-asset-card": {
          fileName: "src/components/glow-asset-card.html",
          fileContent: `<svg><filter id="glow"></filter></svg><div class="box">b</div>`,
          cssFileContent:
            ".box {\n  clip-path: url(#glow);\n  background: url(/img/hero.png); /* comment */\n}\n",
        },
      };
      const manifest = await build(list);
      const entry = entryOf(manifest, "glow-asset-card");
      expect(entry.unsupported).toBeUndefined();
      expect(entry.css).toEqual({ perInstance: true });
      const template = templateOf(manifest, "glow-asset-card");
      for (const id of REQUEST_IDS) {
        const real = runScopingPipeline(
          { name: "glow-asset-card", ...list["glow-asset-card"] },
          id,
        );
        const text = await pipelineCss(real, "/docs/", minifyCss);
        expect(text).toContain("url(/docs/img/hero.png)");
        expect(text).not.toContain("comment");
        expect(text).toContain(`url(#${real.scopedIdNames!.glow})`);
        expect(
          instantiateTemplate(template, id, hashFor(identifiers))
            ?.cssFileContent,
        ).toBe(text);
      }
    },
  );

  it("every component is per instance with scoping.deduplicateCss: false, with the same pipeline bytes", async () => {
    config.scoping.deduplicateCss = false;
    config.base = "/docs/";
    config.minify.css = true;
    const manifest = await build(cards());
    expect(entryOf(manifest, "my-card").css).toEqual({ perInstance: true });
    expect(entryOf(manifest, "plain-card").css).toEqual({ perInstance: true });
    expect(entryOf(manifest, "my-card").cspStable.style).toBe(false);
    const real = runScopingPipeline(
      { name: "asset-card", ...cards()["asset-card"] },
      REQUEST_IDS[0],
    );
    const text = await pipelineCss(real, "/docs/", minifyCss);
    expect(text).toContain("url(/docs/img/hero.png)");
    expect(
      instantiateTemplate(
        templateOf(manifest, "asset-card"),
        REQUEST_IDS[0],
        getAttributeNameHash,
      )?.cssFileContent,
    ).toBe(text);
  });

  it("a component without a stylesheet has css null and a stable (empty) style set", async () => {
    const manifest = await build(cards());
    const entry = entryOf(manifest, "bare-card");
    expect(entry.css).toBeNull();
    expect(entry.cspStable.style).toBe(true);
  });
});

describe.each([true, false])(
  "minify.js at manifest build (identifiers %s)",
  (identifiers) => {
    beforeEach(() => {
      config.minify.identifiers = identifiers;
    });

    const scopedThenMinified = async (
      name: string,
      instanceId: string,
      minifier: (code: string) => string | Promise<string>,
    ): Promise<string> => {
      const real = runScopingPipeline({ name, ...cards()[name] }, instanceId);
      return minifyScriptTagsInHtml(real.fileContent, minifier);
    };

    it("the built-in minifier runs on the sentinel output and every token survives with the same count", async () => {
      config.minify.js = true;
      const manifest = await build(cards());
      const template = templateOf(manifest, "my-card");
      for (const id of REQUEST_IDS) {
        expect(render(manifest, "my-card", id)).toBe(
          await scopedThenMinified("my-card", id, memoizedMinifyJs),
        );
      }
      // The script is really minified in the template and the id reference
      // inside it is still a token.
      const text = render(manifest, "my-card", REQUEST_IDS[0]);
      expect(text).not.toContain("const root = document");
      expect(template.fileContent.tokens.length).toBeGreaterThan(
        identifiers ? 2 : 1,
      );
    });

    it("an esbuild minify.js function is applied the same way", async () => {
      const esbuildMinify = async (code: string) =>
        (await transform(code, { loader: "js", minify: true })).code;
      config.minify.js = esbuildMinify;
      const manifest = await build(cards());
      for (const id of REQUEST_IDS) {
        expect(render(manifest, "my-card", id)).toBe(
          await scopedThenMinified("my-card", id, esbuildMinify),
        );
        expect(render(manifest, "plain-card", id)).toBe(
          await scopedThenMinified("plain-card", id, esbuildMinify),
        );
      }
    });

    it("a minifier that splits a token marks the component unsupported: scoping-template-unavailable", async () => {
      // Breaks every scoped name inside a string literal in two, inside the
      // part that carries the instance id (the hash itself, or the
      // `__<id>__` segment of an unhashed name), so the token count in the
      // minified script no longer matches the recorded run.
      config.minify.js = (code: string) =>
        code.replace(
          /"(b[0-9A-Za-z]{11}|bascik__[\w-]+?__[a-z0-9]+__[\w-]+)"/g,
          (_match, name: string) => {
            const segments = name.split("__");
            const at =
              segments.length >= 4
                ? `${segments[0]}__${segments[1]}__`.length +
                  Math.max(1, Math.floor(segments[2].length / 2))
                : Math.max(1, Math.floor(name.length / 2));
            return `"${name.slice(0, at)}" + "${name.slice(at)}"`;
          },
        );
      const manifest = await build(cards());
      expect(entryOf(manifest, "my-card").unsupported).toEqual({
        reason: "scoping-template-unavailable",
        detail: expect.stringMatching(
          identifiers
            ? /^minify\.js split the scoped name "b[0-9A-Za-z]{11}"$/
            : /^minify\.js split the scoped name "bascik__my-card__[\w-]+"$/,
        ),
      });
      // A component whose scripts carry no token is unaffected.
      expect(entryOf(manifest, "plain-card").unsupported).toBeUndefined();
    });

    it("a scoped id inside a script comment is dropped by the built-in minifier: accepted because minifying a second id's real output equals the prediction", async () => {
      config.minify.js = true;
      const list: ComponentList = {
        "commented-card": {
          fileName: "src/components/commented-card.html",
          fileContent: `<div id="root" class="c"><script>
// Reads document.getElementById("root") once.
const root = document.getElementById("root");
root.classList.add("on");
</script></div>`,
          cssFileContent: ".c { color: red } .on { color: blue }",
        },
      };
      const manifest = await build(list);
      const entry = entryOf(manifest, "commented-card");
      expect(entry.unsupported).toBeUndefined();
      const template = templateOf(manifest, "commented-card");
      // The recorded run has the id twice (comment and call); the minified
      // template keeps one occurrence.
      const scopedId = (id: string) =>
        runScopingPipeline(
          { name: "commented-card", ...list["commented-card"] },
          id,
        ).scopedIdNames!.root;
      for (const id of REQUEST_IDS) {
        const real = runScopingPipeline(
          { name: "commented-card", ...list["commented-card"] },
          id,
        );
        expect(real.fileContent.split(scopedId(id)).length - 1).toBe(3);
        const minified = await minifyScriptTagsInHtml(
          real.fileContent,
          memoizedMinifyJs,
        );
        expect(minified.split(scopedId(id)).length - 1).toBe(2);
        expect(render(manifest, "commented-card", id)).toBe(minified);
      }
      expect(template.tokenCount).toBeGreaterThan(0);
    });

    it("minify.html is not applied to the template", async () => {
      config.minify.html = true;
      const list: ComponentList = {
        "roomy-card": {
          fileName: "src/components/roomy-card.html",
          fileContent: `<div class="r">\n  <!-- a note -->\n  <p>   spaced   </p>\n</div>`,
          cssFileContent: ".r { color: red }",
        },
      };
      const manifest = await build(list);
      expect(manifest.minifyHtml).toBe(true);
      const real = runScopingPipeline(
        { name: "roomy-card", ...list["roomy-card"] },
        REQUEST_IDS[0],
      );
      expect(render(manifest, "roomy-card", REQUEST_IDS[0])).toBe(
        real.fileContent,
      );
      expect(render(manifest, "roomy-card", REQUEST_IDS[0])).toContain(
        "\n  <!-- a note -->\n  <p>   spaced   </p>\n",
      );
    });
  },
);

describe.each([true, false])("cspStable (identifiers %s)", (identifiers) => {
  beforeEach(() => {
    config.minify.identifiers = identifiers;
  });

  it("cspStable.script is false when a token lies inside a <script> body", async () => {
    const manifest = await build(cards());
    const entry = entryOf(manifest, "my-card");
    expect(entry.cspStable.script).toBe(false);
    expect(entry.scriptHashes).toEqual([]);
  });

  it("a class-only script is stable and scriptHashes equal the first-instance hashes", async () => {
    const list = cards();
    const manifest = await build(list);
    const entry = entryOf(manifest, "plain-card");
    expect(entry.cspStable.script).toBe(true);
    expect(entry.scriptHashes).toHaveLength(1);
    for (const id of REQUEST_IDS) {
      expect(
        computePageCspHashes(render(manifest, "plain-card", id)).scripts,
      ).toEqual(entry.scriptHashes);
    }
    const first = viaBuild(`<plain-card></plain-card>`, list, PAGE_PATH);
    expect(computePageCspHashes(first.transpiledHtmlBody).scripts).toEqual(
      entry.scriptHashes,
    );
  });

  it("a component without scripts is stable with no hashes", async () => {
    const manifest = await build(cards());
    expect(entryOf(manifest, "bare-card").cspStable).toEqual({
      style: true,
      script: true,
    });
    expect(entryOf(manifest, "bare-card").scriptHashes).toEqual([]);
  });

  it("two usages of a nested child stay in the parent's template and get two ids from the loop", async () => {
    const list = nestedCards();
    const manifest = await build(list);
    const parent = render(manifest, "nest-parent", REQUEST_IDS[0]);
    // The template keeps the child usages (prop and forwarded slot included)
    // for the loop to expand: it is the parent's own scoping run.
    expect(parent.match(/<nest-child\b/g)).toHaveLength(2);
    expect(parent).toContain("<div data-bascik-slot>fwd</div>");
    expect(parent).not.toContain('class="c"');

    const html = `<nest-parent></nest-parent>`;
    const expected = viaBuild(html, list, PAGE_PATH);
    const mintId = vi.fn((name: string, ordinal: number) =>
      deriveInstanceId(PAGE_PATH, name, ordinal, new Set()),
    );
    const actual = renderWithManifest(html, list, manifest, PAGE_PATH, {
      mintId,
    });
    expect(mintId.mock.calls).toEqual([
      ["nest-parent", 1],
      ["nest-child", 1],
      ["nest-child", 2],
    ]);
    expect(unnumbered(actual.transpiledHtmlBody)).toBe(
      unnumbered(expected.transpiledHtmlBody),
    );
    const ids = actual.usedComponents
      .filter((c) => c.name === "nest-child")
      .map((c) => c.scopedIdNames?.c);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("manifest file", () => {
  let distDir = "";

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), "bascik-component-manifest-"));
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  it("records the build config it was made under", async () => {
    config.minify.html = true;
    config.base = "/docs/";
    const manifest = await build(cards());
    expect(manifest.schema).toBe(COMPONENT_MANIFEST_SCHEMA_VERSION);
    expect(COMPONENT_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(manifest.identifiers).toBe(true);
    expect(manifest.minifyHtml).toBe(true);
    expect(manifest.base).toBe("/docs/");
    expect(manifest.inheritAttributes).toBe(true);
    expect(Object.keys(manifest.components).sort()).toEqual(
      Object.keys(cards()).sort(),
    );
    for (const [name, entry] of Object.entries(manifest.components)) {
      expect(entry.name).toBe(name);
    }
  });

  it("is byte-identical across two builds, with sorted keys, and round-trips through readComponentManifest", async () => {
    // Every entry kind at once: supported, unsupported, staged scripts.
    const list = { ...cards(), ...scriptCards(), ...bindingCards() };
    const first = await build(list);
    const path = await writeComponentManifest(distDir, first);
    expect(path).toBe(join(distDir, ".bascik", "components.json"));
    const bytes1 = await readFile(path, "utf8");
    serverSidecarRegistry.clear();
    clearScopingTemplates();
    const second = await build(list);
    await writeComponentManifest(distDir, second);
    const bytes2 = await readFile(path, "utf8");
    expect(bytes2).toBe(bytes1);

    const parsed = JSON.parse(bytes1) as ComponentManifest;
    const names = Object.keys(parsed.components);
    expect(names).toEqual([...names].sort());
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());

    const read = await readComponentManifest(distDir);
    expect(read).toEqual(first);
    expect(read).toEqual(second);
  });

  it("returns null when no manifest was written", async () => {
    expect(await readComponentManifest(distDir)).toBeNull();
  });

  it("refuses another schema with the rebuild message", async () => {
    await mkdir(join(distDir, ".bascik"), { recursive: true });
    await writeFile(
      join(distDir, ".bascik", "components.json"),
      JSON.stringify({ schema: 99, components: {} }),
      "utf8",
    );
    await expect(readComponentManifest(distDir)).rejects.toThrow(/schema 99/);
    await expect(readComponentManifest(distDir)).rejects.toThrow(
      /Run `bascik --build`/,
    );
    await expect(readComponentManifest(distDir)).rejects.toThrow(
      /components\.json/,
    );
  });

  it.each([
    // A string schema must not read as "uses schema 1, but understands schema 1".
    [
      "a string schema",
      { schema: "1", components: {} },
      /uses schema "1", but this runtime understands schema 1/,
    ],
    [
      "a missing schema",
      { components: {} },
      /uses schema undefined, but this runtime understands schema 1/,
    ],
    [
      "a missing components member",
      { schema: 1 },
      /is malformed \(no "components" member\)/,
    ],
  ])(
    "refuses a manifest with %s with the rebuild message",
    async (_label, manifest, expected) => {
      await mkdir(join(distDir, ".bascik"), { recursive: true });
      await writeFile(
        join(distDir, ".bascik", "components.json"),
        JSON.stringify(manifest),
        "utf8",
      );
      await expect(readComponentManifest(distDir)).rejects.toThrow(expected);
      await expect(readComponentManifest(distDir)).rejects.toThrow(
        /Run `bascik --build`/,
      );
    },
  );

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["a non-object template", { template: "x", css: null, jobs: [] }],
    [
      "an unknown reason",
      {
        name: "a",
        filePath: "src/components/a.html",
        template: null,
        unsupported: { reason: "nope" },
        css: null,
        jobs: [],
        cspStable: { style: false, script: false },
        scriptHashes: [],
      },
    ],
    [
      "a missing cspStable",
      {
        name: "a",
        filePath: "src/components/a.html",
        template: null,
        css: null,
        jobs: [],
        scriptHashes: [],
      },
    ],
  ])(
    "refuses a manifest whose entry is not a ManifestEntry (%s) with the rebuild message",
    async (_label, entry) => {
      // A hand-edited or truncated entry must be a located message from the
      // reader, never a TypeError from whoever dereferences it (check.ts).
      await mkdir(join(distDir, ".bascik"), { recursive: true });
      await writeFile(
        join(distDir, ".bascik", "components.json"),
        JSON.stringify({
          schema: COMPONENT_MANIFEST_SCHEMA_VERSION,
          identifiers: true,
          minifyHtml: false,
          base: "/",
          inheritAttributes: true,
          components: { a: entry },
        }),
        "utf8",
      );
      await expect(readComponentManifest(distDir)).rejects.toThrow(
        /is malformed \(entry "a"/,
      );
      await expect(readComponentManifest(distDir)).rejects.toThrow(
        /Run `bascik --build`/,
      );
    },
  );

  it("refuses a malformed manifest with the rebuild message", async () => {
    await mkdir(join(distDir, ".bascik"), { recursive: true });
    await writeFile(
      join(distDir, ".bascik", "components.json"),
      "{nope",
      "utf8",
    );
    await expect(readComponentManifest(distDir)).rejects.toThrow(
      /Run `bascik --build`/,
    );
  });

  it("the manifest template is JSON-safe: instantiating the parsed copy equals instantiating the original", async () => {
    const manifest = await build(cards());
    const copy = JSON.parse(JSON.stringify(manifest)) as ComponentManifest;
    for (const name of Object.keys(cards())) {
      for (const id of REQUEST_IDS) {
        expect(render(copy, name, id)).toBe(render(manifest, name, id));
      }
    }
    // join is what the renderer uses on the parsed parts.
    const template = templateOf(copy, "my-card");
    expect(
      joinSegments(
        template.fileContent,
        new Array<string>(template.tokenCount).fill("x"),
      ),
    ).toContain("<div ");
  });
});
