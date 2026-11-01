/**
 * @module init
 *
 * Bootstraps a new Bascik project in the current working directory.
 * Invoked via `bascik init`.
 *
 * Creates:
 *  - src/pages/index.html   — starter HTML page
 *  - src/components/        — empty components directory
 *  - .gitignore additions    — dist/, node_modules/.cache/bascik/, and the
 *    TLS key and certificate the server generates (newline style kept)
 *  - .vscode/settings.json   — "html.validate.scripts": false (merged, never replaced)
 *  - .vscode/extensions.json — recommends the Bascik extension (merged, never replaced)
 *  - AGENTS.md               — the project brief for coding assistants (merged, never replaced)
 *  - CLAUDE.md               — imports AGENTS.md for Claude Code (merged, never replaced)
 *  - .agents/skills/, .claude/skills/ — the Bascik agent skills, after a Y/n
 *    question that defaults to yes (`-y` answers yes, `--no-skills` skips),
 *    installed with the skills CLI at this Bascik version's tag
 *
 * Updates package.json (if present):
 *  - Adds "type": "module" only when absent; a "commonjs" project is refused
 *    before anything is written
 *  - Adds the @bascik/bascik dependency at `^<running version>` when it is in
 *    neither dependencies nor devDependencies
 *  - Adds "dev" and "build" scripts if not already defined
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SKILLS_QUESTION,
  agentFilesReportLines,
  answeredNo,
  createPrompter,
  installSkills,
  skillsLaterLines,
  skillsRef,
  skillsReportLines,
  writeAgentFiles,
  type AgentFileStatus,
  type AgentsOptions,
} from "./agent-setup.ts";
import { readVersion } from "./version.ts";
import {
  HTML_VALIDATE_SCRIPTS,
  BASCIK_EXTENSION_ID,
  vscodeReportLines,
  writeVscodeFiles,
  type VscodeFileStatus,
} from "./vscode-settings.ts";

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Bascik App</title>
</head>
<body>
  <h1>Hello from Bascik</h1>
  <p>Edit <code>src/pages/index.html</code> to get started.</p>
</body>
</html>
`;

/**
 * Lines init makes sure `.gitignore` has. The two `.pem` names are the files
 * pki.ts writes into the project folder when `http.tls.enabled` is set
 * without a keyFile or certFile; the private key must never be committed.
 * The exact names, not `*.pem`, so certificates a project commits on purpose
 * stay tracked.
 */
const REQUIRED_GITIGNORE_ENTRIES = [
  "dist/",
  "node_modules/.cache/bascik/",
  "bascik-privkey.pem",
  "bascik-cert.pem",
];

/** Write a file only if it does not already exist. Returns true when written. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    await writeFile(path, content, "utf8");
    return true;
  }
}

export interface InitOptions {
  /** `-y`: answer yes to the agent skills question. */
  yes?: boolean;
  /** False for `--no-skills`: neither ask about nor install the agent skills. */
  skills?: boolean;
  /** Asks a question and resolves with the answer. Defaults to the terminal. */
  ask?: (question: string) => Promise<string>;
  /** Installs the skills. Defaults to the skills CLI; replaced in tests. */
  install?: typeof installSkills;
  /** The Bascik version whose skills to install. Defaults to this package's. */
  version?: string;
}

export async function initProject(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  const pagesDir = join(cwd, "src", "pages");
  const componentsDir = join(cwd, "src", "components");
  const indexPath = join(pagesDir, "index.html");
  const gitignorePath = join(cwd, ".gitignore");
  const pkgPath = join(cwd, "package.json");
  const version = options.version ?? (await readVersion());

  // Read and check package.json before writing anything, so a refusal (a
  // "commonjs" project) leaves the folder exactly as it was.
  const pkgPlan = await planPackageJson(pkgPath, version);

  // Ensure directories exist
  await mkdir(pagesDir, { recursive: true });
  await mkdir(componentsDir, { recursive: true });

  // Create starter files (skip if already present)
  const wroteIndex = await writeIfAbsent(indexPath, INDEX_HTML);
  console.log(
    wroteIndex
      ? "  created: src/pages/index.html"
      : "  skipped: src/pages/index.html (already exists)",
  );

  const addedToGitignore = await ensureGitignoreEntries(
    gitignorePath,
    REQUIRED_GITIGNORE_ENTRIES,
  );
  console.log(
    addedToGitignore.length > 0
      ? `  updated: .gitignore (${addedToGitignore.join(", ")})`
      : "  skipped: .gitignore (already set)",
  );

  const scripts = await writePackageJson(pkgPath, pkgPlan);
  const commands = bascikCommands(scripts);
  await setUpVscode(cwd);
  await setUpAgentFiles(cwd, commands);
  await setUpSkills(cwd, options, version);
  printDone(commands);
}

