/**
 * @module csp-header-node
 *
 * The opt-in `contentSecurityPolicy` header on the Node servers. The hashes
 * come from the build, never from a response body:
 *
 * - `bascik --server` reads dist/.bascik/csp-hashes.json (already widened
 *   for routes that render components at request time) once.
 * - The dev server reads the hashes it recorded for the route as it compiled
 *   the page, and widens a page with server or stream scripts with its
 *   component manifest, as the build does.
 *
 * Without the option nothing is computed and no header is added.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BascikConfig } from "./config.ts";
import { cspHashCollector, type CspHashesManifest } from "./csp-hashes.ts";
import {
  manifestCspHashes,
  type ComponentManifest,
} from "./component-manifest-file.ts";
import {
  contentSecurityPolicyHeader,
  widenCspRouteHashes,
  type CspRouteHashes,
} from "./content-security-policy.ts";
import { getHttpPath } from "./paths.ts";
import type { StoredPage } from "./types.ts";

let prodManifest: CspHashesManifest | null | undefined;

const readProdManifest = (): CspHashesManifest | null => {
  if (prodManifest !== undefined) return prodManifest;
  try {
    prodManifest = JSON.parse(
      readFileSync(
        join(BascikConfig.directory.out, ".bascik", "csp-hashes.json"),
        "utf8",
      ),
    ) as CspHashesManifest;
  } catch {
    prodManifest = null;
  }
  return prodManifest;
};

const componentHashes = new WeakMap<object, CspRouteHashes>();

const hashesOf = (manifest: ComponentManifest): CspRouteHashes => {
  let hashes = componentHashes.get(manifest);
  if (!hashes) {
    hashes = manifestCspHashes(manifest);
    componentHashes.set(manifest, hashes);
  }
  return hashes;
};

/** The CSP header for an HTML page response, or {} when the option is unset. */
export const cspHeadersForPage = (
  page: Pick<
    StoredPage,
    "relativePagePath" | "componentManifest" | "serverScriptPlan"
  >,
): Record<string, string> => {
  const policy = BascikConfig.contentSecurityPolicy;
  if (!policy) return {};
  const route = getHttpPath(page.relativePagePath);
  const own = BascikConfig.isProdServer
    ? (readProdManifest()?.[route] ?? undefined)
    : cspHashCollector.getRoute(route);
  // A page with server or stream scripts can render any manifest component
  // at request time, so it carries their hashes too (a build already wrote
  // them into csp-hashes.json; the dev server adds them here).
  const extra =
    page.serverScriptPlan && page.componentManifest
      ? hashesOf(page.componentManifest)
      : undefined;
  const { name, value } = contentSecurityPolicyHeader(
    policy,
    widenCspRouteHashes(own, extra),
  );
  return { [name]: value };
};
