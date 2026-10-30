# Getting Started

Node.js 24 LTS is recommended. The minimum supported version is Node.js 22.22.

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

`npm create bascik@rc` scaffolds a complete starter site: pages, components with unit tests, Playwright E2E browser tests, global CSS, `vite.config.js`, `.vscode/extensions.json` recommending the official Bascik extension, `.vscode/settings.json` that turns off a VS Code check which gives false errors on Bascik pages, and a `.gitignore` with Vitest, `npm run lint` (`bascik --check`, with the `@bascik/language-server` linter installed), E2E testing, and code coverage pre-configured.

Its component scripts are TypeScript (`<script type="text/typescript">`), and every component root and interactive part carries a `data-testid` for tests. Run `npm create bascik@rc -- --help` to list every option.

It does not create `bascik.config.ts` because the starter uses Bascik's built-in defaults. A fresh project passes `npm run lint`; until you set the site's production URL, `bascik --check` warns that `BASCIK_SITE_URL` is not set and `npm run build` fails, because the sitemap and `robots.txt` need it. Set it where the site is built (see [Environment files and the site URL](/cli#environment-files-and-the-site-url)), or turn off `generate.sitemap` and `generate.robots`.

For coding assistants, it writes an `AGENTS.md` brief with the project's commands and house rules, and a `CLAUDE.md` that imports it for Claude Code. It then asks whether to install the [Bascik agent skills](/agent-skills#new-projects) (yes by default, and with `-y`); pass `--no-skills` to skip them. See [Project Brief](/agent-skills#project-brief) for what the brief says.

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

`bascik init` also adds the `AGENTS.md` and `CLAUDE.md` [project brief](/agent-skills#project-brief), appending to files you already have, and asks whether to install the [agent skills](/agent-skills#new-projects). `bascik init -y` installs them without asking, and `bascik init --no-skills` skips them.

### Editor Setup

`bascik init` also sets up VS Code: it adds a `.vscode/settings.json` with the setting below and recommends the [Bascik extension](/tools/vscode-extension) in `.vscode/extensions.json`. It adds to files you already have and keeps what is in them. If you set up the project by hand, add this to `.vscode/settings.json`:

```json
{
  "html.validate.scripts": false
}
```

VS Code's built-in HTML checker joins every classic `<script>` (one without `type="module"`) in a file into one JavaScript file, so a page with two Bascik scripts that each `export default` shows the false error "A module cannot have multiple default exports." Bascik runs each script on its own. The setting turns off only VS Code's check of code inside `<script>` tags in `.html` files. The Bascik extension offers to add the setting to a Bascik workspace the first time it starts there, and changes nothing unless you click. See [Several Scripts in One File](/tools/vscode-extension#several-scripts-in-one-file) for what the setting changes.

<!-- demo:component-html -->

```html
<!-- src/components/site-nav.html -->
<style>
  .nav {
    display: flex;
    gap: 1rem;
  }
</style>
<nav class="nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

<!-- demo:page-html -->

```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Home</title>
  </head>
  <body>
    <site-nav></site-nav>
    <main>
      <h1>Hello world</h1>
    </main>
  </body>
</html>
```

At build time, Bascik replaces `<site-nav>` with its component markup and scopes the class names its CSS uses into `dist/index.html`. The `<nav>` you wrote is the `<nav>` that ships, and the `lang` attribute and `<main>` landmark tell browsers and screen readers what the page is: see [Component Best Practices](/component-best-practices#use-htmls-elements) for the elements to pick.

<!-- demo:page-output-html -->

```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Home</title>

    <style>
      .bascik__site-nav__nav {
        display: flex;
        gap: 1rem;
      }
    </style>
  </head>
  <body>
    <!-- src/components/site-nav.html -->

    <nav class="bascik__site-nav__nav">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>

    <main>
      <h1>Hello world</h1>
    </main>
  </body>
</html>
```

## See Working Components

The [Example Components](/example-components) are tested components to read and learn from, from a site header to a contact form.
