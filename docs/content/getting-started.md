# Getting Started

Bascik requires Node.js v22.18+. Get up and running in under five minutes.

## Quick Start

The fastest way to start a new Bascik project with no prompts, just a running site:

```sh
npm create bascik@latest my-site -y
```

That scaffolds the project, installs dependencies, and starts the dev server in one shot. Open **http://localhost:8080** in your browser to see your live site.

Pass a different name to use it as both the directory name and the site title. If you omit `-y`, the CLI steps through the setup prompts interactively.

`npm create bascik@latest` scaffolds a complete starter site: pages, components with unit tests, Playwright E2E browser tests, global CSS, `vite.config.js`, `.vscode/extensions.json` recommending the official Bascik extension, and a `.gitignore` with Vitest, the `@bascik/language-server` linter (`npm run lint`), E2E testing, and code coverage pre-configured. It does not create `bascik.config.ts` because the starter uses Bascik's built-in defaults.

### Manual Setup

To add Bascik to an existing project:

```sh
npm install @bascik/bascik
```

Run `bascik init` to create the starter directory structure, or add `"dev": "bascik"` and `"build": "bascik --build"` to your `package.json` scripts.

<!-- demo:component-html -->
```html
<!-- src/components/site-nav.html -->
<nav class="nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

<!-- demo:page-html -->
```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html>
<head><title>Home</title></head>
<body>
  <site-nav></site-nav>
  <h1>Hello world</h1>
</body>
</html>
```

At build time, Bascik resolves `<site-nav>` into its component markup and scopes the class names into `dist/index.html`:

<!-- demo:page-output-html -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html>
<head><title>Home</title></head>
<body>
  <nav class="bascik__site-nav__nav">
    <a href="/">Home</a>
    <a href="/about">About</a>
  </nav>
  <h1>Hello world</h1>
</body>
</html>
```
