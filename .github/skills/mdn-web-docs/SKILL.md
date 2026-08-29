---
name: mdn-web-docs
description: Look up, reference, and verify HTML, CSS, JavaScript, Web APIs, accessibility, and browser compatibility data using MDN Web Docs. Use when checking Web API signatures, CSS property syntax, Baseline support status, or vanilla JS patterns.
---

# MDN Web Docs Reference & Research Skill

MDN Web Docs ([https://developer.mozilla.org/en-US/](https://developer.mozilla.org/en-US/)) is the authoritative developer documentation for vanilla web technologies: HTML, CSS, JavaScript, Web APIs, ARIA, and HTTP.

When developing Bascik (`pkg/`), writing documentation (`docs/`), or authoring component scoping rules, use MDN documentation to verify standard syntax, method signatures, Baseline support, and best practices.

---

## 1. Primary Documentation Hubs on MDN

| Topic | Direct Hub URL | Key Areas Covered |
| :--- | :--- | :--- |
| **HTML** | [https://developer.mozilla.org/en-US/docs/Web/HTML](https://developer.mozilla.org/en-US/docs/Web/HTML) | Elements reference, global attributes, `data-*` custom attributes, form semantics |
| **CSS** | [https://developer.mozilla.org/en-US/docs/Web/CSS](https://developer.mozilla.org/en-US/docs/Web/CSS) | Properties, selectors, pseudo-classes, at-rules (`@container`, `@layer`, `@keyframes`, `@scope`), CSS nesting |
| **JavaScript** | [https://developer.mozilla.org/en-US/docs/Web/JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript) | Language reference, built-in objects, regular expressions, modules |
| **Web APIs & DOM** | [https://developer.mozilla.org/en-US/docs/Web/API](https://developer.mozilla.org/en-US/docs/Web/API) | `Document`, `Element`, `EventTarget`, `CustomEvent`, `EventSource` (SSE), `MutationObserver` |
| **Accessibility (ARIA)** | [https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA) | ARIA roles, states, properties, and HTML semantic equivalents |
| **HTTP & Security** | [https://developer.mozilla.org/en-US/docs/Web/HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP) | Status codes, headers, MIME types, caching policies, ALPN/HTTP2, Server-Sent Events |

---

## 2. URL Conventions & Direct Path Lookups

MDN uses predictable URL structures. You can construct direct canonical URLs for almost any feature:

### HTML Elements & Attributes
* **HTML Element:** `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/<element-name>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template`
* **Global Attributes:** `https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/<attribute-name>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/data-*`

### CSS Properties, Selectors, and At-Rules
* **CSS Property:** `https://developer.mozilla.org/en-US/docs/Web/CSS/<property-name>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/container-type`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme`
* **CSS Pseudo-classes:** `https://developer.mozilla.org/en-US/docs/Web/CSS/:<pseudo-name>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/:has`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/:is`
* **CSS At-Rules:** `https://developer.mozilla.org/en-US/docs/Web/CSS/@<rule-name>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/@container`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/CSS/@layer`
* **CSS Nesting:** `https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_nesting/Using_CSS_nesting`

### Web APIs & DOM Interfaces
* **Interface / Class:** `https://developer.mozilla.org/en-US/docs/Web/API/<Interface>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/API/Element`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/API/EventSource`
* **Method / Property:** `https://developer.mozilla.org/en-US/docs/Web/API/<Interface>/<member>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/API/Element/querySelector`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/API/Element/closest`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/API/Document/getElementById`

### JavaScript Built-ins
* **Global Object / Method:** `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/<Object>/<method>`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace`
  * *Example:* `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp`

---

## 3. How to Verify Compatibility & Baseline Status

MDN includes the standard **Browser Compatibility Data (BCD)** table and **Baseline** status at the top and bottom of each page:

1. **Baseline Widely Available:** Supported across all major browsers (Chrome, Edge, Firefox, Safari) for at least 30 months. Safe for unconditional default output in Bascik without polyfills.
2. **Baseline Newly Available:** Supported across all major evergreen browsers recently. Supported in Bascik with documentation notes in `docs/content/compatibility.md`.
3. **Limited Availability / Non-Standard:** Feature is not yet supported in all engines. If supported by Bascik, mark with clear compatibility callouts.
4. **Deprecated / Obsolete:** Do not introduce into Bascik runtime, components, or docs examples.

---

## 4. MDN Search & Discovery Workflow

When researching unfamiliar web APIs or verifying spec details:

1. **Construct Canonical MDN URL:** Use the URL patterns in Section 2 to navigate directly to the target API documentation.
2. **Inspect Syntax & Formal Definition:** Check parameter types, return values, exceptions thrown, and edge case behaviors (such as handling `null` or special tokens).
3. **Review "Specifications" Section:** MDN links directly to the underlying W3C or WHATWG specification section at the bottom of each page.
4. **Check Interactive Examples:** Verify vanilla JavaScript and CSS usage patterns to ensure Bascik examples use modern, idiomatic web standards.
