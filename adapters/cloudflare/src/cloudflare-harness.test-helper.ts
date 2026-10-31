/**
 * Local workerd harness for the Cloudflare adapter tests (prompts 134/135).
 *
 * Runs an emitted deployment bundle inside Miniflare (the same `workerd`
 * binary Wrangler uses) with the asset layer in front, exactly as Pages
 * advanced mode / Workers Static Assets route in production:
 *
 * - static paths are answered by the asset worker and never reach the user
 *   worker unless listed in the invocation routes;
 * - listed routes run the user worker first, which forwards non-matching
 *   requests through `env.ASSETS.fetch`.
 *
 * Bindings are synthetic: a text binding (`GREETING`) and a service binding
 * (`GATE`) whose fetch resolves only when the test releases it, so streaming
 * assertions never synchronize by sleeping. Every harness is disposed.
 *
 * Early-byte assertions use `node:http` directly: undici's `fetch` may
 * coalesce small chunks, which would make a buffered body look streamed.
 */
import http from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Miniflare } from "miniflare";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_COMPATIBILITY_FLAGS,
} from "./compat.ts";

export type DeployTarget = "cloudflare-pages" | "cloudflare-workers";

export interface Gate {
  release(): void;
  released: Promise<void>;
}

export const createGate = (): Gate => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
};

export interface HarnessOptions {
  /** Root of the built fixture project (contains dist/). */
  projectRoot: string;
  target: DeployTarget;
  /** Text bindings made available on `env`. */
  bindings?: Record<string, string>;
  /** Service bindings resolved on demand. */
  gate?: Gate;
  /** Override the invocation route list (fault injection). */
  invocationRoutes?: string[];
  /** Override the compatibility date (fault injection). */
  compatibilityDate?: string;
  /**
   * Collect what the Worker logs into `logs` instead of printing it, for
   * tests that compare a host's log with the Node server's.
   */
  collectLogs?: boolean;
}

export interface Harness {
  url: URL;
  mf: Miniflare;
  /** The Worker's log messages, in order, with `collectLogs`; else empty. */
  logs: string[];
  dispose(): Promise<void>;
  /** Plain fetch through undici; fine for status/headers/full-body checks. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Raw HTTP request that reports each body chunk with its arrival time. */
  streamed(
    path: string,
    headers?: Record<string, string>,
  ): Promise<StreamedResponse>;
}

export interface StreamedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Await the first chunk; times out on a bounded watchdog. */
  first(timeoutMs?: number): Promise<{ text: string; atMs: number }>;
  /** Await until the accumulated body contains `marker`; returns the body so far. */
  until(marker: string, timeoutMs?: number): Promise<string>;
  /** Await completion; returns every chunk in order. */
  all(timeoutMs?: number): Promise<Array<{ text: string; atMs: number }>>;
  /** Tear down the socket early (client disconnect). */
  destroy(): void;
}

/**
 * The runtime settings a deployment of the bundle runs under, which the
 * harness hands to workerd. Pages fixes the asset behavior (`/about` serves
 * `about.html`, a miss gets the nearest 404.html) and takes its compatibility
 * settings from the project, so the adapter's pinned ones are used. Workers
 * read them from the generated wrangler.jsonc, top level, exactly as
 * `wrangler deploy` does: an authored `compatibility_date`, extra flags,
 * `html_handling` or `not_found_handling` must reach the tests, or a test
 * passes under settings production never uses.
 */
type NotFoundHandling = "none" | "single-page-application" | "404-page";
type HtmlHandling =
  | "auto-trailing-slash"
  | "drop-trailing-slash"
  | "force-trailing-slash"
  | "none";

export interface HarnessSettings {
  compatibilityDate: string;
  compatibilityFlags: string[];
  assetConfig: {
    not_found_handling: NotFoundHandling;
    html_handling: HtmlHandling;
  };
  userWorkerRoutes: string[];
}

export const readHarnessSettings = async (
  targetDir: string,
  target: DeployTarget,
): Promise<HarnessSettings> => {
  if (target === "cloudflare-pages") {
    const routes = JSON.parse(
      await readFile(join(targetDir, "public", "_routes.json"), "utf8"),
    ) as {
      include: string[];
    };
    return {
      compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
      compatibilityFlags: [...CLOUDFLARE_COMPATIBILITY_FLAGS],
      assetConfig: {
        not_found_handling: "404-page",
        html_handling: "auto-trailing-slash",
      },
      userWorkerRoutes: routes.include,
    };
  }
  const wrangler = JSON.parse(
    await readFile(join(targetDir, "wrangler.jsonc"), "utf8"),
  ) as {
    compatibility_date?: string;
    compatibility_flags?: string[];
    assets?: {
      run_worker_first?: string[] | boolean;
      not_found_handling?: NotFoundHandling;
      html_handling?: HtmlHandling;
    };
  };
  const first = wrangler.assets?.run_worker_first;
  return {
    compatibilityDate:
      wrangler.compatibility_date ?? CLOUDFLARE_COMPATIBILITY_DATE,
    compatibilityFlags: wrangler.compatibility_flags ?? [
      ...CLOUDFLARE_COMPATIBILITY_FLAGS,
    ],
    assetConfig: {
      // Cloudflare's own defaults when the key is absent.
      not_found_handling: wrangler.assets?.not_found_handling ?? "none",
      html_handling: wrangler.assets?.html_handling ?? "auto-trailing-slash",
    },
    // `true` runs the Worker before every asset, as Cloudflare does.
    userWorkerRoutes: first === true ? ["/*"] : first || ["/*"],
  };
};

