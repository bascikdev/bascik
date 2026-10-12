<!-- Content for home page demo code blocks extracted by docs/src/pages/index.html. -->

<!-- demo:home-nav-component -->
```html
<!-- src/components/site-nav.html -->
<style>
  .nav {
    display: flex;
    gap: 24px;
    padding: 16px 28px;
    border-bottom: 3px solid #d3ff8d;
  }
  .link { color: #d3ff8d; }
  .link:hover { text-decoration: underline; }
</style>
<nav class="nav">
  <a class="link" href="/">Home</a>
  <a class="link" href="/why-bascik">Why Bascik</a>
  <a class="link" href="/getting-started">Docs</a>
</nav>
```

<!-- demo:home-nav-usage -->
```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<body>
  <site-nav />
  <h1>Welcome</h1>
</body>
</html>
```

<!-- demo:home-nav-output -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__site-nav__nav {
      display: flex;
      gap: 24px;
      padding: 16px 28px;
      border-bottom: 3px solid #d3ff8d;
    }
    .bascik__site-nav__link { color: #d3ff8d; }
    .bascik__site-nav__link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <nav class="bascik__site-nav__nav">
    <a class="bascik__site-nav__link" href="/">Home</a>
    <a class="bascik__site-nav__link" href="/components">Components</a>
    <a class="bascik__site-nav__link" href="/slots">Slots</a>
  </nav>
  <h1>Welcome</h1>
</body>
</html>
```

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

<!-- demo:home-slot-component -->
```html
<!-- src/components/dialog-box.html -->
<style>
  .dialog {
    border: 1px solid #3a3d40;
    border-radius: 8px;
    padding: 20px;
    background: #1e2022;
  }
  .header {
    border-bottom: 1px solid #2e3032;
    padding-bottom: 10px;
    margin-bottom: 14px;
    font-weight: 700;
  }
</style>

<div class="dialog">
  <div class="header">
    <div data-bascik-slot="header">
      <span>Notice</span>
    </div>
  </div>
  <div class="body">
    <div data-bascik-slot>
      <p>Default content if no slot content was provided.</p>
    </div>
  </div>
</div>
```

<!-- demo:home-slot-usage -->
```html
<!-- src/pages/index.html -->
<dialog-box>
  <span data-bascik-slot="header">Account Settings</span>
  <p>Your components accept slots, attributes, and regular HTML tags.</p>
  <button type="button">Save Changes</button>
</dialog-box>
```

<!-- demo:home-slot-output -->
```html
<!-- dist/index.html -->
<style>
  .bascik__dialog-box__dialog {
    border: 1px solid #3a3d40;
    border-radius: 8px;
    padding: 20px;
    background: #1e2022;
  }
  .bascik__dialog-box__header {
    border-bottom: 1px solid #2e3032;
    padding-bottom: 10px;
    margin-bottom: 14px;
    font-weight: 700;
  }
</style>

<div class="bascik__dialog-box__dialog">
  <div class="bascik__dialog-box__header">
    <span>Account Settings</span>
  </div>
  <div class="bascik__dialog-box__body">
    <p>Your components accept slots, attributes, and regular HTML tags.</p>
    <button type="button">Save Changes</button>
  </div>
</div>
```

<!-- demo:home-stream-card -->
```html
<!-- 1. Skeletons and footer flush in the very first byte. Zero wait. -->
<div class="stream-layout">
  <div class="skeleton" role="status">Loading live metrics...</div>

  <!-- 2. Async backend finishes, flushes straight into the open connection -->
  <div class="slot">
    <script data-bascik-stream>
      import { escape } from '@/lib/server.ts';

      export default async function (request, context, { signal }) {
        const stats = await fetchDatabaseStats({ signal });
        return `<article class="card"><h3>${escape(stats.cluster)}</h3><p>99.99% Uptime</p></article>`;
      }
    </script>
  </div>
</div>
```

<!-- demo:home-stream-css -->
```css
/* 3. Pure CSS: :has() swaps the skeleton out the moment HTML arrives */
.stream-layout:has(.card) .skeleton {
  display: none;
}

/* 4. CSS flex order: footer sent in chunk 1, but sits visually at the bottom */
footer {
  order: 99;
}
```
