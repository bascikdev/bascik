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
import { scanApiRouteFiles, formatApiRouteWarning, buildApiRouteTree } from "./lib/api-routes.ts";
import { withCompilationPublisher } from "./lib/compilation-events.ts";
import { eventEmitter } from "./lib/events.ts";

export const runTranspile = async (options: { exitOnError?: boolean } = {}): Promise<void> => {
  const projectRoot = resolve(process.cwd());
  const outputDirectory = resolve(projectRoot, BascikConfig.directory.out);
  const relativeOutputDirectory = relative(projectRoot, outputDirectory);
  if (
    relativeOutputDirectory === "" ||
    relativeOutputDirectory === ".." ||
    relativeOutputDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeOutputDirectory)
  ) {
    throw new Error(
      `Refusing to clean output directory outside the project root: ${outputDirectory}`,
    );
  }
  // Targeted builds added by prompt 33 must skip this full output clean.
  const isTargetedBuild = Boolean(BascikConfig.isBuild && BascikConfig.only && BascikConfig.only.length > 0);
  if (!isTargetedBuild) {
    await rm(outputDirectory, { recursive: true, force: true });
  }

  const overallStart = performance.now();

  if (BascikConfig.isBuild) {
    await runExecPhase("pre");
    const parallel = startExecParallel();
    // Start both branches before joining. Observe every failure immediately,
    // and wait for all children even when compilation or another child fails.
    const results = await Promise.allSettled([
      parallel,
      (async () => {
        await watchFiles();
        await runExecPhase("post");
      })(),
    ]);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `Build pipeline failed: ${failures.map(result => String(result.reason)).join('; ')}`);
    const version = await readVersion();
    // Prompt 101: all metadata (sidecar, CSP, manifest) and the durable
    // ownership inventory land in ONE ownership transaction. For a targeted
    // build the coordinator reconciles rebuilt/untouched owners and prunes
    // obsolete outputs; for a full build dist/ was cleaned, so it publishes
    // the current process's state fresh with no merge.
    await finalizeOwnedArtifacts(version, {
      forTargetedBuild: Boolean(BascikConfig.only && BascikConfig.only.length > 0),
    });

    // Prompt 48: Warn when API routes are found in src/api/ during static builds
    const apiDir = BascikConfig.directory?.api ?? "src/api";
    const absoluteApiDir = resolve(projectRoot, apiDir);
    const apiFiles = await scanApiRouteFiles(absoluteApiDir);
    if (apiFiles.length > 0) {
      try {
        const routes = buildApiRouteTree(apiFiles, absoluteApiDir, BascikConfig.base);
        const routePaths = routes.map((r) => r.path);
        console.warn("\n" + formatApiRouteWarning(routePaths, apiDir));
      } catch (err) {
        console.warn("\n" + (err as Error).message);
      }
    }

    const totalElapsed = performance.now() - overallStart;
    console.log(`\n✓ Build complete in ${formatDuration(totalElapsed)}`);
  } else {
    await runExecPhase("pre");
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

    const publications: [string, unknown][] = [];
    await withCompilationPublisher((event, payload) => publications.push([event, payload]), watchFiles);
    await runExecPhase("post");
    for (const [event, payload] of publications) eventEmitter.emit(event, payload);
    const version = await readVersion();
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
    console.log(`✓ All tasks completed in ${formatDuration(totalElapsed)}`);
    if (url) console.log(`Server running at ${url}`);
  }
};

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("transpile.js"));

if (isMain) {
  await runTranspile({ exitOnError: true });
}

