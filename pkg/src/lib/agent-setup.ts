/**
 * @module agent-setup
 *
 * Sets a new Bascik project up for coding assistants:
 *
 *  - `AGENTS.md` is a short project brief that GitHub Copilot, Cursor, Codex,
 *    Gemini CLI and others read: the commands, the house rules, and where the
 *    agent skills live.
 *  - `CLAUDE.md` imports that brief with `@AGENTS.md`. Claude Code reads
 *    CLAUDE.md, and skips AGENTS.md when a CLAUDE.md exists, so the import is
 *    what makes every assistant read the same brief.
 *  - The Bascik agent skills are installed with the skills CLI
 *    (https://skills.sh) into `.agents/skills/` and `.claude/skills/`, pinned
 *    to the Bascik version being set up. The opt-in `bascik-refactor` skill is
 *    left out.
 *
 * Existing AGENTS.md and CLAUDE.md files are merged, never replaced. A skills
 * install that fails, such as when offline, never fails the setup: the report
 * says which command to run later.
 *
 * Two identical copies exist, `create/src/agent-setup.ts` for
 * `npm create bascik` and `pkg/src/lib/agent-setup.ts` for `bascik init`.
 * `create/src/agent-setup.test.ts` fails when they differ.
 */

import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ─── Skills ───────────────────────────────────────────────────────────────────

/** The GitHub repository the skills CLI installs the Bascik skills from. */
export const SKILLS_REPO = "bascikdev/bascik";

/**
 * The skills CLI, pinned so its flags cannot change under a released
 * create-bascik. 1.7.4 needs Node 22.20, below Bascik's 22.22 floor.
 */
export const SKILLS_CLI = "skills@1.7.4";

/** The skills CLI agents whose folders a project gets, in SKILL_DESTINATIONS order. */
export const SKILL_AGENTS = ["universal", "claude-code"] as const;

/**
 * Project directories that receive the agent skills. `.agents/skills` is the shared location read by GitHub
 * Copilot, Cursor, Codex, Gemini CLI, OpenCode, and others; Claude Code reads `.claude/skills`.
 */
export const SKILL_DESTINATIONS = [".agents/skills", ".claude/skills"] as const;

/**
 * The skills a new project gets. The skills CLI has no way to leave one out
 * and silently ignores a name it does not know, so this is the full list of
 * the repository's `skills/` folders minus OPT_IN_SKILLS, and a test keeps it
 * that way.
 */
export const PROJECT_SKILLS = [
  "bascik",
  "bascik-compatibility",
  "bascik-components",
  "bascik-config",
  "bascik-migrate",
  "bascik-scripts",
  "bascik-seo",
  "bascik-testing",
] as const;

/** Skills readers install on purpose with `--skill <name>`. */
export const OPT_IN_SKILLS = ["bascik-refactor"] as const;

export const SKILLS_QUESTION =
  "Install the Bascik agent skills for coding assistants (Claude Code, Copilot, Cursor, Codex...)? (Y/n) ";

/**
 * Replaces the GitHub source, such as with a local checkout of the
 * repository, so tests install without the network. Used as given: no
 * version pin and no fallback.
 */
export const SKILLS_SOURCE_ENV = "BASCIK_SKILLS_SOURCE";

/** The git tag the skills for `version` are released under, or undefined when it is not a release version. */
export function skillsRef(version: string | undefined): string | undefined {
  return version !== undefined &&
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)
    ? `v${version}`
    : undefined;
}

/** The arguments after `npx skills` that install the project skills from `source`. */
export function skillsAddArgs(source: string): string[] {
  return [
    "add",
    source,
    ...SKILL_AGENTS.flatMap((agent) => ["-a", agent]),
    "--copy",
    "-y",
    "--skill",
    ...PROJECT_SKILLS,
  ];
}

/** The command a reader runs to install the project skills, at `ref` when given. */
export function skillsCommand(ref?: string): string {
  const source = ref ? `${SKILLS_REPO}#${ref}` : SKILLS_REPO;
  return `npx skills ${skillsAddArgs(source).join(" ")}`;
}

type SpawnSyncFunction = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

/**
 * The command that runs `npx <args>`. On Windows `npx` is `npx.cmd`, which
 * Node cannot start directly, so it goes through `cmd.exe` the way
 * create-bascik's `npmInvocation` runs npm.
 */
export function npxInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  return platform === "win32"
    ? {
        command: env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", "npx", ...args],
      }
    : { command: "npx", args };
}

/**
 * The lines that give the command to run later: pinned to `ref` when there
 * is one, so the skills match the Bascik version, and how to drop the pin if
 * that tag does not exist yet.
 */
export function skillsLaterLines(ref: string | undefined): string[] {
  return [
    `  ${skillsCommand(ref)}`,
    ...(ref
      ? [`(If the ${ref} tag is not found, run it without #${ref}.)`]
      : []),
  ];
}

