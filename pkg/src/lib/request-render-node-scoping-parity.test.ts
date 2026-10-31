/**
 * Request-time scoping parity on the Node host (prompt 158 R2-02): the
 * constructs the October 2026 scoping fixes taught the compiler (escaped and
 * non-ASCII class selectors, dotted `@layer` names, an escape next to a
 * descendant element) rendered from a page server script through
 * `request-render-node.ts`, two instances each, with the manifest's
 * templates replayed for request ids. Every instance must equal a fresh run
 * of the build's scoping pipeline for the same id, and its stylesheet the
 * block the build emits (`deduplicateCss`), with identifiers off and on, and
 * for components whose classes are scoped per instance (a `url(#id)`
 * reference) as well as shared ones.
 *
 * Misuse lens: a typo'd tag beside the real ones passes through as written,
 * and a request id never takes the build's 8-hex shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Records the instance ids the renderer instantiates templates for; the real
// replay still runs.
const instantiated = vi.hoisted(
  () => [] as Array<{ name: string; instanceId: string }>,
);
vi.mock("./scoping-instantiate.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./scoping-instantiate.ts")>();
  return {
    ...actual,
    instantiateTemplate: (
      ...args: Parameters<typeof actual.instantiateTemplate>
    ) => {
      const result = actual.instantiateTemplate(...args);
      if (result && /^r[0-9a-f]{7}$/.test(args[1])) {
        instantiated.push({ name: currentName(args[0]), instanceId: args[1] });
      }
      return result;
    },
  };
});

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import type { ScopingTemplate } from "./scoping-instantiate.ts";
import {
  clearScopingTemplates,
  runScopingPipeline,
} from "./scoping-template.ts";
import { scriptRegistry } from "./script-registry.ts";
import {
  executeServerScriptPlan,
  planServerScripts,
} from "./server-scripts.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { deduplicateCss } from "./styles.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

type MutableConfig = { minify: { identifiers: boolean } };
const config = BascikConfig as unknown as MutableConfig;

// The template objects of the current manifest, by component name.
const templateNames = new Map<ScopingTemplate, string>();
const currentName = (template: ScopingTemplate): string =>
  templateNames.get(template) ?? "?";

const PER_INSTANCE_MARKUP = `<svg><filter id="glow"></filter></svg>`;

const components = (): ComponentList => {
  const escaped = {
    html: `<div class="md:flex a:b café"><p>x</p><span class="w-1/2">y</span><b class="esc\u0001">z</b></div>`,
    css: `.md\\:flex p { display: flex } .a\\:b { color: red } .café span { margin: 0 } .w-1\\/2 { width: 50% } .esc\\1  b { font-weight: 700 }`,
  };
  const layered = {
    html: `<section class="a b"><p>x</p></section>`,
    css: `@layer base.theme, base.reset; @layer base.theme { .a p { color: red } } @layer base.reset { .b { margin: 0 } }`,
  };
  const entry = (
    name: string,
    { html, css }: { html: string; css: string },
    perInstance: boolean,
  ) => ({
    fileName: `src/components/${name}/${name}.html`,
    fileContent: perInstance
      ? `${PER_INSTANCE_MARKUP}<i class="glow-user">g</i>${html}`
      : html,
    cssFileContent: perInstance
      ? `.glow-user { filter: url(#glow) } ${css}`
      : css,
  });
  return {
    "esc-card": entry("esc-card", escaped, false),
    "esc-glow-card": entry("esc-glow-card", escaped, true),
    "layer-card": entry("layer-card", layered, false),
    "layer-glow-card": entry("layer-glow-card", layered, true),
  };
};

const NAMES = Object.keys(components());

const PAGE_FILE = "src/pages/parity.html";
/**
 * A page whose server script returns `body`. JSON.stringify alone leaves `<`
 * as is, so a body holding `</script>` or `<!--` would end or change the
 * script element; `<`, `>` and the two JavaScript line separators are written
 * as \u escapes, which the string literal turns back into the same text.
 */
const serverPage = (body: string): string =>
  `<main><script data-bascik-server>export default () => ${JSON.stringify(
    body,
  ).replace(
    /[<>\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )};</script></main>`;

