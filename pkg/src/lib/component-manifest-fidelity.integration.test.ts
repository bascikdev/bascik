/**
 * Manifest fidelity over every real component in the repository (prompt 157).
 *
 * Property: for every supported component under the five component roots,
 * rendering usages through the expansion loop with the manifest's templates
 * as the scope (the request-time path: `instantiateTemplate` for a fresh id,
 * attr bindings injected after scoping, id references restored through
 * `scopedIdNames`, no sourceURL numbering) equals the build path
 * (`recursivelyTranspile`, the component build-script pass of
 * page-transpile.ts, sidecar extraction, `minify.js`) byte for byte, apart
 * from the `?instance=N` sourceURL suffix the build adds and the request
 * path does not. Unsupported components are skip-listed with their reason,
 * and the unsupported set per root is pinned to the expected small list, so
 * a component that silently becomes unsupported fails here.
 *
 * Runs with identifiers on and off and with `minify.js` off and on (the
 * built-in minifier), and with `minify.html` on under base "/" and "/docs/":
 * the build rewrites base paths in and minifies the whole page
 * (page-transpile.ts), the request path finishes each top-level usage with
 * `usageFinalizer` as wrapRunner does, and the two must agree apart from
 * where client scripts are hoisted to (the page's end against the
 * outermost instance's, D8), which the comparison factors out. Under
 * `minify.html` the usages are also placed inside a `<pre>` and a table
 * cell, where the build keeps whitespace and comments or leaves a comment
 * separator. Each root is built from its own directory so build
 * scripts resolve `@/` and relative imports as the site does; the e2e site's
 * TypeScript components need its esbuild transformer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { transform } from "esbuild";

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return {
    ...original,
    BascikConfig: structuredClone(original.BascikConfig),
  };
});

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
  type UnsupportedReason,
} from "./component-manifest.ts";
import { minifyHtml } from "./html-minifier.ts";
import { expandByUsage, usageFinalizer } from "./request-render.ts";
import {
  BUILD_EXPANSION_LIMITS,
  recursivelyTranspile,
} from "./component-expansion.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { invalidateComponentListCache, listComponents } from "./components.ts";
import { deriveInstanceId, getAttributeNameHash } from "./names.ts";
import { memoizedMinifyJs } from "./js-minifier.ts";
import {
  minifyScriptTagsInHtml,
  resolveCssMinifier,
} from "./page-minification.ts";
import { rewriteCssBasePaths, rewriteHtmlBasePaths } from "./base-path.ts";
import {
  applyScopingResult,
  instantiateTemplate,
} from "./scoping-instantiate.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import {
  extractServerScriptsToSidecar,
  serverSidecarRegistry,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { deduplicateCss } from "./styles.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

interface Root {
  dir: string;
  components: string[];
  /** The components the manifest must refuse, with the reason it must give. */
  unsupported: Record<string, UnsupportedReason>;
  typescript?: boolean;
}

// Pinned from the components as authored; each reason was established by
// building the root's manifest and reading the entry's `unsupported.detail`:
// - docs-pagination and docs-sidebar render the current page's navigation
//   from BASCIK_PAGE_PATH / BASCIK_PAGE_FILE;
// - site-header highlights the current page from BASCIK_PAGE_PATH;
// - page-aware-badge and shared-build-badge print BASCIK_PAGE_PATH;
// - server-script-comp returns `<p id="comp-server-output">`, an id the
//   build scopes per instance inside the script body;
// - css-import plans a CSS @import while scoping, which the template
//   recorder never reuses;
// (build-breakdown, a component that is only a build script, is supported:
//   its script is data-bascik-build-once, so its markup is printed when the
//   component is registered and the template already holds it.)
const ROOTS: Root[] = [
  {
    dir: "docs",
    components: ["src/components"],
    unsupported: {
      "docs-pagination": "build-script-reads-page-context",
      "docs-sidebar": "build-script-reads-page-context",
    },
  },
  {
    dir: "examples",
    components: ["components"],
    unsupported: { "site-header": "build-script-reads-page-context" },
  },
  {
    dir: "examples/starter-site",
    components: ["src/components"],
    unsupported: {},
  },
  {
    dir: "pkg/e2e",
    components: ["src/components"],
    unsupported: {
      "css-import": "scoping-template-unavailable",
      "page-aware-badge": "build-script-reads-page-context",
      "shared-build-badge": "build-script-reads-page-context",
      "server-script-comp": "instance-scoped-server-script",
    },
    typescript: true,
  },
  {
    dir: "adapters/cloudflare/e2e/fixture",
    components: ["src/components"],
    unsupported: {},
  },
];

const PAGE_PATH = "src/pages/fidelity.html";

