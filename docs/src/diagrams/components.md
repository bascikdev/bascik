<!-- demo:components-layouts-html-only -->
```text
src/components/
  my-card.html
```

<!-- demo:components-layouts-single-file -->
```text
src/components/
  my-card.html   (markup, style, script)
```

<!-- demo:components-layouts-companion -->
```text
src/components/
  my-card.html
  my-card.css
```

<!-- demo:components-layouts-subfolder -->
```text
src/components/
  my-card/
    my-card.html
    my-card.css
```

<!-- demo:components-scope-boundary-page-in -->
```html
<main id="main-content">
```

<!-- demo:components-scope-boundary-page-out -->
```html
<main id="main-content">
```

<!-- demo:components-scope-boundary-component-in -->
```html
<button id="menu">
```

<!-- demo:components-scope-boundary-component-out -->
```html
<button id="bascik__site-nav__a1b2c3d4__menu">
```

<!-- demo:components-shared-head-page -->
```html
<head>
  <site-head />
  <title>Home - My Site</title>
</head>
```

<!-- demo:components-shared-head-built -->
```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/styles.css" />
  <title>Home - My Site</title>
</head>
```