const render = async (
  html: string,
  manifest: ComponentManifest,
): Promise<string> =>
  (
    await executeServerScriptPlan(
      planServerScripts(html, PAGE_FILE),
      new Request("http://localhost/parity"),
      { remoteIp: "127.0.0.1" },
      1000,
      PAGE_FILE,
      manifest,
    )
  ).toString("utf8");

const build = async (): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  const manifest = await buildComponentManifest(components(), BascikConfig);
  templateNames.clear();
  for (const [name, entry] of Object.entries(manifest.components))
    if (entry.template) templateNames.set(entry.template, name);
  return manifest;
};

/** The build's scoping of `name` for `instanceId`, as a page would get it. */
const fresh = (name: string, instanceId: string): BascikComponent =>
  runScopingPipeline({ name, ...components()[name] }, instanceId);

const count = (text: string, part: string): number =>
  text.split(part).length - 1;

beforeEach(() => {
  config.minify.identifiers = false;
  serverSidecarRegistry.clear();
  scriptRegistry.clear();
  clearScopingTemplates();
  instantiated.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([false, true])(
  "request-time scoping parity with the build (identifiers %s)",
  (identifiers) => {
    it("renders two instances of every escaped-class and @layer component exactly as the build scopes them", async () => {
      config.minify.identifiers = identifiers;
      const manifest = await build();
      for (const name of NAMES) {
        expect(
          manifest.components[name].unsupported,
          `<${name}> is renderable`,
        ).toBeUndefined();
        expect(manifest.components[name].template).not.toBeNull();
      }
      const out = await render(
        serverPage(
          NAMES.map((name) => `<${name}></${name}>`.repeat(2)).join(""),
        ),
        manifest,
      );
      for (const name of NAMES) expect(out).not.toContain(`<${name}`);

      // Two instances per component, each a distinct request id.
      expect(instantiated).toHaveLength(2 * NAMES.length);
      expect(new Set(instantiated.map((i) => i.instanceId)).size).toBe(
        2 * NAMES.length,
      );
      for (const name of NAMES) {
        const uses = instantiated.filter((i) => i.name === name);
        expect(uses, `<${name}>`).toHaveLength(2);
        for (const { instanceId } of uses) {
          const scoped = fresh(name, instanceId);
          expect(out, `<${name}> ${instanceId} markup`).toContain(
            scoped.fileContent,
          );
          const block = `<style>${deduplicateCss([scoped], true)}</style>`;
          // A shared stylesheet is emitted once per response; one scoped per
          // instance (url(#id)) once per instance.
          expect(count(out, block), `<${name}> ${instanceId} style`).toBe(1);
          if (scoped.requiresPerInstanceCss && !identifiers)
            expect(block).toContain(`__${instanceId}__`);
        }
      }

      // The constructs survived scoping as the build writes them.
      if (!identifiers) {
        expect(out).toContain(".bascik__esc-card__md\\:flex .b_el_esc-card_p");
        expect(out).toContain(".bascik__esc-card__esc\\1  .b_el_esc-card_b");
        expect(out).toContain(
          "@layer bascik__layer-card__layer__base.bascik__layer-card__layer__theme,",
        );
        expect(out).toContain('class="bascik__esc-card__md:flex');
      }
    });

    it("misuse: a typo'd tag beside the real ones is sent as written, and request ids never take the build's shape", async () => {
      config.minify.identifiers = identifiers;
      const manifest = await build();
      const out = await render(
        serverPage(`<esc-crad></esc-crad><esc-card></esc-card><layer-card>`),
        manifest,
      );
      expect(out).toContain("<esc-crad></esc-crad>");
      expect(out).not.toContain("<esc-card");
      for (const { instanceId } of instantiated)
        expect(instanceId).not.toMatch(/^[0-9a-f]{8}$/);
      const esc = instantiated.find((i) => i.name === "esc-card")!;
      expect(out).toContain(fresh("esc-card", esc.instanceId).fileContent);
    });
  },
);

describe("the serverPage fixture", () => {
  it("misuse: a body holding </script> or <!-- stays inside the server script", () => {
    const body = "<p>a</script><!--b--></p>";
    const page = serverPage(body);
    expect(count(page.toLowerCase(), "</script")).toBe(1);
    const code = page.slice(
      page.indexOf(">", page.indexOf("<script")) + 1,
      page.lastIndexOf("</script>"),
    );
    const handler = new Function(code.replace("export default", "return"))();
    expect(handler()).toBe(body);
  });
});
