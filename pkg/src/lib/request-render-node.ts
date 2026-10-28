/**
 * @module request-render-node
 *
 * The Node host of the request-time component renderer (prompt 157, D4):
 * the name hash the manifest was built with, a `node:crypto` hex digest for
 * ids, ONE `ScriptJob` per component job id built from the sidecar when a
 * manifest is first used (so a component's server script is one module with
 * shared state, never one per request), and a component-job runner that goes
 * through `runServerScriptJob` with the parent's remaining budget and the
 * configured `scripts.onServerScriptError` policy, exactly like a page job.
 *
 * server-scripts.ts wires the host in: `executeServerScriptPlan` and
 * `streamServerScripts` take the page's manifest and wrap their runner with
 * it. The import cycle with server-scripts.ts is deliberate and benign: each
 * side only calls the other inside a function, never while evaluating.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ServerScriptError } from "./build-error.ts";
import { BascikConfig } from "./config.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { createNameHasher } from "./name-hash.ts";
import { scriptRegistry } from "./script-registry.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import {
  runServerScriptJob,
  type ScriptJob,
  type ServerScriptContext,
} from "./server-scripts.ts";
import type { ComponentManifest } from "./component-manifest.ts";
import { getDisplayPath } from "./page-diagnostics.ts";
import {
  renderFailureMessage,
  requestRoutePath,
  type RenderHost,
} from "./request-render.ts";

const identity = (input: string): string => input;

/** The hex digest instance ids and markers are minted from. */
export const hashHex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const nameHashers = new WeakMap<ComponentManifest, (input: string) => string>();

/**
 * The scoped-name hash for a manifest: the build's attribute-name hash when
 * it was built with `minify.identifiers`, identity otherwise. A renderer
 * that picked the wrong one would pass in dev and break only in built output.
 * Not `getAttributeNameHash` itself: its process-wide cache is never cleared
 * in production, and the names a request hashes embed request instance ids,
 * so it would grow with every request. One bounded hasher per manifest
 * (name-hash.ts, the algorithm `getAttributeNameHash` uses) instead.
 */
export const hashNameFor = (
  manifest: ComponentManifest,
): ((input: string) => string) => {
  if (!manifest.identifiers) return identity;
  let hash = nameHashers.get(manifest);
  if (!hash) {
    hash = createNameHasher((input) =>
      createHash("sha256").update(input).digest(),
    );
    nameHashers.set(manifest, hash);
  }
  return hash;
};

/**
 * How a message names the manifest: under the configured output directory,
 * or as the caller names that directory (production boot names it relative
 * to the working directory in its own messages).
 */
const componentsJsonPath = (outDir?: string): string =>
  `${outDir ?? BascikConfig.directory?.out ?? "dist"}/.bascik/components.json`;

const componentJobs = new WeakMap<
  ComponentManifest,
  Record<string, ScriptJob>
>();

/**
 * One `ScriptJob` per component job the manifest names, resolved through the
 * sidecar registry, memoized per manifest object. A manifest naming a job the
 * sidecar lacks is a stale dist (the two artifacts are written by one build):
 * this throws a located message instead of letting a placeholder reach a
 * client, at production boot and again on the first request a dev or a hand-
 * edited dist gets there.
 */
