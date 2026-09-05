# Overview

Switching an existing site to Bascik lets you replace complex client-side framework runtimes and heavy bundlers with standard vanilla HTML, CSS, and JavaScript. Bascik compiles your components at build time, yielding fast static pages and zero client runtime overhead.

## Is Bascik Right for Your Project?

- **Great fit:** Content-driven websites, marketing pages, company portals, documentation, blogs, and agency projects where fast load times, SEO, and low maintenance matter.
- **When to stay with your current framework:** Applications requiring complex, state-heavy client interfaces (such as interactive dashboards, canvas editors, or real-time collaborative apps) that rely heavily on a client-side reactive state store.

## Transferable Knowledge

Most of what you already know translates directly to Bascik:
- **Component Thinking:** You still break UIs into reusable pieces like headers, cards, and footers.
- **File-Based Routing:** Your URL structure maps directly to files under `src/pages/`.
- **Standard Web APIs:** You write standard HTML tags, modern CSS, and vanilla DOM JavaScript without proprietary framework wrappers.

## A Low-Risk First Step

You do not need to convert your entire project at once. A good first step is migrating a single content page and a shared card component:

1. Create a new Bascik workspace with `yarn create bascik`.
2. Extract one reusable UI block into `src/components/post-card/post-card.html`.
3. Create `src/pages/index.html` and use `<post-card></post-card>`.
4. Run `yarn dev` to inspect your zero-JS output immediately.

## How to Switch

The transition follows a consistent five-step workflow:

### 1. Extract Components
Move repeating markup patterns (such as navigation, footers, cards, or buttons) into `.html` files in `src/components/`. The hyphenated filename becomes the component tag name.

### 2. Map Slots and Props
Replace framework-specific slots and properties with Bascik equivalents:
- Map `children` in React or `<slot>` in Vue/Svelte to `data-bascik-slot`.
- Map plain text values to `data-bascik-prop-*` attributes. For element attributes, use `data-bascik-attr-*`. For rich HTML content, use named slots (`data-bascik-slot="name"`).

### 3. Handle Scoped Styles
Write modern CSS in paired `.css` files (e.g. `src/components/post-card/post-card.css`) or inline `<style>` tags. Bascik scopes class names and deduplicates CSS automatically. If your project uses [Tailwind CSS](/libraries#tailwind-css), you can continue using Tailwind via PostCSS.

### 4. Set Up Pages and Routes
Place static `.html` files in `src/pages/`. For parameterized routes like blogs, use [Dynamic Routes](/dynamic-routes) with `[slug].html` templates.

### 5. Retain Interactive JS
Write standard vanilla JavaScript in `<script>` tags inside components for client interactivity. Bascik automatically isolates instance IDs so multiple components do not clash.

> **AI-Assisted Migration:** If you use LLMs or AI coding assistants to help convert component templates, see the [Agent Skill](/tools/agent-skill) documentation for guidelines on providing context to AI tools.

## What Maps to What

| Framework Concept | Bascik Equivalent | Documentation |
| --- | --- | --- |
| Component file (`.jsx`, `.vue`, `.svelte`, `.astro`) | `.html` component file in `src/components/` | [Components](/components) |
| `children` prop / default `<slot>` | `data-bascik-slot` | [Slots](/slots) |
| Named slots | `data-bascik-slot="name"` | [Slots](/slots#named-slots) |
| Text props | `data-bascik-prop-name="value"` | [Props](/props) |
| Attribute props | `data-bascik-attr-href="link"` | [Props](/props#attribute-binding) |
| CSS Modules / scoped CSS | Paired `.css` file or `<style>` block (auto-scoped) | [Scoped Styles](/scoped-styles) |
| File-based routing | Files in `src/pages/` | [Dynamic Routes](/dynamic-routes) |
| Dynamic routes (`[slug].js`) | `src/pages/[slug].html` build-time route generation | [Dynamic Routes](/dynamic-routes) |
| Build-time data fetching (`getStaticProps`) | `<script data-bascik-build>` | [Build Scripts](/build-scripts) |
| Request-time SSR / Streaming | `<script data-bascik-server>` / `<script data-bascik-stream>` | [Server Scripts](/server-scripts) · [Stream Scripts](/stream-scripts) |
| API endpoints | Handlers in `src/api/` using standard `Request` and `Response` | [API Routes](/api-routes) |
| Client interactivity / hooks | Vanilla JS in `<script>` tags | [Scoped JavaScript](/scoped-javascript) |

> Choose where you are coming from: [Astro](/switch/from-astro) · [Eleventy](/switch/from-eleventy) · [Hugo](/switch/from-hugo) · [Next.js](/switch/from-next) · [React](/switch/from-react) · [Svelte](/switch/from-svelte) · [Vue](/switch/from-vue)
