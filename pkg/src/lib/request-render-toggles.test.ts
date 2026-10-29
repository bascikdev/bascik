/**
 * The binding toggles and `scripts.renderLimits` at request time (the
 * renderer every host runs: Node dev, `bascik --server`, the Worker).
 *
 * - Binding rules travel in the component manifest (`manifest.security`),
 *   recorded at build, so build and request time agree on every host. A
 *   manifest without the field was built with both protections on.
 * - Render limits come from the host (`RenderHost.limits`, partial); absent
 *   means today's values. Each failure names its setting and the configured
 *   number.
 */
import { describe, expect, it, vi } from "vitest";
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
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import type { ExecutionPlan, ScriptJobRunner } from "./request-execution.ts";
import {
  REQUEST_RENDER_LIMITS,
  RequestRenderError,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ComponentList } from "./types.ts";

interface Policy {
  blockScriptUrls: boolean;
  blockCodeBindings: boolean;
}
const BLOCKED_URL = "about:invalid";
const sha256hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const plan = (): ExecutionPlan => ({
  segments: [{ kind: "script", mode: "server", id: "a" }],
  firstStreamIndex: -1,
});

const host = (
  manifest: ComponentManifest,
  extra: Record<string, unknown> = {},
): RenderHost =>
  ({
    manifest,
    hashName: (s: string) => s,
    hashHex: sha256hex,
    httpPath: "/t",
    timeoutMs: 1000,
    runComponentJob: vi.fn(async () => ""),
    externalTags: createExternalTagMatcher([]),
    ...extra,
  }) as RenderHost;

const render = async (
  manifest: ComponentManifest,
  output: string,
  extra: Record<string, unknown> = {},
): Promise<string> =>
  wrapRunner(
    (async () => output) as ScriptJobRunner,
    plan(),
    host(manifest, extra),
  )("a", new AbortController().signal);

const list: ComponentList = {
  "t-link": {
    fileName: "src/components/t-link.html",
    fileContent: `<a class="l" data-bascik-attr-href="u" data-bascik-attr-onclick="c">go</a>`,
  },
  "t-frame": {
    fileName: "src/components/t-frame.html",
    fileContent: `<iframe class="f" data-bascik-attr-srcdoc="u"></iframe>`,
  },
  "t-script": {
    fileName: "src/components/t-script.html",
    fileContent: `<div class="s"><script data-bascik-prop-v>void 0;</script></div>`,
  },
  "t-embed": {
    fileName: "src/components/t-embed.html",
    fileContent: `<object class="e" type="application/pdf"></object>`,
  },
  "t-card": {
    fileName: "src/components/t-card.html",
    fileContent: `<p class="c">card</p>`,
  },
  "t-box": {
    fileName: "src/components/t-box.html",
    fileContent: `<div class="b"><div data-bascik-slot>s</div></div>`,
  },
};

const buildManifest = async (): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(list, BascikConfig);
};
const withPolicy = (
  manifest: ComponentManifest,
  security: Policy | undefined,
): ComponentManifest => {
  const copy = { ...manifest } as ComponentManifest & { security?: Policy };
  if (security) copy.security = security;
  else delete copy.security;
  return copy;
};

const LINK = `<t-link data-bascik-prop-u="javascript:alert(1)" data-bascik-prop-c="go()"></t-link>`;
const FRAME = `<t-frame data-bascik-prop-u="&lt;b&gt;x&lt;/b&gt;"></t-frame>`;
const SCRIPT = `<t-script data-bascik-prop-v="window.x=1"></t-script>`;
const EMBED = `<t-embed data="data:application/pdf;base64,JVBE"></t-embed>`;

