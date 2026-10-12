<!-- demo:preserve-references-scoped-in -->
```html
<label for="email">Email</label>
<input id="email">
```

<!-- demo:preserve-references-scoped-out -->
```html
<label for="bascik__form__a1b__email">Email</label>
<input id="bascik__form__a1b__email">
```

<!-- demo:preserve-references-target-in -->
```html
<label for="email">Email</label>
<input id="email" data-bascik-preserve="id">
```

<!-- demo:preserve-references-target-out -->
```html
<label for="email">Email</label>
<input id="email">
```

<!-- demo:preserve-references-link-in -->
```html
<nav data-bascik-preserve="id"><a href="#target">Jump</a></nav>
<section id="target">Content</section>
```

<!-- demo:preserve-references-link-out -->
```html
<nav><a href="#target">Jump</a></nav>
<section id="bascik__page__a1b__target">Content</section>
```