type Commands = NonNullable<AgentsOptions["commands"]>;

/** Whether an npm script runs the Bascik CLI, with `--build` or without. */
function runsBascik(script: string | undefined, build: boolean): boolean {
  return (
    typeof script === "string" &&
    /^\s*(npx\s+)?bascik(\s|$)/.test(script) &&
    /(^|\s)--build(\s|=|$)/.test(script) === build
  );
}

/**
 * The commands that run the Bascik dev server and build: the npm scripts when
 * they run Bascik, otherwise `npx bascik`, as when a project's `dev` script
 * runs another tool or there is no package.json.
 */
function bascikCommands(
  scripts: Record<string, string> | undefined,
): Required<Commands> {
  return {
    dev: runsBascik(scripts?.dev, false) ? "npm run dev" : "npx bascik",
    build: runsBascik(scripts?.build, true)
      ? "npm run build"
      : "npx bascik --build",
  };
}

/** Write or merge AGENTS.md and CLAUDE.md, the brief every coding assistant reads. */
async function setUpAgentFiles(cwd: string, commands: Commands): Promise<void> {
  const report = await writeAgentFiles(cwd, { commands });
  const problems = agentFilesReportLines({
    agents: report.agents === "failed" ? "failed" : "unchanged",
    claude: report.claude === "failed" ? "failed" : "unchanged",
  });
  const added: Record<keyof typeof report, string> = {
    agents: 'a "## Bascik" section',
    claude: "@AGENTS.md",
  };
  const files = { agents: "AGENTS.md", claude: "CLAUDE.md" } as const;
  for (const key of ["agents", "claude"] as const) {
    const status: AgentFileStatus = report[key];
    if (status === "created") console.log(`  created: ${files[key]}`);
    else if (status === "updated") {
      console.log(`  updated: ${files[key]} (added ${added[key]})`);
    } else if (status === "unchanged") {
      console.log(`  skipped: ${files[key]} (already set)`);
    }
  }
  for (const line of problems) console.log(`  ${line}`);
}

/**
 * Ask whether to install the agent skills (yes by default) and install them
 * with the skills CLI. A failed install is reported with the command to run
 * later and never fails init.
 */
async function setUpSkills(
  cwd: string,
  options: InitOptions,
  version: string,
): Promise<void> {
  if (options.skills === false) {
    console.log("  skipped: agent skills (--no-skills)");
    return;
  }
  if (!options.yes) {
    let answer: string;
    if (options.ask) {
      answer = await options.ask(SKILLS_QUESTION);
    } else {
      const prompter = createPrompter();
      answer = await prompter.ask(SKILLS_QUESTION);
      prompter.close();
    }
    if (answeredNo(answer)) {
      console.log("  skipped: agent skills. To install them later, run:");
      for (const line of skillsLaterLines(skillsRef(version))) {
        console.log(`  ${line}`);
      }
      return;
    }
  }
  console.log("  installing: Bascik agent skills…");
  const result = (options.install ?? installSkills)(cwd, { version });
  for (const line of skillsReportLines(result)) console.log(`  ${line}`);
}

/** What init will do to package.json, decided before anything is written. */
type PackageJsonPlan =
  | { kind: "skip"; reason: string }
  | {
      kind: "update";
      pkg: Record<string, unknown>;
      changes: string[];
      scripts: Record<string, string>;
    };

/**
 * The dependency range init writes for @bascik/bascik: a caret range on the
 * version that is running, as create-bascik writes. `latest` is a dist-tag,
 * not a range, so it would float to whatever the tag points at on every
 * install without a lockfile; it is only the fallback when the running
 * version cannot be read.
 */
function bascikDependencyRange(version: string): string {
  return version === "unknown" ? "latest" : `^${version}`;
}

/**
 * Read package.json and work out what Bascik needs added. Throws, before
 * init has written anything, when the project sets "type": "commonjs".
 */
