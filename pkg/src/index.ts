#!/usr/bin/env node

import { mkdir, appendFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { CLI_USAGE, resolveCliAction } from "./lib/cli.ts";
import { readVersion } from "./lib/version.ts";
import { installProcessCrashHandlers } from "./lib/crash-net.ts";

export { readVersion, installProcessCrashHandlers };

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
  options: { exitOnFinish?: boolean; logger?: (...args: unknown[]) => void } = {}
): Promise<{ action: string; exitCode?: number }> => {
  const exit = (code: number) => {
    if (options.exitOnFinish !== false) {
      process.exit(code);
    }
  };

  const logger = options.logger ?? console.log.bind(console);

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
    case "add": {
      const { addComponents } = await import("./lib/add.ts");
      const targets = decision.flags.addTargets ?? [];
      try {
        const result = await addComponents(targets, {
          force: decision.flags.force,
          yes: decision.flags.yes,
          dryRun: decision.flags.dryRun,
        });
        const targetDir = relative(process.cwd(), result.targetComponentsDir).replace(/\\/g, "/") || ".";
        if (decision.flags.dryRun) {
          logger(`[bascik add] dry run: would copy ${result.copiedFiles.length} file(s) into ${targetDir}.`);
          for (const f of result.copiedFiles) {
            logger(`  would copy: ${f.destPath}`);
          }
        } else {
          logger(`[bascik add] successfully added ${result.copiedFiles.length} file(s) into ${targetDir}.`);
          for (const f of result.copiedFiles) {
            logger(`  added: ${f.destPath}`);
          }
        }
        exit(0);
        return { action: "add", exitCode: 0 };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(errMsg);
        exit(1);
        return { action: "add", exitCode: 1 };
      }
    }
    case "check": {
      const { checkProject, formatFindingsHuman, formatFindingsJson } = await import("./lib/check.ts");
      const findings = await checkProject();
      if (decision.flags.json) {
        logger(formatFindingsJson(findings));
      } else {
        logger(formatFindingsHuman(findings));
      }
      const exitCode = decision.flags.strict
        ? findings.errors + findings.warnings > 0
          ? 1
          : 0
        : findings.errors > 0
          ? 1
          : 0;
      exit(exitCode);
      return { action: "check", exitCode };
    }
    case "server": {
      const { startProdServer } = await import("./lib/server-prod.ts");
      await startProdServer();
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
  // Install process-level crash net for unexpected rejections / exceptions.
  installProcessCrashHandlers();

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

