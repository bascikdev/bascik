<!-- Content for home page demo code blocks extracted by docs/src/pages/index.html. -->

<!-- demo:home-build-output -->
```text
$ bascik
transpiled: pages/404.html
transpiled: pages/index.html
transpiled: pages/cli.html
transpiled: pages/license.html
transpiled: pages/getting-started.html
...
✓ 59 pages transpiled in 1421ms
Server running at http://localhost:8080
```

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
