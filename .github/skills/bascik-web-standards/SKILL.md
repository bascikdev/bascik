---
name: bascik-web-standards
description: Reference and compliance guidelines for W3C, WHATWG, and ECMA web standards in Bascik. Use when implementing HTML component scoping, CSS selector parsing, DOM query rewriting, custom element syntax, ARIA semantics, or ensuring spec-compliant build output.
---

# Web Standards Compliance in Bascik (W3C / WHATWG / ECMA)

Bascik is designed to produce zero-runtime-overhead vanilla web code that adheres strictly to published Web Standards (W3C Recommendations, WHATWG Living Standards, and ECMA-262 specifications).

When authoring, compiling, or transforming HTML, CSS, and JavaScript in Bascik, use these specifications as the authoritative ground truth rather than framework-specific conventions.

---

## 1. Authoritative Standards Specifications & Search Indexes

### Primary Specification Hubs
* **W3C Technical Reports Index:** [https://www.w3.org/TR/?status%5B0%5D=standard](https://www.w3.org/TR/?status%5B0%5D=standard) (Filter by Recommendations / Candidate Recommendations).
* **W3C CSS Current Work & Index:** [https://www.w3.org/Style/CSS/current-work](https://www.w3.org/Style/CSS/current-work) (Full index of all CSS module levels, stable specs, and editors' drafts).
* **HTML Living Standard (WHATWG):** [https://html.spec.whatwg.org/multipage/](https://html.spec.whatwg.org/multipage/) (or single-page for in-browser searching: [https://html.spec.whatwg.org/](https://html.spec.whatwg.org/)).
* **DOM Living Standard (WHATWG):** [https://dom.spec.whatwg.org/](https://dom.spec.whatwg.org/).
* **Web Platform Tests & Browser Compatibility:** [https://wpt.fyi/](https://wpt.fyi/) and [https://caniuse.com/](https://caniuse.com/).

### Specific Module References
* **CSS Selectors Level 4:** [https://www.w3.org/TR/selectors-4/](https://www.w3.org/TR/selectors-4/) (Nesting, `:is()`, `:where()`, `:has()`, `:not()`, specificity calculation).
* **CSS Cascading & Inheritance Level 5 & 6:** [https://www.w3.org/TR/css-cascade-5/](https://www.w3.org/TR/css-cascade-5/) (`@layer`, `@scope`, origin order).
* **CSS Custom Properties Level 1:** [https://www.w3.org/TR/css-variables-1/](https://www.w3.org/TR/css-variables-1/) (`var(--name)` and property resolution).
* **CSS Containment Level 3:** [https://www.w3.org/TR/css-contain-3/](https://www.w3.org/TR/css-contain-3/) (`@container` queries and named containers).
* **WAI-ARIA 1.2 / 1.3:** [https://www.w3.org/TR/wai-aria-1.2/](https://www.w3.org/TR/wai-aria-1.2/) (Accessibility roles, states, and properties).
* **ECMA-262 (ECMAScript):** [https://tc39.es/ecma262/](https://tc39.es/ecma262/) (Language specification for JS engine behavior).

---

## 2. How to Look Up and Verify Standards

When implementing or validating features in Bascik, follow this research and verification process:

### Step 1: Locate the Canonical Spec Section
1. **HTML Elements and Attributes:**
   - Search the WHATWG HTML standard (`https://html.spec.whatwg.org/multipage/indices.html#elements-3` or `https://html.spec.whatwg.org/multipage/indices.html#attributes-3`).
   - For custom element naming rules, check §4.13.1.2 (`#valid-custom-element-name`).
   - For custom data attributes, check §3.2.6.6 (`#embedding-custom-non-visible-data-with-the-data-attributes`).
2. **CSS Properties and Selectors:**
   - Search the W3C CSS Current Work index (`https://www.w3.org/Style/CSS/current-work`).
   - Check the formal grammar syntax box (e.g. `<selector-list>`, `<forgiving-selector-list>`) at the top of each spec section.
3. **DOM Methods & Events:**
   - Search the WHATWG DOM specification (`https://dom.spec.whatwg.org/#interface-element` or `#interface-document`).

### Step 2: Check Specification Maturity Status
Always verify the maturity tier of the specification:
* **W3C Recommendation (REC) / WHATWG Living Standard:** Fully ratified standard. Safe and required for baseline Bascik behavior.
* **Candidate Recommendation (CR / CRD):** Stable specification undergoing implementation validation. Fully supported if widely implemented in evergreen browsers (Baseline).
* **Working Draft (WD) / Editor's Draft (ED):** In-progress proposals. Support cautiously and record status in `docs/content/compatibility.md`.
* **Vendor-prefixed / Proprietary:** Reject or isolate behind explicit opt-in flags.

### Step 3: Disambiguate Browser Quirks vs. Standards
* If a browser behaves differently from the spec, the **W3C Recommendation / WHATWG Living Standard grammar is the source of truth** for Bascik's parser.
* Check [https://wpt.fyi/](https://wpt.fyi/) (Web Platform Tests) to see cross-engine test suites and consensus behavior.

---

## 3. Core Web Standards Principles in Bascik

### 1. Custom Elements & Valid HTML Names (WHATWG HTML §4.13)
* Custom tag names must contain a hyphen (`-`), start with an ASCII lowercase letter, and not collide with reserved SVG/MathML namespaces or deprecated HTML tags.
* Example: `<my-card>` is valid; `<mycard>` or `<font-face>` is invalid.

### 2. Attribute Syntax & `data-*` Custom Data Attributes (WHATWG HTML §3.2.6.6)
* Bascik internal scoping markers and directives use standard `data-*` attributes (`data-bascik-s-*`, `data-bascik-slot`, `data-bascik-prop-*`, `data-bascik-build`, `data-bascik-server`).
* `data-*` attribute names must not contain uppercase ASCII characters or characters outside the XML-compatible NCName set.

### 3. CSS Selector Semantics & Specificity (W3C Selectors 4)
* Attribute scoping (`.card[data-bascik-s-abc]`) adds $(0, 1, 0)$ specificity over class selectors.
* Pseudo-classes like `:where()` add $(0, 0, 0)$ specificity, while `:is()` and `:not()` take the specificity of their most specific argument.
* CSS Scoping transformations must never produce invalid selector grammar (e.g. invalid combinators or double colons in pseudo-elements).

### 4. DOM Standard Query Equivalents (WHATWG DOM §4)
* Bascik JS scoping transforms standard DOM lookups (`document.getElementById`, `document.querySelector`, `element.querySelectorAll`, `closest`).
* Scoped script rewriting must preserve the native return types (`Element | null`, `NodeList`, `HTMLCollection`) and standard event dispatch semantics (`CustomEvent`, `EventTarget`).

### 5. Semantic HTML & ARIA Accessibility (W3C WAI-ARIA)
* Avoid `div` soup. Favor native HTML semantic elements (`<nav>`, `<main>`, `<article>`, `<section>`, `<aside>`, `<header>`, `<footer>`, `<figure>`, `<time>`).
* Do not override native semantics with redundant ARIA roles (e.g. `<button role="button">` is discouraged by W3C HTML-ARIA rules).

---

## 4. Web Quality & Standards Validation Tools in Bascik

The Bascik repository enforces standards compliance via integrated tooling:

* **`webhint` (`hint`):** Automated static analysis checking cross-browser compatibility, HTML valid markup, ARIA best practices, and HTTP security headers. Run via:
  ```sh
  yarn check:standards
  ```
* **`codespell`:** Validates American English spelling across source code and docs:
  ```sh
  yarn check:spelling
  ```
* **Lighthouse Standards Auditing:** Audits accessibility, SEO, and web best practices:
  ```sh
  npx vitest run docs/lighthouse/lighthouserc.test.ts
  ```

---

## 5. Grounding Check for New Features

When adding or refactoring features in `pkg/src/`:
1. Check the relevant W3C Recommendation or WHATWG Living Standard first.
2. Confirm the syntax is part of the official specification rather than proprietary browser behavior or transient bundler conventions.
3. Update `docs/content/compatibility.md` with the corresponding standard and support status.
