/**
 * create-cli.integration.test.ts
 *
 * The create-bascik command as a reader runs it, end to end.
 *
 * Boundary tested:
 * `node <compiled create-bascik> …` in a temporary folder -> real scaffold -> real skills CLI
 * (`npx skills@<pinned> add`) -> files on disk and the printed output.
 *
 * Collaborators:
 * - The TypeScript compiler, which builds `src/` into a temporary folder once, so the test runs the
 *   same JavaScript `npm create bascik` runs without depending on a separate `yarn create:build`.
 * - The real skills CLI through npx. `BASCIK_SKILLS_SOURCE` points it at this repository's checkout,
 *   so it installs the skills on this branch without GitHub; npx needs the network only the first
 *   time it fetches the pinned CLI.
 *
 * Contract asserted:
 * 1. `-y --no-skills` writes AGENTS.md and CLAUDE.md, installs no skills, and prints the pinned
 *    command to install them later, as `bascik init` does.
 * 2. `-y` installs every project skill, byte for byte, as real copies in `.agents/skills/` and
 *    `.claude/skills/`, without the opt-in `bascik-refactor`.
 * 3. Without a terminal and without `-y`, the run finishes (it used to exit 13 mid-way): piped
 *    answers are used in order, and questions after the input ends take their defaults.
 * 4. A skills install that fails never fails the scaffold: exit 0 and the command to run later.
 * 5. A typo'd flag is refused before anything is written, naming the flag it meant.
 * 6. A project name that would leave the current folder, or a target that already holds the
 *    starter's files or is a file, is refused in one line, exit 1, with nothing written.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_MD,
  PROJECT_SKILLS,
  SKILLS_QUESTION,
  SKILLS_SOURCE_ENV,
  agentsMd,
  skillsCommand,
  skillsLaterLines,
  skillsRef,
} from "./agent-setup.ts";
import { BASCIK_VERSION } from "./scaffold.ts";

/** The command to run later, pinned to the version create-bascik scaffolds. */
const LATER = skillsLaterLines(skillsRef(BASCIK_VERSION));

const CREATE_DIR = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(CREATE_DIR, "..");

let work: string;
let entry: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "bascik-create-cli-"));
  const out = join(work, "dist");
  const tsc = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
      "-p",
      join(CREATE_DIR, "tsconfig.build.json"),
      "--outDir",
      out,
      "--declarationDir",
      join(work, "types"),
      "--sourceMap",
      "false",
    ],
    { encoding: "utf8" },
  );
  expect(tsc.status, `${tsc.stdout}${tsc.stderr}`).toBe(0);
  entry = join(out, "index.js");
}, 60_000);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** Run create-bascik in a fresh folder with `input` piped to stdin (then closed). */
async function create(
  args: string[],
  options: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    /** Called with the fresh folder before create-bascik runs in it. */
    setup?: (parent: string) => void;
  } = {},
): Promise<{ status: number | null; output: string; parent: string }> {
  const parent = await mkdtemp(join(work, "run-"));
  options.setup?.(parent);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // npm sets these when it runs create-bascik; a leftover one would change the flags.
  delete env.npm_config_yes;
  delete env.npm_config_skills;
  delete env.npm_config_install;
  delete env.npm_config_template;
  Object.assign(env, options.env);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: parent,
    env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    parent,
  };
}

const QUIET = ["--no-install", "--no-dev"];

