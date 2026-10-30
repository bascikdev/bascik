# Agent Skills Tests

The test suite for the public [Bascik agent skills](../skills/README.md): the workspace `bascik-skills-tests`. It is for contributors changing a skill's `SKILL.md` or one of its `scripts/`. Nothing here is published.

## Why It Is Not in `skills/` or `docs/`

`skills/` ships to users as is (`npx skills add bascikdev/bascik`, and the `https://bascik.dev/assets/skills.tar.gz` archive the docs build publishes), so it holds no tests, fixtures, or dev dependencies. The skills are not part of the docs site either, so their tests have their own workspace with its own Vitest config, coverage, and CI jobs.

## What It Tests

- **Unit tests** (`tests/*.test.ts`): each script in `skills/*/scripts/` (`verify.mjs`, `audit-components.mjs`, `check-tokens.mjs`, the `bascik-refactor` parity checks, and the rest), the links and rules inside each `SKILL.md`, and that the lint rule table in `bascik-compatibility` matches the compiler's rules.
- **Integration tests** (`tests/*.integration.test.ts`): runs that need the real compiler, the real language server, or a real browser, such as checking a monorepo of sites and the refactor parity checks against fixture pages.
- **Fixtures** live in `tests/fixtures/`.

Coverage counts the skills' `.mjs` scripts (`../skills/**/*.mjs`), not the test files.

## Run It

Use Node 24. From the repository root:

```sh
yarn skills:unit         # unit tests (builds pkg first)
yarn skills:integration  # integration tests (builds pkg and the language server first)
yarn skills:test         # both
yarn skills:typecheck    # TypeScript type check
yarn skills:coverage     # unit coverage, written to skills-tests/test-coverage.json
```

The integration tests that drive a browser need Playwright's Chromium (`npx playwright install chromium`). CI runs the unit and integration projects as the "Agent Skills Unit Tests" and "Agent Skills Integration Tests" jobs in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
