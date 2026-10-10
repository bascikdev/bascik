import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildScopingTemplate,
  instantiateScopingTemplate,
  recordScopingRun,
  runScopingPipeline,
  __scopingTemplateInternalsForTests as internals,
} from "./scoping-template.ts";
import type { BascikComponent } from "./types.ts";

// The scoping pipeline must treat generated names as opaque tokens: renaming
// the instance-dependent names of one instance's output must give exactly the
// real output of another instance. These tests check that property on the real
// pipeline; scoping-template.ts relies on it to reuse results.

const setConfig = (identifiers: boolean, deduplicateCss: boolean): void => {
  (BascikConfig.minify as { identifiers: boolean }).identifiers = identifiers;
  (BascikConfig.scoping as { deduplicateCss: boolean }).deduplicateCss = deduplicateCss;
};

const copy = (component: BascikComponent): BascikComponent => ({ ...component });

/** Predict instance `next` from a recorded run of `first`; null when not reusable. */
const predict = (input: BascikComponent, first: string, next: string) => {
  const recorded = recordScopingRun(copy(input), first);
  if (!recorded.clean) return { template: null, predicted: null };
  const template = buildScopingTemplate(
    internals.inputTexts(input),
    first,
    recorded.calls,
    internals.snapshotResult(recorded.component),
  );
  if (!template) return { template: null, predicted: null };
  return { template, predicted: instantiateScopingTemplate(template, next, internals.inputTexts(input)) };
};

const real = (input: BascikComponent, instanceId: string) =>
  internals.snapshotResult(runScopingPipeline(copy(input), instanceId));

// Short values on purpose: single letters and common words appear inside
// hashed names and instance IDs, so substring-sensitive checks get exercised.
const value = fc.constantFrom("a", "b", "f", "x1", "btn", "lang", "root", "c-d", "el", "id", "p", "ab12", "bascik");

const htmlFragment = fc.oneof(
  fc.tuple(value, value, value).map(([a, b, c]) => `<div id="${a}" class="${b} ${c}">`),
  fc.constant("</div>"),
  fc.tuple(value, value).map(([a, b]) => `<input name="${a}" id="${b}">`),
  value.map((a) => `<label for="${a}">L</label>`),
  fc.tuple(value, value).map(([a, b]) => `<span aria-labelledby="${a} ${b}" aria-describedby="${a}">s</span>`),
  value.map((a) => `<a href="#${a}">link</a>`),
  value.map((a) => `<img usemap="#${a}" alt=""><map name="${a}"></map>`),
  fc.constant(`<meta name="viewport" content="width=device-width">`),
  value.map((a) => `<code class="${a}">c</code>`),
  value.map((a) => `<pre data-bascik-preserve="class"><span class="${a}">k</span></pre>`),
  value.map((a) => `<p class="${a}">t</p>`),
  value.map((a) => `<!-- note id="${a}" class="${a}" -->`),
  value.map((a) => `<svg><use href="#${a}"></use></svg>`),
  fc.tuple(value, value).map(([a, b]) => `<button popovertarget="${a}" commandfor="${b}">b</button>`),
  fc.tuple(value, value).map(([a, b]) =>
    `<script>const r = document.getElementById("${a}"); document.querySelector("#${a} .${b}"); ` +
    `r.classList.add("${b}", "${a}"); r.classList.toggle("${b}", true); r.classList.contains("${a}"); ` +
    `r.setAttribute("id", "${a}"); document.getElementsByName("${b}"); r.className = "${a} ${b}"; ` +
    `r.closest(".${b}"); document.getElementsByClassName("${a}");</script>`),
  value.map((a) => `<script type="module">document.querySelector(".${a}")?.remove();</script>`),
  value.map((a) => `<script type="application/ld+json">{"id": "${a}"}</script>`),
  value.map((a) => `<script data-bascik-build="page">export default () => "<p class='${a}'>x</p>";</script>`),
  fc.tuple(value, value).map(([a, b]) =>
    `<style>#${a} { color: red } .${b} > p { margin: 0 } @keyframes ${b} { from { opacity: 0 } } ` +
    `.${a} { animation: ${b} 1s; --${a}: 1; color: var(--${a}); } [id] { color: blue } .${b} { color: #abcdef12 }</style>`),
  value.map((a) => `<textarea class="${a}">raw <b id="${a}"></b></textarea>`),
  fc.tuple(value, value).map(([a, b]) => `<input list="${a}" form="${b}"><datalist id="${a}"></datalist><form id="${b}"></form>`),
  fc.tuple(value, value).map(([a, b]) => `<table><tr><th id="${a}">h</th><td headers="${a} ${b}">d</td></tr></table>`),
  value.map((a) => `<div style="clip-path: url(#${a}); color: red" class="${a}">s</div>`),
  value.map((a) => `<svg><use xlink:href="#${a}"></use><linearGradient id="${a}"></linearGradient><rect fill="url(#${a})"/></svg>`),
  value.map((a) => `<template><p id="${a}" class="${a}">t</p></template><slot name="${a}"></slot>`),
  value.map((a) => `<pre><code class="${a}" id="${a}">x</code></pre>`),
  fc.tuple(value, value).map(([a, b]) => `<script>el.className += " ${a}"; el.classList.replace("${a}", "${b}");</script>`),
  fc.tuple(value, value).map(([a, b]) =>
    `<style>:has(#${a}) { color: red } #${a}:hover .${b} {} [id="${a}"] { color: blue } @property --${a} { syntax: '*'; inherits: false; }</style>`),
);

