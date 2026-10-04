/**
 * run.ts: the CLI's behavior, with every side effect passed in. `index.ts` supplies the real terminal,
 * file system root, and child processes; tests supply fakes and a local archive server.
 */
import { join } from "node:path";
import { OFFICIAL_EXAMPLES, SourceError, parseExampleSource, type ExampleSource } from "./catalog.js";
import { USAGE, UsageError, parseCliOptions } from "./cli.js";
import { ExampleError, installExample, type InstallOptions, type InstalledExample } from "./example.js";
import { scaffold, validateProjectName } from "./scaffold.js";

export interface Io {
  ask(question: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
  /** Run a command, inheriting the terminal. Returns its exit status (null when it could not start). */
  run(command: string, args: string[], cwd: string): number | null;
  cwd(): string;
  platform: NodeJS.Platform;
  /** Whether a person can answer prompts. */
  interactive: boolean;
}

export interface RunOptions extends InstallOptions {
  /** Called when a staging directory is created, so the process can remove it on a signal. */
  onStaging?: (directory: string) => void;
}

/** Interactive choice of what to start from. Returns an example id, or null for the default starter. */
async function chooseStarter(io: Io): Promise<string | null> {
  io.out("\nWhat would you like to start from?\n");
  io.out("  1) Default starter (a small site with a few pages and components)\n");
  OFFICIAL_EXAMPLES.forEach((example, index) => io.out(`  ${index + 2}) ${example.id}: ${example.description}\n`));
  for (;;) {
    const answer = (await io.ask(`Choose 1-${OFFICIAL_EXAMPLES.length + 1} (1): `)).trim();
    if (answer === "" || answer === "1") return null;
    const picked = OFFICIAL_EXAMPLES[Number.parseInt(answer, 10) - 2];
    if (/^\d+$/.test(answer) && picked) return picked.id;
    io.out("Please enter one of the numbers above.\n");
  }
}

function describeInstalled(source: ExampleSource, installed: InstalledExample, io: Io): void {
  const { info } = installed;
  io.out(`✓ Copied ${installed.files} file${installed.files === 1 ? "" : "s"} from ${source.label}\n`);
  if (info.license) io.out(`  License: ${info.license}\n`);
  if (info.bascikRange) io.out(`  Works with Bascik ${info.bascikRange}\n`);
  for (const requirement of info.requirements) io.out(`  Note: ${requirement}\n`);
  if (source.kind === "github") {
    io.out(
      "\n  This example came from a third-party repository. Bascik did not write or review it.\n" +
        "  Read its package.json (scripts and dependencies) before installing or running it.\n",
    );
  }
}

/** Returns the process exit code. */
export async function run(args: string[], io: Io, options: RunOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseCliOptions(args);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`\nError: ${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  if (parsed.helpFlag) {
    io.out(USAGE);
    return 0;
  }

  // Resolve what to start from before asking anything else: a bad example fails with no prompts.
  let source: ExampleSource | null = null;
  try {
    if (parsed.example !== undefined) source = parseExampleSource(parsed.example, parsed.examplePath);
  } catch (error) {
    if (error instanceof SourceError) {
      io.err(`\nError: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  let projectName = parsed.projectName;
  if (!projectName) {
    // As before, a name is asked for even with --yes. Without a terminal there is no one to ask.
    projectName = io.interactive ? (await io.ask("Project name (bascik-app): ")).trim() || "bascik-app" : "bascik-app";
  }
  const nameError = validateProjectName(projectName);
  if (nameError) {
    io.err(`\nError: ${nameError}\n`);
    return 1;
  }

  if (!source && parsed.example === undefined && !parsed.yesFlag && io.interactive) {
    const choice = await chooseStarter(io);
    if (choice) source = parseExampleSource(choice);
  }

  const projectDir = join(io.cwd(), projectName);
  if (source) {
    io.out(`\nCreating "${projectName}" from ${source.label}…\n`);
    let installed: InstalledExample;
    try {
      installed = await installExample(source, projectDir, projectName, options);
    } catch (error) {
      if (error instanceof ExampleError) {
        io.err(`\nError: ${error.message}\nNothing was created.\n`);
        return 1;
      }
      throw error;
    }
    describeInstalled(source, installed, io);
  } else {
    io.out(`\nCreating Bascik project "${projectName}"…\n\n`);
    await scaffold(projectName, io.cwd());
    io.out(`✓ Scaffolded ${projectName}/\n`);
  }

  // Installing runs the project's own package.json scripts and dependencies, so for a third-party
  // example it is a separate decision: --yes alone does not imply it.
  const runsForeignScripts = source?.kind === "github";
  let shouldInstall: boolean;
  let shouldDev: boolean;
  if (parsed.yesFlag) {
    shouldInstall = !runsForeignScripts;
    shouldDev = shouldInstall && !parsed.noDevFlag;
  } else if (io.interactive) {
    const question = runsForeignScripts ? "Install dependencies now? This runs scripts from the third-party example. (y/N) " : "Install dependencies now? (Y/n) ";
    const answer = (await io.ask(`\n${question}`)).trim().toLowerCase();
    shouldInstall = runsForeignScripts ? answer === "y" || answer === "yes" : answer !== "n";
    shouldDev = shouldInstall && (await io.ask("Start the dev server after install? (Y/n) ")).trim().toLowerCase() !== "n";
  } else {
    shouldInstall = false;
    shouldDev = false;
  }

  const npm = io.platform === "win32" ? "npm.cmd" : "npm";
  if (shouldInstall) {
    io.out("\nInstalling dependencies…\n\n");
    const status = io.run(npm, ["install"], projectDir);
    if (status !== 0) {
      io.err(`\nError: npm install ${status === null ? "could not be started" : `failed with exit code ${status}`}. The project is in ${projectName}/.\nFix the problem above, then run: cd ${projectName} && npm install\n`);
      return status ?? 1;
    }
  }
  if (shouldDev) {
    io.out("\nStarting dev server…\n\n");
    const status = io.run(npm, ["run", "dev"], projectDir);
    io.out(`\nTo start again:  cd ${projectName} && npm run dev\n`);
    return status === null ? 1 : status;
  }

  io.out("\nNext steps:\n\n");
  io.out(`  cd ${projectName}\n`);
  if (!shouldInstall) io.out("  npm install\n");
  io.out("  npm run dev\n\n");
  return 0;
}
