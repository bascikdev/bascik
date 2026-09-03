# Linting & Web Standards

Automated web standards checks and HTML linting catch accessibility flaws, invalid markup, and browser compatibility issues in component templates before deployment.

## Webhint Integration

The **[Webhint VS Code Extension](https://marketplace.visualstudio.com/items?itemName=webhint.vscode-webhint)** (`webhint.vscode-webhint`) and the `hint` CLI (`npx hint`) provide real-time standards auditing.

Bascik projects structure HTML as modular components and layout partials. Because component templates are standalone partials expanded into complete HTML documents at build time, a standard `.hintrc` configuration helps avoid false positives while catching genuine standards issues.

## Recommended `.hintrc` Configuration

Place a `.hintrc` file in your project root:

```json
{
  "extends": [
    "development"
  ],
  "hints": {
    "apple-touch-icons": "off",
    "meta-viewport": "off",
    "meta-charset-utf-8": "off",
    "detect-css-reflows/paint": "off",
    "detect-css-reflows/composite": "off",
    "compat-api/css": [
      "default",
      {
        "ignore": [
          "scrollbar-width",
          "scrollbar-width: none"
        ]
      }
    ],
    "compat-api/html": [
      "default",
      {
        "ignore": [
          "meta[name=theme-color]"
        ]
      }
    ]
  },
  "ignoredUrls": [
    {
      "domain": ".*(e2e|dist|test-results|coverage|hint-report).*",
      "hints": [
        "*"
      ]
    }
  ]
}
```

## Configuration Breakdown

### 1. Document-Level Metadata Hints (`meta-*`, `apple-touch-icons`)

In Bascik, document metadata like `<meta charset="UTF-8">`, `<meta name="viewport">`, and `<link rel="apple-touch-icon">` are usually centralized in a reusable head component (such as `<site-head />`) or page layout.

- **`meta-charset-utf-8: "off"`**: Turns off warnings for source templates where character encoding is injected dynamically via a component.
- **`meta-viewport: "off"`**: Prevents warnings in individual component templates that do not contain top-level `<head>` tags.
- **`apple-touch-icons: "off"`**: Touch icons belong in global head components rather than individual component partials.

### 2. CSS Reflow Hints (`detect-css-reflows/*`)

- **`detect-css-reflows/paint` & `detect-css-reflows/composite`: `"off"`**: Modern interactive components often animate opacity, transform, or border colors. Disabling these hints reduces noise while retaining core accessibility and compatibility auditing.

### 3. Progressive CSS Compatibility (`compat-api/css`)

- **`compat-api/css`**: Allows specific modern CSS properties (such as `scrollbar-width`) where progressive enhancement is intentional and browsers without support gracefully fall back.

### 4. Ignoring Build Output and Test Directories (`ignoredUrls`)

By default, the Webhint VS Code extension scans every HTML file in your open workspace. Without URL filtering, Webhint will attempt to parse compiled output in `dist/`, test artifacts in `e2e/`, and test coverage HTML reports.

- **`ignoredUrls`**: Matches any path containing `dist`, `e2e`, `test-results`, `coverage`, or `hint-report` and disables all hints for those files, ensuring Webhint only validates your raw source templates.

## Component Authoring Best Practices

When authoring Bascik components with Webhint enabled:

### 1. Explicit Button Types

Webhint checks that all `<button>` elements declare an explicit `type` attribute:

```html
<!-- Good: explicit type prevents default form submission -->
<button type="button" class="toggle-btn">Toggle Panel</button>

<!-- Avoid: defaults to type="submit" and triggers Webhint warning -->
<button class="toggle-btn">Toggle Panel</button>
```

### 2. Accessible Form Elements

Every form control requires an accessible label, `aria-label`, or `title` attribute:

```html
<!-- Accessible text input -->
<label for="user-email">Email Address</label>
<input id="user-email" name="email" type="email">

<!-- Accessible hidden or icon-only input -->
<input name="csrf_token" type="hidden" title="CSRF Token" aria-label="CSRF Token">
```

### 3. Valid Custom Element Names

Custom component tags must contain a hyphen and start with a lowercase letter according to WHATWG HTML specifications:

```html
<!-- Valid Bascik component tags -->
<site-nav />
<user-profile-card />

<!-- Invalid custom tags -->
<navcard />
<UserProfile />
```

## Running Lint Checks in CI

Add Webhint to your project scripts:

```json
{
  "scripts": {
    "check:standards": "npx hint src/pages"
  }
}
```

Run standards checks alongside Bascik's structural validator:

```sh
npm run check:standards && npx bascik --check
```

### Strict CI Gates with `--strict`

To fail CI pipelines if any warnings exist (such as unmatched tags or unused components), pass `--strict`:

```sh
npm run check:standards && npx bascik --check --strict
```

### Machine-Readable Diagnostics with `--json`

To integrate Bascik diagnostics with CI summary reporters or automated PR bots, pass `--json`:

```sh
npx bascik --check --json > check-report.json
```
