import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
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
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildScopingTemplate,
  clearScopingTemplates,
  instantiateScopingTemplate,
  recordScopingRun,
  runScopingPipeline,
  scopeComponentInstance,
  __scopingTemplateInternalsForTests as internals,
  __scopingTemplateStatsForTests as stats,
} from "./scoping-template.ts";
import type { BascikComponent } from "./types.ts";

// Template reuse checked against the adversarial inputs the October 2026
// scoping fixes introduced (prompt 158 R2-02): each construct is scoped for
// several instances, and the template-replayed result must equal a fresh run
// of the real pipeline byte for byte.

interface Case {
  name: string;
  html: string;
  css?: string;
}

// A `url(#id)` reference makes a component's CSS per instance, so class,
// keyframe, layer and container names then embed the instance ID.
const PER_INSTANCE = `<svg><filter id="glow"></filter></svg>`;
const PER_INSTANCE_CSS = `.glow-user { filter: url(#glow) }`;

const cases: Case[] = [
  {
    name: "escaped class selectors",
    html: `<div class="a:b md:flex w-1/2 hover:text-red" id="box">x</div>`,
    css: `.a\\:b { color: red } .md\\:flex p { display: flex } .w-1\\/2 { width: 50% } .hover\\:text-red:hover > span { color: red }`,
  },
  {
    name: "non-ASCII and hex-escaped class selectors",
    html: `<p class="café ünï 10x">x</p><span class="naïve">y</span>`,
    css: `.café { color: red } .ünï span { color: blue } .\\31 0x { margin: 0 } .na\\EF ve { padding: 0 }`,
  },
  {
    name: "control-character escapes in class selectors",
    html: `<p class="a&#9;b">x</p>`,
    css: `.a\\9 b { color: red }`,
  },
  {
    name: "backslash in attribute values",
    html: `<div class="a\\b c" id="p\\q" title="x\\y" data-path="C:\\dir\\file"><label for="p\\q">L</label></div>`,
    css: `.c { color: red } #p\\\\q { margin: 0 }`,
  },
  {
    name: "@layer with dotted names",
    html: `<div class="a b">x</div>`,
    css: `@layer base.theme, base.reset; @layer base.theme { .a { color: red } } @layer base.reset { .b p { margin: 0 } }`,
  },
  {
    name: "@import with layer()",
    html: `<div class="a">x</div>`,
    css: `@import url("./theme.css") layer(theme.base); .a { color: red }`,
  },
  {
    name: "[id] selector forms",
    html: `<div id="root" class="a"><p id="inner">x</p><span>y</span></div>`,
    css: `.a:not([id]) { color: red } @supports selector([id]) { .a { color: blue } } [id="inner"], .a span { margin: 0 } [ ID ] { padding: 0 } [id-ref] { border: 0 } #root { gap: 1px }`,
  },
  {
    name: "multi-name container-name and container shorthand",
    html: `<div class="wrap card">x</div>`,
    css: `.wrap { container-name: sidebar main-area; } .card { container: card-box narrow / inline-size; } @container sidebar (min-width: 10px) { .card { color: red } } @container narrow (max-width: 1px) { .wrap p { margin: 0 } }`,
  },
  {
    name: "nested &:hover descendants",
    html: `<div class="card"><p>x</p><a class="link">l</a></div>`,
    css: `.card { color: red; &:hover p { color: blue } & > .link:focus span { margin: 0 } &.card:is(.link) li { padding: 0 } }`,
  },
  {
    name: "@media preludes with commas",
    html: `<div class="a b">x</div>`,
    css: `@media screen, print { .a { color: red } .b > p { margin: 0 } } @media (min-width: 1px), (orientation: portrait) and (hover: hover) { .a { color: blue } }`,
  },
  {
    name: "custom properties in template style attributes",
    html: `<div class="a" style="--gap: 2px; margin: var(--gap); --a-b: 1">x</div><p style="color: var(--accent, red)">y</p>`,
    css: `.a { --gap: 1px; --accent: blue; padding: var(--gap); color: var(--accent) }`,
  },
  {
    name: "compound selectors in querySelector",
    html: `<div class="a b" id="root"><p class="c">x</p></div>
<script>document.querySelector(".a.b")?.classList.add("c"); document.querySelectorAll("#root.a .c.a, .b.c > .a").forEach((node) => node.remove()); document.querySelector("div.a.b:not(.c)");</script>`,
    css: `.a.b { color: red } .c { margin: 0 }`,
  },
  {
    name: "comparisons and id assignments in scripts",
    html: `<div id="root" class="a">x</div>
<script>let count = 0; const max = 3; const ok = true; if (count<max && ok) count++; const el = document.getElementById("root"); el.id = "root"; el .id = "other"; const o = { id = 1 } = {}; for (let i = 0; i<max; i++) el.className = "a";</script>`,
    css: `.a { color: red }`,
  },
  {
    name: "regex and template literals in scripts",
    html: `<div id="root" class="a">x</div>
<script>const re = /\\.a\\b/g; const t = \`.a \${"#root"}\`; document.querySelector(\`#root .a\`); const s = "a<b" + '.a';</script>`,
    css: `.a { color: red }`,
  },
];