export const loadComponentJobs = (
  manifest: ComponentManifest,
  outDir?: string,
): Record<string, ScriptJob> => {
  const cached = componentJobs.get(manifest);
  if (cached) return cached;
  const jobs: Record<string, ScriptJob> = {};
  const missing: string[] = [];
  for (const entry of Object.values(manifest.components)) {
    for (const job of entry.jobs) {
      const staged = serverSidecarRegistry.getScript(job.id);
      if (!staged) {
        missing.push(`"${job.id}" of <${entry.name}> (${entry.filePath})`);
        continue;
      }
      const marker = staged.mode === "stream" ? " data-bascik-stream" : "";
      const openTag = `<script type="text/bascik-server" data-bascik-server-id="${job.id}"${marker}>`;
      const fullTag = `${openTag}</script>`;
      jobs[job.id] = {
        fullTag,
        scriptContent: staged.source,
        openTag,
        index: 0,
        length: fullTag.length,
        startLine: staged.sourceLine ?? 1,
        mode: staged.mode,
        placeholderId: job.id,
        srcPath: staged.modulePath,
        sourceFile: staged.sourceFile ?? job.sourceFile,
        sourceLine: staged.sourceLine ?? job.sourceLine,
        sourceColumn: staged.sourceColumn,
        outputScope: staged.outputScope ?? job.outputScope,
      };
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[bascik] ${missing.length === 1 ? "component script" : "component scripts"} ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} listed in ${componentsJsonPath(outDir)} but missing from the ` +
        `server-scripts sidecar, so the build artifacts do not match. Run \`bascik --build\` to regenerate them.`,
    );
  }
  componentJobs.set(manifest, jobs);
  return jobs;
};

const warnedKeys = new WeakMap<ComponentManifest, Set<string>>();

/**
 * Dev only: the unresolved-tag and unsupported-component logs, once per key
 * per manifest. Each dev publication builds a new manifest, so a tag that
 * becomes unresolved again (its component deleted, or renamed) is logged
 * again instead of staying silent for the rest of the process.
 */
const warnOnceFor =
  (manifest: ComponentManifest) =>
  (key: string, message: string): void => {
    let keys = warnedKeys.get(manifest);
    if (!keys) warnedKeys.set(manifest, (keys = new Set()));
    if (keys.has(key)) return;
    keys.add(key);
    console.warn(message);
  };

export interface NodeRenderHostOptions {
  request: Request;
  context: ServerScriptContext;
  /** The page job budget (`scripts.timeout`); nested jobs get what remains. */
  timeoutMs: number;
  /** The page file, for diagnostics of a job without its own source file. */
  filePath?: string;
}

/**
 * The render host for one request on Node. The route comes from the request
 * URL; the external-tag matcher from `components.external`; the dev log only
 * when the script registry runs in development, so production logs nothing
 * per request.
 */
export const createNodeRenderHost = (
  manifest: ComponentManifest,
  options: NodeRenderHostOptions,
): RenderHost => {
  const jobs = loadComponentJobs(manifest);
  const { request, context, timeoutMs, filePath } = options;
  const host: RenderHost = {
    manifest,
    hashName: hashNameFor(manifest),
    hashHex,
    httpPath: requestRoutePath(request.url),
    timeoutMs,
    runComponentJob: (id, signal, budgetMs) => {
      const job = jobs[id];
      if (!job) {
        return Promise.reject(
          new Error(
            `[bascik] component script "${id}" is not listed in ${componentsJsonPath()}. Run \`bascik --build\`.`,
          ),
        );
      }
      return runServerScriptJob(
        job,
        request,
        context,
        budgetMs,
        filePath,
        signal,
      );
    },
    externalTags: createExternalTagMatcher(BascikConfig.components?.external),
    // D4.6: a render failure follows the policy exactly as a failing script
    // does in runServerScriptJob: the located message is thrown as a
    // ServerScriptError (server.ts logs its message, never a stack) or
    // logged as a warning.
    onRenderError: (error) => {
      const message = renderFailureMessage(error, request.url);
      const behavior = BascikConfig.scripts?.onServerScriptError ?? "error";
      if (behavior === "error") throw new ServerScriptError(message);
      if (behavior === "warn") console.warn(message);
    },
  };
  if (scriptRegistry.mode === "development") {
    host.warnOnce = warnOnceFor(manifest);
    // The form `bascik --check` prints, relative to the component root.
    host.displayFile = (path) => getDisplayPath(resolve(process.cwd(), path));
  }
  return host;
};
