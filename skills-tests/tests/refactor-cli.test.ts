// The bascik-refactor scripts as commands: each one runs its CLI only when it is the script Node was asked to run.
// That check must hold however the path is spelled. Node resolves symlinks in the main module's path before it sets
// import.meta.url, so comparing it with process.argv[1] as typed made every script a silent no-op (exit 0, no output)
// when any folder on the path was a symlink: a skills folder linked into .claude/skills, the skills CLI's symlink
// install, a Windows junction, or macOS's /tmp and $TMPDIR. A gate such as lighthouse-gate then passed without
// checking anything. These tests spawn each script through a link to the scripts folder and through its real path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(
  new URL("../../skills/bascik-refactor/scripts", import.meta.url),
);

/** Each script with no arguments must fail loudly, naming what is missing. */
const NO_ARGS: Record<string, RegExp> = {
  "breakpoint-matrix": /--css/,
  "geometry-diff": /--prod <url> is required/,
  "compare-route": /--prod <url> is required/,
  "lighthouse-gate": /--dir <folder>/,
  "llms-txt": /BASCIK_OUT_DIR is not set/,
  "responsive-webp": /--src <image> is required/,
  "worker-response-policy": /--html <built page> is required/,
};

let tmp: string;
let link: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bascik-refactor-cli-"));
  link = join(tmp, "link");
  // A junction needs no admin rights on Windows; elsewhere the type is ignored and a plain symlink is made.
  symlinkSync(SCRIPTS, link, "junction");
  writeFileSync(join(tmp, "bad.json"), "{}");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const run = (dir: string, script: string, args: string[] = []) => {
  const env = { ...process.env };
  delete env.BASCIK_OUT_DIR;
  return spawnSync(process.execPath, [join(dir, `${script}.mjs`), ...args], {
    cwd: tmp,
    env,
    encoding: "utf8",
  });
};

describe.each([
  ["the real path", () => SCRIPTS],
  ["a symlinked folder", () => link],
])("bascik-refactor scripts run through %s", (_label, dir) => {
  it.each(Object.entries(NO_ARGS))(
    "misuse: %s with no arguments exits 1 and says what is missing",
    (script, message) => {
      const result = run(dir(), script);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(message);
    },
  );

  it("misuse: lighthouse-gate fails a file that is not a Lighthouse result instead of passing it", () => {
    const result = run(dir(), "lighthouse-gate", [join(tmp, "bad.json")]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/not a Lighthouse result/);
  });

  it("--help prints usage and exits 0", () => {
    const result = run(dir(), "worker-response-policy", ["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Usage: node worker-response-policy\.mjs/);
  });
});
