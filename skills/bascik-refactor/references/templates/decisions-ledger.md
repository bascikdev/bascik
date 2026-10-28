# Differences and decisions

Every intentional difference between production and the Bascik site. Add a row before you ship the difference,
never after a reviewer finds it. Scripts do not read this file: when a row changes pixels, add an entry with the same
id to `docs/migration/accepted.json`, as narrow as the difference, so `compare-route.mjs --accepted` lets that case
pass and names the id in its report:

```json
[
  { "id": "D-01", "route": "{{ROUTE}}", "mask": ["footer"] },
  {
    "id": "D-02",
    "route": "{{ROUTE}}",
    "minWidth": 767,
    "maxWidth": 767,
    "maxRatio": 0.005
  }
]
```

Each entry takes `id`, optional `route`, `minWidth` and `maxWidth`, and at least one of `mask` (selectors painted
over on both sides) or `maxRatio` (the pixel budget for matching cases). A row without a pixel effect, such as a
focus ring that only shows on keyboard focus, needs no entry.

| id   | route     | matrix case | legacy behavior                  | new behavior                   | reason                   | evidence                        | approved by |
| ---- | --------- | ----------- | -------------------------------- | ------------------------------ | ------------------------ | ------------------------------- | ----------- |
| D-01 | {{ROUTE}} | all         | Footer links at 3.1:1 contrast   | Footer links at 4.6:1 contrast | WCAG AA, Lighthouse a11y | artifacts/compare/... report    | {{OWNER}}   |
| D-02 | {{ROUTE}} | 767x1024    | Focus outline removed on buttons | Visible focus ring             | Keyboard users           | interaction trace "open menu"   | {{OWNER}}   |
| D-03 | {{ROUTE}} | all         | Hero fades in from opacity 0     | Hero visible on first paint    | LCP candidate            | Lighthouse LCP before and after | {{OWNER}}   |

Columns:

- **id:** stable, never reused.
- **route** and **matrix case:** where the difference shows (a width x height, or "all").
- **legacy behavior** and **new behavior:** what a reviewer sees on each side.
- **reason:** the rule or score it serves.
- **evidence:** a report, screenshot or measurement under `artifacts/`.
- **approved by:** the person who accepted the difference.