const cssFile = fc.option(
  fc.array(
    fc.oneof(
      value.map((a) => `.${a} { color: red; }`),
      value.map((a) => `#${a} { color: blue; }`),
      fc.constant("p { margin: 0; } div > span { padding: 1px; }"),
      value.map((a) => `@keyframes ${a} { to { opacity: 1; } } .${a} { animation: ${a} 2s; }`),
      value.map((a) => `@layer ${a} { .${a} { color: green; } }`),
      value.map((a) => `.${a} { container-name: ${a}; anchor-name: --${a}; view-transition-name: ${a}; }`),
      value.map((a) => `:root { --${a}: 2px; } .${a} { width: var(--${a}); }`),
      value.map((a) => `.${a}::after { content: "#${a} .${a}"; background: url(./${a}.png); }`),
      fc.tuple(value, value).map(([a, b]) =>
        `@counter-style ${a} { system: cyclic; symbols: x; } ol { list-style: ${a}; } li::before { content: counter(i, ${a}) counters(i, ".", ${b}); }`),
      fc.tuple(value, value).map(([a, b]) => `.${a} { position-anchor: --${b}; } @position-try --${b} { top: 0; } .${b} { anchor-name: --${b}; }`),
      value.map((a) => `.${a} { filter: url(#${a}); } @container ${a} (min-width: 1px) { .${a} { color: red } }`),
      value.map((a) => `::view-transition-old(${a}) { opacity: 0 } .${a} { view-transition-name: ${a}; }`),
    ),
    { maxLength: 6 },
  ).map((rules) => rules.join("\n")),
  { nil: undefined },
);

const componentArb = fc.record({
  name: fc.constantFrom("my-card", "code-block", "x-a", "nav-bar"),
  fileContent: fc.array(htmlFragment, { minLength: 1, maxLength: 10 }).map((parts) => parts.join("\n")),
  cssFileContent: cssFile,
}).map(({ name, fileContent, cssFileContent }): BascikComponent => ({
  name,
  fileName: `/project/src/components/${name}/${name}.html`,
  fileContent,
  ...(cssFileContent === undefined ? {} : { cssFileContent }),
}));

const hex = "0123456789abcdef".split("");
const instanceIdArb = fc.oneof(
  fc.string({ unit: fc.constantFrom(...hex), minLength: 8, maxLength: 8 }),
  fc.constantFrom("00000000", "aaaaaaaa", "abcdef12", "ab12ab12", "ffffffff", "0a0a0a0a", "deadbeef"),
);

