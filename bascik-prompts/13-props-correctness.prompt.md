# 13: Props correctness and escaping

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/components.ts`, `pkg/src/lib/processing.ts`, and their tests.

Three bugs plus the escaping decision. All four produce wrong output silently, and two are
currently locked in by tests that assert the wrong behavior.

---

## Bug 1: `extractProps` reads the whole element, not the opening tag

`processing.ts#L402` passes `component.content` to `extractProps`. But `getTag` defines
`content` as `htmlString.slice(openTag.start, closeIndex + closeTag.length)`, which **includes
all children**.

`components.ts#L557` then scans it globally:

```js
const regexp = /data-bascik-prop-([\w-]+)=("[^"]*"|'[^']*')/gi;
```

So props declared on **nested child components inside slot content leak upward into the
parent**:

```html
<my-card>
  <my-badge data-bascik-prop-text="beta"></my-badge>
</my-card>
```

`my-card` receives `{ text: "beta" }` and will fill any `data-bascik-prop-text` receiver in its
own template.

**Fix:** scan the **opening tag only**, exactly as `extractInheritableAttributes` already does
correctly.

**No test covers this today.** Every `extractProps` test feeds a bare opening tag, which is why
it survived.

---

## Bug 2: a parent prop destroys a child's declared prop

`components.ts#L595-L611`. The marker regex makes the value optional:

```js
`<(\\w+(?:-\\w+)*?)(${ATTR_VALUE}?)\\s+${attrName}(?:=("[^"]*"|'[^']*'))?(${ATTR_VALUE})>([\\s\\S]*?)<\\/\\1>`;
```

If the parent template contains `<my-child data-bascik-prop-label="static">…</my-child>` and
the parent is **also** given a `label` prop, the child tag is rewritten to
`<my-child>parentValue</my-child>`. The child's declared prop **and its inner content** are
silently destroyed.

This directly contradicts the comment three lines below, which says markers carrying a value
are child component prop declarations and must be preserved.

**Fix:** a marker that **carries a value** is a child's declaration. Leave it alone.

`components.test.ts#L1097-L1100` only exercises the no-collision case, so the bug reads as
intentional. Update that test.

---

## Bug 3: a value containing the delimiting quote truncates silently

`extractProps` uses `/data-bascik-prop-([\w-]+)=("[^"]*"|'[^']*')/gi`, so a value containing the
same quote character that delimits it truncates with **no warning**.

**Fix:** detect and warn at minimum. Entity-encoded quotes (`&quot;`, `&#39;`) must round-trip
correctly.

---

## Decision: escape prop values

**Do not re-litigate.** Prop values are HTML-escaped on injection. **Slots** are the documented
way to pass raw markup.

`components.ts#L595-L607` splices `propValue` into the HTML **verbatim**. Combined with
`data-bascik-build` scripts that emit prop values from a CMS, a database, or an API, that is a
straightforward stored-XSS sink.

It also means a prop value containing `data-bascik-slot` or a component tag is subsequently
interpreted as markup, because prop injection happens **before** slot resolution and the outer
loop re-scans for components.

Escape `&`, `<`, `>`, `"`, and `'` on injection.

`components.test.ts#L1303` currently asserts verbatim injection under an "adversarial prop
values" heading. That test asserts the vulnerable behavior. Update it.

### Slots are verified to work as the raw-markup path

`extractNamedSlotContent` (`components.ts#L731-L742`) and `replaceNamedSlots` (`#L751-L771`)
insert content by string splice with no encoding. The result is recursively transpiled at
`processing.ts#L807`, and scoping applies to the injected elements.

So a consumer can pass `<strong>bold</strong>` or a whole `<img>` through a slot and have it
render as markup, including nested components. Document this as the intended escape hatch, and
test it so the claim is pinned.

---

## TDD steps

### Step 1: pin all four as failing, before fixing anything

| Test                                                              | Expected failure       |
| ----------------------------------------------------------------- | ---------------------- |
| a nested child's prop does not reach the parent                   | the parent receives it |
| a parent prop does not destroy a child's declared prop or content | both are replaced      |
| a prop value containing the delimiting quote warns                | it truncates silently  |
| a prop value containing `<script>` renders as text                | it is injected raw     |

### Steps 2 to 5

2. Fix bug 1. Add a test with a nested component **inside slot content**, since that is the
   real-world shape.
3. Fix bug 2. Update `components.test.ts#L1097-L1100`.
4. Fix bug 3, including `&quot;` and `&#39;` round-trips.
5. Add escaping. Update `components.test.ts#L1303`. Add a slot test proving raw markup still
   works and is scoped.

## Testing

**Unit:** all of the above, in `components.test.ts` and `processing.test.ts`.

**E2E:** add a fixture component used **twice** with different props, plus a component whose
template contains a child component with its own declared prop, plus a prop value containing
`<script>alert(1)</script>`.

- `playwright.config.ts` (static build): assert no cross-talk between instances, the child's
  prop survives, and the script payload renders as **text** with no dialog and no console error.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: the escaping assertion only. Prop injection is build-time, so the
  server configs add little; state that reasoning if you skip the rest.

Use `data-testid` and `page.getByTestId()`.

## Documentation

| File                             | Change                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/content/props.md`          | Prop values are HTML-escaped. Slots are the way to pass raw markup, with a worked example  |
| `docs/content/slots.md`          | Cross-link from props. State that slot content is scoped and may contain nested components |
| `docs/content/compatibility.md`  | **Required by repo policy.** Add rows for prop escaping and the nested-prop boundary       |
| `docs/content/faq.md`            | "Why is my prop value showing as escaped text?"                                            |
| `docs/src/pages/assets/SKILL.md` | Props are escaped; slots carry markup. Gotcha explicit. Sync `create/assets/SKILL.md`      |

## Acceptance criteria

- [ ] All four step-1 tests failed before their fixes and pass after.
- [ ] `extractProps` scans the opening tag only.
- [ ] A parent prop never destroys a child's declared prop or content.
- [ ] A value containing the delimiting quote warns; entity-encoded quotes round-trip.
- [ ] Prop values are HTML-escaped on injection.
- [ ] Both tests that asserted the wrong behavior are updated.
- [ ] Slots still carry raw markup, are scoped, and can contain nested components, all tested.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` succeeds, since the docs site uses props heavily.
- [ ] E2E added; the user has run `yarn e2e:all`.

## Do not do

- Do not add `data-bascik-attr-*`. Prompt 17.
- Do not add a raw-prop opt-out attribute. Slots are the answer.
- Do not add interpolation or a templating syntax.
- Do not run Playwright or pre-push scripts.