describe("npm create bascik and the agent skills", () => {
  it("-y --no-skills writes AGENTS.md and CLAUDE.md and installs no skills", async () => {
    const { status, output, parent } = await create([
      "my-site",
      "-y",
      "--no-skills",
      ...QUIET,
    ]);
    expect(status, output).toBe(0);
    const site = join(parent, "my-site");
    expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe(agentsMd());
    expect(readFileSync(join(site, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
    expect(existsSync(join(site, ".agents"))).toBe(false);
    expect(existsSync(join(site, ".claude"))).toBe(false);
    expect(existsSync(join(site, "skills-lock.json"))).toBe(false);
    expect(output).not.toContain("Installing the Bascik agent skills");
    expect(output).toContain(
      `To install the Bascik agent skills later, run this in my-site:\n${LATER.join("\n")}\n`,
    );
    expect(LATER[0]).toContain(`#v${BASCIK_VERSION}`);
  });

  it("misuse: --no-skills and --no-install written before --, which npm exports as empty values, are honored", async () => {
    // What npm 11 hands over for `npm create bascik my-site -y --no-skills --no-install -- --no-dev`.
    const { status, output, parent } = await create(["my-site", "--no-dev"], {
      env: {
        npm_config_yes: "true",
        npm_config_skills: "",
        npm_config_install: "",
      },
    });
    expect(status, output).toBe(0);
    expect(output).not.toContain("Installing the Bascik agent skills");
    expect(output).not.toContain("Installing dependencies");
    expect(output).toContain(LATER[0]);
    expect(existsSync(join(parent, "my-site", ".agents"))).toBe(false);
    expect(existsSync(join(parent, "my-site", "node_modules"))).toBe(false);
  });

  it("misuse: --no-install also skips the dev server, which cannot start without dependencies", async () => {
    const { status, output } = await create([
      "my-site",
      "-y",
      "--no-skills",
      "--no-install",
    ]);
    expect(status, output).toBe(0);
    expect(output).not.toContain("Starting dev server");
    expect(output).toContain(
      "Next steps:\n\n  cd my-site\n  npm install\n  npm run dev\n",
    );
  });

  it("misuse: answering n to the install does not ask to start the dev server", async () => {
    // Skills: n, install: n. A dev question would take the third answer.
    const { status, output } = await create(
      ["my-site", "--template", "default"],
      { input: "n\nn\n" },
    );
    expect(status, output).toBe(0);
    expect(output).not.toContain("Start the dev server");
    expect(output).not.toContain("Starting dev server");
    expect(output).toContain("  npm install\n  npm run dev\n");
  });

  it("misuse: a failed npm install does not go on to start the dev server", async () => {
    // A stand-in npm that records its arguments and fails, as npm install does offline.
    const fakeBin = await mkdtemp(join(work, "fake-npm-"));
    const log = join(fakeBin, "npm.log");
    writeFileSync(
      join(fakeBin, "npm"),
      '#!/bin/sh\necho "$@" >> "$NPM_LOG"\nexit 1\n',
    );
    chmodSync(join(fakeBin, "npm"), 0o755);
    writeFileSync(
      join(fakeBin, "npm.cmd"),
      '@echo %*>>"%NPM_LOG%"\r\n@exit /b 1\r\n',
    );
    const pathKey =
      Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
      "PATH";
    const { status, output } = await create(["my-site", "-y", "--no-skills"], {
      env: {
        NPM_LOG: log,
        [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey] ?? ""}`,
      },
    });
    expect(status, output).toBe(0);
    expect(readFileSync(log, "utf8").trim().split(/\r?\n/)).toEqual([
      "install",
    ]);
    expect(output).toContain(
      'npm install did not finish. Run "npm install" in my-site yourself.',
    );
    expect(output).not.toContain("Starting dev server");
    expect(output).toContain("  cd my-site\n  npm install\n  npm run dev\n");
  });

  it("-y installs every project skill as real copies in both folders, without bascik-refactor", async () => {
    const { status, output, parent } = await create(
      ["my-site", "-y", ...QUIET],
      { env: { [SKILLS_SOURCE_ENV]: REPO_ROOT } },
    );
    expect(status, output).toBe(0);
    expect(output).toContain(
      "✓ Installed the Bascik agent skills in .agents/skills/ and .claude/skills/",
    );
    const site = join(parent, "my-site");
    for (const dir of [".agents/skills", ".claude/skills"]) {
      expect(readdirSync(join(site, dir)).sort(), dir).toEqual(
        [...PROJECT_SKILLS].sort(),
      );
      for (const name of PROJECT_SKILLS) {
        const installed = join(site, dir, name);
        expect(lstatSync(installed).isSymbolicLink(), installed).toBe(false);
        expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toBe(
          readFileSync(join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8"),
        );
      }
    }
    expect(
      readFileSync(
        join(site, ".claude/skills/bascik/scripts/verify.mjs"),
        "utf8",
      ),
    ).toBe(
      readFileSync(join(REPO_ROOT, "skills/bascik/scripts/verify.mjs"), "utf8"),
    );
    expect(existsSync(join(site, "skills-lock.json"))).toBe(true);
  }, 120_000);

  it("misuse: without a terminal and without -y it uses piped answers in order, then defaults, and finishes", async () => {
    // The first answer is the skills question's; the input then ends.
    const { status, output, parent } = await create(
      ["my-site", "--template", "default", ...QUIET],
      { input: "n\n" },
    );
    expect(status, output).toBe(0);
    expect(output).not.toContain("unsettled top-level await");
    expect(output).toContain(`${SKILLS_QUESTION}n\n`);
    expect(existsSync(join(parent, "my-site", ".agents"))).toBe(false);
    expect(existsSync(join(parent, "my-site", "AGENTS.md"))).toBe(true);
    // Answering n gets the same hint as --no-skills and bascik init.
    expect(output).toContain(LATER[0]);
  });

  it("misuse: with stdin closed and no answers, every question takes its default instead of exiting 13", async () => {
    const { status, output, parent } = await create(["--no-skills", ...QUIET], {
      input: "",
    });
    expect(status, output).toBe(0);
    expect(output).toContain("Project name (bascik-app): \n");
    expect(output).toContain("Deploy to Cloudflare Workers? (y/N) \n");
    expect(existsSync(join(parent, "bascik-app", "AGENTS.md"))).toBe(true);
  });

  it("misuse: a skills install that fails still scaffolds, exits 0 and prints the command to run later", async () => {
    const { status, output, parent } = await create(
      ["my-site", "-y", ...QUIET],
      { env: { [SKILLS_SOURCE_ENV]: join(work, "no-such-checkout") } },
    );
    expect(status, output).toBe(0);
    expect(output).toMatch(
      /Could not install the Bascik agent skills \(.+\)\./,
    );
    expect(output).toContain(`  ${skillsCommand(skillsRef(BASCIK_VERSION))}\n`);
    expect(existsSync(join(parent, "my-site", "src/pages/index.html"))).toBe(
      true,
    );
  }, 120_000);

  it.each([["--help"], ["-h"], ["my-site", "--help"]])(
    "%s prints the usage and exits 0 without asking or writing anything",
    async (...args) => {
      const { status, output, parent } = await create(args);
      expect(status).toBe(0);
      expect(output).toContain("Usage: npm create bascik@rc");
      expect(output).toContain("--template <name>");
      expect(output).not.toContain("Project name");
      expect(readdirSync(parent)).toEqual([]);
    },
  );

  it.each([[".."], ["."], ["/abs/site"], ["my site"]])(
    "misuse: the project name %j is refused before anything is written",
    async (name) => {
      const { status, output, parent } = await create([
        name,
        "-y",
        "--no-skills",
        ...QUIET,
      ]);
      expect(status, output).toBe(1);
      expect(output).toContain(`Error: "${name}"`);
      expect(output).not.toContain("Creating Bascik project");
      expect(readdirSync(parent)).toEqual([]);
      expect(existsSync(join(parent, "..", "package.json"))).toBe(false);
    },
  );

  it("misuse: an existing project's package.json and pages are kept, and nothing is written", async () => {
    const packageJson = '{ "name": "my-site", "version": "9.9.9" }\n';
    const page = "<h1>Mine</h1>\n";
    const { status, output, parent } = await create(
      ["my-site", "-y", "--no-skills", ...QUIET],
      {
        setup: (dir) => {
          mkdirSync(join(dir, "my-site", "src", "pages"), { recursive: true });
          writeFileSync(join(dir, "my-site", "package.json"), packageJson);
          writeFileSync(join(dir, "my-site", "src/pages/index.html"), page);
        },
      },
    );
    expect(status, output).toBe(1);
    expect(output).toContain(
      'Error: "my-site" already has package.json, src/pages/index.html, which the starter would replace. Nothing was written.',
    );
    expect(output).toContain("https://bascik.dev/getting-started#manual-setup");
    expect(output).not.toContain("Scaffolded");
    const site = join(parent, "my-site");
    expect(readFileSync(join(site, "package.json"), "utf8")).toBe(packageJson);
    expect(readFileSync(join(site, "src/pages/index.html"), "utf8")).toBe(page);
    expect(readdirSync(site).sort()).toEqual(["package.json", "src"]);
  });

  it("misuse: a project name that is an existing file is refused without a stack trace", async () => {
    const { status, output, parent } = await create(
      ["notes.txt", "-y", "--no-skills", ...QUIET],
      { setup: (dir) => writeFileSync(join(dir, "notes.txt"), "mine\n") },
    );
    expect(status, output).toBe(1);
    expect(output).toContain(
      'Error: "notes.txt" already exists and is not a folder.',
    );
    expect(output).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(parent, "notes.txt"), "utf8")).toBe("mine\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "misuse: a folder it cannot write to is reported in one line, not a stack trace",
    async () => {
      const { status, output } = await create(
        ["locked/my-site", "-y", "--no-skills", ...QUIET],
        {
          setup: (dir) => {
            mkdirSync(join(dir, "locked"));
            chmodSync(join(dir, "locked"), 0o500);
          },
        },
      );
      expect(status, output).toBe(1);
      expect(output).toMatch(
        /Error: could not create locked\/my-site: EACCES: permission denied/,
      );
      expect(output).not.toMatch(/\n\s+at /);
    },
  );

  it("misuse: a typo'd --no-skill is refused before anything is written", async () => {
    const { status, output, parent } = await create([
      "my-site",
      "-y",
      "--no-skill",
      ...QUIET,
    ]);
    expect(status).toBe(1);
    expect(output).toContain(
      'Unknown option "--no-skill". Did you mean "--no-skills"?',
    );
    expect(existsSync(join(parent, "my-site"))).toBe(false);
  });
});
