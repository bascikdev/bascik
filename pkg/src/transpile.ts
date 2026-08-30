import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { BascikConfig } from "./lib/config.ts";
import { watchFiles } from "./lib/watch.ts";
import { runExecOnBuild, startExecDev } from "./lib/exec.ts";
import { mem } from "./lib/mem.ts";
import { eventEmitter } from "./lib/events.ts";

export const runTranspile = async (options: { exitOnError?: boolean } = {}): Promise<void> => {
  const overallStart = performance.now();

  if (BascikConfig.isBuild) {
    await runExecOnBuild();
    await watchFiles();
    const totalElapsed = Math.round(performance.now() - overallStart);
    console.log(`\n✓ Build complete in ${totalElapsed}ms`);
  } else {
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
    await execReady;
    mem.setBootingDone();
    eventEmitter.emit("boot-done");
    const totalElapsed = Math.round(performance.now() - overallStart);
    console.log(`✓ All tasks completed in ${totalElapsed}ms`);
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

