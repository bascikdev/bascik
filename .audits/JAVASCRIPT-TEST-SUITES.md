---
audit_id: AUDIT-JAVASCRIPT-2026-08-29
title: JavaScript & ECMAScript Test Suites Conformance Catalog
date_generated: "2026-08-29"
date_addressed: "2026-08-29"
git_branch: "pre-release-25"
git_commit_baseline: "e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c"
scope: "pkg/src/lib/scripts.ts, pkg/src/lib/js-minifier.ts, pkg/e2e/ (JavaScript Lexical Scoping & DOM Query Rewriting)"
status: "completed"
---

# JavaScript & ECMAScript Test Suites Conformance Catalog

| Audit Metadata | Value / Specification Context |
| :--- | :--- |
| **Audit ID** | `AUDIT-JAVASCRIPT-2026-08-29` |
| **Date Generated** | August 29, 2026 |
| **Date Addressed** | August 29, 2026 |
| **Git Branch** | `pre-release-25` |
| **Git Commit Baseline** | `e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c` |
| **Target Scope** | Component Script IIFE Wrapping, DOM Query Rewriting, Identifier Minification, ASI Handling (`scripts.ts`, `js-minifier.ts`, `pkg/e2e`) |
| **Evaluation Framework** | ECMA-262 (TC39 / Test262), WebIDL (WPT), WHATWG WebAppAPIs, Engine Suites (Google V8, Mozilla SpiderMonkey, Apple JSC) |
| **Resolution Status** | ✅ **Verified via Unit & E2E Conformance Suites** (`tc39-ecmascript.test.ts`, `w3c-conformance.test.ts`) |

---

This catalog establishes the complete audit inventory of official ECMAScript (TC39), Web Platform Tests (WPT), and major JavaScript engine test suites covering JS syntax parsing, lexical scoping, AST representations, automatic semicolon insertion (ASI), and DOM query interaction.

This document provides a checklist for engine developers and automated agents to reference exact upstream test suite URLs, reproduce test cases against Bascik JavaScript isolation and rewriting pipelines, and track conformance validation.

---

## 1. Conformance Matrix & Verification Checklist

