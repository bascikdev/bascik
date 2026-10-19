# Benchmarking & Profiling

Bascik ships a repeatable benchmarking and profiling harness in `pkg/bench/` for measuring compiler throughput, verifying byte-identical output across compiler changes, and capturing CPU, event-loop, and memory profiles under realistic workloads. Nothing in `pkg/bench/` is included in the published npm package.

## Tooling Overview

| Command (from the repository root)                  | Entry point                       | Purpose                                                                               |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `yarn pkg:bench`                                    | `pkg/bench/*.bench.ts`            | Vitest throughput microbenchmarks on fixed in-memory inputs                           |
| `yarn workspace @bascik/bascik profile:compare`     | `pkg/bench/compiler-compare.ts`   | Paired baseline versus candidate compiler builds with byte-identity verification      |
| `yarn workspace @bascik/bascik profile:compiler`    | `pkg/bench/compiler-timeline.ts`  | Cold, warm, and live-edit compiler timelines on an isolated project copy              |
| `yarn workspace @bascik/bascik profile:workload`    | `pkg/bench/profile-workload.ts`   | Bounded runtime captures (HTTP/1.1, HTTP/2 with TLS, static serving, dev, and builds) |
| `node pkg/bench/profile-boundaries.ts <report-dir>` | `pkg/bench/profile-boundaries.ts` | Resource-boundary capture with optional heap allocation sampling                      |

## Throughput Microbenchmarks (`yarn pkg:bench`)

Microbenchmarks use Vitest's `bench` test-context fixture (`pkg/bench/transpile.bench.ts`) to measure isolated stages of the transpilation pipeline on fixed inputs:

- **JavaScript minification scaling**: slash-heavy and slash-light inputs from 52 KB to 437 KB to verify linear `O(n)` scaling.
- **HTML minification and tag scanning**: `minifyHtml`, `getTag`, and `replaceTag` on paired and self-closing component tags.
- **CSS scoping transforms**: `convertCssElementSelectorsToClasses`, `scopeCssCustomProperties`, and `deduplicateCss`.
- **Component expansion scaling**: `recursivelyTranspile` across 10 to 3,200 flat and nested component instances, plus sequential multi-page simulations.

Run the suite from the repository root:

```sh
yarn pkg:bench
```

Before timing begins, the benchmark suite runs oracle assertions on the output (checking expansion counts and scoped class prefixes) so a broken mock or regression fails immediately rather than recording misleading numbers.

## Private Report Directories

Every profiling and comparison command writes to an explicit `--report-dir` path. The harness enforces strict isolation rules before running any workload:

- **Outside the repository**: The path must be absolute and outside the repository and any watched, served, or cleaned output tree.
- **Private permissions**: The directory must be new or empty, owned by the current user, and created with mode `0700`.
- **No source tree pollution**: Fixtures get their own real `node_modules/.cache` directory so captures never read or mutate the repository's build-script cache or `docs/dist/`.

Create a compliant report directory on macOS or Linux with `mktemp -d`:

```sh
REPORT_DIR="$(mktemp -d /private/tmp/bascik-bench-XXXXXX)"
chmod 0700 "$REPORT_DIR"
```

## Paired Compiler Comparisons (`profile:compare`)

When optimizing the transpilation pipeline, wall-clock timings from separate runs can drift due to thermal throttling, OS disk caching, or background load. Worse, building two different project directories changes deterministic instance IDs (`deriveInstanceId` hashes absolute source paths), making emitted HTML impossible to diff byte-for-byte.

`profile:compare` solves both problems:

1. **Same-path execution**: Both compilers build the exact same private fixture path. Before each build, the fixture's `node_modules/@bascik/bascik` symlink is repointed to the compiler snapshot under test.
2. **Alternating round order**: Odd rounds run `baseline` then `candidate`; even rounds run `candidate` then `baseline`. Both cold (`.cache` cleared) and warm (`.cache` reused) states are measured every round.
3. **Byte-identical verification**: Every emitted HTML file in `dist/` is hashed and compared between baseline and candidate on every round. If any page differs by a single byte, the run stops and reports the mismatch.

### Preparing Baseline and Candidate Snapshots

Use a detached `git worktree` (never `git stash`) to build an immutable baseline snapshot from `main` or the pre-optimization commit, and copy the current working tree build as the candidate snapshot:

