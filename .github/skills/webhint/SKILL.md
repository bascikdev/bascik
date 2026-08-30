---
name: webhint
description: Guide for configuring and using Webhint (hint) for accessibility, cross-browser compatibility, web standards, and performance auditing. Use when creating or modifying .hintrc files, configuring hints, overriding severities, setting up ignoredUrls, or integrating webhint in VS Code and CI.
---

# Webhint Configuration and Audit Guide

Webhint (`hint`) is a linting and auditing tool for web standards, accessibility (via axe), cross-browser CSS/JS compatibility, security, and performance.

---

## 1. Webhint Configuration Methods

Webhint loads its project configuration from one of three sources in order of precedence:

1. **`.hintrc` File:** A JSON configuration file placed in the project or package root (recommended).
2. **`package.json` `hintConfig` Property:** Inline configuration defined inside `package.json`.
3. **Environment Variables:** Dynamic property overrides using `webhint_*` environment variables.

---

## 2. `.hintrc` Structure & Core Properties

```json
{
  "extends": [
    "development"
  ],
  "connector": {
    "name": "local"
  },
  "formatters": [
    "stylish"
  ],
  "parsers": [
    "html",
    "css",
    "javascript"
  ],
  "hints": {
    "apple-touch-icons": "off",
    "meta-viewport": "off",
    "meta-charset-utf-8": "off",
    "button-type": "warning",
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

### Key Configuration Sections
* **`extends`**: Inherits preset rule sets:
  * `"development"`: Best practices for local development workflows.
  * `"web-recommended"`: Standard production web guidelines.
  * `"accessibility"`: Focused accessibility auditing.
  * `"progressive-web-apps"`: PWA manifest and service worker requirements.
* **`connector`**: Defines how resources are retrieved (`"local"` for static local files, `"jsdom"` or `"puppeteer"` for browser rendering).
* **`formatters`**: Output formats (`"stylish"`, `"codeframe"`, `"summary"`, `"html"`, `"json"`).
* **`parsers`**: File AST parsers (`"html"`, `"css"`, `"javascript"`, `"typescript"`, `"babel-config"`).

---

## 3. Configuring Hints and Severities

### Severity Levels
* **`"off"`** (or `"-"` prefix): Disables the hint completely.
* **`"error"`**: Critical standards violation; must be fixed immediately.
* **`"warning"`**: Potential problem or browser compatibility issue to investigate.
* **`"hint"`**: Minor optimization or code style suggestion.
* **`"information"`**: Informational notice.

### Hint Syntax Variations

#### Object Syntax (Recommended)
```json
{
  "hints": {
    "button-type": "error",
    "meta-viewport": "off",
    "compat-api/css": [
      "default",
      {
        "ignore": ["scrollbar-width"]
      }
    ]
  }
}
```

#### Array Syntax
```json
{
  "hints": [
    "button-type:error",
    "-meta-viewport",
    [
      "compat-api/css:warning",
      {
        "ignore": ["scrollbar-width"]
      }
    ]
  ]
}
```

---

## 4. Ignoring Domains, Test Directories, and Build Artifacts (`ignoredUrls`)

To prevent false positives on test files, generated build artifacts, or third-party URLs, use the `ignoredUrls` array.

```json
{
  "ignoredUrls": [
    {
      "domain": ".*[\\\\/](e2e|dist|test-results|coverage|hint-report)[\\\\/].*",
      "hints": [
        "*"
      ]
    },
    {
      "domain": "www.external-analytics.com",
      "hints": [
        "no-disallowed-headers"
      ]
    }
  ]
}
```

* **`domain`**: String or regular expression matching target file paths or URLs.
* **`hints`**: Array of hint IDs to ignore on matching URLs, or `["*"]` to ignore all hints.

---

## 5. Setting Properties via Environment Variables

Properties can be overridden dynamically using environment variables prefixed with `webhint_`:

* Nesting is represented using underscores (`_`).
* **Example:** `webhint_connector_options_waitFor=60000` corresponds to `.hintrc` `{ "connector": { "options": { "waitFor": 60000 } } }`.
* *Note:* Environment variables are ignored if the exact key is explicitly defined in `.hintrc`.

---

## 6. Bascik Component & Partial Gotchas

When auditing Bascik HTML source files:

1. **HTML Component Partials:** Source templates (`src/pages/*.html` or `src/components/*.html`) may omit document-level tags (`<meta charset="utf-8">` or `<meta name="viewport">`) if those tags are injected centrally via component partials (such as `<docs-head />`). Disable `meta-charset-utf-8` and `meta-viewport` in `.hintrc` for component source trees.
2. **Interactive Elements:** Ensure all `<button>` elements explicitly include `type="button"` (or `type="submit"` / `type="reset"`).
3. **Form Accessibility (`axe/forms`):** Ensure inputs have associated `<label>` tags, `aria-label`, or `title` attributes. Test inputs in `e2e/` test suites should be excluded via `ignoredUrls` in `.hintrc`.
