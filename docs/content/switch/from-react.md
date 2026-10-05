# From React

React and Bascik both structure user interfaces into reusable components, but they use different execution models. React renders components in JavaScript using a virtual DOM and client-side runtime, whereas Bascik compiles components at build time into vanilla HTML, CSS, and JavaScript.

## When to Switch vs Keep React

- **Switch to Bascik:** For landing pages, marketing sites, documentation, company portals, blogs, and content-first web applications where instant initial page loads, simple maintenance, and zero client runtime matter.
- **Keep React:** For applications centered around complex, highly interactive client-side state trees (such as design tools, rich document editors, or real-time collaborative spreadsheets).

## Mental Model Comparison

| Concept | React | Bascik |
| --- | --- | --- |
| Component definition | JSX function returning React elements | Plain `.html` file in `src/components/` |
| Component invocation | `<SiteNav prop="val" />` (requires import) | `<site-nav data-bascik-prop-*="val"></site-nav>` (auto-resolved) |
| Child content | `props.children` | `<div data-bascik-slot></div>` |
| Named content areas | Render props / Compound components | Named slots (`data-bascik-slot="name"`) |
| Scoped styles | CSS Modules (`styles.foo`) / CSS-in-JS | Paired `.css` files or inline `<style>` (auto-scoped) |
| Client interactivity | `useState`, `useEffect`, SyntheticEvents | Standard vanilla DOM APIs in `<script>` tags |
| Build output | JS bundles + Client hydration runtime | Vanilla HTML, CSS, and optional scoped JS |

## A Low-Risk First Step

Migrate a simple static component (such as a card or navigation bar) to get familiar with Bascik's HTML component format:

1. Create a project with `npm create bascik@latest my-site`.
2. Extract your JSX markup into a standard HTML file in `src/components/site-nav/site-nav.html`.
3. Move your CSS Module rules into `src/components/site-nav/site-nav.css`.
4. Use `<site-nav></site-nav>` inside `src/pages/index.html` without import statements.
5. Run `npm run dev` to inspect the scoped output.

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

> **Text only:** Props accept plain text strings, which Bascik escapes. Boolean and number props arrive as text too, so a `stocked={true}` prop becomes `data-bascik-prop-stocked="true"` and a script compares it with the string. Object and array props have no equivalent. For rich HTML content, use a named slot instead. For computed or array-based content, print one component per item from a `<script data-bascik-build>` block.

A prop can also land in an attribute instead of the text, which is how a value reaches a CSS selector or a script without a wrapper element:

```html
<!-- src/components/product-row/product-row.html -->
<tr data-bascik-attr-data-stocked="stocked">
  <td data-bascik-prop-name></td>
</tr>
```