describe("scoping pipeline treats generated names as opaque tokens", () => {
  for (const identifiers of [false, true]) {
    for (const deduplicateCss of [true, false]) {
      it(`renaming predicts the real output (identifiers ${identifiers}, deduplicateCss ${deduplicateCss})`, () => {
        setConfig(identifiers, deduplicateCss);
        let reusable = 0;
        let runs = 0;
        fc.assert(
          fc.property(componentArb, instanceIdArb, instanceIdArb, (input, first, next) => {
            fc.pre(first !== next);
            runs++;
            const { predicted } = predict(input, first, next);
            if (!predicted) return;
            reusable++;
            expect(predicted).toEqual(real(input, next));
          }),
          // SCOPING_PROPERTY_RUNS raises the search depth for local deep runs.
          { numRuns: Number(process.env.SCOPING_PROPERTY_RUNS ?? 400) },
        );
        // The property must not hold vacuously.
        expect(reusable).toBeGreaterThan(runs * 0.5);
      });
    }
  }

  it("predicts IDs whose names contain the component's own short tokens", () => {
    setConfig(true, true);
    const input: BascikComponent = {
      name: "my-card",
      fileName: "/project/src/components/my-card/my-card.html",
      fileContent: `<div id="a"><label for="a">x</label><span class="b" aria-labelledby="a">y</span></div>
<script>document.getElementById("a").classList.add("b");</script>
<style>#a { color: red } .b { color: blue }</style>`,
      cssFileContent: "#a .b { margin: 0 }",
    };
    // Search for instance IDs whose scoped id hash contains "a" and "b": the
    // authored values then occur inside generated names.
    const ids: string[] = [];
    for (let n = 0; ids.length < 6 && n < 5000; n++) {
      const id = n.toString(16).padStart(8, "0");
      const scoped = real(input, id).fileContent;
      const name = /id="([^"]+)"/.exec(scoped)?.[1] ?? "";
      if (name.includes("a") && name.includes("b")) ids.push(id);
    }
    expect(ids.length).toBe(6);
    for (const next of ids.slice(1)) {
      const { predicted } = predict(input, ids[0], next);
      expect(predicted).not.toBeNull();
      expect(predicted).toEqual(real(input, next));
    }
  });

  it("records per-instance CSS names derived from scoped ids", () => {
    setConfig(true, true);
    // A url(#id) fragment makes the CSS per instance, so class names are
    // derived from the instance ID too.
    const input: BascikComponent = {
      name: "my-card",
      fileName: "/project/src/components/my-card/my-card.html",
      fileContent: `<svg><filter id="glow"></filter></svg><div id="panel" class="box"><style>.box { filter: url(#glow) }</style></div>`,
      cssFileContent: "#panel { margin: 0 } .box { clip-path: url(#glow) }",
    };
    const { template, predicted } = predict(input, "11111111", "22222222");
    expect(template).not.toBeNull();
    // The instance ID, two scoped ids, and names derived from the instance.
    expect(template!.tokenCount).toBeGreaterThanOrEqual(4);
    expect(predicted).toEqual(real(input, "22222222"));
    expect(real(input, "22222222").requiresPerInstanceCss).toBe(true);
  });
});

// Every real component in the repository, predicted for several instance IDs.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const componentFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".html"))
    .map((path) => join(dir, path));
};
const corpus = [
  ...componentFiles(join(repositoryRoot, "docs/src/components")),
  ...componentFiles(join(repositoryRoot, "pkg/e2e/src/components")),
];

describe("scoping templates on the repository's components", () => {
  it("finds the component corpus", () => {
    expect(corpus.length).toBeGreaterThan(50);
  });

  for (const identifiers of [false, true]) {
    it(`predicts every reusable component exactly (identifiers ${identifiers})`, () => {
      setConfig(identifiers, true);
      const ids = ["3f2a9c01", "00000000", "ffffffff", "a1b2c3d4", "deadbeef", "0badf00d"];
      let reusable = 0;
      for (const htmlPath of corpus) {
        const cssPath = htmlPath.replace(/\.html$/, ".css");
        const name = htmlPath.replace(/\\/g, "/").split("/").pop()!.replace(/\.html$/, "");
        const input: BascikComponent = {
          name,
          fileName: htmlPath,
          fileContent: readFileSync(htmlPath, "utf8"),
          ...(existsSync(cssPath) ? { cssFileContent: readFileSync(cssPath, "utf8") } : {}),
        };
        const recorded = recordScopingRun(copy(input), ids[0]);
        if (!recorded.clean) continue;
        const template = buildScopingTemplate(
          internals.inputTexts(input), ids[0], recorded.calls, internals.snapshotResult(recorded.component),
        );
        if (!template) continue;
        reusable++;
        for (const next of ids.slice(1)) {
          const predicted = instantiateScopingTemplate(template, next, internals.inputTexts(input));
          if (!predicted) continue;
          expect(predicted, `${htmlPath} instance ${next}`).toEqual(real(input, next));
        }
      }
      expect(reusable).toBeGreaterThan(corpus.length * 0.8);
    });
  }
});
