<!-- demo:attribute-inheritance-id-free-in -->
```html
<!-- template root -->
<div class="x">...</div>

<!-- usage -->
<plain-id id="outer" class="extra" />
```

<!-- demo:attribute-inheritance-id-free-out -->
```html
<div class="bascik__plain-id__x extra" id="outer">...</div>
```

<!-- demo:attribute-inheritance-id-own-in -->
```html
<!-- template root -->
<div class="x" id="mine">...</div>

<!-- usage -->
<own-id id="outer" class="extra" />
```

<!-- demo:attribute-inheritance-id-own-out -->
```html
<div class="bascik__own-id__x extra" id="bascik__own-id__a1b2c3d4__mine">...</div>
```
