# Bascik Docs

The official Bascik documentation site, built with Bascik itself.

## Pages

| Route              | Content                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `/`                | Overview and feature index                                           |
| `/getting-started` | Installation, folder structure, first component, dev + build scripts |
| `/slots`           | Default slot, `data-bascik-slot`, slot fallback content, named slots |
| `/props`           | `data-bascik-prop-*`: injecting text values into component templates |

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

The E2E run builds and serves its own copy of the site, so it can run while `yarn docs:dev` is up:

|                     | Dev server (`yarn docs:dev`)  | E2E (`yarn docs:e2e`)                                              |
| ------------------- | ----------------------------- | ------------------------------------------------------------------ |
| Config              | `bascik.config.ts`            | `e2e/bascik.config.ts` (the same config, another output directory) |
| Output              | `dist/`                       | `.e2e/dist/`                                                       |
| Private build files | `.bascik/dist/`               | `.e2e/.bascik/dist/`                                               |
| Port                | 8080 (8081, 8082… when taken) | 8099, or `BASCIK_E2E_PORT`                                         |

Specs that read built files import the output directory from `e2e/site.ts`, never `dist/`. The run starts its own server and fails when the port is already taken, rather than testing whatever answers there. To keep a server up between runs, start it with `yarn workspace bascik-docs e2e:serve` and run with `BASCIK_E2E_PORT=8099`: setting the variable is what lets the run reuse a server on that port. CI never reuses one.

Because the documentation site is built in production mode with identifier minification enabled (`minify.identifiers: true`), raw CSS classes and element IDs are hashed and compressed. To prevent brittle tests that break upon minification, E2E tests under `docs/e2e/` must target elements using standard `data-testid` attributes or accessible roles (e.g., `page.getByTestId(...)`, `page.getByRole(...)`).

### Lighthouse Auditing

To catch performance, accessibility, best practices, and SEO regressions locally before deployment, the documentation site includes Lighthouse CI CLI (`@lhci/cli`) pre-configured in `lighthouse/lighthouserc.json`.

The audits build the production bundle, start Bascik's production server (`bascik --server`), and test the documentation routes against strict score thresholds.

Like the E2E run, the audits build and serve their own copy of the site, so they can run while `yarn docs:dev` or `yarn docs:e2e` is up:

|                     | Dev server (`yarn docs:dev`)  | E2E (`yarn docs:e2e`)  | Lighthouse (`yarn docs:lighthouse`)                                       |
| ------------------- | ----------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Config              | `bascik.config.ts`            | `e2e/bascik.config.ts` | `lighthouse/bascik.config.ts` (the same config, another output directory) |
| Output              | `dist/`                       | `.e2e/dist/`           | `.lighthouse/dist/`                                                       |
| Private build files | `.bascik/dist/`               | `.e2e/.bascik/dist/`   | `.lighthouse/.bascik/dist/`                                               |
| Port                | 8080 (8081, 8082… when taken) | 8099                   | 8097                                                                      |

The port and output directory live in `lighthouse/site.ts`; the `lighthouserc*.json` files repeat the port in their URLs, and `lighthouse/lighthouserc.test.ts` fails when they disagree. Each script first runs `lighthouse/check-port.ts`, which stops the run before building when something already answers on 8097 (often a server left from an earlier run): Lighthouse CI only warns when the server it starts never reports ready, and would then audit whatever answers on the port.

```sh
# Gate: mobile (/, /getting-started, /components, /search, /libraries, /sitemap), then desktop
# (/, /getting-started, /stream-scripts, /sitemap, /search), then light-theme accessibility
yarn docs:lighthouse

# Audit all documentation routes (generated dynamically from nav.ts)
yarn docs:lighthouse:all
```

The gate (`lighthouserc.json` for mobile, `lighthouserc.desktop.json` for desktop) fails on:

- **Performance:** a score under 0.95
- **Accessibility, Best Practices, SEO:** a score under 1.0 (mobile)
- **Budgets:** more than 4,000 DOM elements, more than 50 KB of script, a layout shift above 0.01 on /libraries, and a mobile LCP above 2 seconds on /sitemap

Layout forced by a script before first paint (`forced-reflow-insight`) is a warning. So is `lcp-discovery-insight` on desktop: it asks for `fetchpriority="high"` on the opening demo recording, which the docs leave off because on a phone that recording is not the largest paint and the hint makes its download compete with the text that is. The sweep over every route (`yarn docs:lighthouse:all`) warns on a performance score under 0.95 instead of failing, since it takes one run per page.

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
