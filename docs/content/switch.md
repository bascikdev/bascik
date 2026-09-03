# Overview

Moving an existing site to Bascik is mostly a mechanical transformation: extract repeated markup into component files, replace runtime framework logic with build-time equivalents, and let Bascik handle scoping. LLMs can do most of this automatically given the right context.

## How to Switch

The process is consistent regardless of the source framework:

### 1. Identify and Extract Components
Find repeating markup patterns, such as navigation, footers, cards, or buttons, and extract them into `.html` files in `src/components/`.

### 2. Map Framework Slots and Props
Replace framework-specific slots and properties with Bascik equivalents:
- Map `children` in React or `<slot>` in Vue/Svelte to `data-bascik-slot`.
- Map standard string or number props to `data-bascik-prop-*` attributes. For rich HTML content, use named slots instead.

### 3. Handle Scoped Styles
Migrate CSS Modules, styled-components, or Tailwind to vanilla CSS. You can write CSS directly in inline `<style>` blocks or use paired `.css` files (e.g., `component-name.css`). Bascik will scope and deduplicate them automatically.

### 4. Setup Pages and Routes
Move client-side routes and layout wrappers into static `.html` files under `src/pages/`.

### 5. Retain Interactive JS
Keep vanilla JS (such as event listeners, fetch calls, or animations) in standard `<script>` tags inside your components. Remove framework-specific hooks and state utilities.

> **Using AI to switch:** Give the LLM the source files plus the `SKILL.md` file (served at `/assets/SKILL.md` or in `.github/skills/bascik/SKILL.md`). The file contains a complete reference of Bascik's component format, scoping rules, and constraints, enough for most LLMs to perform the transformation without needing to look up anything else.

## What Maps to What

| Framework Concept | Bascik Equivalent |
| --- | --- |
| JSX component file | `.html` component file |
| `children` prop / default slot | `data-bascik-slot` |
| Named slots | `data-bascik-slot="name"` |
| String/number props | `data-bascik-prop-name="value"` |
| CSS Modules / scoped CSS | Paired CSS or inline `<style>` tag (auto-scoped) |
| Client-side routing / pages | One `.html` file per route in `src/pages/` |
| Static props / getStaticProps | Inline content in the page HTML |
| Conditional rendering | No direct equivalent, choose the correct HTML at build time or toggle visibility with CSS/JS at runtime |
| Component state / hooks | Vanilla JS in a `<script>` tag (auto-scoped per instance) |
| Data fetching at build time | Not built-in, pre-generate the HTML in a build script and include it in the page |

> Choose where you are coming from: [Astro](/switch/from-astro) · [Eleventy](/switch/from-eleventy) · [Hugo](/switch/from-hugo) · [Next.js](/switch/from-next) · [React](/switch/from-react) · [Svelte](/switch/from-svelte) · [Vue](/switch/from-vue)
