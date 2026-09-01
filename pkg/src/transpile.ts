import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BascikConfig } from "./lib/config.ts";
import { watchFiles } from "./lib/watch.ts";
import { runExecPhase, startExecParallel, startExecDev } from "./lib/exec.ts";
import { mem } from "./lib/mem.ts";
import { eventEmitter } from "./lib/events.ts";
import { formatDuration } from "./lib/format.ts";
import { manifestCollector } from "./lib/manifest.ts";
import { readVersion } from "./lib/version.ts";
import { serverSidecarRegistry } from "./lib/server-sidecar.ts";
import { cspHashCollector } from "./lib/csp-hashes.ts";

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
  await rm(outputDirectory, { recursive: true, force: true });

  const overallStart = performance.now();

  if (BascikConfig.isBuild) {
    await runExecPhase("pre");
    await startExecParallel();
    await watchFiles();
    await runExecPhase("post");
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
    const totalElapsed = performance.now() - overallStart;
    console.log(`\n✓ Build complete in ${formatDuration(totalElapsed)}`);
  } else {
    await runExecPhase("pre");
    startExecParallel();
    const { startServer } = await import("./lib/server.ts");
    const serverReady = startServer().catch((err) => {
      console.error("Server startup failed:", err);
      if (options.exitOnError !== false) {
        process.exit(1);
      }
      throw err;
    });

    const execReady = startExecDev();
    const url = await serverReady;

    await watchFiles();
    await runExecPhase("post");
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
    await execReady;
    mem.setBootingDone();
    eventEmitter.emit("boot-done");
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

