import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import fc from "fast-check";
import type { ComponentList } from "../src/lib/types.ts";

export const FUZZ_TARGETS = [
  "expansion",
  "props",
  "slots",
  "tags",
  "masking",
  "javascript",
] as const;
type FuzzTarget = (typeof FUZZ_TARGETS)[number];

export interface FuzzInput {
  html: string;
  components: ComponentList;
  props: Record<string, string>;
  searchFrom: number;
  javascript: string;
}

export type CompilerProbe = Record<FuzzTarget, (input: FuzzInput) => unknown>;

interface FuzzOptions {
  runs: number;
  seed: number;
  targets: readonly FuzzTarget[];
  path?: string;
}

interface FuzzResult {
  target: FuzzTarget;
  failed: boolean;
  runs: number;
  seed: number;
  path: string;
  counterexample: FuzzInput | null;
  error: string | null;
}

const fragments = fc.constantFrom(
  "text",
  "<",
  "<<",
  ">",
  "=",
  "$1",
  "$&",
  "$`",
  "$'",
  "\r\n",
  "\u00a0",
  '<my-card data-bascik-prop-title="$1">body</my-card>',
  '<MY-CARD title="<my-card>"><my-card-x/></MY-CARD>',
  '<my-card><div data-bascik-slot="head">header</div><b>body</b></my-card>',
  '<my-card><my-card-x><div data-bascik-slot="head">child</div></my-card-x></my-card>',
  '<div title="<my-card></my-card>">quoted</div>',
  "<div title='</my-card>'>single</div>",
  "<div title=<my-card>unquoted</div>",
  '<my-card title="unterminated',
  "<p Data-Bascik-Prop-title>fallback</p>",
  "<p data-bascik-prop-title>fallback</p>",
  '<my-card-x data-bascik-prop-title="a>b=c"/>',
  "<div data-bascik-slot>default</div>",
  '<div data-bascik-slot="head">named</div>',
  '<x:y><div data-bascik-slot="head">qualified</div></x>',
  "<!-- <my-card></my-card> -->",
  "<!--",
  "-->",
  '<script>"<my-card></my-card>"</script>',
  '<style>.x::after{content:"<my-card>"}</style>',
  "<textarea><my-card></my-card></textarea>",
  "<script>",
  "</script>",
  "<style>",
  "</style>",
  "<textarea>",
  "</textarea>",
);

const inputArbitrary = fc
  .record({
    html: fc.array(fragments, { maxLength: 12 }).map((parts) => parts.join("")),
    template: fc.constantFrom(
      '<article class="card"><h2 data-bascik-prop-title></h2><div data-bascik-slot></div></article>',
      "<p DATA-BASCIK-PROP-TITLE>fallback</p>",
      '<header data-bascik-slot="head">fallback</header><main data-bascik-slot></main>',
      '<div id="target"><my-card-x></my-card-x><script>document.getElementById("target")</script></div>',
      "<div><!-- <my-card> --><textarea><my-card></textarea></div>",
      "<span>$1 $& $` $'</span>",
    ),
    props: fc.dictionary(
      fc.constantFrom("title", "head", "missing"),
      fc.constantFrom("", "hello", "$1", "$&", "$`", "$'", '<b>"&</b>'),
    ),
    searchFrom: fc.nat({ max: 2000 }),
    javascript: fc
      .array(
        fc.constantFrom(
          'const value = "literal";',
          "value++\nnext()",
          "value / 2",
          "// comment\n",
          "/* comment */",
          "if (value)\nnext()",
          "return\n",
          "/[a/b]+/g",
          "`a${value}`",
          "$1",
          "$&",
          " + + ",
          " - - ",
          "\u00a0",
          "\u2028",
          "\ufeff",
          "\r\n",
        ),
        { maxLength: 25 },
      )
      .map((parts) => parts.join("")),
  })
  .map(({ template, ...input }): FuzzInput => ({
    ...input,
    searchFrom: input.searchFrom % (input.html.length + 1),
    components: {
      "my-card": {
        fileContent: template,
        cssFileContent: ".card{color:red}#target{color:blue}",
      },
      "my-card-x": { fileContent: "<span data-bascik-prop-title>badge</span>" },
      "x:y": { fileContent: "<aside data-bascik-slot></aside>" },
    },
  }));