/**
 * Output that shows npx or npm failed to reach the registry, before the
 * skills CLI ran. Trying another source then only waits on the network again.
 */
const NPM_NETWORK_FAILURE =
  /npm (error|ERR!)|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET/;

/**
 * npm settings for the npx run, unless the user set their own: no fetch
 * retries and a short fetch timeout, so a first run offline, with the CLI not
 * yet in npm's cache, fails in seconds instead of after minutes of silence.
 */
const NPM_FETCH_ENV = {
  npm_config_fetch_retries: "0",
  npm_config_fetch_timeout: "20000",
} as const;

/** The longest one skills CLI run may take; a full install takes seconds. */
const SKILLS_TIMEOUT_MS = 90_000;

export interface SkillsInstallResult {
  /**
   * `pinned`: installed at the release tag. `latest`: the tag install failed
   * and the default branch worked. `custom`: installed from SKILLS_SOURCE_ENV.
   * `failed`: nothing was installed.
   */
  status: "pinned" | "latest" | "custom" | "failed";
  /** The release tag that was tried, when the version had one. */
  ref?: string;
  /** Why the last attempt failed. */
  error?: string;
  /** The command to run later, when status is `failed`, pinned to `ref` when there is one. */
  command: string;
}

/** The last line a failed run printed, without terminal colors, as its reason. */
function failureReason(result: SpawnSyncReturns<Buffer | string>): string {
  if (result.error) return result.error.message;
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(
    /\u001b\[[0-9;?]*[A-Za-z]/g,
    "",
  );
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s│└┌◇◆■●○◒◐◓◑|]+/, "").trim())
    .filter(Boolean);
  const failure = lines.filter((line) => /fail|error|not found/i.test(line));
  return (
    failure[0] ??
    lines.at(-1) ??
    `skills CLI exited with ${result.status ?? result.signal}`
  );
}

/**
 * Install the project skills into `cwd` with the skills CLI: at the release
 * tag for `version` first, then from the default branch. Output is captured
 * so a failed first attempt does not alarm anyone. Never throws.
 */