type MutableConfig = {
  base: string;
  directory: { components: string[] };
  minify: { identifiers: boolean; js: boolean; html: boolean };
  scripts: Record<string, unknown>;
};
const config = BascikConfig as unknown as MutableConfig;

const identity = (input: string): string => input;

const freshState = () => ({
  ordinalMap: new Map<string, number>(),
  issuedIds: new Set<string>(),
});

/**
 * The bare id-reference targets the build rewrites (id-references.ts); the
 * manifest refuses `for`, `headers` and fragment `href` bindings on elements
 * the build does not rewrite them on, so the rule needs no element here.
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

/** `data-bascik-build` scripts left for the page's post-expansion pass (page-transpile.ts). */
const PENDING_BUILD_SCRIPT_RE =
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*\sdata-bascik-build(?:-once)?(?=[\s=/>])/i;

const unnumbered = (html: string): string =>
  html.replace(/\?instance=\d+/g, "");
/** Placeholder ids differ by construction (page vs component ids); the shape must not. */
const anonymizePlaceholders = (html: string): string =>
  html.replace(/data-bascik-server-id="[^"]+"/g, 'data-bascik-server-id="#"');
const placeholderIds = (html: string): string[] =>
  [...html.matchAll(/data-bascik-server-id="([^"]+)"/g)].map((m) => m[1]);

/**
 * Client scripts, which `minify.html` hoists: to the page's end at build
 * time, to the end of the outermost instance at request time (D8). Removed
 * with the line break the minifier puts before each, and kept in order.
 *
 * Tags are matched as the HTML tokenizer reads them: any case, a quoted
 * attribute value may hold ">", and the end tag may carry whitespace or junk
 * before its ">". Scripts that are not hoistable stay in place on both paths,
 * so the replacement keeps them on purpose.
 */
const HOISTABLE_SCRIPT_RE =
  /\n?<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script(?:[\t\n\f\r /][^>]*)?>/gi;
const isHoistable = (attrs: string): boolean =>
  !/data-bascik/i.test(attrs) &&
  !/(?:^|\s)type\s*=\s*["']?(?!module\b|text\/javascript\b)/i.test(attrs);
const unhoisted = (html: string) => {
  const scripts: string[] = [];
  const rest = html.replace(HOISTABLE_SCRIPT_RE, (element, attrs: string) => {
    if (!isHoistable(attrs)) return element;
    scripts.push(element.replace(/^\n/, ""));
    return "";
  });
  return { html: rest, scripts };
};

/** The build path, as page-transpile.ts runs it for a page body. */
const viaBuild = async (
  usage: string,
  list: ComponentList,
  jsMinifier: ((code: string) => string | Promise<string>) | null,
) => {
  clearScopingTemplates();
  const state = freshState();
  let { transpiledHtmlBody: html, usedComponents } = recursivelyTranspile(
    usage,
    list,
    [],
    PAGE_PATH,
    state,
  );
  let passes = 0;
  while (PENDING_BUILD_SCRIPT_RE.test(html) && passes < 10) {
    passes++;
    html = await executeBuildScripts(html, PAGE_PATH, null, {
      pageFile: PAGE_PATH,
    });
    ({ transpiledHtmlBody: html, usedComponents } = recursivelyTranspile(
      html,
      list,
      usedComponents,
      PAGE_PATH,
      state,
    ));
  }
  html = rewriteHtmlBasePaths(html, config.base);
  if (config.minify.html) html = minifyHtml(html);
  const scripts: Record<string, ServerScriptEntry> = {};
  html = extractServerScriptsToSidecar(html, PAGE_PATH, scripts, PAGE_PATH);
  if (jsMinifier) html = await minifyScriptTagsInHtml(html, jsMinifier);
  return { html, usedComponents, scripts };
};

/**
 * The request path: the loop with the manifest's templates as the scope, one
 * top-level usage at a time, each finished as wrapRunner finishes it.
 */
const viaManifest = (
  usage: string,
  list: ComponentList,
  manifest: ComponentManifest,
) => {
  const state = freshState();
  const hashName = manifest.identifiers ? getAttributeNameHash : identity;
  const usedComponents: BascikComponent[] = [];
  const transpiledHtmlBody = expandByUsage(
    usage,
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
        deriveInstanceId(PAGE_PATH, name, ordinal, state.issuedIds),
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
    },
    usedComponents,
    usageFinalizer(manifest),
  );
  return { transpiledHtmlBody, usedComponents };
};

