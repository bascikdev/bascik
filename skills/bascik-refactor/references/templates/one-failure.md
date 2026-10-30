# Repair one failure: {{FAILURE_ID}}

Read `docs/migration/execution-contract.md` first. Fix this one failure and nothing else.

## The failure

- Id: {{FAILURE_ID}}
- Matrix case: {{MATRIX_CASE}}
- Evidence (report lines, screenshots, measured boxes, Lighthouse audit ids): {{EVIDENCE}}
- Files you may change: {{OWNER_FILES}}

## Steps

1. Reproduce it at {{MATRIX_CASE}} with the command that reported it.
2. Find the cause in production evidence and the legacy source. Name it in one sentence before changing anything.
3. Make the smallest change in {{OWNER_FILES}}. If the fix needs a file outside that list, stop and report it.
4. Run the focused check, then the acceptance checks.
5. If the change is an intentional difference from production, log it in `docs/migration/decisions.md`.

## Acceptance

{{ACCEPTANCE}}

The failure no longer reproduces at {{MATRIX_CASE}} or at the neighboring matrix cases, and no check that passed
before now fails. End with the handoff from the execution contract.
