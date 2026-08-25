# Bascik

> Bascik is a build tool for HTML components. Write your components in vanilla HTML, CSS, and JavaScript. Bascik scopes and assembles them at build time, outputting vanilla HTML pages with zero JavaScript added. Supports static site generation (SSG) out of the box.

> **Docs Site Source.** This documentation site itself is a complete, real-world Bascik site! It features complex build-time generation, such as dynamically building the navigation, rendering markdown files, extracting code blocks, generating breadcrumbs, structured schema, sitemaps, and even live-embedding coverage stats. Check out the [Bascik Docs Source Code on GitHub](https://github.com/bascikdev/bascik/tree/main/docs) to see exactly how these advanced features are structured and built.

## What Bascik Does

- Resolves custom HTML tags (`<my-nav></my-nav>`) to their component source HTML at build time.
- Scopes CSS class names, element selectors, `@keyframes`, and CSS custom properties per component so they never collide.
- Rewrites DOM selector calls (`getElementById`, `querySelector`, etc.) in component scripts to match scoped attribute names.
- Wraps component scripts in IIFEs so variables do not leak between components.
- Outputs a `dist/` directory of plain `.html` files with zero runtime dependencies and no client-side JS added by Bascik itself.
- Supports TypeScript natively; `bascik.config.ts`, build scripts, and helper modules run on Node 22.18+ with no compiler step.

## What Bascik Does Not Do

- It is not a JavaScript framework. There is no virtual DOM, no reactive state, no client-side routing.
- It does not add any JavaScript to pages. Every script in the output was written by you.
- It does not require Web Components, Shadow DOM, or any browser-specific API.

## Sub-Second Build Speeds

Bascik transpiles and scopes entire static sites in milliseconds.

The website you're on right now is a prime example of a non-trivial build. Every single one of its 50 pages executes custom Node.js build-time scripts to convert Markdown content, extract demo code blocks, generate breadcrumbs, and construct structured search schemas. Even with all of these custom build scripts, sitemap generation, and component scoping, the entire site compiles in just 1.1 seconds.

<!-- demo:home-build-output -->
```text
$ bascik
transpiled: pages/404.html
transpiled: pages/index.html
transpiled: pages/search.html
transpiled: pages/license.html
transpiled: pages/getting-started.html
...
✓ 50 pages transpiled in 1150ms
Server running at http://localhost:8080
```

## Example: One Component, Start to Finish

Create a file. The file name is the tag name. HTML, CSS, and JavaScript live together in that one file, and everything gets scoped automatically at build time.

<!-- demo:home-card-component -->
```html
<!-- src/components/my-card.html -->
<style>
  .card {
    padding: 24px 28px;
    border: 1px solid #3a3d40;
    border-top: 3px solid #d3ff8d;
    border-radius: 10px;
  }
</style>
<article class="card">
  <div data-bascik-slot></div>
</article>
```

Reference the tag in any page. No imports, no registration, no configuration.

<!-- demo:home-card-usage -->
```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<body>
  <my-card>
    <h3>My Card</h3>
    <p>Any HTML goes inside as slot content.</p>
  </my-card>
</body>
</html>
```

At build time Bascik inlines the component and scopes every class name and DOM selector:

<!-- demo:home-card-output -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__my-card__card {
      padding: 24px 28px;
      border: 1px solid #3a3d40;
      border-top: 3px solid #d3ff8d;
      border-radius: 10px;
    }
  </style>
</head>
<body>
  <article class="bascik__my-card__card">
    <h3>My Card</h3>
    <p>Any HTML goes inside as slot content.</p>
  </article>
</body>
</html>
```

## Example: Two Isolated Instances

The same component used twice on one page. Each instance gets its own namespace, so plain `getElementById` and `querySelector` calls stay fully isolated without runtime JS, Shadow DOM, or a virtual DOM.

<!-- demo:home-counter-usage -->
```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<body>
  <demo-counter data-bascik-prop-label="Instance A" />
  <demo-counter data-bascik-prop-label="Instance B" />
</body>
</html>
```
<!-- demo:home-counter-html -->
```html
<!-- src/components/demo-counter/demo-counter.html -->
<div class="ctr">
  <span class="ctr-label" data-bascik-prop-label>
    Counter
  </span>
  <span class="ctr-count" id="count">0</span>
  <div class="ctr-btns">
    <button class="ctr-dec" id="dec">−</button>
    <button class="ctr-inc" id="inc">+</button>
  </div>
</div>
<script src="demo-counter.ts"></script>
```

<!-- demo:home-counter-css -->
```css
/* src/components/demo-counter/demo-counter.css */
.ctr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.ctr-count {
  font-size: 2.4rem;
  font-weight: 700;
  color: #d3ff8d;
}
.ctr-dec, .ctr-inc {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  cursor: pointer;
}
```

<!-- demo:home-counter-js -->
```ts
// src/components/demo-counter/demo-counter.ts
const count = document.getElementById('count') as HTMLElement;
const dec   = document.getElementById('dec') as HTMLButtonElement;
const inc   = document.getElementById('inc') as HTMLButtonElement;
let n: number = 0;

dec.addEventListener('click', () => {
  n--;
  count.textContent = String(n);
});
inc.addEventListener('click', () => {
  n++;
  count.textContent = String(n);
});
```

<!-- demo:home-counter-output-html -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__demo-counter__ctr {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .bascik__demo-counter__ctr-count {
      font-size: 2.4rem;
      font-weight: 700;
      color: #d3ff8d;
    }
    .bascik__demo-counter__ctr-dec,
    .bascik__demo-counter__ctr-inc {
      width: 40px;
      height: 40px;
      border-radius: 6px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="bascik__demo-counter__ctr">
    <span class="bascik__demo-counter__ctr-label">Instance A</span>
    <span class="bascik__demo-counter__ctr-count"
          id="bascik__demo-counter__a1b2__count">0</span>
    <div class="bascik__demo-counter__ctr-btns">
      <button class="bascik__demo-counter__ctr-dec"
              id="bascik__demo-counter__a1b2__dec">−</button>
      <button class="bascik__demo-counter__ctr-inc"
              id="bascik__demo-counter__a1b2__inc">+</button>
    </div>
  </div>
  <script>
    (function() {
      const count = document.getElementById("bascik__demo-counter__a1b2__count");
      const dec   = document.getElementById("bascik__demo-counter__a1b2__dec");
      const inc   = document.getElementById("bascik__demo-counter__a1b2__inc");
      let n = 0;
      dec.addEventListener("click", () => { n--; count.textContent = String(n); });
      inc.addEventListener("click", () => { n++; count.textContent = String(n); });
    })();
  </script>
</body>
</html>
```
