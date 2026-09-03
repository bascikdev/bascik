# From React

React and Bascik both build UIs from reusable components. The core difference is that Bascik does all component work at build time and outputs vanilla HTML, there is no virtual DOM, no framework runtime, and no JSX. Switching is mostly mechanical: rename files, swap JSX syntax for HTML, and replace framework abstractions with their build-time or vanilla-JS equivalents.

## File and Folder Setup

Move your component source files into `src/components/`. The file name becomes the HTML tag name, so names must be hyphenated. Pair each component HTML file with a `.css` file in the same directory to replace CSS Modules.

```text
Before (React)               After (Bascik)
src/components/              src/components/
  SiteNav.jsx                  site-nav/
  SiteNav.module.css             site-nav.html
  Card.jsx                       site-nav.css
  Card.module.css              card/
  AlertBox.jsx                   card.html
  AlertBox.module.css            card.css
                               alert-box/
                                 alert-box.html
                                 alert-box.css
```

## Component Syntax

A Bascik component is a vanilla HTML file. There are no imports, no function declarations, and no JSX. The file name (minus the extension) is the tag name.

```jsx
// SiteNav.jsx (React - before)
import styles from './SiteNav.module.css';

export function SiteNav() {
  return (
    <nav className={styles.nav}>
      <a href="/" className={styles.logo}>Acme</a>
    </nav>
  );
}
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <a href="/" class="logo">Acme</a>
</nav>
```

No import statement is needed to use this component. Bascik resolves `<site-nav></site-nav>` to `src/components/site-nav/site-nav.html` automatically by tag name.

## children → Default Slot

React's `children` prop maps to Bascik's default slot. Add `data-bascik-slot` (no value) to any element inside the component where child content should appear. Fallback content goes inside that element and renders when the component is invoked with no children.

```jsx
// Card.jsx (React - before)
export function Card({ children }) {
  return <div className="card">{children}</div>;
}

// Usage
<Card><p>Card content here.</p></Card>
```

```html
<!-- src/components/card/card.html (Bascik - after) -->
<div class="card">
  <div data-bascik-slot>No content provided.</div>
</div>

<!-- Usage -->
<card><p>Card content here.</p></card>
```

## Named Render Props / Slot Pattern → Named Slots

React's named render props and compound component slot patterns map to Bascik's `data-bascik-slot="name"` attribute. Place a receiver element with `data-bascik-slot="name"` inside the component, then pass the content from the usage site using the same attribute.

```jsx
// PageLayout.jsx (React - before)
export function PageLayout({ header, children }) {
  return (
    <div className="layout">
      <header>{header}</header>
      <main>{children}</main>
    </div>
  );
}

// Usage
<PageLayout header={<h1>Welcome</h1>}>
  <p>Main content.</p>
</PageLayout>
```

```html
<!-- src/components/page-layout/page-layout.html (Bascik - after) -->
<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
</div>

<!-- Usage -->
<page-layout>
  <p>Main content.</p>
  <div data-bascik-slot="header"><h1>Welcome</h1></div>
</page-layout>
```

## String Props → data-bascik-prop-*

React string props become `data-bascik-prop-*` attributes. Add the attribute (with no value) to the element inside the component that should receive the text, then supply the value at the usage site.

```jsx
// AlertBox.jsx (React - before)
export function AlertBox({ title, message }) {
  return (
    <div className="alert">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

<AlertBox title="Success" message="Your changes were saved." />
```

```html
<!-- src/components/alert-box/alert-box.html (Bascik - after) -->
<div class="alert">
  <strong data-bascik-prop-title></strong>
  <p data-bascik-prop-message></p>
</div>

<!-- Usage -->
<alert-box
  data-bascik-prop-title="Success"
  data-bascik-prop-message="Your changes were saved."
></alert-box>
```

> **Text only:** Props accept plain text strings. Boolean, number, object, and array values have no equivalent. For rich HTML content, use a named slot instead. For computed or array-based content, use a `<script data-bascik-build>` block in the page.

## useState / useEffect → Vanilla JS

`useState`, `useEffect`, and event handlers become vanilla JavaScript in a `<script>` tag inside the component. Bascik automatically scopes `id` values and class names referenced in the script, so multiple instances of the component on the same page work independently.

```jsx
// Counter.jsx (React - before)
import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span id="count">{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
```

