---
audit_id: AUDIT-W3C-HTML-2026-08-29
title: W3C & WHATWG HTML, DOM & Web Components Test Suites Catalog
date_generated: "2026-08-29"
date_addressed: "2026-08-29"
git_branch: "pre-release-25"
git_commit_baseline: "e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c"
scope: "pkg/src/lib/components.ts, pkg/src/lib/html-minifier.ts, pkg/src/lib/processing.ts, pkg/src/lib/slots.ts, pkg/e2e/ (HTML Compiler & DOM)"
status: "completed"
---

# W3C & WHATWG HTML, DOM & Web Components Test Suites Catalog

| Audit Metadata | Value / Specification Context |
| :--- | :--- |
| **Audit ID** | `AUDIT-W3C-HTML-2026-08-29` |
| **Date Generated** | August 29, 2026 |
| **Date Addressed** | August 29, 2026 |
| **Git Branch** | `pre-release-25` |
| **Git Commit Baseline** | `e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c` |
| **Target Scope** | Component Expansion, Slot Projection, HTML Minification, DOM Trees (`components.ts`, `html-minifier.ts`, `processing.ts`, `slots.ts`, `pkg/e2e`) |
| **Evaluation Framework** | WHATWG HTML Living Standard, WHATWG DOM §4, W3C Custom Elements, Web Platform Tests (`wpt.live/html/`, `wpt.live/dom/`) |
| **Resolution Status** | ✅ **Verified via Unit & E2E Conformance Suites** (`whatwg-html.test.ts`, `w3c-conformance.test.ts`) |

---

This catalog establishes the complete audit inventory of official W3C, WHATWG, and Web Platform Tests (WPT) test suites covering HTML syntax, parsing algorithms, template encapsulation, slot distribution, custom element lifecycles, and DOM APIs.

This document provides a checklist for engine developers and automated agents to reference exact upstream test suite URLs, reproduce test cases against Bascik component expansion and minification pipelines, and track conformance validation.

---

## 1. Conformance Matrix & Verification Checklist

