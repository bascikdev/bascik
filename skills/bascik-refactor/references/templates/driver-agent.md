# Driver agent

You run the migration queue in `docs/migration/prompts/`, in the order of the prompt pack index. You read
`docs/migration/execution-contract.md` before every prompt.

## The loop

1. Take the next prompt whose status is not PASS.
2. Do the work, or hand it to a worker agent with the prompt text unchanged.
3. Run every acceptance check in the prompt on the final files, yourself, from a clean build.
4. **PASS gate:** mark the prompt PASS only when every acceptance check passes. Never advance to the next prompt
   while any check fails. A handoff that says "should pass" is a FAIL.
5. For each application-owned failure, write a one-failure prompt (`templates/one-failure.md`) with the evidence and
   the owner files, run it, and run the gate again. Keep going until the gate passes.
6. Update the index status and continue.

When several worker agents run in parallel, give each a strictly disjoint set of files. Merge their work one at a
time, running the gate after each merge.

## Framework issues

When Bascik itself seems to block a check (a compiler error on valid input, scoping that breaks a valid pattern, a
missing capability), do not work around it in application code. Write a self-contained issue prompt in
`docs/migration/issues/` with these sections:

1. **Question or defect:** one sentence.
2. **Environment:** Bascik version, Node.js version, operating system, browser and Lighthouse versions, deployment
   target.
3. **Minimal repro:** the smallest page, component and config that show it, with the exact command and its output.
4. **Investigation:** what you checked, what you ruled out, and the docs pages you read.
5. **Proposed resolution:** the change you expect in Bascik, or the documented pattern you missed.
6. **Regression plan:** the test that will prove the fix and keep it fixed.
7. **Boundaries:** what the fix must not change.

Then hold the queue: mark the prompt BLOCKED with the issue link, and do not start prompts that depend on it until the
issue is resolved upstream or the docs show the supported pattern. File the issue at
https://github.com/bascikdev/bascik/issues.

## Ledger

Every intentional difference from the legacy site gets a row in `docs/migration/decisions.md`
(`templates/decisions-ledger.md`). The scripts never read that file. A ledger row that changes pixels also gets an
entry with the same id in `docs/migration/accepted.json`, which `compare-route.mjs --accepted` turns into masks or a
per-case budget for the matching routes and widths only. A comparison passes the gate only through such an entry:
never raise `--max-ratio` for a whole run, never add a `--mask` that has no ledger row, and name the ids applied in
the handoff. A failure that no approved row explains is a regression.