// Misuse lens: the same constructs typo'd or left incomplete. Each must either
// be refused by the recorder or replay exactly; none may diverge.
const misuseCases: Case[] = [
  {
    name: "trailing backslash in a class selector",
    html: `<div class="a b">x</div>`,
    css: `.a\\ { color: red } .b p { margin: 0 } .b\\`,
  },
  {
    name: "class-like and empty @layer names",
    html: `<div class="a b">x</div>`,
    css: `@layer .a { .b { color: red } } @layer a..b; @layer { .a p { margin: 0 } }`,
  },
  {
    name: "unclosed [id selector",
    html: `<div id="root" class="a">x</div>`,
    css: `.a:not([id) { color: red } @supports selector([id) { .a { color: blue } } .a p { margin: 0 }`,
  },
  {
    name: "empty container-name and stray &",
    html: `<div class="a">x<p>y</p></div>`,
    css: `.a { container-name: ; } & p { color: red } .a { &:hover { } & { } }`,
  },
  {
    name: "@media with a dangling comma",
    html: `<div class="a">x</div>`,
    css: `@media screen, { .a { color: red } } @media , print { .a p { margin: 0 } }`,
  },
  {
    name: "malformed custom properties in style attributes",
    html: `<div class="a" style="--: 1; color: var(--); --a: ; margin: var(--a">x</div>`,
    css: `.a { --a: 1px; margin: var(--a) }`,
  },
  {
    name: "typo'd compound selectors and unterminated strings in scripts",
    html: `<div class="a b" id="root">x</div>
<script>document.querySelector(".a."); document.querySelector("..a"); document.querySelector(".a..b"); if (count<max && ok) { el.id = "root; }</script>`,
    css: `.a.b { color: red }`,
  },
];

const ids = ["1a2b3c4d", "00000000", "ffffffff", "deadbeef", "a1b2c3d4"];

const setConfig = (identifiers: boolean, deduplicateCss: boolean): void => {
  (BascikConfig.minify as { identifiers: boolean }).identifiers = identifiers;
  (BascikConfig.scoping as { deduplicateCss: boolean }).deduplicateCss =
    deduplicateCss;
};

const componentFor = (test: Case, perInstance: boolean): BascikComponent => ({
  name: "my-card",
  fileName: "/project/src/components/my-card/my-card.html",
  fileContent: perInstance
    ? `${PER_INSTANCE}<div class="glow-user">g</div>${test.html}`
    : test.html,
  ...(test.css === undefined && !perInstance
    ? {}
    : {
        cssFileContent: perInstance
          ? `${PER_INSTANCE_CSS} ${test.css ?? ""}`
          : test.css,
      }),
});

const real = (input: BascikComponent, instanceId: string) =>
  internals.snapshotResult(runScopingPipeline({ ...input }, instanceId));

/** The recorder's template for `input` on instance `first`, or null when it refuses. */
const templateFor = (input: BascikComponent, first: string) => {
  const recorded = recordScopingRun({ ...input }, first);
  if (!recorded.clean) return null;
  return buildScopingTemplate(
    internals.inputTexts(input),
    first,
    recorded.calls,
    internals.snapshotResult(recorded.component),
  );
};

