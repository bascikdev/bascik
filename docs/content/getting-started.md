# Getting Started

Node.js 24 LTS is recommended. The minimum supported version is Node.js 22.18, the first release that runs `.ts` files natively, which Bascik relies on for `bascik.config.ts`, build scripts, and helper modules. Get up and running in under five minutes.

## Quick Start

The fastest way to start a new Bascik project with no prompts, just a running site:

```sh
npm create bascik@latest my-site -y
```

That scaffolds the project, installs dependencies, and starts the dev server in one shot. Open **http://localhost:8080** in your browser to see your live site.

Pass a different name to use it as both the directory name and the site title. If you omit `-y`, the CLI steps through the setup prompts interactively.

`npm create bascik@latest` scaffolds a complete starter site: pages, components with unit tests, Playwright E2E browser tests, global CSS, `vite.config.js`, `.vscode/extensions.json` recommending the official Bascik extension, and a `.gitignore` with Vitest, the `@bascik/language-server` linter (`npm run lint`), E2E testing, and code coverage pre-configured. It does not create `bascik.config.ts` because the starter uses Bascik's built-in defaults.

### Start from an example

Pass `--example` (or `-e`) to start from a complete example instead of the default starter:

```sh
npm create bascik@latest my-blog -- --example blog
```

The official examples are developed in the [`templates/` folder](https://github.com/bascikdev/bascik/tree/main/templates) of the Bascik repository, and each is published as the branch `examples/<name>` when a Bascik version is released. `blog` is a Markdown blog with tags, a paginated archive, an Atom feed, and page metadata. Run `npm create bascik@latest` with no arguments to pick from a list.

An example can also be any public GitHub repository. Pass its link, and add `/tree/<branch-or-tag>/<folder>` to use a branch, a tag, a commit, or a subfolder:

```sh
npm create bascik@latest my-app -- --example https://github.com/owner/repo
npm create bascik@latest my-app -- --example https://github.com/owner/repo/tree/main/starter
npm create bascik@latest my-app -- --example https://github.com/owner/repo --example-path starter
```

The folder must contain a `package.json`. The new project takes the name you chose, and nothing else in the example is changed.

What to know before you use it:

- **It needs the internet.** The example is downloaded from GitHub, and only `github.com` links are accepted. Private repositories are not supported.
- **Official examples only change on a release.** `--example blog` downloads the `examples/blog` branch, which is updated after a Bascik release is published, so an example never needs a Bascik version you cannot install yet. It is not pinned to your `create-bascik` version: the same command can give a newer example later.
- **Pin third-party examples yourself.** Without a branch or tag, a repository's default branch is used and can change. Use a tag or a commit for something repeatable.
- **Third-party examples are not reviewed by Bascik.** Installing runs the example's own `package.json` scripts and dependencies, so `--yes` copies a third-party example but does not install it. Read its `package.json`, then run `npm install` yourself, or answer `y` when asked.
- **Official examples behave like the default starter.** `--yes` installs and starts the dev server, and `--no-dev` stops after the install.
- **Safety.** The download is size limited and times out. Symbolic links, hard links, and paths that climb out of the project are refused, and nothing is created if any check fails. The destination must not exist or must be empty; existing files are never overwritten or deleted.
- **Compatibility.** An example can list a license, requirements, and the Node version it needs in a `template.json`. The CLI prints them and refuses an example that needs a newer Node than the one running.

| Option | What it does |
| --- | --- |
| `-e`, `--example <name\|link>` | Official example name, or a `https://github.com/...` link |
| `--example-path <folder>` | Folder inside the repository, when the link has no `/tree/...` part |
| `-y`, `--yes` | Use the defaults without prompting |
| `--no-dev` | With `--yes`, install but do not start the dev server |
| `-h`, `--help` | Show the options |

Unknown options and unknown example names are errors, so a typo never silently scaffolds the default starter.

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
