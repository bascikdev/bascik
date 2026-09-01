# 19: Unified preserve

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/javascript.ts`, `pkg/src/lib/components.ts`, `pkg/src/lib/processing.ts`,
`extensions/vscode-bascik/`.

**Depends on prompt 18**, which consolidated five shielding implementations into one. Use that
utility. **Do not add a sixth mechanism.**

**Decision, do not re-litigate:** preserve is ONE concept with TWO scopes.

| Scope                       | Mechanism                                                   |
| --------------------------- | ----------------------------------------------------------- |
| By tag name, every instance | `scoping.preserve: ['code']` (config, renamed in prompt 03) |
| One element and its subtree | `data-bascik-preserve` (attribute, new here)                |

Both mean: **do not transform content and do not scope attributes inside this.**

---

## Why the attribute is needed

Three real situations need one element excluded from scoping, and the only lever today is a
**global** config flag that disables scoping everywhere.

**1. Third-party widget mount points.** Cloudflare Turnstile, Google reCAPTCHA, and
accessibility overlays locate their container by literal ID, for example
`grecaptcha.render('recaptcha-container', …)`. A scoped ID makes the widget permanently
invisible to its own script.

**2. Forms posting to an external API.** Bascik scopes `name` per instance, so a form submits
`bascik__contact__a1b2c3__email` instead of `email`. The receiving endpoint, a serverless
function or a CRM or an email service, cannot be changed to expect a build-time hash.

**3. Hand-authored inline SVG** with its own internal ID graph the author wants left alone.

`scoping.attributes.name: false` "solves" case 2 but disables name scoping site-wide, which
**silently breaks radio-button group isolation** between instances of the same component. That
is the trap this feature exists to avoid.

---

## Syntax

```html
<!-- Preserve everything: id, name, and class -->
<div id="turnstile-container" data-bascik-preserve></div>

<!-- Preserve only specific attributes (space-separated) -->
<form id="contact" data-bascik-preserve="name">
  <input id="email" name="email" type="email" />
