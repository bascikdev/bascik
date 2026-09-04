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
3. Transpiles all pages and components into memory and disk.
4. Initializes high-speed filesystem watchers across pages, components, the import root, and custom `watchPaths`.
5. Starts an HTTP development server with live reload on port 8080.

## CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--port <number>` | Port to listen on | `8080` |
| `--hostname <string>` | Interface to bind | `localhost` |
| `--base <path>` | Deployment path prefix | `/` |
| `--config <path>` | Path to explicit config file | `bascik.config.ts` |
| `--env-file <path>` | Custom environment file path | `./.env` |
| `--site-url <url>` | Override canonical site URL | `process.env.BASCIK_SITE_URL` |

```sh
# Start dev server on custom port
bascik --port 3000
```

## Live Reload via Server-Sent Events (SSE)

Bascik injects a lightweight, zero-dependency SSE client into HTML pages served during development.

- When an HTML, CSS, or JavaScript file is saved, Bascik re-transpiles only affected pages and notifies connected browsers via an SSE event stream (`/__bascik_sse`).
- Browsers reload seamlessly without requiring browser extensions or external polling tools.
- Live reload scripts are completely stripped from production builds (`bascik --build`).

## Browser Error Overlay

When a syntax error, build script failure, or invalid component reference occurs, Bascik presents a full-screen interactive error overlay directly in the browser:

- **Source Line Remapping:** Displays the original HTML template file, line number, and column.
- **Detailed Stack Traces:** Strips internal V8 and Node runtime frames to highlight your authored code.
- **Auto-Dismiss on Fix:** As soon as you correct the error and save the file, the dev server re-transpiles the page and dismisses the overlay instantly.

## Automatic Watching & Invalidation

The development server watches:

- **`src/pages/`:** Adding or editing pages immediately creates or updates the corresponding route.
- **`src/components/` (and all `directory.components` roots):** Editing a component automatically re-transpiles every page that uses that component tag.
- **`src/` (or `scripts.importRoot`):** Updating shared `@/` script helpers invalidates dependent build script caches and re-renders affected pages.
- **`pipeline.watchPaths`:** Custom content directories or JSON data files trigger re-compilation according to your configured globs.

> **Next:** See [Watch Paths](/watch-paths) to configure custom watch directories, or explore [Production Server](/production-server) to learn about production runtime hosting.
