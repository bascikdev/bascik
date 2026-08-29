---
name: bascik-css-scoping
description: Build-time CSS scoping, AST transformations, and PostCSS plugins in Bascik. Use when modifying CSS scoping logic, handling nesting, keyframes, container queries, custom properties, or specificity isolation.
---

# Modern CSS Scoping & PostCSS Transformations in Bascik

Bascik provides zero-runtime, build-time CSS scoping in `pkg/src/lib/styles.ts` using PostCSS. It encapsulates styles per component instance without requiring Shadow DOM, runtime stylesheets, or client-side JavaScript.

---

## 1. Core Scoping Mechanics

Bascik scopes styles by transforming selectors in component `<style>` blocks and matching them with scoped attribute identifiers (`data-bascik-s-*` / `data-bascik-c-*`) injected into the HTML markup:

1. **Class Names:** Transforms `.btn` $\rightarrow$ `.btn[data-bascik-s-xyz]` (or hashed production classes).
2. **Element Selectors:** Transforms `p` $\rightarrow$ `p[data-bascik-s-xyz]`.
3. **CSS Custom Properties (Variables):** Scopes `--card-bg` $\rightarrow$ `--card-bg-xyz` so variables defined in one component cannot leak across component boundaries.
4. **Keyframe Animations:** Scopes `@keyframes fadeIn` $\rightarrow$ `@keyframes fadeIn-xyz` and rewrites corresponding `animation: fadeIn ...` declarations.

---

## 2. Handling Modern CSS Features

### CSS Nesting (`&`)

Modern native CSS nesting rules are resolved and scoped correctly:

```css
/* Input */
.card {
  padding: 1rem;
  &.active {
    border-color: green;
  }
  & > .header {
    font-weight: bold;
  }
}

/* Scoped Output */
.card[data-bascik-s-abc] {
  padding: 1rem;
}
.card.active[data-bascik-s-abc] {
  border-color: green;
}
.card[data-bascik-s-abc] > .header[data-bascik-s-abc] {
  font-weight: bold;
}
```

### Relational & Pseudo-Class Selectors (`:has()`, `:is()`, `:where()`, `:not()`)

When traversing complex selector lists inside pseudo-classes:
* Ensure that inner target classes are scoped without corrupting the structural pseudo-class syntax.
* For `:global(.cls)`, strip the pseudo-wrapper and leave `.cls` unscoped.

### Container Queries (`@container`) & Layer Rules (`@layer`)

* Scopes selectors inside `@container` blocks and `@layer` blocks identically to root rules.
* Scopes named container names if configured.

---

## 3. Performance & AST Optimization

* **Single-Pass PostCSS AST Walking:** Traverse the AST using `root.walkRules` and `root.walkAtRules` rather than performing multiple complete traversals.
* **String Replacement Traps:** When substituting scoped names back into CSS declarations, use replacer functions `() => scopedName` to avoid `$` replacement bugs.

---

## 4. Testing & Verification

Run the style transformer unit test suite:

```sh
# Run CSS scoping tests
npx vitest run pkg/src/lib/styles.test.ts
```
