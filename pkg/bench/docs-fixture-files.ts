/**
 * Repository files and directories the docs site reads from outside `docs/`
 * (build scripts, `pipeline.watchPaths` and `exec` producers in
 * `docs/bascik.config.ts`). A benchmark fixture of the docs site copies these
 * next to its `docs/` copy, or the baseline compiler rejects the config with
 * "path does not exist". `pkg/src/lib/bench-docs-fixture.test.ts` checks the
 * list against the config's `../` watch paths.
 */

/** Sibling directories copied recursively. */
export const DOCS_FIXTURE_SIBLING_DIRECTORIES: readonly string[] = [
  "examples",
  "skills",
];

/** Sibling files copied one by one, repository-relative. */
export const DOCS_FIXTURE_SIBLING_FILES: readonly string[] = [
  "CHANGELOG.md",
  "pkg/package.json",
  "pkg/test-coverage.json",
  "pkg/e2e-test-coverage.json",
  "create/test-coverage.json",
  "extensions/vscode-bascik/test-coverage.json",
  "adapters/cloudflare/test-coverage.json",
  "lsp/test-coverage.json",
  "skills-tests/test-coverage.json",
];
