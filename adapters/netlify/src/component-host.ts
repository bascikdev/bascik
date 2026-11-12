/**
 * @module component-host
 *
 * The function's render host for request-time components: what runtime.ts
 * needs to render component tags returned by server and stream scripts. Kept
 * in its own module so build.ts can substitute a stub for a site with nothing
 * to render. Ported from the Cloudflare adapter's host, which must produce
 * the same bytes as `bascik --server`: the renderer's ids and the build's
 * scoped names are both sha256-based.
 */
import { createHash } from "node:crypto";
import {
  createNameHasher,
  manifestHasComponents,
  renderFailureMessage,
  requestRoutePath,
  wrapRunner,
  type ExecutionPlan,
  type ExecutionSegment,
  type RenderHost,
  type ScriptOutputRunner,
} from "@bascik/bascik/runtime";
import type { ComponentManifest, GraphPage, SiteGraph } from "./runtime.js";

const encoder = new TextEncoder();

const identity = (input: string): string => input;

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/**
 * The scoped-name hash the manifest was built with: the build's
 * attribute-name hash under `minify.identifiers` (the portable algorithm,
 * from node:crypto's sha256), identity otherwise. The wrong one would
 * render class names the emitted stylesheet does not define. One hasher per
 * manifest for the instance's life, with the bounded memo Node's host uses:
 * the names a template replays embed the request instance id, so an
 * unbounded memo would grow with the requests an instance serves.
 */
const nameHashes = new WeakMap<ComponentManifest, (input: string) => string>();
const hashNameFor = (
  manifest: ComponentManifest,
): ((input: string) => string) => {
  if (!manifest.identifiers) return identity;
  let hash = nameHashes.get(manifest);
  if (!hash) {
    hash = createNameHasher((input) =>
      createHash("sha256").update(input).digest(),
    );
    nameHashes.set(manifest, hash);
  }
  return hash;
};

/**
 * The plan the renderer sees, with script segments keyed by their index in
 * the page as on Node (`server-scripts.ts` addresses jobs that way). The
 * renderer hashes the job key into every request-time instance id, so the
 * same key is what makes the function's bytes equal to `bascik --server`'s. One
 * per page: the renderer caches the page's fragment contexts per plan.
 */
interface IndexedPlan {
  plan: ExecutionPlan;
  jobIds: string[];
}
const indexedPlans = new WeakMap<GraphPage, IndexedPlan>();
const indexedPlanFor = (page: GraphPage): IndexedPlan => {
  let indexed = indexedPlans.get(page);
  if (!indexed) {
    const jobIds: string[] = [];
    const segments: ExecutionSegment[] = page.segments.map((segment, i) => {
      if (segment.kind === "static")
        return { kind: "static", bytes: encoder.encode(segment.text ?? "") };
      jobIds[i] = segment.id!;
      return {
        kind: "script",
        mode: page.jobs[segment.id!].mode,
        id: String(i),
      };
    });
    indexed = {
      plan: {
        segments,
        firstStreamIndex: segments.findIndex(
          (s) => s.kind === "script" && s.mode === "stream",
        ),
      },
      jobIds,
    };
    indexedPlans.set(page, indexed);
  }
  return indexed;
};

/**
 * The page's plan and a runner that renders component tags in job output,
 * with this function as the render host: names and ids from `node:crypto`, the
 * graph's script deadline, and `runComponentJob` (the graph's component
 * scripts, run like page jobs with the parent's remaining budget).
 * Production logs nothing per request, so the host has no `warnOnce`, and
 * `components.external` (which only silences that log) is not needed.
 * Null when the manifest has nothing to render: the caller keeps its own
 * plan and runner.
 */
export const componentExecution = (
  page: GraphPage,
  graph: SiteGraph,
  request: Request,
  run: ScriptOutputRunner,
  runComponentJob: RenderHost["runComponentJob"],
  log: (message: string) => void,
): { plan: ExecutionPlan; run: ScriptOutputRunner } | null => {
  const manifest = graph.components?.manifest;
  if (!manifest || !manifestHasComponents(manifest)) return null;
  const { plan, jobIds } = indexedPlanFor(page);
  const byIndex: ScriptOutputRunner = (index, signal) =>
    run(jobIds[Number(index)] ?? index, signal);
  return {
    plan,
    run: wrapRunner(byIndex, plan, {
      manifest,
      hashName: hashNameFor(manifest),
      hashHex: sha256Hex,
      // Decoded as on Node, so the ids agree with `bascik --server`.
      httpPath: requestRoutePath(request.url),
      timeoutMs: graph.scriptTimeoutMs,
      runComponentJob,
      externalTags: () => false,
      // The build's scripts.renderLimits (absent: the defaults).
      limits: graph.renderLimits,
      // D4.6, as on Node and as runGraphJob treats a failing script: the
      // located message fails the job under "error" (a 500 before commit,
      // the stream error log after), is logged under "warn", and the slot
      // is empty under "warn" and "ignore".
      onRenderError: (error) => {
        const message = renderFailureMessage(error, request.url);
        if (graph.onServerScriptError === "error") throw new Error(message);
        if (graph.onServerScriptError === "warn") log(message);
      },
    }),
  };
};
