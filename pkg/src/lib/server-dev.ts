/**
 * @module server-dev
 *
 * Dev Server
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bascik` (no flags) runs the same HTTP server as production (`server.ts`,
 * the shared core) with a few additions layered on top:
 *
 *   - Pages are transpiled from `src/` into memory and re-transpiled on change
 *     (`watch.ts`), instead of being loaded once from `dist/`.
 *   - The live-reload SSE script is injected and `/bascik-live-reload` is served.
 *   - A boot page answers requests that arrive before the first transpile lands.
 *   - `data-bascik-server` scripts run from source on every request.
 *
 * Everything else (routing, headers, compression, server scripts, streaming,
 * error pages) is identical in both modes, so a page that works here behaves
 * the same under `bascik --server`. This module owns only the dev-specific
 * boot sequence; its production counterpart is `server-prod.ts`.
 */

import { mem } from "./mem.ts";
import { eventEmitter } from "./events.ts";
import { startExecDev } from "./exec.ts";
import { startServer } from "./server.ts";

export interface DevServerHandle {
  /** Resolves with the listening URL once the port is bound; rejects if binding fails. */
  url: Promise<string>;
  /** Resolves once every dev-mode `exec` script has started. */
  execReady: Promise<void>;
  /**
   * Call once the initial transpile and post exec phase are complete. Waits for
   * `execReady`, then marks the store as booted and emits `boot-done` so the
   * boot page stops answering requests.
   */
  finishBoot(): Promise<void>;
}

/**
 * Bind the shared server immediately so the URL is usable while the first
 * transpile is still running, and kick off dev exec scripts alongside it.
 * The caller (`transpile.ts`) runs the transpile/watch pipeline in between
 * and then calls `finishBoot()`.
 */
export const startDevServer = (options: { exitOnError?: boolean } = {}): DevServerHandle => {
  const url = startServer().catch((err) => {
    console.error("Server startup failed:", err);
    if (options.exitOnError !== false) {
      process.exit(1);
    }
    throw err;
  });
  const execReady = startExecDev();

  const finishBoot = async (): Promise<void> => {
    await execReady;
    mem.setBootingDone();
    eventEmitter.emit("boot-done");
  };

  return { url, execReady, finishBoot };
};