async function planPackageJson(
  pkgPath: string,
  version: string,
): Promise<PackageJsonPlan> {
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(pkgPath, "utf8");
  } catch {
    return { kind: "skip", reason: "not found — run `npm init` first" };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    return { kind: "skip", reason: "could not parse — edit manually" };
  }

  const changes: string[] = [];

  if (pkg.type === "commonjs") {
    throw new Error(
      '[bascik] init aborted: package.json sets "type": "commonjs". ' +
        "Bascik config uses ESM syntax, so update this project manually if you want to migrate. " +
        "Nothing was written.",
    );
  }

  // Use ESM for future bascik.config.ts support when package type is absent.
  if (pkg.type === undefined) {
    pkg.type = "module";
    changes.push('"type": "module"');
  }

  const hasDependency = (field: string): boolean => {
    const deps = pkg[field];
    return (
      typeof deps === "object" &&
      deps !== null &&
      Boolean((deps as Record<string, unknown>)["@bascik/bascik"])
    );
  };
  if (!hasDependency("dependencies") && !hasDependency("devDependencies")) {
    if (typeof pkg.dependencies !== "object" || pkg.dependencies === null) {
      pkg.dependencies = {};
    }
    (pkg.dependencies as Record<string, string>)["@bascik/bascik"] =
      bascikDependencyRange(version);
    changes.push('"@bascik/bascik" dependency');
  }

  // Add dev/build scripts
  if (typeof pkg.scripts !== "object" || pkg.scripts === null) {
    pkg.scripts = {};
  }
  const scripts = pkg.scripts as Record<string, string>;

  if (!scripts.dev) {
    scripts.dev = "bascik";
    changes.push('"dev" script');
  }
  if (!scripts.build) {
    scripts.build = "bascik --build";
    changes.push('"build" script');
  }

  return { kind: "update", pkg, changes, scripts };
}

/**
 * Write the planned package.json changes. Resolves with the scripts it ends
 * up with, or undefined when there is no package.json it could read.
 */
async function writePackageJson(
  pkgPath: string,
  plan: PackageJsonPlan,
): Promise<Record<string, string> | undefined> {
  if (plan.kind === "skip") {
    console.log(`  skipped: package.json (${plan.reason})`);
    return undefined;
  }
  if (plan.changes.length > 0) {
    await writeFile(pkgPath, JSON.stringify(plan.pkg, null, 2) + "\n", "utf8");
    console.log(`  updated: package.json (${plan.changes.join(", ")})`);
  } else {
    console.log("  skipped: package.json (already configured)");
  }
  return plan.scripts;
}

/**
 * Write or merge .vscode/settings.json and .vscode/extensions.json. VS Code's
 * HTML checker joins a page's <script> blocks into one file, so two Bascik
 * scripts that each `export default` show a false error without the setting.
 */
async function setUpVscode(cwd: string): Promise<void> {
  const report = await writeVscodeFiles(cwd);
  const added: Record<keyof typeof report, string> = {
    settings: `"${HTML_VALIDATE_SCRIPTS}": false`,
    extensions: BASCIK_EXTENSION_ID,
  };
  const problems = vscodeReportLines({
    settings: keepProblem(report.settings),
    extensions: keepProblem(report.extensions),
  });
  for (const key of ["settings", "extensions"] as const) {
    const file = `.vscode/${key}.json`;
    const status = report[key];
    if (status === "created") console.log(`  created: ${file}`);
    else if (status === "updated") {
      console.log(`  updated: ${file} (added ${added[key]})`);
    } else if (status === "unchanged") {
      console.log(`  skipped: ${file} (already set)`);
    }
  }
  for (const line of problems) console.log(`  ${line}`);
}

/** Only the statuses that need the user to act, for vscodeReportLines. */
function keepProblem(status: VscodeFileStatus): VscodeFileStatus {
  return status === "invalid" || status === "failed" ? status : "unchanged";
}

function printDone(commands: Commands): void {
  const start =
    commands.dev === "npm run dev"
      ? "  npm run dev\n  yarn dev"
      : `  ${commands.dev}`;
  console.log(`
Done! Start the dev server with:

${start}

Configuration is optional. Create bascik.config.ts only when you need
to change a default: https://bascik.dev/configuration
`);
}

/**
 * Append the entries `.gitignore` lacks, in the file's own newline style (a
 * CRLF file stays CRLF). Resolves with the entries it added.
 */
async function ensureGitignoreEntries(
  path: string,
  entries: string[],
): Promise<string[]> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }

  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const toAppend = entries.filter((entry) => !existing.has(entry));
  if (toAppend.length === 0) {
    return [];
  }

  let next = current;
  if (next.length > 0 && !next.endsWith("\n")) {
    next += newline;
  }
  next += toAppend.join(newline) + newline;
  await writeFile(path, next, "utf8");
  return toAppend;
}
