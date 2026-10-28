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

1. Capture production and the target for {{ROUTE}} at every case in the breakpoint matrix with identical settings.
2. Work one section at a time, top to bottom. For each section:
   1. Find the owning production subtree from stable anchors (heading text, `href`, `src`, `alt`, landmarks, test
      ids), never generated class names.
   2. Extract structure, geometry, computed styles, pseudo-elements and image sources.
   3. Read only the legacy owner of that subtree in {{LEGACY_ENTRY}} and its imports.
   4. Implement it in {{TARGET_PAGE}} or a component from {{REQUIRED_COMPONENTS}}: semantic HTML, scoped CSS from
      measured relationships, no framework wrappers.
   5. Build, reload, re-measure the same boxes and fix the section before the next one.
3. Implement every interaction in {{INTERACTIONS}} with accurate ARIA state and keyboard support.
4. Log each intentional difference in `docs/migration/decisions.md`. If it changes pixels, add an entry with the same
   id to `docs/migration/accepted.json`, as narrow as the difference (route, width range, masked selector).

## Acceptance checks

All must pass on the final files. `PROD_URL`, `TARGET_URL` and `REFACTOR` come from the execution contract. Rebuild and
restart the production server (`npx bascik --build && npx bascik --server`) before the comparisons, and stop it at
the end. The Lighthouse reports are collected fresh for {{ROUTE}}, so a stale report cannot pass:

```sh
npx bascik --build && npx bascik --check
node "$REFACTOR/geometry-diff.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route "{{ROUTE}}"
node "$REFACTOR/compare-route.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route "{{ROUTE}}" \
  --interactions docs/migration/interactions.json --accepted docs/migration/accepted.json
rm -f artifacts/lighthouse/route-mobile.json artifacts/lighthouse/route-desktop.json
mkdir -p artifacts/lighthouse
npx lighthouse "$TARGET_URL{{ROUTE}}" --quiet --chrome-flags=--headless=new --output=json \
  --output-path=artifacts/lighthouse/route-mobile.json
npx lighthouse "$TARGET_URL{{ROUTE}}" --quiet --chrome-flags=--headless=new --output=json --preset=desktop \
  --output-path=artifacts/lighthouse/route-desktop.json
node "$REFACTOR/lighthouse-gate.mjs" artifacts/lighthouse/route-mobile.json --form-factor mobile
node "$REFACTOR/lighthouse-gate.mjs" artifacts/lighthouse/route-desktop.json --form-factor desktop
```

End with the handoff from the execution contract.