```sh
BENCH_ROOT="$(mktemp -d /private/tmp/bascik-compare-XXXXXX)"
chmod 0700 "$BENCH_ROOT"

# 1. Build the baseline compiler snapshot from main (or a target commit)
git worktree add --detach "$BENCH_ROOT/wt-baseline" main
ln -s "$PWD/node_modules" "$BENCH_ROOT/wt-baseline/node_modules"
node ./node_modules/typescript/bin/tsc -p "$BENCH_ROOT/wt-baseline/pkg/tsconfig.build.json"
mkdir -p "$BENCH_ROOT/compilers/baseline/pkg"
cp -R "$BENCH_ROOT/wt-baseline/pkg/dist" "$BENCH_ROOT/wt-baseline/pkg/bin" \
      "$BENCH_ROOT/wt-baseline/pkg/src" "$BENCH_ROOT/wt-baseline/pkg/package.json" \
      "$BENCH_ROOT/compilers/baseline/pkg/"
ln -s "$PWD/node_modules" "$BENCH_ROOT/compilers/baseline/pkg/node_modules"
git worktree remove --force "$BENCH_ROOT/wt-baseline"

# 2. Build and copy the candidate compiler snapshot from the current working tree
yarn pkg:build
mkdir -p "$BENCH_ROOT/compilers/candidate/pkg"
cp -R pkg/dist pkg/bin pkg/src pkg/package.json "$BENCH_ROOT/compilers/candidate/pkg/"
ln -s "$PWD/node_modules" "$BENCH_ROOT/compilers/candidate/pkg/node_modules"
```

### Benchmarking the Built-In Pipeline Fixture (`--fixture pipeline`)

For fast, focused compiler comparisons, pass `--fixture pipeline`. The harness generates a 25-page, 10-component project (1,000 component instances total) inside the report directory that exercises ID scoping, element and `#id` CSS selectors, `aria-*` and `href="#..."` ID reference rewriting, dynamic `data-bascik-attr-*` and `data-bascik-prop-*` bindings, and `data-bascik-build` scripts importing external packages:

```sh
mkdir -p "$BENCH_ROOT/report-pipeline" && chmod 0700 "$BENCH_ROOT/report-pipeline"

yarn workspace @bascik/bascik profile:compare \
  --fixture pipeline \
  --baseline "$BENCH_ROOT/compilers/baseline/pkg" \
  --candidate "$BENCH_ROOT/compilers/candidate/pkg" \
  --mode build --rounds 5 --site-url https://example.com \
  --report-dir "$BENCH_ROOT/report-pipeline"
```

### Benchmarking the `create-bascik` Starter Site

To measure a small starter project, scaffold a fresh site into `$BENCH_ROOT` and link workspace dependencies:

```sh
yarn create:build
(cd "$BENCH_ROOT" && node "$OLDPWD/create/dist/index.js" starter-site -y --no-install --no-dev)
mkdir -p "$BENCH_ROOT/starter-site/node_modules/@bascik"
for entry in "$PWD"/node_modules/* "$PWD"/node_modules/.*; do
  name="$(basename "$entry")"
  if [[ "$name" != "." && "$name" != ".." && "$name" != ".cache" && "$name" != "@bascik" ]]; then
    ln -s "$entry" "$BENCH_ROOT/starter-site/node_modules/$name"
  fi
done
ln -s "$BENCH_ROOT/compilers/baseline/pkg" "$BENCH_ROOT/starter-site/node_modules/@bascik/bascik"

mkdir -p "$BENCH_ROOT/report-starter" && chmod 0700 "$BENCH_ROOT/report-starter"
yarn workspace @bascik/bascik profile:compare \
  --project "$BENCH_ROOT/starter-site" \
  --baseline "$BENCH_ROOT/compilers/baseline/pkg" \
  --candidate "$BENCH_ROOT/compilers/candidate/pkg" \
  --mode build --rounds 5 --site-url https://example.com \
  --report-dir "$BENCH_ROOT/report-starter"
```

### Benchmarking the Full Documentation Site

To compare full multi-worker builds on the repository `docs/` site, seed a fixture via `profile:compiler` (which copies `docs/` along with sibling `examples/`, `skills/`, `CHANGELOG.md`, and coverage JSON files) and point `profile:compare` at the prepared fixture directory:

