<!-- demo:scoped-styles-global-classes-in -->
```html
<a class="skip-link dnav-logo">
```

<!-- demo:scoped-styles-global-classes-out -->
```html
<a class="skip-link bascik__site-nav__dnav-logo">
```

<!-- demo:scoped-styles-custom-properties-local-in -->
```css
.card {
  --signal-color: #d3ff8d;
  background: var(--signal-color);
}
```

<!-- demo:scoped-styles-custom-properties-local-out -->
```css
.bascik__brand-card__card {
  --bascik__brand-card__signal-color: #d3ff8d;
  background: var(--bascik__brand-card__signal-color);
}
```

<!-- demo:scoped-styles-custom-properties-global-in -->
```css
.card {
  background: var(--card-bg);
}
```

<!-- demo:scoped-styles-custom-properties-global-out -->
```css
.bascik__brand-card__card {
  background: var(--card-bg);
}
```
