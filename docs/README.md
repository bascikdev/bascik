# Bascik Docs

The official Bascik documentation site — built with Bascik itself.

## Pages

| Route                | Content                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `/`                  | Overview and feature index                                               |
| `/getting-started`   | Installation, folder structure, first component, dev + build scripts     |
| `/slots`             | Default slot, `data-bascik-slot`, slot fallback content, named slots     |
| `/props`             | `data-bascik-prop-*` — injecting text values into component templates    |
| `/scoped-styles`     | CSS file pairing, class scoping, element scoping, `@media`, `@keyframes` |
| `/scoped-javascript` | IIFE isolation, ID/class selector rewriting, build/dev-only scripts      |
| `/configuration`     | Full `bascik.config.ts` reference with `buildOverrideConfig`             |

## Components

| Component     | Purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `docs-nav`    | Sticky top navigation                                               |
| `docs-footer` | Page footer                                                         |
| `code-block`  | Syntax-highlighted code block; props: `lang`, optional `file` label |

## Development

Run `yarn install` from the **repo root** (not this directory). The repo uses Yarn workspaces, so `@bascik/bascik` is symlinked directly to `pkg/`, so no pack step is needed.

```sh
# from repo root
corepack enable
yarn install
yarn pkg:build                       # build the package first
yarn docs:dev                        # dev server at http://localhost:8080
yarn docs:build                      # write dist/
yarn docs:typecheck                  # TypeScript type check
yarn docs:unit                       # Vitest unit tests
yarn docs:e2e                        # Playwright E2E tests
yarn docs:lighthouse                 # Lighthouse CLI audit (core routes)
yarn docs:lighthouse:all             # Lighthouse CLI audit (all routes from nav.ts)
yarn docs:coverage                   # unit tests with coverage report
```

## Testing & Auditing

The documentation site maintains high quality and prevents regressions through automated tests and audits:

### Unit Tests

```sh
yarn docs:unit         # Run Vitest unit tests
yarn docs:coverage     # Run unit tests and generate a coverage report
```

### End-to-End (E2E) Tests

```sh
yarn docs:e2e          # Run Playwright E2E integration tests
```

Because the documentation site is built in production mode with identifier minification enabled (`minify.identifiers: true`), raw CSS classes and element IDs are hashed and compressed. To prevent brittle tests that break upon minification, E2E tests under `docs/e2e/` must target elements using standard `data-testid` attributes or accessible roles (e.g., `page.getByTestId(...)`, `page.getByRole(...)`).

### Lighthouse Auditing

To catch performance, accessibility, best practices, and SEO regressions locally before deployment, the documentation site includes Lighthouse CI CLI (`@lhci/cli`) pre-configured in `lighthouse/lighthouserc.json`.

The audits build the production bundle, start Bascik's production server (`bascik --server`), and test the documentation routes against strict score thresholds.

```sh
# Fast default audit across core routes (/, /getting-started, /components)
yarn docs:lighthouse

# Audit all documentation routes (generated dynamically from nav.ts)
yarn docs:lighthouse:all
```

The audit configuration verifies scores across core categories:

- **Performance:** Warning threshold at 0.90
- **Accessibility:** Error threshold at 1.0
- **Best Practices:** Error threshold at 1.0
- **SEO:** Error threshold at 1.0

Detailed audit reports are saved to `.lighthouseci` locally so you can open full HTML reports in your browser to inspect any flagged issues.

## Package Development (linked source)

```sh
yarn workspace bascik-docs pkg-dev   # watches pkg source directly via --watch-path
```

## Design

The docs site shares the same color palette as the demo app:

```text
background:  #18191b
accent:      #d3ff8d
text:        #f0f1f2
text-muted:  #7c8290
```

The layout uses a sidebar on desktop (`docs-layout` CSS grid) that collapses to a single column on mobile.
