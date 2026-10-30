# Accessibility

The Lighthouse accessibility audit runs a subset of the axe-core rules: semantic HTML, sufficient color contrast, keyboard navigability, accessible names, and valid ARIA usage. Because Bascik outputs real HTML, every accessibility technique the platform provides is available to you without a plugin or library. Components are plain HTML elements, so their semantics reach the final page unchanged. [Component Best Practices](/component-best-practices#use-htmls-elements) covers choosing those elements, including a component's root.

Lighthouse can only check what a machine can verify, so a score of 100 is a floor and not proof that a page is accessible. Test with a keyboard and a screen reader before you ship.

## Semantic Landmarks, Names, and Labels

Most failed audits come from a handful of missing basics. Use landmark elements, give every control an accessible name, and set the page language.

```html
<!-- Declare the page language -->
<html lang="en">
  <!-- Skip link: the first focusable element, so keyboard users can bypass the navigation -->
  <a href="#main-content" class="skip-link">Skip to main content</a>

  <!-- Use semantic landmark elements -->
  <header>…</header>
  <nav aria-label="Primary navigation">…</nav>
  <main id="main-content">…</main>
  <footer>…</footer>

  <!-- Every image needs a meaningful alt (or empty alt for decorative images) -->
  <img src="chart.png" alt="Bar chart showing 40% growth in Q3" />
  <img src="divider.svg" alt="" />

  <!-- Buttons must have accessible names -->
  <button type="button" aria-label="Close dialog">
    <svg aria-hidden="true">…</svg>
  </button>

  <!-- Form inputs must be labeled -->
  <label for="email">Email address</label>
  <input type="email" id="email" name="email" autocomplete="email" />
</html>
```

Other rules that Lighthouse reports frequently:

- **Unique `<title>` per page.** The `document-title` audit fails on an empty or missing title. Every Bascik page is its own `.html` file, so each one gets its own.
- **Descriptive link text.** Avoid "click here" and "read more" as the only link text. The `link-name` audit fails on links with no text at all, such as an icon-only link without `aria-label`.
- **Heading order.** Do not skip levels (an `<h2>` followed directly by an `<h4>`). Use one `<h1>` per page.
- **Zoom stays enabled.** Never set `user-scalable=no` or a restrictive `maximum-scale` in the viewport meta tag.
- **No positive `tabindex`.** Use `tabindex="0"` to make a custom element focusable and `tabindex="-1"` for programmatic focus only.

### Components and IDs

Bascik scopes IDs per component instance and rewrites same-component references with them, including `for`, `aria-labelledby`, `aria-describedby`, and `aria-controls`, so label associations keep working inside a component. References that cross a component boundary are not rewritten, so keep a label and its control in the same component. See [ID References](/compatibility#id-references) for the full list.

## Skip Links

A **skip link** is one of the highest-value, lowest-effort accessibility improvements you can add. Style it to be visually hidden until focused, then revealed, so it does not affect the visual layout for mouse users.

```css
/* Accessible skip link pattern */
.skip-link {
  position: absolute;
  top: -100%;
  left: 0;
  padding: 8px 16px;
  background: #d3ff8d;
  color: #000;
  font-weight: 600;
  z-index: 9999;
  text-decoration: none;
}

.skip-link:focus {
  top: 0;
}
```

Give the target landmark a matching `id` (`<main id="main-content">`) so the link has somewhere to land.

## Color Contrast and Focus

The `color-contrast` audit is the most common accessibility failure on otherwise clean pages. Text needs a contrast ratio of at least 4.5:1 against its background (3:1 for large text), and this applies to every theme you ship, including dark and light modes. Never remove the focus outline without replacing it with an equally visible style.

```css
/* Keep a visible focus indicator for keyboard users only */
:focus-visible {
  outline: 3px solid #1a73e8;
  outline-offset: 2px;
}

/* Respect users who ask for less motion */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

> **MDN reference.** [`:focus-visible`](https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible) and [`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) on MDN cover browser support and usage notes.

## CSS-First Interactivity

Before writing a line of JavaScript for any UI behavior, ask: **can HTML and CSS do this?**

The browser ships a set of interactive primitives that require zero JavaScript. They are also the most accessible way to build these widgets, because keyboard handling, focus management, and ARIA roles are implemented by the browser and keep working when JavaScript fails or is blocked. They also cost the engine nothing to parse, which helps [Performance](/lighthouse/performance). The rule is simple: reach for JavaScript only when the platform genuinely cannot do the job.

### Collapsible Sections and Toggle Menus: `<details>`

`<details>` and `<summary>` give you a fully accessible toggle with no JavaScript, open/close state, keyboard activation (Enter, Space), and correct ARIA roles are all handled by the browser:

```html
<details>
  <summary>How does Bascik scope CSS?</summary>
  <p>
    It renames each class the component's stylesheet defines to a name unique to
    that component, at build time.
  </p>
</details>
```

The same pattern works for mobile navigation drawers. Wrap the nav links in `<details>`, put the hamburger button inside `<summary>`, and use the `[open]` attribute in CSS to drive all state:

```html
<nav>
  <a href="/" class="logo">MySite</a>
  <details class="nav-details">
    <summary class="nav-toggle" aria-label="Toggle navigation">
      <span class="hamburger-icon"></span>
    </summary>
    <ul class="nav-links">
      <li><a href="/about">About</a></li>
      <li><a href="/blog">Blog</a></li>
    </ul>
  </details>
</nav>
```

```css
/* Remove the default <summary> triangle marker */
.nav-toggle {
  list-style: none;
  cursor: pointer;
}
.nav-toggle::-webkit-details-marker {
  display: none;
}

/* Desktop: always show nav links regardless of open/closed state */
@media (min-width: 769px) {
  .nav-details {
    display: flex;
    align-items: center;
  }
  .nav-details > summary {
    display: none;
  }
  .nav-details > .nav-links {
    display: flex;
  } /* override UA hidden state */
}

/* Mobile: show links when open - pure CSS, no event listeners */
@media (max-width: 768px) {
  .nav-links {
    display: none;
  }
  .nav-details[open] > .nav-links {
    display: flex;
    flex-direction: column;
  }

  /* Animate hamburger → X using the [open] selector */
  .nav-details[open] .hamburger-icon {
    background: transparent;
  }
  .nav-details[open] .hamburger-icon::before {
    top: 0;
    transform: rotate(45deg);
  }
  .nav-details[open] .hamburger-icon::after {
    top: 0;
    transform: rotate(-45deg);
  }
}

/* Lock body scroll when the overlay is open - still no JS */
body:has(.nav-details[open]) {
  overflow: hidden;
}
```

> **`body:has()`** is supported in Chrome 105+, Firefox 121+, and Safari 15.4+. It is the CSS-only solution to the previously JS-only problem of locking the page scroll behind an open overlay.

> **MDN reference.** [`<details>` and `<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details) on MDN document the `open` attribute, keyboard behavior, and accessibility semantics. The [`:has()` pseudo-class](https://developer.mozilla.org/en-US/docs/Web/CSS/:has) covers the CSS parent selector and browser support.

### Modal Dialogs: `<dialog>`

The `<dialog>` element provides a native modal with backdrop, focus trapping, and Escape-to-close, behaviors that previously required hundreds of lines of JavaScript to implement correctly:

```html
<button id="open-modal" type="button">Open</button>

<dialog id="my-modal">
  <p>Modal content here.</p>
  <form method="dialog">
    <button>Close</button>
  </form>
</dialog>
<script type="text/typescript">
  const modal = document.getElementById("my-modal") as HTMLDialogElement;
  document
    .getElementById("open-modal")!
    .addEventListener("click", () => modal.showModal());
</script>
```

```css
dialog::backdrop {
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}
```

The `onclick` inline handlers are one-liners, not a script file. `<dialog>` handles focus management, keyboard dismissal, and `aria-modal` automatically.

> **MDN reference.** The [`<dialog>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog) on MDN covers `showModal()`, `close()`, `returnValue`, the `::backdrop` pseudo-element, and browser compatibility.

### The Decision Framework

When building any interactive feature, work through this checklist before writing JavaScript:

1. **Can a native HTML element do it?** `<details>`, `<dialog>`, `<input type="range">`, `<datalist>`, `<meter>`, `<progress>` cover a huge range of interactive patterns out of the box.
2. **Can a CSS state selector do it?** `:checked`, `:target`, `:hover`, `:focus-within`, `:has()`, `[open]` handle most toggle and reveal behaviors.
3. **Can an HTML attribute do it?** `loading="lazy"`, `required`, `disabled`, `hidden`, `contenteditable`.

Only if all three answers are no should you reach for JavaScript. When you do, scope it, defer it, and keep it small.
