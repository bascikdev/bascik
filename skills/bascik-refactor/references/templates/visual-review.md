# Visual review: {{ROUTE}}

Read `docs/migration/execution-contract.md` first. You are an agent with image input, and you did not write this
route. Your job is to find differences between production and the Bascik target. A route cannot pass while you report
any, so report every one you see, however small, and never decide that one is acceptable: only a ledger row in
`docs/migration/decisions.md` makes a difference intentional.

## Inputs

- `artifacts/review/` holds the review page for {{ROUTE}}, written by
  `node "$REFACTOR/review-page.mjs" --route "{{ROUTE}}"`. It links the screenshots it shows.
- The full-page screenshots at rest, production and target side by side, for every matrix case
  (`artifacts/compare/`, from `compare-route.mjs`).
- The open states: a crop of every dropdown, menu and disclosure opened on both sides
  (`artifacts/checks/states/`, from `run-checks.mjs`).
- The run-checks findings and the production defects for {{ROUTE}} (`artifacts/checks/`): read them after you look,
  not before, so they do not steer your eye.

## Steps

Read the images side by side, one matrix case at a time, the rest state first and then every open state. Compare the
pair region by region, top to bottom, against this checklist:

1. Missing interactions: every button, link and control does what production does, such as a hero button that scrolls
   to its section.
2. Dropdown menus, opened: the same style and the same icons as production.
3. Repeated sections: a section on several pages is one component, and every copy looks the same.
4. Link color and font weight: links and text match at rest, on hover and on keyboard focus.
5. Vertical spacing between elements matches inside every section.
6. Alignment at every breakpoint: text and buttons line up the same at each width.
7. Overlapping elements: an icon over a dot or a badge over an image sits exactly where production puts it.

Also compare what the checklist does not name: images and their crop, borders, shadows, colors, and any layer present
on one side only (a cookie banner, a chat button, a sticky bar).

## Report

For each difference: the matrix case (width x height) or the open state, the region, what production shows, what the
target shows, and the checklist number. Write the report next to the route's review page, with the same name and
`.visual.md` in place of `.html` (for `/` that is `artifacts/review/index.visual.md`), and start it with the line
`Route: {{ROUTE}}`, so no other route's report is ever read as this one's. If you find no difference, say which cases
and open states you read, so a person can check that nothing was skipped.

The driver marks {{ROUTE}} PASS only when this report lists no differences and a person has signed a pass verdict in
`docs/migration/review/` with the review page. Never write that sign-off file yourself.