describe("binding toggles at request time, from manifest.security", () => {
  it("a manifest without the field behaves as both on", async () => {
    const manifest = withPolicy(await buildManifest(), undefined);
    const html = await render(manifest, LINK + FRAME + SCRIPT + EMBED);
    expect(html).toContain(`href="${BLOCKED_URL}"`);
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("window.x=1");
    expect(html).toContain(`data="${BLOCKED_URL}"`);
  });

  it("blockScriptUrls: false binds the href and the inherited object data as written", async () => {
    const manifest = withPolicy(await buildManifest(), {
      blockScriptUrls: false,
      blockCodeBindings: true,
    });
    const html = await render(manifest, LINK + EMBED);
    expect(html).toContain(`href="javascript:alert(1)"`);
    expect(html).toContain(`data="data:application/pdf;base64,JVBE"`);
    expect(html).not.toContain(BLOCKED_URL);
    expect(html).not.toContain("onclick");
  });

  it("blockCodeBindings: false binds onclick, srcdoc and the script receiver", async () => {
    const manifest = withPolicy(await buildManifest(), {
      blockScriptUrls: true,
      blockCodeBindings: false,
    });
    const html = await render(manifest, LINK + FRAME + SCRIPT);
    expect(html).toContain(`onclick="go()"`);
    expect(html).toContain(`srcdoc="&lt;b&gt;x&lt;/b&gt;"`);
    expect(html).toMatch(/<script>window\.x=1<\/script>/);
    expect(html).toContain(`href="${BLOCKED_URL}"`);
  });

  it("off means no dev warning either", async () => {
    const manifest = withPolicy(await buildManifest(), {
      blockScriptUrls: false,
      blockCodeBindings: false,
    });
    const warnOnce = vi.fn();
    await render(manifest, LINK + FRAME + SCRIPT + EMBED, { warnOnce });
    expect(
      warnOnce.mock.calls.filter(([, m]) =>
        /about:invalid|Ignoring data-bascik/.test(String(m)),
      ),
    ).toEqual([]);
  });

  it("the manifest records the build's security setting", async () => {
    const config = {
      ...BascikConfig,
      security: { blockScriptUrls: false, blockCodeBindings: true },
    };
    clearScopingTemplates();
    serverSidecarRegistry.clear();
    const manifest = (await buildComponentManifest(
      list,
      config as never,
    )) as ComponentManifest & { security?: Policy };
    expect(manifest.security).toEqual({
      blockScriptUrls: false,
      blockCodeBindings: true,
    });
  });

  it("a build without security config records both on, or nothing (read as on)", async () => {
    const manifest = (await buildManifest()) as ComponentManifest & {
      security?: Policy;
    };
    expect(
      manifest.security ?? { blockScriptUrls: true, blockCodeBindings: true },
    ).toEqual({ blockScriptUrls: true, blockCodeBindings: true });
  });
});

describe("renderLimits from the host", () => {
  const fails = async (
    output: string,
    limits: Record<string, number>,
    pattern: RegExp,
    extra: Record<string, unknown> = {},
  ) => {
    const manifest = await buildManifest();
    const error = await render(manifest, output, { limits, ...extra }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RequestRenderError);
    expect((error as Error).message).toMatch(pattern);
    return error as Error;
  };

  it("REQUEST_RENDER_LIMITS carries today's values under the config names", () => {
    expect(REQUEST_RENDER_LIMITS).toEqual({
      maxInstances: 1000,
      maxOutputLength: 4 * 1024 * 1024,
      maxDepth: 4,
      maxNestedScripts: 64,
      rescanFactor: 16,
      rescanBase: 32 * 1024 * 1024,
    });
  });

  it("maxInstances: 2 refuses three cards and names the setting", async () => {
    const error = await fails(
      "<t-card></t-card>".repeat(3),
      { maxInstances: 2 },
      /more than 2 component instances/,
    );
    expect(error.message).toContain("scripts.renderLimits.maxInstances");
  });

  it("maxInstances: 2 allows two cards", async () => {
    const manifest = await buildManifest();
    const html = await render(manifest, "<t-card></t-card>".repeat(2), {
      limits: { maxInstances: 2 },
    });
    expect(html.match(/card<\/p>/g)).toHaveLength(2);
  });

  it("maxOutputLength: 50 refuses a rendered output over 50 characters, naming the setting and number, not 4 MiB", async () => {
    const error = await fails(
      "<t-card></t-card>".repeat(4),
      { maxOutputLength: 50 },
      /50 characters/,
    );
    expect(error.message).toContain("scripts.renderLimits.maxOutputLength");
    expect(error.message).not.toContain("4 MiB");
  });

  it("maxNestedScripts and maxDepth are taken from the host", async () => {
    const nestedList: ComponentList = {
      "n-card": {
        fileName: "src/components/n-card.html",
        fileContent: `<div class="n"><script data-bascik-server>export default () => "<b>x</b>";</script></div>`,
      },
    };
    clearScopingTemplates();
    serverSidecarRegistry.clear();
    const manifest = await buildComponentManifest(nestedList, BascikConfig);
    const run = (limits: Record<string, number>) =>
      render(manifest, "<n-card></n-card>".repeat(3), {
        limits,
        runComponentJob: vi.fn(async () => "<b>x</b>"),
      }).then(
        () => null,
        (e: Error) => e,
      );
    const nested = await run({ maxNestedScripts: 2 });
    expect(nested).toBeInstanceOf(RequestRenderError);
    expect(nested!.message).toContain("scripts.renderLimits.maxNestedScripts");
    expect(nested!.message).toMatch(/more than 2 nested component scripts/);
    expect(await run({ maxNestedScripts: 3 })).toBeNull();
  });

  it("rescanFactor and rescanBase set the scan budget and are named in the message", async () => {
    // Nested usages read each level's slot again (component-scan-budget.ts);
    // a tiny base and factor trip it.
    const error = await fails(
      "<t-box>".repeat(20) + "x".repeat(2000) + "</t-box>".repeat(20),
      { rescanFactor: 1, rescanBase: 1 },
      /rescan/,
    );
    expect(error.message).toMatch(
      /scripts\.renderLimits\.(rescanFactor|rescanBase)/,
    );
  });

  it("no limits on the host is today's behavior", async () => {
    const manifest = await buildManifest();
    const html = await render(manifest, "<t-card></t-card>".repeat(20));
    expect(html.match(/card<\/p>/g)).toHaveLength(20);
  });
});