const configs = [
  [false, true],
  [true, true],
  [false, false],
  [true, false],
] as const;

// Plans a CSS @import (file system access), which the recorder never reuses.
const REFUSED = new Set(["@import with layer()"]);

describe("scoping templates replay the October 2026 adversarial inputs exactly", () => {
  // Set here too, so the check holds when the file runs outside the unit
  // project's env; restored afterwards rather than deleted.
  const previousVerify = process.env.BASCIK_VERIFY_SCOPING_TEMPLATES;
  beforeEach(() => {
    clearScopingTemplates();
    stats.reset();
    process.env.BASCIK_VERIFY_SCOPING_TEMPLATES = "1";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (previousVerify === undefined)
      delete process.env.BASCIK_VERIFY_SCOPING_TEMPLATES;
    else process.env.BASCIK_VERIFY_SCOPING_TEMPLATES = previousVerify;
    vi.restoreAllMocks();
  });

  for (const [identifiers, deduplicateCss] of configs) {
    for (const perInstance of [false, true]) {
      const label = `identifiers ${identifiers}, deduplicateCss ${deduplicateCss}, per-instance CSS ${perInstance}`;
      for (const test of [...cases, ...misuseCases]) {
        it(`${test.name}: replayed instances equal a fresh scoping (${label})`, () => {
          setConfig(identifiers, deduplicateCss);
          const input = componentFor(test, perInstance);
          const template = templateFor(input, ids[0]);
          if (REFUSED.has(test.name)) {
            expect(template).toBeNull();
            return;
          }
          // Not vacuous: every other construct is recorded as a template.
          expect(template).not.toBeNull();
          if (perInstance)
            expect(real(input, ids[0]).requiresPerInstanceCss).toBe(true);
          for (const next of ids.slice(1)) {
            const predicted = instantiateScopingTemplate(
              template!,
              next,
              internals.inputTexts(input),
            );
            expect(predicted, `instance ${next}`).not.toBeNull();
            expect(predicted, `instance ${next}`).toEqual(real(input, next));
          }
        });

        it(`${test.name}: scopeComponentInstance reuses the template under BASCIK_VERIFY_SCOPING_TEMPLATES=1 (${label})`, () => {
          setConfig(identifiers, deduplicateCss);
          const input = componentFor(test, perInstance);
          // Recorded, verified twice, then reused: each reuse is recomputed
          // with the real pipeline and throws on any difference.
          for (const id of ids)
            expect(
              internals.snapshotResult(
                scopeComponentInstance({ ...input }, id),
              ),
              `instance ${id}`,
            ).toEqual(real(input, id));
          expect(stats.reused).toBe(REFUSED.has(test.name) ? 0 : 2);
        });
      }
    }
  }

  it("random combinations of the adversarial constructs replay exactly", () => {
    const hex = "0123456789abcdef".split("");
    const instanceId = fc.oneof(
      fc.string({ unit: fc.constantFrom(...hex), minLength: 8, maxLength: 8 }),
      fc.constantFrom(...ids),
    );
    const replayable = [...cases, ...misuseCases].filter(
      (test) => !REFUSED.has(test.name),
    );
    let reusable = 0;
    let runs = 0;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...replayable), {
          minLength: 2,
          maxLength: 5,
        }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        instanceId,
        instanceId,
        (picked, identifiers, deduplicateCss, perInstance, first, next) => {
          fc.pre(first !== next);
          runs++;
          setConfig(identifiers, deduplicateCss);
          const input = componentFor(
            {
              name: "combined",
              html: picked.map((test) => test.html).join("\n"),
              css: picked.map((test) => test.css ?? "").join("\n"),
            },
            perInstance,
          );
          const template = templateFor(input, first);
          if (!template) return;
          const predicted = instantiateScopingTemplate(
            template,
            next,
            internals.inputTexts(input),
          );
          if (!predicted) return;
          reusable++;
          expect(predicted).toEqual(real(input, next));
        },
      ),
      { numRuns: Number(process.env.SCOPING_PROPERTY_RUNS ?? 200) },
    );
    expect(reusable).toBeGreaterThan(runs * 0.8);
  });
});
