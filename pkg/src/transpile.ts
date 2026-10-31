import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BascikConfig } from "./lib/config.ts";
import { watchFiles } from "./lib/watch.ts";
import { runExecPhase, startExecParallel } from "./lib/exec.ts";
import { formatDuration } from "./lib/format.ts";
import { manifestCollector } from "./lib/manifest.ts";
import { readVersion } from "./lib/version.ts";
import { serverSidecarRegistry } from "./lib/server-sidecar.ts";
import { cspHashCollector } from "./lib/csp-hashes.ts";
import { finalizeOwnedArtifacts } from "./lib/ownership.ts";
import {
  scanApiRouteFiles,
  formatApiRouteWarning,
  buildApiRouteTree,
} from "./lib/api-routes.ts";
import { withCompilationPublisher } from "./lib/compilation-events.ts";
import { eventEmitter } from "./lib/events.ts";
import {
  assertProductionBuildState,
  writeBuildState,
} from "./lib/build-state.ts";
import { toleratingExecFailure } from "./lib/exec-policy.ts";
import { stdout as colorOut } from "./lib/colors.ts";
import { pinServerUrl } from "./lib/pinned-banner.ts";
import { privateDirFor } from "./lib/private-dir.ts";
import { assertPlaceholdersKept } from "./lib/lost-placeholders.ts";
import { isSameOrInsideOnDisk } from "./lib/config-validation.ts";
import { findConfigFile } from "./lib/config-file-names.ts";

/**
 * The source folder or config file the output clean would delete, named as a
 * config key with its path, or undefined when the clean deletes no source.
 * Both folders the clean removes are checked: the output directory and its
 * private sibling.
 */
const findSourceInsideCleanTargets = (
  projectRoot: string,
  outputDirectory: string,
): string | undefined => {
  const directory = BascikConfig.directory;
  const sources: [string, string | undefined][] = [
    ["directory.pages", directory.pages],
    ...(directory.components ?? []).map((root): [string, string] => [
      "directory.components",
      root,
    ]),
    ["directory.api", directory.api],
    ["scripts.importRoot", BascikConfig.scripts?.importRoot],
    ["the config file", findConfigFile().path],
  ];
  const targets = [outputDirectory, privateDirFor(outputDirectory)];
  for (const [name, path] of sources) {
    if (typeof path !== "string" || path === "") continue;
    const resolved = resolve(projectRoot, path);
    // On disk, not only by string: on a case-insensitive file system (the
    // macOS and Windows default) an out of "SRC" is the src folder.
    if (targets.some((target) => isSameOrInsideOnDisk(resolved, target)))
      return `${name} ${relative(projectRoot, resolved).replace(/\\/g, "/")}`;
  }
  return undefined;
};

