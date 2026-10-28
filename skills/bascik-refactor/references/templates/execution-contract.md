# Execution contract

Every prompt in this migration reads this file first. Fill in the `{{...}}` placeholders once and commit the result
as `docs/migration/execution-contract.md`.

## Locations

- Live reference (read-only): {{LIVE_URL}}
- Legacy repository (read-only): {{LEGACY_REPO}}
- Target Bascik repository (the only place you write): {{TARGET_REPO}}
- Page families and their owners: {{PAGE_FAMILIES}}
- Breakpoint matrix: {{MATRIX_FILE}}
- Inventories: `docs/migration/routes.json`, `urls.txt`, `interactions.json`, `integrations.json`, `decisions.md`,
  `accepted.json`

## Environment

Every command assumes these, set once per shell:

```sh
export PROD_URL={{LIVE_URL}}
export TARGET_URL=http://localhost:8080            # the URL `bascik --server` prints
export BASCIK_SITE_URL={{LIVE_URL}}                # the public origin, for sitemap, robots.txt and canonicals
export REFACTOR=.agents/skills/bascik-refactor/scripts  # wherever the skills are installed
```

Compare and audit a production build only: `npx bascik --build && npx bascik --server` (or `npx wrangler dev` for
the Cloudflare wrapper). Never the dev server. Start it in the background, rebuild after each change, and stop it
before you hand off.

## Non-negotiables

1. Match production at every case in {{MATRIX_FILE}}: pixels, geometry, content and interactions. Live production
   wins on geometry; the legacy source explains the responsive math; the target owns clean semantic HTML and CSS.
2. 100 in all five Lighthouse categories (Performance, Accessibility, Best Practices, SEO, Agentic Browsing) on every
   page, mobile and desktop.
3. Clean Bascik: one `.html` page per route, components with props and slots, scoped CSS, TypeScript only where
   behavior needs it. No framework runtime carried over. No copied grid wrappers or generated class names.
4. No Lighthouse gaming: no audit or user-agent detection, no vendor-free mode for audits, no hidden content, no
   timers or delays that outlast the audit.
5. Production defects are observations: fix them, and log each fix in `docs/migration/decisions.md`.

## Safety

- Browse production read-only. Never submit a real form, place an order, create an account or send synthetic
  analytics events.
- Never write to the legacy repository.
- No secrets, tokens or personal data in any file, prompt, screenshot name or log.
- Keep screenshots and reports under `artifacts/`, which is ignored by git.

## Working method

1. Inspect: read the inventories, the production subtree and the legacy owner before editing.
2. Make the smallest change that moves one check from fail to pass.
3. Run a focused check (the section's measurement, screenshot or interaction test).
4. Format the changed files.
5. Run the gate commands:

   ```sh
   {{GATE_COMMANDS}}
   ```

6. Hand off.

## Handoff contract

End every prompt with:

- **Status:** PASS or FAIL, per acceptance check.
- **Revisions:** what changed and why, one line each.
- **Files:** every file created or changed.
- **Commands:** the exact commands run and their results (exit codes, failing lines).
- **Not verified:** anything you could not check, and why.
