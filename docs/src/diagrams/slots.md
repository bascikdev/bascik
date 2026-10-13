<!-- demo:slots-zones-template -->
```html
<section class="panel">
  <header data-bascik-slot="title"></header>
  <div data-bascik-slot></div>
  <footer data-bascik-slot="actions">No actions</footer>
</section>
```

<!-- demo:slots-zones-usage -->
```html
<panel-box>
  <div data-bascik-slot="title"><h3>Hello</h3></div>
  <p>Body text</p>
</panel-box>
```

<!-- demo:slots-zones-out -->
```html
<section class="bascik__panel-box__panel">
  <h3>Hello</h3>
  <p>Body text</p>
  No actions
</section>
```
