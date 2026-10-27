# Getting Started

Node.js 24 LTS is recommended. The minimum supported version is Node.js 22.18.

## Quick Start

Create a new site with Bascik:

```sh
npm create bascik@rc my-site -y
```

During the release candidate period, `@rc` selects the current release candidate.

That scaffolds the project, installs dependencies, and starts the dev server in one shot.

Open **http://localhost:8080** in your browser to see your live site.

Edit a page or a component and save. The browser updates on its own, with no manual refresh:

![An editor above a browser showing the starter site. A heading is edited and saved and the browser updates. A component's border color is edited and saved and every card updates](/assets/demos/live-reload-stacked@2x.webp)

## Create Bascik Command

```sh
npm create bascik@rc my-site
```

Pass a different name to use it as both the directory name and the site title.

If you omit `-y`, the CLI steps through the setup prompts interactively.

`npm create bascik@rc` scaffolds a complete starter site: pages, components with unit tests, Playwright E2E browser tests, global CSS, `vite.config.js`, `.vscode/extensions.json` recommending the official Bascik extension, and a `.gitignore` with Vitest, `npm run lint` (`bascik --check`, with the `@bascik/language-server` linter installed), E2E testing, and code coverage pre-configured.

It does not create `bascik.config.ts` because the starter uses Bascik's built-in defaults.

To start a site that deploys to Cloudflare Workers, pass `--template cloudflare`. You get the same starter plus the [Cloudflare adapter](/deployment/cloudflare) and Wrangler as dev dependencies, a `build` script that emits the Workers bundle, `preview` and `deploy` scripts, and a demo page with a server script and an API route that run in the Worker. Without `--template`, the interactive prompts ask the same question.

```sh
npm create bascik@rc my-site -- --template cloudflare
```

The `--` matters: npm keeps flags placed before it for itself and does not pass them on, so `--template` has to follow a `--`. `-y` works on either side of it because `create-bascik` also reads npm's own `yes` setting, so `npm create bascik@rc my-site -y -- --template cloudflare` scaffolds, installs, and starts the dev server without a single prompt.

## Manual Setup

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
  <head>
    <title>Home</title>
  </head>
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
  <head>
    <title>Home</title>
  </head>
  <body>
    <nav class="bascik__site-nav__nav">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
    <h1>Hello world</h1>
  </body>
</html>
```

## See Working Components

The [Example Components](/example-components) are tested components to read and learn from, from a site header to a contact form.
