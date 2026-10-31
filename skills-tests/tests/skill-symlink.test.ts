// The public skill scripts as commands: each one runs its CLI only when it is the script Node was asked to run.
// That check must hold however the path is spelled. Node resolves symlinks in the main module's path before it sets
// import.meta.url, so comparing it with process.argv[1] as typed made every script a silent no-op (exit 0, no output)
// when any folder on the path was a symlink: the skills CLI's symlink install into .claude/skills, a linked skills
// folder, a Windows junction, or macOS's /tmp and $TMPDIR. An audit used as a CI gate (`audit-seo.mjs --strict`,
// `verify.mjs`) then passed without checking anything. These tests spawn each script through a link to the skills
// folder and through its real path. bascik-refactor has the same check in refactor-cli.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));

/** Every script outside bascik-refactor, by its path under skills/. */
const SCRIPTS = [
  "bascik/scripts/add-example.mjs",
  "bascik/scripts/audit-components.mjs",
  "bascik/scripts/check-links.mjs",
  "bascik/scripts/list-components.mjs",
  "bascik/scripts/new-component.mjs",
  "bascik/scripts/preview.mjs",
  "bascik/scripts/read-doc.mjs",
  "bascik/scripts/search-docs.mjs",
  "bascik/scripts/verify.mjs",
  "bascik-compatibility/scripts/baseline.mjs",
  "bascik-compatibility/scripts/lookup.mjs",
  "bascik-components/scripts/check-tokens.mjs",
  "bascik-config/scripts/audit-config.mjs",
  "bascik-config/scripts/check-workspace.mjs",
  "bascik-scripts/scripts/new-post.mjs",
  "bascik-seo/scripts/audit-seo.mjs",
];

let tmp: string;
let link: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bascik-skill-symlink-"));
  link = join(tmp, "skills");
  // A junction needs no admin rights on Windows; elsewhere the type is ignored and a plain symlink is made.
  symlinkSync(SKILLS, link, "junction");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const run = (dir: string, script: string, args: string[]) =>
  spawnSync(process.execPath, [join(dir, script), ...args], {
    // Never let a script reach a project here.
    cwd: tmp,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

describe.each([
  ["the real path", () => SKILLS],
  ["a symlinked skills folder", () => link],
])("skill scripts run through %s", (_label, dir) => {
  it.each(SCRIPTS)("%s --help prints usage and exits 0", (script) => {
    const result = run(dir(), script, ["--help"]);
    expect(result.status, result.stderr).toBe(0);
    const name = script.split("/").pop()!;
    expect(result.stdout).toMatch(new RegExp(`^Usage: node ${name}`));
  });

  it.each(SCRIPTS)(
    "misuse: %s with an unknown flag fails, naming the flag, instead of silently passing",
    (script) => {
      const result = run(dir(), script, ["--not-a-real-flag"]);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.status).not.toBeNull();
      expect(result.stderr).toContain("--not-a-real-flag");
    },
  );
});