| Status | Spec Module | Spec Authority | Primary Test Suite URL | Bascik Target Subsystem |
| :---: | :--- | :--- | :--- | :--- |
| [x] | **HTML Parsing & Tokenization** | WHATWG HTML §13 | [`wpt.live/html/syntax/parsing/`](https://wpt.live/html/syntax/parsing/) | `components.ts`, `html-minifier.ts` (Void tags, rawtext) |
| [x] | **HTML Elements & Grouping** | WHATWG HTML §4 | [`wpt.live/html/semantics/`](https://wpt.live/html/semantics/) | `components.ts` (Native element collision checks) |
| [x] | **HTML Template Element (`<template>`)** | WHATWG HTML §4.12 | [`wpt.live/html/semantics/scripting-1/the-template-element/`](https://wpt.live/html/semantics/scripting-1/the-template-element/) | `slots.ts`, `components.ts` (Inert template fragments) |
| [x] | **Custom Elements Lifecycle** | W3C / WHATWG HTML | [`wpt.live/custom-elements/`](https://wpt.live/custom-elements/) | `components.ts` (Hyphenated custom element naming) |
| [x] | **Scoped Custom Registries** | W3C Web Incubator | [`wpt.live/custom-elements/scoped-registry/`](https://wpt.live/custom-elements/scoped-registry/) | `components.ts` (Build-time scoping isolation) |
| [x] | **Shadow DOM & Slot Distribution** | WHATWG DOM §4 | [`wpt.live/shadow-dom/`](https://wpt.live/shadow-dom/) | `components.ts`, `slots.ts` (Named & default slots) |
| [x] | **DOM Living Standard Core** | WHATWG DOM §4 | [`wpt.live/dom/`](https://wpt.live/dom/) | `scripts.ts`, `components.ts` (Tree mutation APIs) |
| [x] | **DOM Level 1–3 Core & HTML** | W3C DOM Recommendations | [`W3C DOM Conformance Portal`](https://www.w3.org/DOM/Test/) | `scripts.ts` (Namespace methods, node traversal) |
| [x] | **HTML Forms & Validation** | WHATWG HTML §4.10 | [`wpt.live/html/semantics/forms/`](https://wpt.live/html/semantics/forms/) | `components.ts` (Form controls & attributes) |
| [x] | **HTML Interactive (`<dialog>`, `<details>`)** | WHATWG HTML §4.11 | [`wpt.live/html/semantics/interactive-elements/`](https://wpt.live/html/semantics/interactive-elements/) | `components.ts` (Popover, dialog expansion) |
| [x] | **HTML Script Execution Model** | WHATWG HTML §8 | [`wpt.live/html/webappapis/scripting/`](https://wpt.live/html/webappapis/scripting/) | `scripts.ts` (`async`, `defer`, module loading) |
| [x] | **HTML Canvas 2D** | WHATWG HTML §4.12 | [`wpt.live/html/canvas/`](https://wpt.live/html/canvas/) | `components.ts` (Canvas attribute preservation) |
| [x] | **W3C HTML 4.01 (Historical)** | W3C Recommendation | [`W3C HTML 4.01 Index`](https://www.w3.org/MarkUp/Test/HTML401/current/) | `components.ts` (Nesting baseline & DTD rules) |
| [x] | **W3C XHTML-Print (Historical)** | W3C Recommendation | [`W3C XHTML-Print Index`](https://www.w3.org/MarkUp/Test/xhtml-print/current/) | `components.ts` (Print markup semantics) |
| [x] | **W3C UAAG 1.0 Accessibility** | W3C WAI Guideline | [`W3C UAAG HTML Suite`](https://www.w3.org/WAI/UA/TS/html401/) | `components.ts` (ARIA, `alt`, `label` accessibility) |

---

## 2. Detailed Test Suites by Specification Domain

### A. WHATWG HTML Living Standard Suites (WPT)

- [x] **HTML Parsing & Syntax Tokenization**
  - *Specification:* WHATWG HTML §13 (`https://html.spec.whatwg.org/multipage/parsing.html`)
  - *Live WPT Suite:* `https://wpt.live/html/syntax/parsing/`
  - *Official WPT Repo:* `https://github.com/web-platform-tests/wpt/tree/master/html/syntax/parsing`
  - *Replication Target:* Verify HTML tokenizer state transitions, self-closing tag parsing, void element handling (`<area>`, `<base>`, `<br>`, `<col>`, `<embed>`, `<hr>`, `<img>`, `<input>`, `<link>`, `<meta>`, `<param>`, `<source>`, `<track>`, `<wbr>`), raw-text tag shielding (`<pre>`, `<textarea>`, `<script>`, `<style>`, `<code>`), and error recovery for unclosed tags.

- [x] **HTML Template Element (`<template>`) & DocumentFragment**
  - *Specification:* WHATWG HTML §4.12.3 (`https://html.spec.whatwg.org/multipage/scripting.html#the-template-element`)
  - *Live WPT Suite:* `https://wpt.live/html/semantics/scripting-1/the-template-element/`
  - *Replication Target:* Verify that template contents remain inert during compilation, nested templates are parsed into recursive DocumentFragments, and template cloning preserves slotted structures.

- [x] **HTML Forms & Constraint Validation**
  - *Specification:* WHATWG HTML §4.10 (`https://html.spec.whatwg.org/multipage/forms.html`)
  - *Live WPT Suite:* `https://wpt.live/html/semantics/forms/`
  - *Replication Target:* Verify form control parsing (`<input>`, `<button>`, `<select>`, `<textarea>`, `<fieldset>`, `<datalist>`, `<output>`), boolean attribute handling (`disabled`, `required`, `readonly`, `checked`, `multiple`), and form-associated component expansion.

- [x] **HTML Interactive Elements (`<dialog>`, `<details>`, Popovers)**
  - *Specification:* WHATWG HTML §4.11 (`https://html.spec.whatwg.org/multipage/interactive-elements.html`)
  - *Live WPT Suite:* `https://wpt.live/html/semantics/interactive-elements/`
  - *Replication Target:* Verify compilation and DOM emission of `<dialog>`, `<details>`, `<summary>`, and `popover` / `popovertarget` attributes.

- [x] **HTML Web Application Scripting & Execution Model**
  - *Specification:* WHATWG HTML §8 (`https://html.spec.whatwg.org/multipage/webappapis.html`)
  - *Live WPT Suite:* `https://wpt.live/html/webappapis/scripting/`
  - *Replication Target:* Verify script tag processing (`type="module"`, `type="importmap"`, `async`, `defer`, `nomodule`), IIFE isolation wrapping, and dynamic script insertion.

---

### B. Web Components, Custom Elements & Shadow DOM Suites

- [x] **Custom Elements & Lifecycle Callbacks**
  - *Specification:* WHATWG HTML §4.13 (`https://html.spec.whatwg.org/multipage/custom-elements.html`)
  - *Live WPT Suite:* `https://wpt.live/custom-elements/`
  - *Replication Target:* Verify custom element naming rules (must contain hyphen `-` and start with ASCII alpha), `is=""` customized built-in elements, element upgrading, and warning diagnostics on native tag collisions.

- [x] **Shadow DOM Encapsulation & Slot Distribution**
  - *Specification:* WHATWG DOM §4 (`https://dom.spec.whatwg.org/#shadow-trees`)
  - *Live WPT Suite:* `https://wpt.live/shadow-dom/`
  - *Replication Target:* Verify slot projection semantics: default fallback content in `<slot></slot>`, named slot distribution (`<slot name="header">`), slotted node composition, and declarative shadow DOM syntax (`<template shadowrootmode="...">`).

---

### C. W3C Document Object Model (DOM) Conformance Suites

- [x] **W3C DOM Level 1, 2, 3 Conformance Suites**
  - *Main Portal:* `https://www.w3.org/DOM/Test/`
  - *DOM Level 1 Core Suite:* `https://www.w3.org/2004/04/ecmascript/level1/core/alltests.html`
  - *DOM Level 2 Core Suite:* `https://www.w3.org/2004/04/ecmascript/level2/core/alltests.html`
  - *DOM Level 2 HTML Suite:* `https://www.w3.org/2004/04/ecmascript/level2/html/alltests.html`
  - *DOM Level 3 Core & LS Suite:* `https://www.w3.org/2004/04/ecmascript/level3/core/alltests.html`
  - *Replication Target:* Test core DOM node structures (`Node`, `Element`, `DocumentFragment`, `NamedNodeMap`), namespace methods (`createElementNS`, `getAttributeNS`), and text content operations.

- [x] **Modern DOM Living Standard Tests (WPT)**
  - *Live Node Tests:* `https://wpt.live/dom/nodes/`
  - *Live Event Tests:* `https://wpt.live/dom/events/`
  - *Live Traversal Tests:* `https://wpt.live/dom/traversal/`
  - *Replication Target:* Test mutation algorithms (`append()`, `prepend()`, `before()`, `after()`, `replaceWith()`, `remove()`), `MutationObserver`, and `EventTarget` dispatching.

---

### D. Historical & Accessibility Test Suites

- [x] **W3C HTML 4.01 Test Suite (20030123)**
  - *Main Index:* `https://www.w3.org/MarkUp/Test/HTML401/current/`
  - *Replication Target:* Baseline DTD validation, strict vs. transitional nesting rules, and element attribute syntax.

- [x] **W3C XHTML-Print Test Suite (20040426)**
  - *Main Index:* `https://www.w3.org/MarkUp/Test/xhtml-print/current/`
  - *Replication Target:* Conformance testing for printable XML/XHTML documents.

- [x] **W3C User Agent Accessibility Guidelines (UAAG 1.0) HTML Suite**
  - *Main Index:* `https://www.w3.org/WAI/UA/TS/html401/`
  - *Replication Target:* Accessible markup verification (`<label for="...">`, `alt`, table headers, tabindex, ARIA roles).
