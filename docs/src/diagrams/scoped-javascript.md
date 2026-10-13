<!-- demo:scoped-javascript-script-placement-dev -->
```html
<div id="panel">...</div>
<script>/* runs here */</script>
<p id="later">Not parsed yet</p>
```

<!-- demo:scoped-javascript-script-placement-prod -->
```html
<div id="panel">...</div>
<p id="later">...</p>
<script>/* runs here, after every element */</script>
</body>
```

<!-- demo:scoped-javascript-id-references-in -->
```html
<label for="email">Email</label>
<input id="email" aria-describedby="email-help">
<p id="email-help">Use your work address.</p>
```

<!-- demo:scoped-javascript-id-references-out -->
```html
<label for="bascik__signup-form__a1b2c3d4__email">Email</label>
<input id="bascik__signup-form__a1b2c3d4__email"
  aria-describedby="bascik__signup-form__a1b2c3d4__email-help">
<p id="bascik__signup-form__a1b2c3d4__email-help">Use your work address.</p>
```