export function installSkills(
  cwd: string,
  options: {
    version?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: SpawnSyncFunction;
  } = {},
): SkillsInstallResult {
  const env = options.env ?? process.env;
  const ref = skillsRef(options.version);
  const custom = env[SKILLS_SOURCE_ENV];
  const sources = custom
    ? [custom]
    : ref
      ? [`${SKILLS_REPO}#${ref}`, SKILLS_REPO]
      : [SKILLS_REPO];
  const spawnEnv: NodeJS.ProcessEnv = { ...NPM_FETCH_ENV, ...env };
  let error = "";
  for (const [index, source] of sources.entries()) {
    // --prefer-offline: a pinned CLI version never changes, so npm's cache is
    // used without asking the registry, which also keeps an offline run fast.
    const { command, args } = npxInvocation(
      ["--prefer-offline", "-y", SKILLS_CLI, ...skillsAddArgs(source)],
      options.platform,
      env,
    );
    const result = (options.spawn ?? spawnSync)(command, args, {
      cwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: SKILLS_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0) {
      const status = custom
        ? "custom"
        : index === 0 && ref
          ? "pinned"
          : "latest";
      return { status, ref, command: skillsCommand(ref) };
    }
    error = failureReason(result);
    // Only a skills CLI failure, such as a missing tag, is worth another
    // source. A spawn error, a timeout or npm offline would just repeat.
    if (
      result.error ||
      NPM_NETWORK_FAILURE.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
    ) {
      break;
    }
  }
  return { status: "failed", ref, error, command: skillsCommand(ref) };
}

/** What to tell the user about a skills install, one line per entry. */
export function skillsReportLines(result: SkillsInstallResult): string[] {
  const where = SKILL_DESTINATIONS.map((dir) => `${dir}/`).join(" and ");
  switch (result.status) {
    case "pinned":
      return [
        `✓ Installed the Bascik agent skills (${result.ref}) in ${where}`,
      ];
    case "latest":
      return [
        `✓ Installed the Bascik agent skills in ${where} from the default branch` +
          (result.ref
            ? `, because the ${result.ref} skills could not be installed`
            : ""),
      ];
    case "custom":
      return [`✓ Installed the Bascik agent skills in ${where}`];
    case "failed":
      return [
        `Could not install the Bascik agent skills (${result.error}).`,
        "Run this in the project folder when you are online:",
        `  ${result.command}`,
        ...skillsLaterLines(result.ref).slice(1),
      ];
  }
}

// ─── AGENTS.md and CLAUDE.md ──────────────────────────────────────────────────

/** The heading of the Bascik section, which is how a merge finds it again. */
export const AGENTS_SECTION_HEADING = "## Bascik";

/** The line in CLAUDE.md that imports the brief. Claude Code skips it inside code. */
export const CLAUDE_IMPORT = "@AGENTS.md";

const DOCS = "https://bascik.dev";

export interface AgentsOptions {
  template?: "default" | "cloudflare";
  /**
   * The commands that run the Bascik dev server and build, when the
   * project's `dev` and `build` npm scripts do not, such as `bascik init` in
   * a project whose scripts run another tool. Default: `npm run dev` and
   * `npm run build`.
   */
  commands?: { dev?: string; build?: string };
}

/** The Bascik section of AGENTS.md, added on its own to an AGENTS.md that has none. */
export function agentsSection(options: AgentsOptions = {}): string {
  const dev = options.commands?.dev ?? "npm run dev";
  const build = options.commands?.build ?? "npm run build";
  const preview =
    options.template === "cloudflare"
      ? "- `npm run preview`: run the built Worker locally in workerd (after `npm run build`)"
      : "- `npx bascik --server`: serve the production build to preview it";
  return `${AGENTS_SECTION_HEADING}

This site is built with [Bascik](${DOCS}): HTML pages and components compiled to plain HTML, CSS and JavaScript.

### Commands

- \`${dev}\`: dev server with live reload at http://localhost:8080
- \`${build}\`: production build into \`dist/\`
- \`npx bascik --check\`: validate pages, components and config
${preview}

### House rules

- Pages read like a list of tag names, such as \`<site-header>\` and \`<feat-card>\`, not long blocks of HTML. Give a section its own component in \`src/components/\` when it has its own job, but do not split further, and pass markup through slots instead of handing props down several layers. See [Components](${DOCS}/components) and [Slots](${DOCS}/slots).
- Write all new code in TypeScript, browser scripts included: a \`.ts\` companion file (\`<script src="counter.ts">\`) or \`<script type="text/typescript">\`. When a script needs full TypeScript or npm packages bundled, run esbuild through [\`scripts.typescript\`](${DOCS}/configuration#scriptstypescript). See [TypeScript in Component Scripts](${DOCS}/scoped-javascript#typescript-in-component-scripts).
- Build HTML that holds visitor data with \`html\` from \`@bascik/bascik/html\`, which escapes every value. See [HTML Helpers](${DOCS}/html-helpers).
- Use semantic HTML: the element for the job (\`<nav>\`, \`<main>\`, \`<article>\`, \`<button>\` for actions, \`<a href>\` for links, a \`<label>\` for every input), one \`<h1>\` per page with no skipped heading levels, \`alt\` on every image, and a component root that is the semantic element itself, not a wrapper \`<div>\`. Bascik ships the markup you write. See [Component Best Practices](${DOCS}/component-best-practices#use-htmls-elements).
- Put \`data-testid\` on each component's root element and on its interactive parts.
- Run \`npx bascik --check\`, and the tests when there are any, before calling work done.

### Agent skills

The Bascik skills in \`.agents/skills/\` and \`.claude/skills/\` hold the details; read them before writing Bascik code. \`skills-lock.json\` records the version they came from. \`npx skills update\` keeps that version, so after upgrading \`@bascik/bascik\` install the matching skills, with the new version in place of \`<version>\`:

\`\`\`sh
${skillsCommand("v<version>")}
\`\`\`

When the folders are missing, run it with this project's \`@bascik/bascik\` version, or without \`#v<version>\` if that tag does not exist. See [Agent Skills](${DOCS}/agent-skills).
`;
}

/** A new project's AGENTS.md. */
export function agentsMd(options: AgentsOptions = {}): string {
  return `# AGENTS.md

Guidance for coding assistants working in this project. Claude Code reads it through \`CLAUDE.md\`.

${agentsSection(options)}`;
}

/** A new project's CLAUDE.md: the import line, then room for notes only Claude Code needs. */
export const CLAUDE_MD = `${CLAUDE_IMPORT}

<!-- Claude Code reads this file instead of AGENTS.md, so the line above imports the shared brief. Add notes only Claude Code needs below. -->
`;

export type AgentFileStatus = "created" | "updated" | "unchanged" | "failed";

export interface AgentFilesReport {
  agents: AgentFileStatus;
  claude: AgentFileStatus;
}

/** Whether `text` has `line` on a line of its own outside fenced code. */
function hasLine(text: string, line: RegExp): boolean {
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    else if (!fenced && line.test(raw)) return true;
  }
  return false;
}

/** `addition` after `existing`, a blank line apart, in the file's own line endings. */
function append(existing: string, addition: string): string {
  const nl = existing.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = existing.replace(/(\r?\n)*$/, "");
  return `${trimmed}${nl}${nl}${addition.replace(/\n/g, nl)}`;
}

