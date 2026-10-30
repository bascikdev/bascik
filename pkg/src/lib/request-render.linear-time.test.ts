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
import { ComponentExpansionLimitError } from "./component-expansion-core.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { getAttributeNameHash } from "./names.ts";
import {
  type ExecutionPlan,
  type ExecutionSegment,
  type ScriptJobRunner,
} from "./request-execution.ts";
import {
  __requestRenderStatsForTests,
  expandByUsage,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectCostRatio,
  expectLinearTime,
  expectLinearTimeAsync,
  measureCostRatio,
  spliceCopies,
  type CalibratedRatio,
  repeatTo,
} from "./linear-time.test-helper.ts";
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

const HTTP_PATH = "/catalog";

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

    // A script output can echo visitor text, so locating its usages and
    // masking it must stay linear in its size. Before: the span loop paired
    // each unclosed opener by walking to the end of the output (about 29 s
    // at 160k characters), and a quoted value holding many `<!--` rescanned
    // to its far closing quote from every one of them (about 3.5 s at 400k
    // and 14 s at 800k). Each check times the output and a quarter of it and
    // requires the time to grow linearly (linear-time.test-helper.ts); its
    // ceiling is far below the old times.
    const HOSTILE_SIZE = 200_000;
    const fill = (unit: string, size = HOSTILE_SIZE): string =>
      repeatTo(unit, size);
    const requestLimits = {
      maxSubstitutions: 1000,
      maxOutputBytes: 64 * 1024 * 1024,
    };
    const expand = (html: string): string => {
      clearScopingTemplates();
      const opts = { ...buildOptions(freshState()), limits: requestLimits };
      try {
        return expandByUsage(html, cards(), opts);
      } catch (error) {
        if (!(error instanceof ComponentExpansionLimitError)) throw error;
        return "limit";
      }
    };

    // Both sizes reach the substitution limit, and its 1000 substitutions
    // cost more than locating the rest of the usages: read alone, the
    // growth of a quadratic locate hid under that fixed cost (1.3 to 1.9).
    // So each output is the usages that reach the limit, then `size`
    // characters more of the same, and the growth is taken over the first
    // part alone (the baseline): it is the growth of the part that varies.
    const BASE_USAGES = requestLimits.maxSubstitutions + 1;
    // The part that varies, about twice the fixed cost at a quarter of it.
    // At 800k it was only as large, and under coverage on CI the fixed cost
    // was three times the part that varies: noise on that small part read
    // as a growth of 16.
    const VARYING_SIZE = 1_600_000;
    it.each([
      [
        "unclosed openers, one closer at the end",
        "<bare-card>",
        (text: string) => `${text}</bare-card>`,
      ],
      [
        "an opener, unclosed openers, one closer",
        "<bare-card>",
        (text: string) => `<bare-card>${text}</bare-card>`,
      ],
      [
        "unclosed openers of another name",
        "<plain-card>",
        (text: string) => `${text}</plain-card>`,
      ],
      [
        "closers only inside attribute values",
        `<bare-card a="</bare-card>">`,
        (text: string) => text,
      ],
    ])(
      "locates the usages of %s in linear time",
      (_name, unit, around) => {
        const html = (size: number) =>
          around(unit.repeat(BASE_USAGES) + fill(unit, size));
        const baseline = html(0);
        expect(expand(html(VARYING_SIZE))).toBe("limit");
        expect(expand(baseline)).toBe("limit");
        // Linear growth over the baseline is the bound; one full-size run
        // under coverage on CI takes 2.2 to 2.5 s, over the default ceiling.
        expectLinearTime(html, VARYING_SIZE, expand, {
          baseline,
          ceilingMs: 10_000,
        });
      },
      2 * LINEAR_TIME_TIMEOUT_MS,
    );

    // A usage whose slot opens many nested usages, each after a lone `<`:
    // the loop re-masked the whole instance after every one of up to 1000
    // nested instances (about 10 s at 200k characters, 48 s at 1M). Both
    // sizes reach the instance limit, so that cost is linear in the output
    // too, and growth cannot see it. What fails it is the cost against the
    // copying the substitutions do anyway, one splice of the fragment each
    // (`spliceCopies`): the highest of four runs on an M-series Mac, with and
    // without coverage, is the calibration; a re-mask per instance costs
    // tens of times it. The growth, over the usages that reach the limit
    // (as above), still fails a pass quadratic in the output.
    const NESTED_COST: CalibratedRatio = { plain: 2.06, coverage: 3.58 };
    it.each([
      ["after a lone <", "<bare-card><"],
      ["after <<", "<bare-card><<"],
    ])(
      "expands nested usages %s without re-masking the instance each time",
      (name, unit) => {
        const html = (size: number) =>
          `<server-card>${unit.repeat(BASE_USAGES)}${fill(unit, size)}</server-card>`;
        const full = html(HOSTILE_SIZE);
        expect(expand(full)).toBe("limit");
        expectLinearTime(html, HOSTILE_SIZE, expand, { baseline: html(0) });
        expectCostRatio(
          measureCostRatio(
            () => expand(full),
            () => spliceCopies(full, requestLimits.maxSubstitutions),
          ),
          NESTED_COST,
          name,
        );
      },
      LINEAR_TIME_TIMEOUT_MS,
    );

    // At 1M characters: V8 searches for the far quote fast enough that the
    // quadratic scan is only a few times slower than a linear one at 200k.
    const COMMENT_OPENERS = 250_000;
    const comments = (count: number) => "<!--".repeat(count);
    it.each([
      [
        "a prop value",
        (count: number) =>
          `<bare-card data-bascik-prop-t="${comments(count)}">x</bare-card>`,
        // A prop value is text in the instance.
        `>${comments(COMMENT_OPENERS).replaceAll("<", "&lt;")}</p>`,
      ],
      [
        "slot content",
        (count: number) =>
          `<server-card><b title="${comments(count)}">x</b></server-card>`,
        `"${comments(COMMENT_OPENERS)}"`,
      ],
      [
        "text after a usage",
        (count: number) =>
          `<bare-card></bare-card><b title="${comments(count)}">`,
        `"${comments(COMMENT_OPENERS)}"`,
      ],
    ])(
      "masks a quoted value full of comment openers in %s in linear time",
      (_name, html, kept) => {
        expect(expand(html(COMMENT_OPENERS))).toContain(kept);
        // About 0.7 s of CPU under coverage at 1M characters: growth guards
        // this one, the ceiling only catches what takes seconds.
        expectLinearTime(html, COMMENT_OPENERS, expand, { ceilingMs: 5000 });
      },
      LINEAR_TIME_TIMEOUT_MS,
    );
  },
);

