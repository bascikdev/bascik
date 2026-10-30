---
name: bascik-css-scoping
metadata:
  internal: true
description: Build-time CSS scoping and token-aware transformations in Bascik. Use when modifying class or ID scoping, CSS selector rewriting, keyframes, container queries, custom properties, or specificity isolation.
---

# CSS Scoping in Bascik

Bascik scopes component CSS at build time without Shadow DOM, runtime stylesheets, or client-side scoping code. CSS work is coordinated by `pkg/src/lib/styles.ts`; do not assume the implementation uses PostCSS or a single AST walk. Follow the tokenizer, shielding, selector-rewrite, and caching helpers at the code path being changed.

---

## 1. Core Scoping Mechanics

Bascik rewrites component names and selectors at build time so CSS selectors match the corresponding transformed component markup:

1. **Classes and identifiers:** Component markup classes, IDs, and name references are rewritten to component/instance-scoped names; `minify.identifiers` may hash generated names.
2. **Element selectors:** Supported element selectors are converted to generated element-class selectors, with matching classes injected into component markup. Unsupported hyphenated type selectors remain unchanged.
3. **CSS custom properties:** Supported custom property names are scoped consistently at declarations and references.
4. **Keyframe animations:** Keyframe declarations are scoped and supported `animation-name` and shorthand references are updated without rewriting timing or other shorthand slots.

The selector transformation intentionally changes specificity when an element selector becomes a class selector. Preserve current compatibility behavior and tests when modifying the transform.

---

## 2. Handling Modern CSS Features

### CSS Nesting (`&`)

Supported CSS nesting is token-aware and scoped without changing the established emitted selector shape:

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

/* Representative scoped output (nesting is kept, not flattened) */
.bascik__my-comp__card {
  padding: 1rem;
  &.bascik__my-comp__active {
    border-color: green;
  }
  & > .bascik__my-comp__header {
    font-weight: bold;
  }
}
```

### Relational & Pseudo-Class Selectors (`:has()`, `:is()`, `:where()`, `:not()`)

When traversing complex selector lists inside pseudo-classes:

- Ensure that inner target classes are scoped without corrupting the structural pseudo-class syntax.
- There is no `:global()`. A class the component's CSS does not define is left unscoped, which is how global utility classes pass through.

### Container Queries (`@container`) & Layer Rules (`@layer`)

- Scopes selectors inside `@container` blocks and `@layer` blocks consistently with root rules.
- Container names declared in the component's CSS (`container-name:` or the `container:` shorthand) and layer names are scoped per component type (`scopeContainerNames`, `scopeLayerNames`); unnamed `@container (…)` queries are untouched.

---

## 3. Performance & Transform Design

- **Preserve the actual parser boundary:** Reuse the existing tokenizer and shields; do not introduce AST assumptions or merge passes without byte-parity and performance evidence.
- **String Replacement Traps:** When substituting scoped names back into CSS declarations, use replacer functions `() => scopedName` to avoid `$` replacement bugs.

---

## 4. Testing & Verification

Run the style transformer unit test suite:

```sh
# Run CSS scoping tests
npx vitest run pkg/src/lib/styles.test.ts
```
