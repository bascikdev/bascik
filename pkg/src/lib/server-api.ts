/**
 * @module server-api
 *
 * API Route Dispatcher for HTTP/1.1 and HTTP/2 Servers
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Scans, caches, matches, and dispatches requests to API route handlers.
 * Zero overhead when `directory.api` does not exist.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { BascikConfig } from "./config.ts";
import {
  scanApiRouteFiles,
  buildApiRouteTree,
  matchApiRoute,
  type ApiRouteDefinition,
  type ApiRouteMatch,
} from "./api-routes.ts";
import { createWebRequest, executeApiRoute } from "./api-runtime.ts";
import { scriptRegistry } from "./script-registry.ts";
import type { BascikRequest, BascikResponse } from "./server.ts";

export class ApiRouteRegistry {
  private routes: ApiRouteDefinition[] = [];
  private scanned = false;
  private apiDir: string = "";

  /**
   * Initializes or refreshes the API route tree from disk.
   */
  async init(apiDir?: string, basePath?: string): Promise<void> {
    const targetDir = apiDir ?? BascikConfig.directory?.api ?? "src/api";
    const targetBase = basePath ?? BascikConfig.base ?? "/";
    this.apiDir = resolve(process.cwd(), targetDir);
    this.scanned = true;

    if (!existsSync(this.apiDir)) {
      this.routes = [];
      return;
    }

    const files = await scanApiRouteFiles(this.apiDir);
    this.routes = buildApiRouteTree(files, this.apiDir, targetBase);
  }

  /**
   * Returns whether any API routes exist.
   */
  hasRoutes(): boolean {
    return this.routes.length > 0;
  }

  /**
   * Returns all registered route definitions.
   */
  getRoutes(): ApiRouteDefinition[] {
    return this.routes;
  }

  /**
   * Match an incoming request pathname.
   */
  match(pathname: string): ApiRouteMatch | null {
    if (this.routes.length === 0) return null;
    return matchApiRoute(this.routes, pathname);
  }

  /**
   * Invalidate a single route file or all routes when files change in dev.
   */
  async reload(basePath = BascikConfig.base): Promise<void> {
    if (!this.scanned) return;
    await this.init(BascikConfig.directory.api, basePath);
  }

  /**
   * Invalidate a specific route file in the script registry and rebuild route tree.
   */
  async invalidateFile(filePath: string, basePath = BascikConfig.base): Promise<void> {
    scriptRegistry.invalidate(filePath);
    await this.reload(basePath);
  }

  /**
   * Dispatch a matching API route request.
   */
  async dispatch(
    req: BascikRequest,
    res: BascikResponse,
    match: ApiRouteMatch,
    secHeaders: Record<string, string>
  ): Promise<number> {
    const webReq = createWebRequest(req);
    const webRes = await executeApiRoute({
      filePath: match.route.filePath,
      request: webReq,
      params: match.params,
      remoteIp: req.remoteIp,
    });

    // Merge headers: security headers first, handler headers overwrite
    const outHeaders: Record<string, any> = { ...secHeaders };

    // Standard headers iterator
    webRes.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });

    // Special handling for set-cookie headers: preserve multiple Set-Cookie
    if (typeof (webRes.headers as any).getSetCookie === "function") {
      const setCookies = (webRes.headers as any).getSetCookie();
      if (Array.isArray(setCookies) && setCookies.length > 0) {
        outHeaders["set-cookie"] = setCookies.length === 1 ? setCookies[0] : setCookies;
      }
    }

    res.respond(webRes.status, outHeaders);

    if (webRes.body) {
      // Pipe stream
      const reader = webRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            res.write(Buffer.from(value));
          }
        }
      } catch (streamErr) {
        // Stream aborted or network error
      } finally {
        res.end();
      }
    } else {
      res.end();
    }

    return webRes.status;
  }
}

export const apiRouteRegistry = new ApiRouteRegistry();