```html
<!-- src/components/my-counter/my-counter.html (Bascik - after) -->
<div>
  <span id="count">0</span>
  <button id="btn">+</button>
</div>
<script>
  const countEl = document.getElementById("count");
  document.getElementById("btn").addEventListener("click", () => {
    countEl.textContent = String(Number(countEl.textContent) + 1);
  });
</script>
```

Bascik rewrites both `id="count"` in the HTML and the `getElementById("count")` call in the script to the same unique scoped value. Two `<my-counter>` instances on the same page each maintain their own independent state.

## CSS Modules → Paired .css Files

Delete the `.module.css` file and create a plain `.css` file alongside the component HTML. Change all `className={styles.foo}` attributes to `class="foo"`. Bascik scopes every class name at build time with no configuration or tooling required.

```css
/* src/components/site-nav/site-nav.css */
.nav {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo {
  font-weight: bold;
  text-decoration: none;
}

.links {
  list-style: none;
  display: flex;
  gap: 12px;
  margin: 0;
  padding: 0;
}
```

## React Router → One .html File Per Route

Replace client-side route definitions with one `.html` file per URL in `src/pages/`. There is no client-side navigation, every link triggers a full page load.

```text
Before (React Router)        After (Bascik)
src/App.jsx                  src/pages/
  <Route path="/" />           index.html
  <Route path="/about" />      about.html
  <Route path="/blog/:slug" /> blog/
                                 my-first-post.html
                                 another-post.html
```

There is no dynamic routing equivalent. Each URL needs its own file. For programmatically generated pages, write a Node.js script that creates the files before running `bascik --build`.

## Conditional Rendering

Bascik has no build-time equivalent of `{condition && <Comp />}`. Choose one of two approaches:

- **Build-time decision:** Include the correct markup in each page's `.html` file directly. If two pages differ, they have different HTML. This is the right choice for things like per-page hero sections or feature flags.
- **Runtime toggle:** Render both branches, then show or hide them with CSS (`display: none`) or vanilla JS toggling a `data-` attribute or class.

## useEffect for Data → `<script data-bascik-build>`

Data fetched at component mount time in React becomes a `<script data-bascik-build>` block that runs as a Node.js ESM module at build time. The script's stdout is injected into the page in place of the tag.

```html
<!-- src/pages/blog.html -->
<main>
  <h1>Blog</h1>
  <ul>
    <script data-bascik-build>
      import { readdir } from 'node:fs/promises';
      const files = await readdir('./content/posts');
      const items = files
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const slug = f.replace('.md', '');
          return `<li><a href="/blog/${slug}">${slug}</a></li>`;
        });
      console.log(items.join('\n'));
    </script>
  </ul>
</main>
```

> **Build scripts run first:** The output of a `<script data-bascik-build>` block can itself contain Bascik component tags. They are resolved in the next pass.

## Before and After: Navigation Component

A realistic nav with a logo slot, link items, and a mobile menu toggle button.

```jsx
// SiteNav.jsx (React - before)
import { useState } from 'react';
import styles from './SiteNav.module.css';

export function SiteNav({ logo, children }) {
  const [open, setOpen] = useState(false);
  return (
    <nav className={styles.nav}>
      <div className={styles.logo}>{logo}</div>
      <button
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        Menu
      </button>
      <ul className={`${styles.links} ${open ? styles.open : ''}`}>
        {children}
      </ul>
    </nav>
  );
}
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <div class="logo"><div data-bascik-slot="logo"></div></div>
  <button class="toggle" id="toggle" aria-expanded="false">Menu</button>
  <ul class="links" id="links">
    <div data-bascik-slot></div>
  </ul>
</nav>
<script>
  const toggle = document.getElementById("toggle");
  const links = document.getElementById("links");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    links.classList.toggle("open");
  });
</script>
```

```html
<!-- Usage in src/pages/index.html -->
<site-nav>
  <li><a href="/about">About</a></li>
  <li><a href="/blog">Blog</a></li>
  <li><a href="/contact">Contact</a></li>
  <div data-bascik-slot="logo"><a href="/">Acme</a></div>
</site-nav>
```

The nav links are slotted in as static `<li>` elements, the logo uses a named slot, and the mobile toggle is vanilla JS that Bascik scopes automatically per instance.