export const startHarness = async (
  options: HarnessOptions,
): Promise<Harness> => {
  // workerd resolves paths itself and rejects a symlinked prefix such as
  // macOS `/tmp` or `/var/folders`; hand it the canonical path.
  const targetDir = await realpath(
    join(options.projectRoot, "dist", ".bascik", options.target),
  );
  const scriptPath =
    options.target === "cloudflare-pages"
      ? join(targetDir, "public", "_worker.js")
      : join(targetDir, "worker.js");

  const settings = await readHarnessSettings(targetDir, options.target);
  const userWorkerRoutes =
    options.invocationRoutes ?? settings.userWorkerRoutes;

  const gate = options.gate;
  const logs: string[] = [];
  const mf = new Miniflare({
    ...(options.collectLogs
      ? {
          handleStructuredLogs: ({ message }: { message: string }) => {
            logs.push(message);
          },
        }
      : {}),
    modules: true,
    // Module names are computed relative to this root; without it, a script
    // outside cwd gets a `../..`-prefixed name that workerd rejects.
    modulesRoot: dirname(scriptPath),
    scriptPath,
    compatibilityDate: options.compatibilityDate ?? settings.compatibilityDate,
    compatibilityFlags: settings.compatibilityFlags,
    bindings: options.bindings ?? {},
    serviceBindings: gate
      ? {
          GATE: async () => {
            await gate.released;
            return new Response("released");
          },
        }
      : {},
    assets: {
      directory: join(targetDir, "public"),
      binding: "ASSETS",
      // What the deployment uses (readHarnessSettings): by default an
      // authored 404.html answers misses, and `/about` serves `about.html`.
      assetConfig: settings.assetConfig,
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        static_routing: { user_worker: userWorkerRoutes },
      },
    },
  });
  let url: URL;
  try {
    url = await mf.ready;
  } catch (err) {
    await mf.dispose().catch(() => {});
    throw err;
  }

  const streamed = (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<StreamedResponse> =>
    new Promise((resolveResponse, reject) => {
      const start = Date.now();
      const chunks: Array<{ text: string; atMs: number }> = [];
      let firstResolve:
        ((c: { text: string; atMs: number }) => void) | undefined;
      let ended = false;
      let endResolvers: Array<() => void> = [];
      const markerWaiters: Array<{
        marker: string;
        resolve: (body: string) => void;
      }> = [];
      const bodySoFar = () => chunks.map((c) => c.text).join("");
      const checkMarkers = () => {
        const body = bodySoFar();
        for (let i = markerWaiters.length - 1; i >= 0; i--) {
          if (body.includes(markerWaiters[i].marker)) {
            markerWaiters[i].resolve(body);
            markerWaiters.splice(i, 1);
          }
        }
      };
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path,
          method: "GET",
          headers: { "accept-encoding": "identity", ...headers },
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (text: string) => {
            const chunk = { text, atMs: Date.now() - start };
            chunks.push(chunk);
            firstResolve?.(chunk);
            firstResolve = undefined;
            checkMarkers();
          });
          res.on("end", () => {
            ended = true;
            for (const r of endResolvers) r();
            endResolvers = [];
          });
          res.on("error", () => {
            ended = true;
            for (const r of endResolvers) r();
          });
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            first: (timeoutMs = 5000) =>
              new Promise((resolveFirst, rejectFirst) => {
                if (chunks.length) return resolveFirst(chunks[0]);
                const watchdog = setTimeout(
                  () =>
                    rejectFirst(
                      new Error(`no first chunk within ${timeoutMs}ms`),
                    ),
                  timeoutMs,
                );
                firstResolve = (c) => {
                  clearTimeout(watchdog);
                  resolveFirst(c);
                };
              }),
            until: (marker, timeoutMs = 5000) =>
              new Promise((resolveMarker, rejectMarker) => {
                const body = bodySoFar();
                if (body.includes(marker)) return resolveMarker(body);
                const watchdog = setTimeout(
                  () =>
                    rejectMarker(
                      new Error(
                        `marker "${marker}" not seen within ${timeoutMs}ms; body so far: ${bodySoFar().slice(0, 300)}`,
                      ),
                    ),
                  timeoutMs,
                );
                markerWaiters.push({
                  marker,
                  resolve: (b) => {
                    clearTimeout(watchdog);
                    resolveMarker(b);
                  },
                });
              }),
            all: (timeoutMs = 10000) =>
              new Promise((resolveAll, rejectAll) => {
                if (ended) return resolveAll(chunks);
                const watchdog = setTimeout(
                  () =>
                    rejectAll(
                      new Error(`body did not end within ${timeoutMs}ms`),
                    ),
                  timeoutMs,
                );
                endResolvers.push(() => {
                  clearTimeout(watchdog);
                  resolveAll(chunks);
                });
              }),
            destroy: () => req.destroy(),
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

  return {
    url,
    mf,
    logs,
    dispose: () => mf.dispose(),
    fetch: (path, init) => fetch(new URL(path, url), init),
    streamed,
  };
};