/** Add the Bascik section to an AGENTS.md, keeping what is there. */
export function mergeAgentsMd(
  existing: string | undefined,
  options: AgentsOptions = {},
): { status: "created" | "updated" | "unchanged"; text: string } {
  if (existing === undefined || existing.trim() === "") {
    return { status: "created", text: agentsMd(options) };
  }
  if (hasLine(existing, /^##\s+Bascik\s*$/)) {
    return { status: "unchanged", text: existing };
  }
  return { status: "updated", text: append(existing, agentsSection(options)) };
}

/** Add the `@AGENTS.md` import to a CLAUDE.md, keeping what is there. */
export function mergeClaudeMd(existing: string | undefined): {
  status: "created" | "updated" | "unchanged";
  text: string;
} {
  if (existing === undefined || existing.trim() === "") {
    return { status: "created", text: CLAUDE_MD };
  }
  if (hasLine(existing, /^\s*@(\.\/)?AGENTS\.md\s*$/)) {
    return { status: "unchanged", text: existing };
  }
  return { status: "updated", text: append(existing, `${CLAUDE_IMPORT}\n`) };
}

async function mergeFile(
  path: string,
  merge: (existing: string | undefined) => {
    status: "created" | "updated" | "unchanged";
    text: string;
  },
): Promise<AgentFileStatus> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
  }
  const result = merge(existing);
  if (result.status !== "unchanged") {
    try {
      await writeFile(path, result.text, "utf8");
    } catch {
      return "failed";
    }
  }
  return result.status;
}

/**
 * Write or merge AGENTS.md and CLAUDE.md in `root`. Never throws; the report
 * says what happened to each file.
 */
export async function writeAgentFiles(
  root: string,
  options: AgentsOptions = {},
): Promise<AgentFilesReport> {
  const [agents, claude] = await Promise.all([
    mergeFile(join(root, "AGENTS.md"), (existing) =>
      mergeAgentsMd(existing, options),
    ),
    mergeFile(join(root, "CLAUDE.md"), mergeClaudeMd),
  ]);
  return { agents, claude };
}

/** Lines worth showing the user: what was added to an existing file, and what to fix by hand. */
export function agentFilesReportLines(report: AgentFilesReport): string[] {
  const lines: string[] = [];
  if (report.agents === "updated") {
    lines.push(`AGENTS.md: added a "${AGENTS_SECTION_HEADING}" section`);
  } else if (report.agents === "failed") {
    lines.push(
      `AGENTS.md: could not be written. Add a "${AGENTS_SECTION_HEADING}" section with the commands and house rules from ${DOCS}/agent-skills#project-brief.`,
    );
  }
  if (report.claude === "updated") {
    lines.push(`CLAUDE.md: added ${CLAUDE_IMPORT}`);
  } else if (report.claude === "failed") {
    lines.push(
      `CLAUDE.md: could not be written. Add a line with ${CLAUDE_IMPORT} to it so Claude Code reads AGENTS.md.`,
    );
  }
  return lines;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

/** Whether an answer to a "(Y/n)" question is no. Anything else, including Enter, is yes. */
export function answeredNo(answer: string): boolean {
  return /^no?$/i.test(answer.trim());
}

export interface Prompter {
  /** Print `question` and resolve with the next line, or "" once input has ended. */
  ask(question: string): Promise<string>;
  close(): void;
}

/**
 * Ask questions on a terminal or a pipe. Lines that arrive before their
 * question, as when answers are piped in, are kept for it, and once input
 * ends (stdin closed, or `</dev/null`) every question gets "", its default,
 * so a run without a terminal never hangs or dies mid-way.
 */
export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  const terminal = Boolean(
    (input as { isTTY?: boolean }).isTTY &&
    (output as { isTTY?: boolean }).isTTY,
  );
  const rl = createInterface({ input, output, terminal });
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let closed = false;
  const answer = (line: string): void => {
    const resolve = waiting;
    waiting = undefined;
    // A typed answer is already on screen; a piped or missing one is not.
    if (!terminal) output.write(`${line}\n`);
    else if (closed) output.write("\n");
    resolve?.(line);
  };
  rl.on("line", (line) => (waiting ? answer(line) : queued.push(line)));
  rl.on("close", () => {
    closed = true;
    if (waiting) answer("");
  });
  rl.on("SIGINT", () => {
    output.write("\n");
    process.exit(130);
  });
  return {
    ask(question) {
      if (closed) {
        output.write(question);
      } else {
        rl.setPrompt(question);
        rl.prompt();
      }
      return new Promise((resolve) => {
        waiting = resolve;
        if (queued.length > 0) answer(queued.shift()!);
        else if (closed) answer("");
      });
    },
    close() {
      rl.close();
    },
  };
}