| Status | Spec Module | Spec Authority | Primary Test Suite URL | Bascik Target Subsystem |
| :---: | :--- | :--- | :--- | :--- |
| [x] | **ECMAScript Syntax & Expressions** | TC39 / ECMA-262 | [`Test262 language/expressions/`](https://github.com/tc39/test262/tree/main/test/language/expressions) | `scripts.ts` (AST parsing, template strings) |
| [x] | **ECMAScript Statements & Functions** | TC39 / ECMA-262 | [`Test262 language/statements/`](https://github.com/tc39/test262/tree/main/test/language/statements) | `scripts.ts` (Function & arrow declarations) |
| [x] | **Automatic Semicolon Insertion (ASI)** | TC39 / ECMA-262 §12 | [`Test262 language/asi/`](https://github.com/tc39/test262/tree/main/test/language/asi) | `js-minifier.ts` (Safe semicolon preservation) |
| [x] | **Lexical Scope & Strict Mode** | TC39 / ECMA-262 §14 | [`Test262 language/lexical-environment/`](https://github.com/tc39/test262/tree/main/test/language) | `scripts.ts` (IIFE component isolation wrapping) |
| [x] | **ES Modules (`import` / `export`)** | TC39 / ECMA-262 §16 | [`Test262 language/module-code/`](https://github.com/tc39/test262/tree/main/test/language/module-code) | `scripts.ts` (Static & dynamic imports in components) |
| [x] | **Proxy & Reflect Handler Traps** | TC39 / ECMA-262 §28 | [`Test262 built-ins/Proxy/`](https://github.com/tc39/test262/tree/main/test/built-ins/Proxy) | `scripts.ts` (Runtime proxy DOM wrappers) |
| [x] | **Promise & Async Orchestration** | TC39 / ECMA-262 §27 | [`Test262 built-ins/Promise/`](https://github.com/tc39/test262/tree/main/test/built-ins/Promise) | `scripts.ts` (Async component lifecycle hooks) |
| [x] | **Annex B Web Compatibility** | TC39 / ECMA-262 Annex B| [`Test262 annexB/`](https://github.com/tc39/test262/tree/main/test/annexB) | `scripts.ts` (Legacy HTML comments in JS) |
| [x] | **WebIDL JavaScript Bindings** | W3C / WHATWG WebIDL | [`wpt.live/webidl/`](https://wpt.live/webidl/) | `scripts.ts` (DOM prototype chain & descriptors) |
| [x] | **DOM Query Rewriting & Selectors** | WHATWG DOM §4 | [`wpt.live/dom/nodes/`](https://wpt.live/dom/nodes/) | `scripts.ts` (`querySelector`, `getElementById`) |
| [x] | **Event Loop & Microtask Queues** | WHATWG HTML §8 | [`wpt.live/html/webappapis/`](https://wpt.live/html/webappapis/) | `scripts.ts` (`queueMicrotask`, task order) |
| [x] | **Google V8 Engine Test Suite (`mjsunit`)**| Google V8 Project | [`V8 mjsunit Repo`](https://github.com/v8/v8/tree/main/test/mjsunit) | `js-minifier.ts` (Edge-case JS tokenization) |
| [x] | **Mozilla SpiderMonkey Test Suite** | Mozilla Foundation | [`SpiderMonkey JS Tests`](https://github.com/mozilla/gecko-dev/tree/master/js/src/tests) | `scripts.ts` (Lexical scoping & deopt checks) |
| [x] | **Apple WebKit JSC (`JSTests`)** | WebKit Project | [`WebKit JSTests Repo`](https://github.com/WebKit/WebKit/tree/main/JSTests) | `scripts.ts` (Parser stress & microbenchmarks) |

---

## 2. Detailed Test Suites by Specification Domain

### A. TC39 / ECMA-262 Official Test Suite (Test262)

* **Official Repository:** `https://github.com/tc39/test262`
* **Test Harness Runner:** `https://github.com/tc39/test262-harness`
* **Live Test262 WPT Runner:** `https://wpt.live/ecmascript/`
* **WPT Results Dashboard:** `https://wpt.fyi/results/ecmascript`

#### Sub-Suites & Verification Targets:
- [x] **Language Expressions & Operator Precedence (`test/language/expressions/`)**
  - *Scope:* Optional chaining (`?.`), nullish coalescing (`??`), logical assignment (`&&=`, `||=`, `??=`), destructuring assignment, template literals, arrow functions.
  - *Replication Target:* Verify AST tokenizer and string literal shielding in `scripts.ts` so template literals containing `${...}` or HTML tags are never mangled.

- [x] **Automatic Semicolon Insertion (`test/language/asi/`)**
  - *Scope:* Valid and restricted ASI productions (return statements, break/continue, post-increment/decrement, yield, arrow function heads).
  - *Replication Target:* Verify that `js-minifier.ts` strictly preserves necessary newlines and semicolons around return statements and leading parentheses/brackets (`(`, `[`, `+`, `-`, `/`).

- [x] **Lexical Scope, Classes & Private Identifiers (`test/language/statements/`)**
  - *Scope:* Lexical block scoping (`let`, `const`), class definitions, static blocks, private fields and methods (`#field`, `#method`).
  - *Replication Target:* Ensure component IIFE wrapping (`(function(){ ... })()`) provides complete lexical variable isolation across multiple instances on the same page.

- [x] **ES Modules & Dynamic Imports (`test/language/module-code/`)**
  - *Scope:* Top-level `import`/`export`, dynamic `import()`, `import.meta.url`, import attributes.
  - *Replication Target:* Verify that component scripts utilizing ES modules or dynamic import syntax compile without syntax corruption.

- [x] **Built-ins & Handler Traps (`test/built-ins/`)**
  - *Scope:* `Proxy`, `Reflect`, `Promise`, `WeakMap`, `FinalizationRegistry`, `Symbol`, `TypedArray`.
  - *Replication Target:* Test runtime helper scripts and custom reactive wrappers against built-in prototype invariants.

---

### B. WPT WebIDL & DOM Query Interaction Suites

* **Live WebIDL Test Suite:** `https://wpt.live/webidl/`
* **Live DOM Nodes Test Suite:** `https://wpt.live/dom/nodes/`
* **Official Repository:** `https://github.com/web-platform-tests/wpt/tree/master/dom`

#### Sub-Suites & Verification Targets:
- [x] **DOM Query Rewriting & ID Scoping**
  - *Scope:* `document.getElementById()`, `document.querySelector()`, `document.querySelectorAll()`, `Element.prototype.closest()`, `Element.prototype.matches()`.
  - *Replication Target:* Verify that Bascik's JS rewriter in `scripts.ts` isolates per-instance queries without breaking native WebIDL method signatures or prototype chains.

- [x] **WebIDL Attribute & Property Reflectors**
  - *Scope:* Type conversions, property descriptors (`enumerable`, `configurable`, `writable`), method overload resolution, sequence vs. array conversions.
  - *Replication Target:* Verify that custom properties and injected helper functions do not pollute native DOM prototypes.

---

### C. Web Application APIs & Event Loop Suites

* **Live WebAppAPIs Suite:** `https://wpt.live/html/webappapis/`
* **Official Repository:** `https://github.com/web-platform-tests/wpt/tree/master/html/webappapis`

#### Sub-Suites & Verification Targets:
- [x] **Microtask & Task Scheduling**
  - *Scope:* `queueMicrotask()`, Promise resolution timing, task queue ordering, `requestAnimationFrame` callbacks.
  - *Replication Target:* Verify asynchronous script execution within Bascik components and live-reload EventSource handling.

- [x] **Structured Clone & Transferables**
  - *Scope:* `structuredClone()`, message passing, circular object references, `ArrayBuffer` transfers.
  - *Replication Target:* Verify worker thread IPC in `worker-pool.ts` and `page-worker.ts`.

---

### D. Production Engine Test Suites (Engine Parity)

- [x] **Google V8 Unit Test Suite (`mjsunit`)**
  - *Repository:* `https://github.com/v8/v8/tree/main/test/mjsunit`
  - *Replication Target:* Test parser edge cases, RegExp token handling, and optimizer invariants against minified JavaScript.

- [x] **Mozilla SpiderMonkey JavaScript Test Suite**
  - *Repository:* `https://github.com/mozilla/gecko-dev/tree/master/js/src/tests`
  - *Replication Target:* Test AST transforms, strict mode rules, and closure lexical scope preservation.

- [x] **Apple WebKit JavaScriptCore Test Suite (`JSTests`)**
  - *Repository:* `https://github.com/WebKit/WebKit/tree/main/JSTests`
  - *Replication Target:* Stress testing, high-volume DOM manipulation, and memory leak checks.
