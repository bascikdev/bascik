# Linting

Automated web standards checks and HTML linting catch accessibility flaws, invalid markup, and browser compatibility issues in component templates before deployment.

## Webhint Integration

If you use the **[Webhint VS Code Extension](https://marketplace.visualstudio.com/items?itemName=webhint.vscode-webhint)** (`webhint.vscode-webhint`) or the `hint` CLI (`npx hint`), add a `.hintrc` configuration file to your project root.

Because Bascik components are standalone HTML template partials expanded into full page shells at build time, individual component files do not contain top-level `<meta name="viewport">` or `<link rel="apple-touch-icon">` tags.

## Recommended `.hintrc` Configuration

```json
{
  "extends": [
    "development"
  ],
  "hints": {
    "apple-touch-icons": "off",
    "compat-api/css": [
      "default",
      {
        "ignore": [
          "scrollbar-width"
        ]
      }
    ],
    "meta-viewport": "off"
  }
}
```

## Configuration Rationale

- **`apple-touch-icons: off`**: Component templates are partials rendered inside full page shells. Apple touch icons belong in the top-level page `<head>`, not in individual component templates.
- **`meta-viewport: off`**: Viewport metadata tags are declared once in page layout templates, so checking for them inside component `.html` files produces false positives.
- **`compat-api/css`**: Ignores specific modern CSS property compatibility checks (like `scrollbar-width`) where progressive enhancement and fallback behavior are intentional.