/** Usages exercising every declared prop and slot, in every tag spelling. */
const usagesFor = (name: string, raw: string): string[] => {
  const props = new Set<string>();
  for (const match of raw.matchAll(/data-bascik-prop-([\w-]+)/g))
    props.add(match[1]);
  for (const match of raw.matchAll(/data-bascik-attr-[\w:.-]+="([^"]*)"/g))
    props.add(match[1]);
  const propAttrs = [...props]
    .sort()
    .map((prop) => ` data-bascik-prop-${prop}="v-${prop} &amp; &lt;b&gt;"`)
    .join("");
  const namedSlots = [
    ...new Set(
      [...raw.matchAll(/data-bascik-slot="([^"]*)"/g)].map((m) => m[1]),
    ),
  ];
  const slotContent =
    namedSlots
      .map(
        (slot) =>
          `<div data-bascik-slot="${slot}"><b class="x">${slot}</b></div>`,
      )
      .join("") + `<em id="d">default <i>slot</i></em>`;
  const upper = name.toUpperCase();
  return [
    `<${name}></${name}>`,
    `<${name}${propAttrs}></${name}>`,
    `<${name}${propAttrs}>${slotContent}</${name}>`,
    `<${name} class="user" aria-label="L" />`,
    `<${name}>`,
    `<${upper}></${upper}>`,
    `<p>before</p><${name}></${name}><${name}${propAttrs}>${slotContent}</${name}><p>after</p>`,
  ];
};

/** The page pipeline's CSS bytes for one used component (page-transpile.ts). */
const pipelineCss = async (component: BascikComponent): Promise<string> => {
  const combined = rewriteCssBasePaths(
    deduplicateCss([component], true),
    (BascikConfig.base as string | undefined) ?? "/",
  );
  const minifier = resolveCssMinifier();
  return minifier ? await minifier(combined) : combined;
};

