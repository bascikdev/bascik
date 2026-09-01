#!/usr/bin/env node

import { readFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { CLI_USAGE, resolveCliAction } from "./lib/cli.ts";
import { readVersion } from "./lib/version.ts";

export { readVersion };

export const resolveBuildLogPath = (args: string[]): string | undefined => {
  return resolveCliAction(args).flags.log;
};

export const setupBuildLogging = async (buildLogPath: string): Promise<string> => {
  const absoluteLogPath = resolve(process.cwd(), buildLogPath);
  await mkdir(dirname(absoluteLogPath), { recursive: true });
  process.env.BASCIK_BUILD_LOG = absoluteLogPath;

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const tee = (target: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      target(...args);
      appendFile(absoluteLogPath, `${format(...args)}\n`, "utf8").catch(() => { });
    };
  };

  console.log = tee(original.log) as typeof console.log;
  console.warn = tee(original.warn) as typeof console.warn;
  console.error = tee(original.error) as typeof console.error;
  console.log(`[bascik] build log: ${absoluteLogPath}`);
  return absoluteLogPath;
};

export const runCli = async (
  args: string[] = process.argv.slice(2),
  options: { exitOnFinish?: boolean } = {}
): Promise<{ action: string; exitCode?: number }> => {
  const exit = (code: number) => {
    if (options.exitOnFinish !== false) {
      process.exit(code);
    }
  };

  const decision = resolveCliAction(args);
  const buildLogPath = decision.flags.log;

  if (decision.action === "build" && buildLogPath) {
    await setupBuildLogging(buildLogPath);
  }

  switch (decision.action) {
    case "help":
      console.log(CLI_USAGE);
      return { action: "help", exitCode: 0 };
    case "version":
      console.log(await readVersion());
      return { action: "version", exitCode: 0 };
    case "error": {
      const message =
        decision.errorMessage ??
        `Error: unknown flag${(decision.unknownFlags ?? []).length > 1 ? "s" : ""}: ${(decision.unknownFlags ?? []).join(", ")}`;
      console.error(`${message}\n`);
      console.error(CLI_USAGE);
      exit(1);
      return { action: "error", exitCode: 1 };
    }
    case "init": {
      const { initProject } = await import("./lib/init.ts");
      console.log("\nInitializing Bascik project…\n");
      await initProject();
      exit(0);
      return { action: "init", exitCode: 0 };
    }
    case "check": {
      const { checkProject } = await import("./lib/check.ts");
      const ok = await checkProject();
      exit(ok ? 0 : 1);
      return { action: "check", exitCode: ok ? 0 : 1 };
    }
    case "server": {
      const { serverProduction } = await import("./lib/serve.ts");
      await serverProduction();
      return { action: "server", exitCode: 0 };
    }
    case "dev":
    case "build":
    default: {
      const { runTranspile } = await import("./transpile.ts");
      try {
        await runTranspile({ exitOnError: options.exitOnFinish !== false });
        return { action: decision.action, exitCode: 0 };
      } catch (err) {
        if (options.exitOnFinish !== false) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("[bascik] build script error") && !errMsg.includes("[bascik] server script error")) {
            console.error(errMsg);
          }
          process.exit(1);
        }
        throw err;
      }
    }
  }
};

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("bascik.js"));

if (isMain) {
  // CLI boundary: anything that escapes runCli (for example a config load
  // failure during a lazy module import) is reported as one clean line. The
  // actionable message is in err.message; a full Node stack and an unhandled
  // rejection banner would only bury it.
  try {
    await runCli(process.argv.slice(2), { exitOnFinish: true });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