export const runTranspile = async (
  options: { exitOnError?: boolean } = {},
): Promise<void> => {
  const projectRoot = resolve(process.cwd());
  const outputDirectory = resolve(projectRoot, BascikConfig.directory.out);
  const relativeOutputDirectory = relative(projectRoot, outputDirectory);
  if (
    relativeOutputDirectory === "" ||
    relativeOutputDirectory === ".." ||
    relativeOutputDirectory.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(relativeOutputDirectory)
  ) {
    throw new Error(
      `Refusing to clean output directory outside the project root: ${outputDirectory}`,
    );
  }
  // Config validation rejects an output directory that is or holds a source
  // folder (config-validation.ts); refuse it again here, right before the
  // recursive delete, so no caller that skipped validation can remove the
  // sources.
  const heldSource = findSourceInsideCleanTargets(projectRoot, outputDirectory);
  if (heldSource) {
    throw new Error(
      `Refusing to clean the output directory ${outputDirectory}: it holds ` +
        `${heldSource}, which the clean would delete. Set directory.out to a ` +
        `folder of its own, such as "dist".`,
    );
  }
  // Targeted builds added by prompt 33 must skip this full output clean.
  const isTargetedBuild = Boolean(
    BascikConfig.isBuild && BascikConfig.only && BascikConfig.only.length > 0,
  );
  if (isTargetedBuild) {
    await assertProductionBuildState("targeted-build");
  }
  if (!isTargetedBuild) {
    // Another process writing this directory (a second dev server in the
    // project, a build beside a running dev server) adds files while the
    // removal walks it, and rmdir fails with ENOTEMPTY. Do not retry: a retry
    // usually wins the race and deletes the other process's output under it,
    // leaving it to serve or ship a partial tree with no error. Fail loudly
    // and say what is in the way instead of a bare ENOTEMPTY.
    // The private folder beside it (private-dir.ts) belongs to the same
    // build: a sidecar or manifest the new build does not write must not
    // survive into it. It goes first, so a folder that cannot be cleared
    // leaves the previous release's pages and artifacts in place together.
    for (const [dir, what] of [
      [privateDirFor(outputDirectory), "the private build folder"],
      [outputDirectory, "the output directory"],
    ] as const) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        throw new Error(
          `Could not clear ${what} ${dir}` +
            `${code ? ` (${code})` : ""}: another bascik dev server or build ` +
            `may be writing to it. Stop it, or give this one its own ` +
            `directory.out.`,
          { cause: err },
        );
      }
    }
  }

  const overallStart = performance.now();

  // Exec script failures follow `pipeline.onExecError`: a build stops on one
  // by default (exit 1), the dev server reports it and keeps running. Page
  // compilation failures are never tolerated here.
  if (BascikConfig.isBuild) {
    await toleratingExecFailure(() => runExecPhase("pre"));
    const parallel = startExecParallel();
    // Start both branches before joining. Observe every failure immediately,
    // and wait for all children even when compilation or another child fails.
    const results = await Promise.allSettled([
      toleratingExecFailure(() => parallel),
      (async () => {
        await watchFiles();
        await toleratingExecFailure(() => runExecPhase("post"));
      })(),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        `Build pipeline failed: ${failures.map((result) => String(result.reason)).join("; ")}`,
      );
    const version = await readVersion();
    // Prompt 101: all metadata (sidecar, CSP, manifest) and the durable
    // ownership inventory land in ONE ownership transaction. For a targeted
    // build the coordinator reconciles rebuilt/untouched owners and prunes
    // obsolete outputs; for a full build dist/ was cleaned, so it publishes
    // the current process's state fresh with no merge.
    // A `post` script (or a `parallel` one, joined above) may have edited the
    // pages after they were written and hashed: the CSP hashes are taken
    // again from dist/ as it now is, so the header matches the HTML that
    // ships, on this host and in the serverless bundle built from it below.
    const editsAfterWrite = (BascikConfig.pipeline?.exec ?? []).some(
      (entry) => entry.phase === "post" || entry.phase === "parallel",
    );
    await finalizeOwnedArtifacts(version, {
      forTargetedBuild: Boolean(
        BascikConfig.only && BascikConfig.only.length > 0,
      ),
      rehashPagesFromDisk: editsAfterWrite,
    });
    // The same script may have removed a server or stream script's
    // placeholder, so the script would never run: fail every build here, on
    // dist/ as it ships and before a serverless bundle is made from it, with
    // the message `bascik --server` gives at startup.
    if (editsAfterWrite)
      await assertPlaceholdersKept(
        outputDirectory,
        relativeOutputDirectory.replace(/\\/g, "/"),
      );

    if (BascikConfig.target) {
      // Prompt 133: the deployment bundle is assembled from the finalized
      // dist/ tree and the sidecar it just committed. Failure here is a build
      // failure: a half-assembled bundle is never left behind.
      const { emitServerlessArtifacts, formatServerlessSummary } =
        await import("./lib/serverless-artifacts.ts");
      const result = await emitServerlessArtifacts(BascikConfig.target, {
        version,
        projectRoot,
      });
      console.log("\n" + formatServerlessSummary(result, projectRoot));
    } else {
      // Prompt 48: Warn when API routes are found in src/api/ during static builds
      const apiDir = BascikConfig.directory?.api ?? "src/api";
      const absoluteApiDir = resolve(projectRoot, apiDir);
      const apiFiles = await scanApiRouteFiles(absoluteApiDir);
      if (apiFiles.length > 0) {
        try {
          const routes = buildApiRouteTree(
            apiFiles,
            absoluteApiDir,
            BascikConfig.base,
          );
          const routePaths = routes.map((r) => r.path);
          console.warn("\n" + formatApiRouteWarning(routePaths, apiDir));
        } catch (err) {
          console.warn("\n" + (err as Error).message);
        }
      }
    }
    await writeBuildState("build", version);

    const totalElapsed = performance.now() - overallStart;
    console.log(
      `\n${colorOut.green("✓ Build complete")} in ${colorOut.bold(formatDuration(totalElapsed))}`,
    );
  } else {
    await toleratingExecFailure(() => runExecPhase("pre"));
    // Parallel entries run alongside the dev server and page compilation:
    // the handle is started here but NOT awaited, so the server binds and
    // pages compile while the entries work. The handle is retained and handed
    // to the dev lifecycle owner, which observes every task's outcome.
    // Completion never compiles pages. A parallel failure
    // surfaces as an honest build-error and never a success reload, without
    // blocking boot. Only the build branch above joins parallel, because a
    // one-shot build must be complete before dist/ is finalized.
    const parallel = startExecParallel();
    // Dev mode is the shared server (server.ts) plus the additions in
    // server-dev.ts; the production counterpart is server-prod.ts.
    const { startDevServer } = await import("./lib/server-dev.ts");
    const dev = startDevServer({ ...options, parallel });
    const url = await dev.url;
    // The URL is known as soon as the port is bound, long before pages finish compiling. Pin it to the top
    // row of an interactive terminal; otherwise it is logged once boot completes, as before.
    const pinned = url ? await pinServerUrl(url) : undefined;

    const publications: [string, unknown][] = [];
    await watchFiles({
      bootCompile: (compileInitialSources) =>
        withCompilationPublisher(
          (event, payload) => publications.push([event, payload]),
          compileInitialSources,
          { onPageErrors: "publish" },
        ),
    });
    await toleratingExecFailure(() => runExecPhase("post"));
    for (const [event, payload] of publications)
      eventEmitter.emit(event, payload);
    const version = await readVersion();
    await writeBuildState("development", version);
    const sidecarPath = await serverSidecarRegistry.writeSidecar(version);
    if (sidecarPath) {
      await manifestCollector.recordFileFromDisk(sidecarPath);
    }
    const cspPath = await cspHashCollector.writeCspHashes();
    if (cspPath) {
      await manifestCollector.recordFileFromDisk(cspPath);
    }
    await manifestCollector.writeManifest(version);
    await dev.finishBoot();
    const totalElapsed = performance.now() - overallStart;
    console.log(
      `${colorOut.green("✓ All tasks completed")} in ${colorOut.bold(formatDuration(totalElapsed))}`,
    );
    if (url && !pinned) console.log(`Server running at ${url}`);
  }
};

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("transpile.js"));

if (isMain) {
  await runTranspile({ exitOnError: true });
}