```sh
mkdir -p "$BENCH_ROOT/docs-seed" && chmod 0700 "$BENCH_ROOT/docs-seed"
yarn workspace @bascik/bascik profile:compiler \
  --tools control --modes build --rounds 1 \
  --compiler "$BENCH_ROOT/compilers/baseline/pkg" \
  --report-dir "$BENCH_ROOT/docs-seed"

mkdir -p "$BENCH_ROOT/report-docs" && chmod 0700 "$BENCH_ROOT/report-docs"
yarn workspace @bascik/bascik profile:compare \
  --project "$BENCH_ROOT/docs-seed/control-build-1/docs" \
  --baseline "$BENCH_ROOT/compilers/baseline/pkg" \
  --candidate "$BENCH_ROOT/compilers/candidate/pkg" \
  --mode build --rounds 3 --site-url https://bascik.dev \
  --report-dir "$BENCH_ROOT/report-docs"
```

### Reading `comparison.json` Metrics

Each `profile:compare` run writes `<report-dir>/comparison.json` containing:

- `byteIdentical`: `true` when every emitted HTML file across all rounds had identical SHA-256 digests between `baseline` and `candidate`.
- `summary`: `median`, `min`, `max`, and raw `samples` of `readyMs` for `baseline-cold`, `baseline-warm`, `candidate-cold`, and `candidate-warm`.
- `runs[].result.batchMs`: Wall time reported by `✓ N pages transpiled in ...`.
- `runs[].pageMs`: Array of per-page synchronous `workMs` timings logged on each `transpiled: <page> in <workMs>` line.
- `runs[].result.cpu`: Main-process `user` and `system` CPU microseconds (`process.cpuUsage()`).
- `runs[].result.operations`: Call counts and cumulative elapsed time for `readFile`, `stat`, and `readdir` on the main isolate.

## Compiler Timelines and Live-Edit Profiling (`profile:compiler`)

`profile:compiler` copies a real Bascik project (defaulting to `docs/`) into a private directory and runs `dev` or `build` modes under a chosen tool (`control`, `cpu`, `doctor`, `bubbleprof`, `heapprofiler`, `0x`, or `flame`):

```sh
REPORT_DIR="$(mktemp -d /private/tmp/bascik-timeline-XXXXXX)"
chmod 0700 "$REPORT_DIR"

# Measure dev server startup and live-reload disk publication on docs edits
yarn workspace @bascik/bascik profile:compiler \
  --tools control --modes dev --edits --seed-cache --rounds 3 \
  --report-dir "$REPORT_DIR"
```

Key flags:

- `--edits`: In `dev` mode, mutates a page (`src/pages/index.html`), a Markdown content file (`content/getting-started.md`), and a shared helper (`src/lib/md-renderer.ts`), measuring `diskMs` from the source write until both the `transpiled` event fires and the updated HTML with the edit marker reaches `dist/`.
- `--seed-cache`: Seeds the fixture's script cache from `docs/node_modules/.cache/bascik/script-cache` before the first run (`populated` followed by `warm`), isolating compiler and watcher performance from cold child-process spawns.
- `--workers true|false`: Overrides `pipeline.workers` on the docs fixture so single-isolate (`--workers false`) and worker-pool (`--workers true`) execution can be compared directly.
- `--worker-cpu auto|all|first|none|inspector`: Controls how worker threads are sampled when `--tools cpu` is selected.

## Runtime Workload Captures (`profile:workload`)

`profile:workload` benchmarks and profiles HTTP/1.1, HTTP/2 with TLS, static serving, live development, serial builds, and worker builds against a deterministic synthetic fixture (`pkg/bench/profile-fixture.ts`):

```sh
REPORT_DIR="$(mktemp -d /private/tmp/bascik-workload-XXXXXX)"
chmod 0700 "$REPORT_DIR"

yarn workspace @bascik/bascik profile:workload \
  --tools control,cpu --scenarios http1,http2,dev,build-serial,build-workers \
  --rounds 20 --report-dir "$REPORT_DIR"
```

Every capture validates response bytes, streamed HTML completion, edit publication, and profiler output integrity before marking the run complete. Process groups are owned and settled with bounded termination deadlines so a timed-out or interrupted profiler never leaves orphan servers or workers behind.
