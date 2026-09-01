---
agent: agent
description: Pre-push checklist: code review & TDD, doc/README updates, check spelling/standards, test workspace (including Lighthouse CLI), update coverage, update SKILL.md, and propagate.
---

Run these steps in order before pushing.

1. Do a pre-review of this branch's committed and uncommitted changes. If you spot anything suspicious, fragile, or a code smell, use Test-Driven Development (TDD) to write failing unit or integration tests to probe your suspicions. This will then enable you to make better choices on if there is a real problem or not. If you need to fix something, the tests are something to validate against.
2. Check if documentation files (such as `docs/content/`, internal docs, and architecture guides) and README files across the workspace (`README.md`, `pkg/README.md`, `create/README.md`, etc.) need to be updated to reflect any new features, API changes, architectural updates, or fixes on this branch.
3. Check spelling, web standards, and static analysis across the workspace to prevent typos, security flaws, and compatibility regressions:
   - Run `yarn check:spelling` to verify American English spelling with codespell.
   - Run `yarn check:standards` to check web standards with webhint.
   - Run Jelly static analysis (`jelly --obj-spread pkg/src/index.ts`) and Semgrep (`semgrep --error --config p/default`) if installed locally to catch static analysis and security issues before pushing.
4. Run typechecks, checks, unit tests, Playwright E2E tests, and Lighthouse CLI audits across all monorepo packages using token-efficient reporters:
   - Run `yarn test:all` to verify typechecks (`typecheck:all`), web standards (`check:all`), unit tests (`unit:all`), E2E tests (`e2e:all`), and Lighthouse audits (`docs:lighthouse`) across pkg, docs, create, and extensions/vscode-bascik. `e2e:all` must run static build, live dev server, production HTTP/1.1, and production HTTP/2 configurations. Playwright E2E tests are configured with concise `--reporter=line` output.
   - Lighthouse CLI (`docs:lighthouse`) runs the same underlying engine (axe-core / Chrome Lighthouse) as DevTools. Review Lighthouse output and reports in `.lighthouseci/`.
   - Parse test results efficiently: check pass/fail status first. If any audit or test fails or drops below threshold, inspect and fix all flagged issues before pushing—including ARIA role/children attributes, color contrast ratios, console errors, broken schema scripts, and performance bottlenecks.
5. `yarn coverage:all`
6. Read `docs/src/pages/assets/SKILL.md` and review changes in `docs/content/` on this branch. Update SKILL.md to reflect any new, changed, or removed APIs and patterns based on documentation updates. Keep entries concise and practical - only change what the review reveals needs changing.
7. `yarn create:prepack`

Confirm which sections of SKILL.md were added, changed, or removed, whether coverage files were updated, and that codespell, webhint, and static analysis checks passed cleanly.
