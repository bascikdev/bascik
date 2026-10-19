# Theming

Bascik styles a site in two layers: one global stylesheet that declares design tokens and base styles, and component CSS that uses those tokens. This page covers the token stylesheet, light and dark themes, a theme toggle with no flash on load, and web fonts. The [starter site](https://github.com/bascikdev/bascik/tree/main/examples/starter-site) in the Bascik repository uses all of it.

## Two Layers

| Layer     | Where                                                                                                      | Holds                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Global    | One stylesheet under `src/pages/`, such as `src/pages/css/styles.css`, linked from a shared head component | Design tokens (`--color-*`, `--space-*`, `--font-*`), the reset, base element styles, `@font-face`, and a few helper classes |
| Component | Each component's `<style>` block or companion `.css` file                                                  | The layout and look of that component, written with the tokens                                                               |

**Declare tokens once, globally, and only read them in components.** A custom property a component declares is renamed to that component (`--brand` becomes `--bascik__card__brand`), so declaring a token inside a component makes a private copy the rest of the site cannot see. A token a component only reads with `var()` is left alone and resolves to the global value. See [Scoped Styles](/scoped-styles#using-global-design-tokens-in-a-component).

- Do not set site-wide tokens with `:root {}` or `html {}` inside a component. The selector stays global, but the property names inside it are still renamed.
- Give components that may be reused elsewhere a fallback: `var(--color-border, currentColor)`.
- Classes a component's stylesheet does not define stay global, so `class="container"` in a component uses the global `.container`.

## Tokens

Name tokens by their role, not their value, so a theme change never renames anything:

```css
:root {
  color-scheme: light dark;

  --color-bg: light-dark(#ffffff, #121316);
  --color-surface: light-dark(#f4f5f7, #1c1e22);
  --color-text: light-dark(#1b1d21, #e8e9ec);
  --color-muted: light-dark(#5b616e, #a2a8b4);
  --color-border: light-dark(#d9dce1, #33363d);
  --color-accent: light-dark(#2457d6, #8ab0ff);

  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --radius: 0.5rem;
}
```

Keep the list short. A component that needs a one-off value can write the value directly. Derive shades with `color-mix()` instead of adding tokens: `color-mix(in srgb, var(--color-accent) 12%, transparent)`.

## Light and Dark Themes

`light-dark()` returns its first value when the element's `color-scheme` is light and its second when it is dark. With `color-scheme: light dark` the operating system decides. Two rules let a visitor's choice override it:

```css
:root[data-theme="light"] {
  color-scheme: light;
}
:root[data-theme="dark"] {
  color-scheme: dark;
}
```

Setting `data-theme` on `<html>` is then the whole theme switch: every token follows, and `color-scheme` also themes form controls, scrollbars, and the page background. `light-dark()` reached Baseline in 2024. To support older browsers, repeat the tokens inside `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` blocks instead.

When a component needs a theme-specific rule that a token cannot express, target `html`, which Bascik never renames:

```css
html[data-theme="dark"] .card {
  box-shadow: none;
}
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) .card {
    box-shadow: none;
  }
}
```

Both blocks are needed, one for a saved dark choice and one for a dark system setting with no saved choice. Tokens avoid this.

## A Toggle Without a Flash

The saved choice has to be applied before the page renders, or the page flashes the wrong theme. A small script in `<head>` reads `localStorage` and sets `data-theme` synchronously; a button elsewhere changes and saves it. Both are shown working in [Theme Toggle](/example-components/theme-toggle).

- Put the head script in a component used inside `<head>`. Bascik keeps that component's script in `<head>`, where it runs before the body renders.
- Keep it tiny and free of imports: anything in `<head>` delays rendering.
- Hide the toggle button until its script runs, so a visitor without JavaScript never sees a button that does nothing.

### Three-Way Switch

To offer system, light, and dark, use a `<select>` and remove the saved value for "system":

```html
<label for="theme">Theme</label>
<select class="select" id="theme">
  <option value="system">System</option>
  <option value="light">Light</option>
  <option value="dark">Dark</option>
</select>
<script>
  const select = document.getElementById("theme");
  select.value =
    document.documentElement.getAttribute("data-theme") ?? "system";
  select.addEventListener("change", () => {
    if (select.value === "system") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("theme");
    } else {
      document.documentElement.setAttribute("data-theme", select.value);
      localStorage.setItem("theme", select.value);
    }
  });
</script>
```

## Images in Dark Mode

```html
<picture>
  <source srcset="/img/diagram-dark.png" media="(prefers-color-scheme: dark)" />
  <img
    src="/img/diagram-light.png"
    alt="How a request reaches the server"
    width="800"
    height="400"
  />
</picture>
```

`<picture>` follows the operating system, not a saved choice. When the toggle must win, render both images and hide one with `html[data-theme="dark"]` rules.

## Fonts

Start with a system font stack: it costs nothing to load. To add a web font, self-host it and declare it once in the global stylesheet:

```css
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-var.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

:root {
  --font-sans: "Inter", system-ui, sans-serif;
}
```

- Use WOFF2, and prefer one variable font file over several weights. Subset it to the characters you need.
- Never declare `@font-face` in a component: it is not scoped and would be injected with that component's styles.
- Preload only the one or two files used above the fold, with `crossorigin`, because fonts are always fetched in CORS mode: `<link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />`.
- Write font URLs root-relative. With a [`base`](/configuration) such as `/docs/`, Bascik rewrites root-relative `url()` values in stylesheets and `href` values in HTML.
- To reduce layout shift when the font swaps in, define a fallback face with `size-adjust` and the `ascent-override` and `descent-override` descriptors.

## Inline the Global Stylesheet

`assets: { inlineStyles: ['src/pages/css/styles.css'] }` injects the file into every page's `<head>` as a `<style>` block, so the first paint needs no stylesheet request. The file is then no longer copied to `dist/`, so remove the `<link>` to it in the same change. See [Lighthouse Performance](/lighthouse/performance).

## Tailwind

Tailwind runs as a `pre` [exec script](/exec-scripts), with `scoping.attributes.class: false` so its utility classes are never renamed. See [JavaScript Libraries](/libraries#tailwind-css). Tokens and Tailwind can coexist; keep one source of truth for colors.