</form>
```

## Rules

- **No value** preserves `id`, `name`, and `class`.
- **A space-separated value** preserves only the listed attributes. Valid tokens: `id`, `name`,
  `class`.
- Applies to the element **and all descendants**.
- The attribute is **stripped from the compiled output**. It is a build-time directive.
- An unknown token warns and is ignored, per the resilience rule.
- **Nesting only widens.** An inner `data-bascik-preserve` cannot re-enable scoping on something
  an ancestor preserved.
- Preserved elements are excluded from ID-reference rewriting **in both directions**, which
  prompts 20 and 21 implement. Leave the hook for them.

---

## Implementation constraint

Use prompt 18's consolidated shielding utility. If it cannot express "preserve these attributes
but still transform content", **extend it** rather than forking it. Record the extension in a
one-line comment.

Note the distinction from `maskRawTextContent`, which prompt 18 kept internal and hardcoded:
that one is **temporary** parse-time safety with a discarded mask. This one is a **persistent**
authoring choice. Prompt 02 documented the pair in `SKILL.md`; keep the code comments agreeing.

---

## TDD steps

Write each failing test first.

1. Bare `data-bascik-preserve` preserves `id`, `name`, and `class` on the element.
2. It preserves them on **descendants** too, at least three levels deep.
3. `data-bascik-preserve="name"` preserves only `name`; `id` and `class` **still scope**.
4. `data-bascik-preserve="id class"` preserves two of three.
5. The attribute is **stripped** from compiled output. Assert on the full output, not a
   substring.
6. An unknown token such as `data-bascik-preserve="href"` warns and is ignored, and the valid
   tokens alongside it still apply.
7. A descendant `data-bascik-preserve` cannot re-enable scoping an ancestor preserved.
8. A descendant **can** widen: an ancestor preserving `name` and a descendant preserving
   nothing-specified results in all three preserved on that subtree.
9. `scoping.preserve` by tag name behaves identically at tag scope, using the same code path.
10. **Radio buttons, which have no coverage today:** two instances of a component **without**
    preserve get **distinct** group names, and radios **within** one instance share a name.
11. The same component **with** `data-bascik-preserve="name"` submits unscoped names in both
    instances, and the radio isolation is deliberately given up. Assert both halves so the
    tradeoff is pinned.

Step 10 is important on its own: it is existing behavior with no test, and prompt 19 is the
natural place to add it because it is the behavior the attribute trades away.

## Testing

**Unit:** all of the above, in `javascript.test.ts` and `components.test.ts`.

**E2E:** add fixtures for the two motivating cases.

- A third-party-style mount point: a `<div id="widget-mount" data-bascik-preserve>` plus a page
  script that does `document.getElementById('widget-mount')` and writes into it.
- A form with `data-bascik-preserve="name"` whose fields must submit unscoped names.
- A component **without** preserve used twice, containing a radio group.

Configs:

- `playwright.config.ts` (static build): the literal ID survives and the page script finds it;
  the form's submitted field names are unscoped; the two radio groups are independent.
- `playwright.dev.config.ts`: same, proving parity.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: the form submission
  case specifically, since that is the one a server actually receives. Assert the received field
  names.

The radio-group assertion is behavioral: click a radio in instance one and assert the selection
in instance two is unaffected.

## Documentation

| File                                      | Change                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/preserve.md` **(new page)** | Plus `docs/src/pages/preserve.html`, added to `docs/src/components/docs-sidebar/docs-sidebar.html`. Lead with the third-party widget case, then external form endpoints, then hand-authored SVG. **Show the radio-button tradeoff explicitly** so nobody reaches for the global `scoping.attributes.name: false`. Cover both scopes: the config option and the attribute |
| `docs/content/components.md`              | Introduce `data-bascik-preserve` in the directive family                                                                                                                                                                                                                                                                                                                 |
| `docs/content/configuration.md`           | `scoping.preserve` and its relationship to the attribute                                                                                                                                                                                                                                                                                                                 |
| `docs/content/compatibility.md`           | **Required by repo policy.** A row for each scope, and a row noting the internal mask is not configurable                                                                                                                                                                                                                                                                |
| `docs/content/faq.md`                     | "How do I use a third-party widget that looks up an element by ID?" and "Why are my form field names hashed?"                                                                                                                                                                                                                                                            |
| `docs/src/pages/assets/SKILL.md`          | Default-first: scoping is on, preserve is the escape hatch. Gotchas: preserving `name` gives up radio isolation. Sync `create/assets/SKILL.md`                                                                                                                                                                                                                           |

**Naming:** prompt 53 establishes that a page h1 must equal its sidebar label. Match from the
start so prompt 53 has nothing to fix here.

## VS Code extension

See `.github/skills/bascik-vscode-extension/SKILL.md`.

- Grammar: highlight `data-bascik-preserve` alongside the other `data-bascik-*` directives.
- **Warning** diagnostic: `data-bascik-preserve` with an unrecognized token.
- **Warning** diagnostic: a `<form>` whose `action` points at an external URL without
  `data-bascik-preserve="name"`, since scoped names will be submitted.
- A test for each.

## Acceptance criteria

- [ ] All eleven tests failed before their fixes and pass after.
- [ ] Bare and valued forms both work; the subtree rule holds; nesting only widens.
- [ ] The attribute is stripped from compiled output.
- [ ] An unknown token warns without discarding the valid tokens beside it.
- [ ] `scoping.preserve` and `data-bascik-preserve` share **one implementation**, built on
      prompt 18's utility, with no sixth mechanism introduced.
- [ ] Radio isolation is tested both with and without preserve.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs, including a real form submission on the server configs;
      the user has run `yarn e2e:all`.
- [ ] The new preserve page exists with h1 matching its sidebar label; `compatibility.md`
      updated; both SKILL.md copies in sync.
- [ ] The extension highlights the directive and has two passing diagnostic tests.

## Do not do

- Do not implement ID-reference rewriting. Prompts 20 and 21; just leave the exclusion hook.
- Do not make `maskRawTextContent` configurable.
- Do not add a third preserve scope.
- Do not run Playwright or pre-push scripts.
