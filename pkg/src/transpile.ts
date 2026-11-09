import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
import { isSameOrInsideOnDisk } from "./lib/path-containment.ts";
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

/**
 * Why the output clean failed, in words that fit the error code. A busy or
 * refilled folder is most likely another bascik process writing it;
 * permission errors (a dist/ owned by root after a sudo build or a Docker
 * volume, a read-only mount, a sync client's lock) are not, so saying so
 * would send the user after a process that does not exist (audit 159
 * finding 140). Anything else is reported with Node's own message.
 */
const cleanFailureCause = (err: unknown, code: string | undefined): string => {
  if (code === "EACCES" || code === "EPERM")
    return (
      `permission denied. Check the ownership and permissions of the folder ` +
      `and everything in it (a folder created by \`sudo\` or a container ` +
      `belongs to another user), or set directory.out to a folder you can write.`
    );
  if (code === "ENOTEMPTY" || code === "EBUSY")
    return (
      `another bascik dev server or build may be writing to it. Stop it, or ` +
      `give this one its own directory.out.`
    );
  return err instanceof Error ? err.message : String(err);
};

/** Refuse an output directory that is a symbolic link (see the clean below). */
const assertOutputIsNotSymlink = (outputDirectory: string): void => {
  let isLink = false;
  try {
    isLink = lstatSync(outputDirectory).isSymbolicLink();
  } catch {
    return; // Absent (or unreadable, which the clean then reports).
  }
  if (!isLink) return;
  let target: string;
  try {
    target = realpathSync(outputDirectory);
  } catch {
    target = resolve(dirname(outputDirectory), readlinkSync(outputDirectory));
  }
  throw new Error(
    `[bascik] error: the output directory ${outputDirectory} is a symbolic ` +
      `link to ${target}. Every build empties and rewrites the output ` +
      `directory, so Bascik does not follow links there: the link would be ` +
      `replaced by a real folder and nothing would reach ${target}. Remove ` +
      `the link and set directory.out to a folder inside the project, then ` +
      `copy or sync it to ${target} after the build (a pipeline.exec "post" ` +
      `script or your deploy step).`,
  );
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
  // A typo'd or uninstalled --target used to surface only after the whole
  // site had been transpiled and dist/ rewritten. Resolve (and load) the
  // adapter first, so the build stops before any work and leaves the
  // previous dist/ alone (audit 159 finding 130).
  if (BascikConfig.isBuild && BascikConfig.target) {
    const { resolveAdapterTarget } =
      await import("./lib/adapter-resolution.ts");
    await resolveAdapterTarget(BascikConfig.target, projectRoot);
  }
  // Targeted builds added by prompt 33 must skip this full output clean.
  const isTargetedBuild = Boolean(
    BascikConfig.isBuild && BascikConfig.only && BascikConfig.only.length > 0,
  );
  if (isTargetedBuild) {
    await assertProductionBuildState("targeted-build");
  }
  if (!isTargetedBuild) {
    // rm() would remove a symbolic link itself, and the build would then
    // recreate the folder as a real directory: the output would never reach
    // the link's target, with no message (audit 159 finding 141). Following
    // the link instead would empty a folder that may be outside the project
    // on every build, so refuse and say which folder to name.
    assertOutputIsNotSymlink(outputDirectory);
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
            `${code ? ` (${code})` : ""}: ${cleanFailureCause(err, code)}`,
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
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    // A single failure is thrown as it is, so its own message (already a
    // located [bascik] error or the page summary) is what the CLI prints,
    // with no class name or `Error:` prefix in front (audit 159 findings 49
    // and 79). Several are joined by message, one per line.
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        failures
          .map((reason) =>
            reason instanceof Error ? reason.message : String(reason),
          )
          .join("\n"),
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