See [Props](/props#put-a-prop-in-an-attribute) for the rules.

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

The script does the work React does on every render: it changes the DOM itself. There is no re-render, so a value that more than one element shows has to be written to each of them by your code. Keep the state in one variable, and put the code that applies it to the page in one function that you call after every change.

> **Lifecycle differs.** A component script runs once, when the browser reaches it, and not once per render. Production HTML minification moves component scripts to the end of the document, while the development server leaves them where the component is, so never rely on a later element existing when the script starts. Look elements up inside an event handler, or after `DOMContentLoaded`.

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

## Lifting State Up → Events and Script Ownership

React's rule is that state lives in the closest common parent, which passes values down as props and callbacks down as functions. Bascik props are text, so a callback cannot be passed. Invert the direction with a DOM event.

- The component that holds the state is a component with a script. It keeps the state in ordinary variables and listens for events.
- A child that collects input reports it with a bubbling `CustomEvent` dispatched from one of its own elements. It owns no state.
- Values that flow down are applied by the parent's script to the DOM, usually by setting the `hidden` attribute, a `data-` attribute, or text.

```html
<!-- src/components/search-bar/search-bar.html: the child reports -->
<form id="form"><input id="text" type="text" aria-label="Search"></form>
<script>
  const form = document.getElementById('form');
  const text = document.getElementById('text');
  text.addEventListener('input', () => {
    form.dispatchEvent(new CustomEvent('filterchange', { bubbles: true, detail: { filterText: text.value } }));
  });
</script>
```

```html
<!-- src/components/filterable-list/filterable-list.html: the parent owns the state -->
<div id="root">
  <search-bar></search-bar>
</div>
<script>
  const root = document.getElementById('root');
  let filterText = '';
  root.addEventListener('filterchange', (event) => {
    filterText = event.detail.filterText;
    // Apply filterText to the page here.
  });
</script>
```

Because the event is dispatched from an element inside the child and bubbles, the parent's listener on its own root element hears it, and only the parent that contains that child hears it. Two copies of the parent on one page filter independently.

> **Plain fields can disagree with the state.** A controlled React input always shows its state. A plain input can show something else after the browser restores typed values on Back or on a reload. Report the fields again on `pageshow` so the script and the page agree.
>
> **Pressing Enter in a form.** A form with one text box submits when the user presses Enter, which reloads the page. Call `preventDefault()` in a `submit` listener if the form only drives a script.

## Composing Components

A component template can use another component, and the nested component resolves. To pass the outer component's `children` through to the inner one, put a default slot marker between the inner component's tags. This is React's `<Inner>{children}</Inner>`:

```html
<!-- src/components/outer-box/outer-box.html -->
<div class="outer"><inner-box><div data-bascik-slot>No content provided.</div></inner-box></div>
```

```html
<outer-box><p>content</p></outer-box>
```

The `<p>` lands in the inner component's slot. With no content between the `<outer-box>` tags, the marker's own text is used. Only the default slot is forwarded this way. A named wrapper written between the inner component's tags belongs to the inner component and fills its named slot.

## React Router → One .html File Per Route

Replace client-side route definitions with files in `src/pages/`. There is no client-side navigation, every link triggers a full page load. Static routes are one `.html` file per URL. A parameterized route such as `/blog/:slug` is a [dynamic route](/dynamic-routes): one template with a bracketed folder name and a `<script data-bascik-routes>` block that prints the list of slugs.

```text
Before (React Router)        After (Bascik)
src/App.jsx                  src/pages/
  <Route path="/" />           index.html
  <Route path="/about" />      about/index.html
  <Route path="/blog/:slug" /> blog/[slug]/index.html
```

```html
<!-- src/pages/blog/[slug]/index.html -->
<script data-bascik-routes>
  console.log(JSON.stringify([
    { params: { slug: 'my-first-post' }, data: { title: 'My first post' } },
    { params: { slug: 'another-post' }, data: { title: 'Another post' } },
  ]));
</script>
<script data-bascik-build>
  const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');
  console.log(`<h1>${route.data.title}</h1>`);
</script>
```

That builds `/blog/my-first-post/` and `/blog/another-post/`. Do not write a script that generates page files into `src/pages/`. A route parameter cannot contain `/`, so use one template per depth. Routes are decided at build time: a path the build did not produce is a 404, and no code in the browser can create one.

## Conditional Rendering

Bascik has no build-time equivalent of `{condition && <Comp />}`. Choose one of two approaches:

- **Build-time decision:** Include the correct markup in each page's `.html` file directly. If two pages differ, they have different HTML. This is the right choice for things like per-page hero sections or feature flags.
- **Runtime toggle:** Render both branches, then show or hide them with the `hidden` attribute, CSS (`display: none`), or vanilla JS toggling a `data-` attribute or class. An element with `hidden` is also removed from the accessibility tree.

A React `.map()` that renders a list from data is the same split. When the data is known at build time, print the items from a build script. When the user decides which items show, print them all and hide the ones that do not match.

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
      const escape = (text) => text.replace(/[&<>"']/g, (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
      const items = files
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const slug = f.replace('.md', '');
          return `<li><a href="/blog/${escape(slug)}">${escape(slug)}</a></li>`;
        });
      console.log(items.join('\n'));
    </script>
  </ul>
</main>
```

JSX escapes interpolated values for you. A template string does not, so escape every value that comes from a file name, a CMS, or an API before you print it.

> **Build scripts run first:** The output of a `<script data-bascik-build>` block can itself contain Bascik component tags. They are resolved in the next pass. A component that only a build script prints is reported as unused by `bascik --check`.

The script runs once at build time, so the data is in the HTML that ships. A page that needs data which changes after the build fetches it with `fetch()` in a component `<script>`, which is the browser-side `useEffect`.

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
