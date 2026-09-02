# Bascik Session Learnings & Hardened Conventions

This repository memory file captures historical lessons, regressions, and user-directed corrections mined from previous coding sessions, PR fixes, and testing audits.

## 1. Developer Tooling Boundaries
- `0x` and `node clinic` are internal engineering tools for developing and profiling the `@bascik/bascik` package (`pkg/`). They are **not** end-user Bascik features and must not be documented as user-facing developer experience APIs in `docs/content/developer-experience.md`.
- Dev dependencies for profiling belong in `pkg/package.json`.

## 2. Dev Server & SSE Live-Reload Semantics
- **Reconnection on Focus**: The browser client automatically triggers an immediate reconnection attempt when the tab regains focus (`document.visibilityState === 'visible'`). This enables instant live-reload after restarting the server without requiring a manual browser refresh.
- **Predictable Behavior**: Avoid convoluted UI dismiss state logic that interferes with reconnection countdowns. Keep reconnect state transitions clean, predictable, and resilient.
- **Watcher Responsiveness**: Ensure file changes across components, pages, and config trigger immediate incremental recompilation without dropping SSE notifications or locking the event loop.

## 3. Worker Threads & Environment Parity
- Node worker threads (`worker-pool.ts`, `page-worker.ts`) do **not** inherit `process.argv` from the main thread.
- `BascikConfig` sets `process.env.BASCIK_BUILD = isBuild ? "1" : "0"` so worker threads properly resolve build vs dev mode.
- If `isBuild` is inaccurate in a worker, file writes fail silently. Always await worker disk writes before terminating pools.

## 4. String Replacement & AST Shielding
- Regex replacements for tags, slots, and build scripts must always use functions `() => value` rather than raw replacement strings to prevent special tokens (`$1`, `$&`) from triggering infinite replacement loops or OOM crashes.
- Raw text content inside `<script>`, `<style>`, and `<textarea>` tags must be masked with same-length whitespace during component extraction to prevent nested tag false-positives (e.g. JSON-LD schema strings).

## 5. Testing & Verification Rules
- **TDD Regressions**: Always write a failing test first that isolates the reported bug before changing implementation code.
- **Granular Test Execution**: Run test files individually to surface errors clearly rather than burying failures in massive multi-package test logs.
- **Identifier Minification Parity**: Production builds hash class names and IDs. All E2E assertions must use `data-testid` and `page.getByTestId(...)`.