describe.each(ROOTS)("component root $dir", (root) => {
  const originalCwd = process.cwd();
  let list: ComponentList;
  const rawOf = (name: string): string =>
    list[name].scriptDependenciesContent ?? list[name].fileContent;

  // Build scripts write their modules and cache under the root's own
  // node_modules/.cache (build-scripts.ts); a root that is not a workspace
  // has no node_modules, and the run must not leave one behind.
  const rootDir = resolve(REPO_ROOT, root.dir);
  const nodeModules = join(rootDir, "node_modules");
  const hadNodeModules = existsSync(nodeModules);

  beforeAll(async () => {
    process.chdir(rootDir);
    invalidateComponentListCache();
    config.directory.components = root.components;
    config.scripts.onBuildScriptError = "error";
    config.scripts.typescript = root.typescript
      ? async (code: string, { sourcePath }: { sourcePath: string }) =>
          (
            await transform(code, {
              loader: "ts",
              target: "es2020",
              sourcefile: sourcePath,
            })
          ).code
      : undefined;
    list = await listComponents(root.components);
    expect(Object.keys(list).length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    invalidateComponentListCache();
    if (!hadNodeModules)
      await rm(nodeModules, { recursive: true, force: true });
  });

  const variants = [
    ...[true, false].flatMap((identifiers) =>
      [false, true].map((minifyJs) => ({
        identifiers,
        minifyJs,
        minifyHtml: false,
        base: "/",
      })),
    ),
    { identifiers: true, minifyJs: true, minifyHtml: true, base: "/docs/" },
    { identifiers: false, minifyJs: false, minifyHtml: true, base: "/" },
  ];
  for (const { identifiers, minifyJs, minifyHtml, base } of variants) {
    describe(`identifiers ${identifiers}, minify.js ${minifyJs}, minify.html ${minifyHtml}, base ${base}`, () => {
      let manifest: ComponentManifest;
      const jsMinifier = minifyJs ? memoizedMinifyJs : null;
      /** Where the build keeps whitespace and comments, or leaves a separator. */
      const placements = (usage: string): string[] =>
        minifyHtml
          ? [
              usage,
              `<pre>${usage}</pre>`,
              `<table><tbody><tr><td>${usage}</td></tr></tbody></table>`,
            ]
          : [usage];
      const comparable = (html: string) =>
        minifyHtml ? unhoisted(html) : { html, scripts: [] };

      beforeAll(async () => {
        config.minify.identifiers = identifiers;
        config.minify.js = minifyJs;
        config.minify.html = minifyHtml;
        config.base = base;
        serverSidecarRegistry.clear();
        clearScopingTemplates();
        manifest = await buildComponentManifest(list, BascikConfig);
      });

      it("covers every component and refuses exactly the expected ones, each with its reason", () => {
        expect(Object.keys(manifest.components).sort()).toEqual(
          Object.keys(list).sort(),
        );
        const unsupported: Record<string, string> = {};
        for (const [name, entry] of Object.entries(manifest.components)) {
          if (entry.unsupported) unsupported[name] = entry.unsupported.reason;
          else expect(entry.template, name).not.toBeNull();
        }
        expect(unsupported).toEqual(root.unsupported);
      });

      it("renders every usage of every supported component exactly as the build does", async () => {
        const supported = Object.keys(list)
          .filter((name) => !manifest.components[name].unsupported)
          .sort();
        const skipped: string[] = [];
        for (const name of supported) {
          for (const usage of usagesFor(name, rawOf(name)).flatMap(
            placements,
          )) {
            const expected = await viaBuild(usage, list, jsMinifier);
            // A parent whose expansion reaches an unsupported child is
            // left with that child unexpanded at request time (D7); the
            // build expands it, so the two cannot agree and it is listed.
            if (
              expected.usedComponents.some(
                (used) => manifest.components[used.name]?.unsupported,
              )
            ) {
              skipped.push(`${name}: ${usage.slice(0, 40)}`);
              continue;
            }
            // viaBuild recorded the page scripts in the registry alongside
            // the component jobs the manifest build staged; both stay.
            const actual = viaManifest(usage, list, manifest);
            const rendered = comparable(
              anonymizePlaceholders(unnumbered(actual.transpiledHtmlBody)),
            );
            const built = comparable(
              anonymizePlaceholders(unnumbered(expected.html)),
            );
            // A script hoisted out of a table leaves an empty-comment
            // separator where it stood. The whole page leaves a script in
            // place when one that runs in place follows it anywhere later
            // (execution order), an instance only when one follows inside
            // it, so with scripts the separators move with D8's hoisting.
            if (
              usage.startsWith("<table>") &&
              (built.scripts.length > 0 || rendered.scripts.length > 0)
            ) {
              built.html = built.html.replaceAll("<!---->", "");
              rendered.html = rendered.html.replaceAll("<!---->", "");
            }
            expect(rendered.html, `${name}: ${usage}`).toBe(built.html);
            expect(rendered.scripts, `${name}: ${usage}`).toEqual(
              built.scripts,
            );
            expect(
              actual.usedComponents.map((c) => c.name),
              `${name}: ${usage}`,
            ).toEqual(expected.usedComponents.map((c) => c.name));
          }
        }
        // No component in these roots nests one of the unsupported ones.
        expect(skipped).toEqual([]);
        // Builds every usage of every component (about 1 s alone with
        // minify.html on); the default 5 s timed out on a loaded machine.
      }, 60_000);

      it("stages the same server and stream script sources as the page sidecar, with the component's output scope", async () => {
        for (const name of Object.keys(list).sort()) {
          const entry = manifest.components[name];
          if (entry.unsupported) continue;
          const usage = `<${name}></${name}>`;
          const expected = await viaBuild(usage, list, jsMinifier);
          const pageIds = placeholderIds(expected.html);
          const actual = viaManifest(usage, list, manifest);
          const componentIds = placeholderIds(actual.transpiledHtmlBody);
          expect(componentIds.length, name).toBe(pageIds.length);
          for (let index = 0; index < pageIds.length; index++) {
            const fromPage = expected.scripts[pageIds[index]];
            const staged = serverSidecarRegistry.getScript(componentIds[index]);
            expect(staged, `${name} job ${index}`).toBeDefined();
            expect(componentIds[index]).toMatch(/^component_script_[0-9a-f]+$/);
            expect(staged?.source, `${name} job ${index}`).toBe(
              fromPage.source,
            );
            expect(staged?.mode).toBe(fromPage.mode);
            expect(staged?.sourceFile).toBe(fromPage.sourceFile);
            expect(staged?.sourceLine).toBe(fromPage.sourceLine);
            expect(staged?.outputScope).toBe(fromPage.outputScope);
          }
        }
      });

      it("records the page pipeline's CSS for every supported component (once per response, or segmented per instance)", async () => {
        for (const name of Object.keys(list).sort()) {
          const entry = manifest.components[name];
          if (entry.unsupported) continue;
          const expected = await viaBuild(`<${name}></${name}>`, list, null);
          const used = expected.usedComponents[0];
          expect(used?.name, name).toBe(name);
          if (entry.css === null) {
            expect(used.cssFileContent ?? "", name).toBe("");
            continue;
          }
          if ("perInstance" in entry.css) {
            expect(
              used.requiresPerInstanceCss ?? false,
              `${name} per-instance`,
            ).toBe(true);
            const predicted = instantiateTemplate(
              entry.template!,
              deriveInstanceId(PAGE_PATH, name, 1),
              identifiers ? getAttributeNameHash : identity,
            );
            expect(predicted?.cssFileContent, name).toBe(
              await pipelineCss(used),
            );
            continue;
          }
          expect(entry.css.text, name).toBe(await pipelineCss(used));
          expect(entry.cspStable.style, name).toBe(true);
        }
      });
    });
  }
});
