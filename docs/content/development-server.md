# Development Server

Bascik includes a built-in local development server with file watching, incremental re-transpilation, Server-Sent Events (SSE) live reload, and an interactive browser error overlay.

## Starting the Dev Server

Run `bascik` or `npm run dev` in your project root:

```sh
# Start development server
npx bascik
# or if configured in package.json
npm run dev
```

When started, Bascik:

1. Loads your project configuration from `bascik.config.ts`.
2. Cleans the output directory (`dist/`) to remove stale artifacts.
3. Transpiles all pages and components into memory and disk. Pages open in your browser compile first, then the home page, then the rest (see [Compile Order](#compile-order)).
4. Initializes high-speed filesystem watchers across pages, components, the import root, and custom `pipeline.watchPaths`.
5. Starts an HTTP development server with live reload on port 8080.

This is the real output of a new project, recorded from the starter site on one machine. Startup takes a fraction of a second, and saving a page afterward rebuilds only that page:

![A terminal running bascik. The line Server running at localhost:8080 stays pinned to the top row while the output below it lists four pages transpiled in under a quarter of a second. After a file is saved, the server reports a rebuild of only pages/index.html in a few milliseconds](/assets/demos/dev-terminal@2x.webp)

## Compile Order

On a large site, the page you are looking at should not wait for the whole site to compile. Whenever the dev server compiles many pages at once, at startup and after a change to a shared component or stylesheet, it works through them in this order:

1. **Pages open in a browser tab.** Each tab's live-reload connection tells the server which page it shows. These pages compile first and reload as soon as they are ready. (With a watched `pipeline.exec` entry, an edit's reloads wait for that cycle's `post` scripts; see [Exec Scripts](/exec-scripts).)
2. **The home page (`/`).** It is the page most often opened next, so it compiles right after the open pages. Other directory indexes such as `blog/index.html` are ordinary pages.
3. **Every other page,** in file order.

The order is checked again each time a page finishes, not once at the start. A tab that connects after compilation began, such as a tab reconnecting after you restarted the server, moves its page to the front of the pages that have not started yet.

While the first compile is still running, the browser shows a short startup page and reloads into your page the moment that page is in memory, before the rest of the site and any `post` scripts finish. Once they finish, the page reloads one more time so it picks up anything the `post` scripts produced. `bascik --build` does not reorder pages.

## Linked Static Assets

For projects with many large static assets, enable development-only asset links instead of copies:

```ts
export default defineConfig({
  assets: {
    symlink: true,
  },
});
```

Bascik links unchanged page assets such as images, SVGs, PDFs, fonts, media, JSON, and XML into `dist/`, then reports `linked:` in the console. Files Bascik transforms, including configured CSS, JavaScript, and web manifest output, continue to be copied. Production builds always emit regular files, never symlinks.

If a Windows environment does not allow symlink creation, Bascik warns once and falls back to copying. Enable Windows Developer Mode or grant symlink permission to use linked assets there.

## CLI Flags

| Flag                | Description                  | Default                              |
| :------------------ | :--------------------------- | :----------------------------------- |
| `--port <number>`   | Port to listen on            | `8080`                               |
| `--host <name>`     | Interface to bind            | `localhost`                          |
| `--config <path>`   | Path to explicit config file | `bascik.config.js`, `.mjs`, or `.ts` |
| `--env-file <path>` | Custom environment file path | `./.env`                             |
| `--site-url <url>`  | Override canonical site URL  | `process.env.BASCIK_SITE_URL`        |

```sh
# Start dev server on custom port
bascik --port 3000
```

## Live Reload via Server-Sent Events (SSE)

Bascik injects a lightweight, zero-dependency SSE client into HTML pages served during development.

- When an HTML, CSS, or JavaScript file is saved, Bascik re-transpiles only affected pages and notifies connected browsers via an SSE event stream (`/bascik-live-reload`).
- Browsers reload seamlessly without requiring browser extensions or external polling tools.
- Live reload scripts are completely stripped from production builds (`bascik --build`).

Here it is on a new project. The first edit changes a page. The second changes the `feat-card` component, and every card on the page updates because they all use it:

![An editor above a browser. A heading edited in the editor and saved changes in the browser. A border color edited in a component and saved changes on every card](/assets/demos/live-reload-stacked@2x.webp)

## Browser Error Overlay

When a syntax error, build script failure, or invalid component reference occurs, Bascik presents a full-screen interactive error overlay directly in the browser:

- **Source Line Remapping:** Displays the original HTML template file, line number, and column.
- **Detailed Stack Traces:** Strips internal V8 and Node runtime frames to highlight your authored code.
- **Auto-Dismiss on Fix:** As soon as you correct the error and save the file, the dev server re-transpiles the page and dismisses the overlay instantly.

A typo in a build script, then the fix:

![An editor above a browser. A typo in a build script, String changed to Strin, is saved and the browser shows a Bascik Build Error overlay naming the file and the ReferenceError. Restoring the letter and saving dismisses the overlay](/assets/demos/error-overlay@2x.webp)

## Automatic Watching & Invalidation

The development server watches:

- **`src/pages/`:** Adding or editing pages immediately creates or updates the corresponding route.
- **`src/components/` (and all `directory.components` roots):** Editing a component automatically re-transpiles every page that uses that component tag.
- **`src/` (or `scripts.importRoot`):** Only request-time modules are reloaded from here. A shared `@/` helper that a build script imports re-renders its pages only when its folder is in `pipeline.watchPaths` (or inside `directory.pages` or `directory.components`); then the edit invalidates dependent build script caches and re-renders the affected pages. A helper imported at request time by a `src=` server script or API route, at any depth, is reloaded on the next request together with every module that imports it; no restart and no edit to the importing file is needed. A helper imported by an inline `data-bascik-server` script is picked up when its page recompiles (or after a restart), because the inline module is a `data:` URL the module graph cannot record an importer edge for.
- **`pipeline.watchPaths`:** Custom content directories or JSON data files trigger re-compilation according to your configured globs.
- **The root config file (`bascik.config.js`, `.mjs`, or `.ts`):** An edit is not applied. The server prints `[bascik] Config file changed: <path>. Restart the server to apply configuration changes.` and keeps running with the configuration it booted with. See [My config changes have no effect](/testing/troubleshooting#my-config-changes-have-no-effect).

## This Website's Build: A Real-World Example

The figures below describe **this docs website, the one you are reading now**, not a typical project. The median page figure is how long one page takes to transpile in a warm production build on one worker without competition from other pages. The dev Markdown-edit figure is different: it measures a save of this site's getting-started content through to the updated page on disk, including watching and rebuilding but **not** the browser reload. Neither figure is the whole-site build time. A page open in your browser is prioritized when many pages need compiling; a one-page edit needs only its affected page unless shared inputs invalidate more.

The cold/warm charts show the site's full production build (`bascik --build`), not dev-server startup. This large site has many pages, components, and build scripts that render Markdown, generate images, and write the search index. The Pages phase includes transpiling and scoping each page as well as its build-script work; it is not a component/CSS-only benchmark. The breakdown lists each build phase, and the per-page figures show the spread between a typical page and the slowest one.

The build runs your Node.js build scripts in isolated child processes, a few at a time, and caches each result. The first build pays for every script. After that, only scripts whose inputs changed run again. The page and component counts are counted live on every build. The timings come from measured builds and name the machine and date they were taken on.

## Next Steps

See [Watch Paths](/watch-paths) to configure custom watch directories, or explore [Production Server](/production-server) to learn about production runtime hosting.