// 31
describe("scaling (identifiers off)", () => {
  beforeEach(() => {
    config.minify.identifiers = false;
  });

  it(
    "a 2 MiB output with 4000 named-slot wrappers, 16000 unclosed opens and 1000 instances renders in linear time",
    async () => {
      const manifest = await build();
      const host = makeHost(manifest);
      // Four named-slot wrappers per usage, each holding four unclosed <i>
      // opens, padded so the whole output is `target` characters.
      const skeleton = (pad: string) =>
        `<slots-card>` +
        ["a", "b", "c", "d"]
          .map(
            (slot) =>
              `<div data-bascik-slot="${slot}"><i><i><i><i>${pad}</div>`,
          )
          .join("") +
        `</slots-card>`;
      const outputOf = (instances: number, target: number) => {
        const bare = skeleton("").length;
        const padPerSlot = Math.ceil((target / instances - bare) / 4);
        return skeleton("p".repeat(padPerSlot)).repeat(instances);
      };
      const render = (html: string) =>
        wrapRunner(
          runnerFrom({ a: html }),
          serverPlan("a"),
          host,
        )("a", signalOf());

      const MiB2 = 2 * 1024 * 1024;
      // 1000 instances at 2 MiB, 250 at a quarter of it.
      const output = (size: number) => outputOf(1000 * (size / MiB2), size);
      const full = output(MiB2);
      expect(full.length).toBeGreaterThanOrEqual(MiB2);
      expect(count(full, "data-bascik-slot=")).toBe(4000);
      expect(count(full, "<i>")).toBe(16000);

      const out = await render(full);
      expect(count(out, `class="bascik__slots-card__s"`)).toBe(1000);
      expect(out).not.toContain("<slots-card");
      expect(count(out, "<style>")).toBe(1);

      // A wall-clock bound alone flakes on shared CI runners (591 ms against a
      // 500 ms bound once), so the test measures how time grows instead
      // (linear-time.test-helper.ts): linear work roughly quadruples from the
      // quarter-size render to the full one, while the quadratic passes this
      // guards against grew about 16 times. Catastrophic regressions (seconds
      // per request) still fail outright on the ceiling.
      await expectLinearTimeAsync(output, MiB2, render, { ceilingMs: 5000 });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("hostile echoed output stays linear (identifiers off)", () => {
  // Script output can echo visitor text (`?q=`), and every request renders
  // it, so a pass that is quadratic in the output is a per-request denial of
  // service. Measured before the fix at 100k characters: rebasing a slot of
  // `<a x` repeated with one quote after it took about 6 s, `<style '` about
  // 1.8 s, and finding nested-job markers in `<script '` repeated about 1.6 s.
  const SIZE = 200_000;

  beforeEach(() => {
    config.minify.identifiers = false;
  });

  it.each([
    ["<a x", "'"],
    ["<style '", ""],
    ["<STYLE a='>' ", ""],
    ['<a href="/x" ', ""],
  ])(
    'base "/docs/": a slot of %j repeated (then %j) renders in linear time',
    async (unit, tail) => {
      config.base = "/docs/";
      const manifest = await build();
      config.base = "/";
      const host = makeHost(manifest);
      const html = (size: number) =>
        `<server-card data-bascik-prop-name="n">${repeatTo(unit, size)}${tail}</server-card>`;
      const render = (output: string) =>
        wrapRunner(
          runnerFrom({ a: output }),
          serverPlan("a"),
          host,
        )("a", signalOf());
      const out = await render(html(SIZE));
      await expectLinearTimeAsync(html, SIZE, render);
      expect(out).not.toContain("<server-card");
      expect(out).toContain('href="/docs/default"');
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each([
    ["<script '", ""],
    ["<script x", ""],
    ["<SCRIPT a='>' ", ""],
    // Every opener's attributes run to the one `>`; what follows it is read once.
    ["<script x", ">"],
  ])(
    "nested-job markers are found in linear time next to %j repeated (then %j)",
    async (unit, tail) => {
      const manifest = await build();
      const host = makeHost(manifest, {
        runComponentJob: vi.fn(async () => "<b>nested</b>"),
      });
      // With a `>` tail, as many spaces after it as there are characters of
      // openers before it.
      const html = (size: number) =>
        `<srv-card></srv-card>${repeatTo(unit, size)}${tail}${tail ? " ".repeat(size) : ""}`;
      const render = (output: string) =>
        wrapRunner(
          runnerFrom({ a: output }),
          serverPlan("a"),
          host,
        )("a", signalOf());
      await expectLinearTimeAsync(html, SIZE, render);
      host.runComponentJob.mockClear();
      const out = await render(html(SIZE));
      expect(host.runComponentJob).toHaveBeenCalledTimes(1);
      expect(out).toContain("<b>nested</b>");
      expect(out).not.toContain("bascik-job");
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
