# Migrate one route: {{ROUTE}}

Read `docs/migration/execution-contract.md` first. Parent prompt: {{PARENT_PROMPT}}. This prompt: {{CHILD_ID}}.

## Inputs

- Route: {{ROUTE}}
- Legacy entry: {{LEGACY_ENTRY}}
- Target page: {{TARGET_PAGE}}
- Production baselines: {{BASELINE_IDS}}
- Components to use or create: {{REQUIRED_COMPONENTS}}
- Interactions on this route (from `interactions.json`): {{INTERACTIONS}}

## Steps

1. Find production's own defects on {{ROUTE}} before you write anything, so you fix them instead of copying them:
   `node "$REFACTOR/production-defects.mjs" --prod "$PROD_URL" --route "{{ROUTE}}"`. Each squished image, icon off its
   heading, overflow or sideways scroll becomes a row in `docs/migration/decisions.md` that says
   "production defect: fix in target". Build the corrected version of those elements; the parity checks compare them
   with the correction, not with production.
2. Capture production and the target for {{ROUTE}} at every case in the breakpoint matrix with identical settings.
3. Work one section at a time, top to bottom. For each section:
   1. Find the owning production subtree from stable anchors (heading text, `href`, `src`, `alt`, landmarks, test
      ids), never generated class names.
   2. Extract structure, geometry, computed styles, pseudo-elements and image sources.
   3. Read only the legacy owner of that subtree in {{LEGACY_ENTRY}} and its imports.
   4. Implement it as a component from {{REQUIRED_COMPONENTS}} (or a new one) and place its tag in {{TARGET_PAGE}}:
      semantic HTML, scoped CSS from measured relationships, no framework wrappers. {{TARGET_PAGE}} stays a list of
      tags. A section with a nameable job is its own component; a part that only makes sense inside its section
      stays in it; a value the section does not use goes to the child through a slot, not a forwarded prop. A
      section that also appears on another route is one component, used on both. Behavior is TypeScript (a `.ts`
      companion or `<script type="text/typescript">`); when {{LEGACY_ENTRY}} is TypeScript, carry its prop and state
      types across.
   5. Build, reload, re-measure the same boxes and fix the section before the next one.
4. Carry every test hook over: each `data-testid`, `data-test`, `data-test-id`, `data-cy` and `data-qa` attribute in
   production's rendered page and in {{LEGACY_ENTRY}} goes on the same element of the target, with the same attribute
   name and value (`testid-carryover`). Then give every control, form, landmark and component root without one a
   `data-testid` (`testid-coverage`): a component root's id is the component name, a part's is `<component>-<part>`,
   and repeated instances share their ids (tests pick one with `filter({ hasText })`, or a `data-testid` on the usage
   tag replaces the root's). Never put request or random data in a test id.
5. Implement every interaction in {{INTERACTIONS}} with accurate ARIA state and keyboard support. The interaction crawl
   also activates every control it finds, so an interaction missing from the list still fails.
6. Match the layers production shows on {{ROUTE}} and only those: cookie banners, notices, chat buttons, sticky bars,
   fresh and after dismissal (`presence-by-route`).
7. Log each intentional difference in `docs/migration/decisions.md`. If it changes pixels, add an entry with the same
   id to `docs/migration/accepted.json`, as narrow as the difference (route, width range, masked selector).

## Acceptance checks

All must pass on the final files. `run-checks.mjs` runs every parity check (production defects, interactions, open
states, repeated sections, text styles, spacing, alignment, overlaps, `testid-carryover`, `testid-coverage` and
`presence-by-route`) and exits 1 on any finding; add a `--route` for each route already migrated, so repeated sections
and banners are compared across routes. Pass `--mask <selector>` only for a dynamic region with a ledger row (an
autoplay carousel, a rotating ticker); every check leaves it out. `PROD_URL`, `TARGET_URL` and `REFACTOR` come from
the execution contract. Rebuild and
restart the production server (`npx bascik --build && npx bascik --server`) before the comparisons, and stop it at
the end. The Lighthouse reports are collected fresh for {{ROUTE}}, so a stale report cannot pass:

```sh
npx bascik --build && npx bascik --check
node "$REFACTOR/../../bascik/scripts/audit-components.mjs"
node "$REFACTOR/geometry-diff.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route "{{ROUTE}}"
node "$REFACTOR/compare-route.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route "{{ROUTE}}" \
  --interactions docs/migration/interactions.json --accepted docs/migration/accepted.json
node "$REFACTOR/run-checks.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route "{{ROUTE}}" \
  --legacy-src "{{LEGACY_REPO}}" --target-src .
rm -f artifacts/lighthouse/route-mobile.json artifacts/lighthouse/route-desktop.json
mkdir -p artifacts/lighthouse
npx lighthouse "$TARGET_URL{{ROUTE}}" --quiet --chrome-flags=--headless=new --output=json \
  --output-path=artifacts/lighthouse/route-mobile.json
npx lighthouse "$TARGET_URL{{ROUTE}}" --quiet --chrome-flags=--headless=new --output=json --preset=desktop \
  --output-path=artifacts/lighthouse/route-desktop.json
node "$REFACTOR/lighthouse-gate.mjs" artifacts/lighthouse/route-mobile.json --form-factor mobile
node "$REFACTOR/lighthouse-gate.mjs" artifacts/lighthouse/route-desktop.json --form-factor desktop
```

Then the review, which no automated check replaces:

```sh
node "$REFACTOR/review-page.mjs" --route "{{ROUTE}}"
```

Hand the page and its screenshots to a visual reviewer agent with `templates/visual-review.md`, fix every difference it
reports, run the checks and `review-page.mjs` again, and have the reviewer look again. Then ask a person to review the
page and sign it (the form, or `review-page.mjs --sign --route "{{ROUTE}}" --reviewer "<name>" --verdict pass` run by
that person); the route is done only when

```sh
node "$REFACTOR/review-page.mjs" --verify --route "{{ROUTE}}"
```

exits 0. It also fails while `run-checks.mjs` reports findings, and after any change to the target's screenshots or
findings since the sign-off. Never write the sign-off file yourself.

End with the handoff from the execution contract.
