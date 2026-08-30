---
name: bascik-lighthouse-performance
description: Auditing, configuration, and performance tuning with Lighthouse CI (LHCI) in Bascik. Use when configuring lighthouserc.json, auditing Core Web Vitals, diagnosing LCP/CLS shifts, or ensuring 100/100 performance budgets.
---

# Lighthouse CI & Core Web Vitals Auditing for Bascik

Bascik's design philosophy is zero runtime JavaScript overhead, resulting in 100/100 Lighthouse performance, accessibility, best practices, and SEO scores. The `docs/lighthouse/` directory manages automated Lighthouse CI runs and assertions.

---

## 1. Lighthouse Configuration Structure

```
docs/lighthouse/
├── generate-config.ts       # Generates URL matrix across all docs pages
├── lighthouserc.json        # Full Lighthouse CI assertions & performance budgets
├── lighthouserc.light.json  # Fast lightweight subset for rapid developer checks
└── lighthouserc.test.ts     # Test suite verifying LHCI config consistency
```

---

## 2. Core Web Vitals Expectations for Bascik Pages

* **Largest Contentful Paint (LCP):** Under 1.0s. Achieved by preloading critical fonts and rendering semantic HTML without client-side hydration delays.
* **Cumulative Layout Shift (CLS):** 0.00. Achieved by setting explicit dimensions or CSS aspect ratios on images and components.
* **Total Blocking Time (TBT):** 0ms. Pages ship with zero framework JavaScript.

---

## 3. SEO & Structured Data Requirements

Docs pages include automated JSON-LD schemas verified during build and audits:
* **BreadcrumbList:** Generated via `docs/scripts/breadcrumb-ld.ts`.
* **Article & TechArticle:** Generated via `docs/scripts/article-schema.ts`.
* **FAQPage:** Generated via `docs/scripts/faq-schema.ts`.

---

## 4. Running Audits

```sh
# Generate dynamic LHCI config matrix
npx --prefix docs tsx docs/lighthouse/generate-config.ts

# Run LHCI config unit test
npx vitest run docs/lighthouse/lighthouserc.test.ts
```
