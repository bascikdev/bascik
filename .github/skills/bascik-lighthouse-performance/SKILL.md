---
name: bascik-lighthouse-performance
metadata:
  internal: true
description: Auditing, configuration, and performance tuning with Lighthouse CI (LHCI) in Bascik. Use when configuring lighthouserc.json, auditing Core Web Vitals, diagnosing LCP/CLS shifts, or ensuring 100/100 performance budgets.
---

# Lighthouse CI & Core Web Vitals Auditing for Bascik

Bascik's design philosophy is zero runtime JavaScript overhead, resulting in 100/100 Lighthouse performance, accessibility, best practices, and SEO scores. The `docs/lighthouse/` directory manages automated Lighthouse CI runs and assertions.

---

## 1. Lighthouse Configuration Structure

```
docs/lighthouse/
├── generate-config.ts           # Writes lighthouserc.all*.json from every page in nav.ts
├── lighthouserc.json            # Mobile gate: assertions & performance budgets
├── lighthouserc.desktop.json    # Desktop gate
├── lighthouserc.light.json      # Light-theme accessibility check
├── lighthouserc.all.json        # Generated: every route (gitignored)
├── lighthouserc.all-light.json  # Generated: every route, light theme
└── lighthouserc.test.ts         # Test suite verifying LHCI config consistency
```

---

## 2. Core Web Vitals Expectations for Bascik Pages

- **Largest Contentful Paint (LCP):** Under 1.0s. Achieved by preloading critical fonts and rendering semantic HTML without client-side hydration delays.
- **Cumulative Layout Shift (CLS):** 0.00. Achieved by setting explicit dimensions or CSS aspect ratios on images and components.
- **Total Blocking Time (TBT):** 0ms. Pages ship with zero framework JavaScript.

---

## 3. SEO & Structured Data Requirements

Docs pages include automated JSON-LD schemas verified during build and audits:

- **BreadcrumbList:** Generated via `docs/src/lib/breadcrumb-ld.ts`.
- **Article & TechArticle:** Generated via `docs/src/lib/article-schema.ts`.
- **FAQPage:** Generated via `docs/src/lib/faq-schema.ts`.

---

## 4. Running Audits

```sh
# Run the gate (mobile, desktop, light theme) or every route
yarn docs:lighthouse
yarn docs:lighthouse:all   # runs generate-config.ts itself

# Generate dynamic LHCI config matrix only
node docs/lighthouse/generate-config.ts

# Run LHCI config unit test
npx vitest run docs/lighthouse/lighthouserc.test.ts
```
