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
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; output: string; parent: string }> {
  const parent = await mkdtemp(join(work, "run-"));
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  // npm sets these when it runs create-bascik; a leftover one would change the flags.
  delete env.npm_config_yes;
  delete env.npm_config_skills;
  delete env.npm_config_template;
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