const capture = (action: () => unknown): unknown => {
  try {
    return { value: action() };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "ThrownValue",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export function runDifferentialFuzz(
  baseline: CompilerProbe,
  candidate: CompilerProbe,
  options: FuzzOptions,
): FuzzResult[] {
  return options.targets.map((target) => {
    const result = fc.check(
      fc.property(inputArbitrary, (input) => {
        const expected = capture(() =>
          baseline[target](structuredClone(input)),
        );
        for (let repeat = 0; repeat < 2; repeat++) {
          const actual = capture(() =>
            candidate[target](structuredClone(input)),
          );
          assert.deepStrictEqual(actual, expected);
        }
      }),
      { numRuns: options.runs, seed: options.seed, path: options.path },
    );
    return {
      target,
      failed: result.failed,
      runs: result.numRuns,
      seed: result.seed,
      path: result.counterexamplePath ?? "",
      counterexample: result.counterexample?.[0] ?? null,
      error:
        result.errorInstance == null
          ? null
          : result.errorInstance instanceof Error
            ? result.errorInstance.message
            : String(result.errorInstance),
    };
  });
}

export function parseFuzzArguments(args: string[]): FuzzOptions & {
  baseline: string;
  candidate: string;
} {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      baseline: { type: "string" },
      candidate: {
        type: "string",
        default: fileURLToPath(new URL("../", import.meta.url)),
      },
      runs: { type: "string", default: "2000" },
      seed: { type: "string", default: "31337" },
      targets: { type: "string", default: FUZZ_TARGETS.join(",") },
      path: { type: "string" },
    },
  });
  assert(values.baseline, "--baseline <built pkg directory> is required");
  const runs = Number(values.runs);
  const seed = Number(values.seed);
  assert(
    Number.isSafeInteger(runs) && runs > 0 && runs <= 1_000_000,
    "runs must be 1..1000000",
  );
  assert(
    Number.isInteger(seed) && seed >= -(2 ** 31) && seed < 2 ** 31,
    "seed must be a signed 32-bit integer",
  );
  const targets = values.targets!.split(",");
  assert(
    targets.every((target) => FUZZ_TARGETS.some((known) => known === target)),
    "unknown target",
  );
  assert(new Set(targets).size === targets.length, "targets must be unique");
  assert(
    values.path === undefined || targets.length === 1,
    "--path requires exactly one target",
  );
  return {
    baseline: resolve(values.baseline),
    candidate: resolve(values.candidate!),
    runs,
    seed,
    targets: targets as FuzzTarget[],
    path: values.path,
  };
}

async function loadCompilerProbe(root: string): Promise<CompilerProbe> {
  const load = (name: string) =>
    import(pathToFileURL(join(root, "dist/lib", `${name}.js`)).href);
  const components: typeof import("../src/lib/components.ts") =
    await load("components");
  const processing: typeof import("../src/lib/processing.ts") =
    await load("processing");
  const javascript: typeof import("../src/lib/js-minifier.ts") =
    await load("js-minifier");
  return {
    expansion: ({ html, components: list }) => {
      const result = processing.recursivelyTranspile(
        html,
        list,
        [],
        "src/pages/fuzz.html",
      );
      return {
        html: result.transpiledHtmlBody,
        names: result.usedComponents.map(({ name }) => name),
      };
    },
    props: ({ html, props }) => ({
      extracted: components.extractProps(html),
      attributes: components.injectPropAttributes(html, props),
      receivers: components.injectProps(html, props),
    }),
    slots: ({ html, components: list }) => {
      const names = new Set(Object.keys(list));
      return {
        default: components.extractDefaultSlotContent(html, names),
        named: components.extractNamedSlotContent(html, names),
        filled: components.replaceNamedSlots(html, { head: "$1 $&" }, names),
        filledDefault: components.replaceDefaultSlots(html, "$1 $&"),
      };
    },
    tags: ({ html, components: list, searchFrom }) => {
      const tag = components.getTag(
        html,
        "my-card",
        list,
        undefined,
        searchFrom,
      );
      const first = components.getFirstComponent(
        html,
        list,
        undefined,
        searchFrom,
      );
      const offsets = (match: typeof tag) => [
        match.startIndex,
        match.endIndex,
        match.contentStart,
        match.closeIndex,
      ];
      return {
        tag,
        offsets: offsets(tag),
        first,
        firstOffsets: offsets(first),
      };
    },
    masking: ({ html }) => components.maskRawTextContent(html),
    javascript: ({ javascript: code }) => javascript.minifyJs(code),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseFuzzArguments(process.argv.slice(2));
  const cwd = process.cwd();
  const argv = process.argv;
  const directory = await mkdtemp(join(tmpdir(), "bascik-compiler-fuzz-"));
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  try {
    process.chdir(directory);
    process.argv = argv.slice(0, 2);
    console.log = console.warn = console.error = () => {};
    const baseline = await loadCompilerProbe(options.baseline);
    const candidate = await loadCompilerProbe(options.candidate);
    const results = runDifferentialFuzz(baseline, candidate, options);
    originalConsole.log(
      JSON.stringify(
        { baseline: options.baseline, candidate: options.candidate, results },
        null,
        2,
      ),
    );
    if (results.some(({ failed }) => failed)) process.exitCode = 1;
  } finally {
    Object.assign(console, originalConsole);
    process.chdir(cwd);
    process.argv = argv;
    await rm(directory, { recursive: true, force: true });
  }
}
