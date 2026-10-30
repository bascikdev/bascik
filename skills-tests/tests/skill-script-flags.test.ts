// Misuse: every public skill script answers a mistyped or incomplete flag with a
// short message naming the flag and the valid ones, and exit code 2, never a
// Node stack trace. audit-components.mjs set the pattern; these follow it.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skills = fileURLToPath(new URL("../../skills/", import.meta.url));

/** Script, its name in messages, a flag it reads, and a string flag it takes a value for. */
const SCRIPTS: Array<[string, string, string, string | undefined]> = [
  ["bascik/scripts/preview.mjs", "preview", "--body", "--file"],
  ["bascik/scripts/verify.mjs", "verify", "--strict", undefined],
  ["bascik/scripts/add-example.mjs", "add-example", "--list", undefined],
  ["bascik/scripts/check-links.mjs", "check-links", "--dist", "--dist"],
  [
    "bascik/scripts/new-component.mjs",
    "new-component",
    "--description",
    "--description",
  ],
  ["bascik/scripts/read-doc.mjs", "read-doc", "--list", undefined],
  ["bascik/scripts/search-docs.mjs", "search-docs", "--limit", "--limit"],
  [
    "bascik-components/scripts/check-tokens.mjs",
    "check-tokens",
    "--json",
    undefined,
  ],
  ["bascik-seo/scripts/audit-seo.mjs", "audit-seo", "--site-url", "--dist"],
  [
    "bascik-config/scripts/audit-config.mjs",
    "audit-config",
    "--strict",
    undefined,
  ],
  [
    "bascik-config/scripts/check-workspace.mjs",
    "check-workspace",
    "--json",
    undefined,
  ],
  [
    "bascik-scripts/scripts/new-post.mjs",
    "new-post",
    "--description",
    "--description",
  ],
  [
    "bascik-compatibility/scripts/lookup.mjs",
    "lookup",
    "--section",
    "--section",
  ],
  [
    "bascik-compatibility/scripts/baseline.mjs",
    "baseline",
    "--limit",
    "--limit",
  ],
];

const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [`${skills}${script}`, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    // Never let a script reach the network or a project here.
    cwd: skills,
    env: { ...process.env, NO_COLOR: "1" },
  });

/** A Node stack frame or a thrown TypeError's own output. */
const STACK = /\n\s+at |ERR_PARSE_ARGS|node:internal|TypeError \[/;

describe.each(SCRIPTS)("%s", (script, name, known, takesValue) => {
  it("misuse: an unknown flag exits 2, naming the flag and the valid ones, with no stack trace", () => {
    const result = run(script, ["--not-a-real-flag"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `${name}: unknown option "--not-a-real-flag".`,
    );
    expect(result.stderr).toContain("Valid options: ");
    expect(result.stderr).toContain(known);
    expect(result.stderr).toContain("--help");
    expect(result.stderr).not.toMatch(STACK);
  });

  it("misuse: a typo'd short flag exits 2 the same way", () => {
    const result = run(script, ["-Q"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${name}: unknown option "-Q".`);
    expect(result.stderr).not.toMatch(STACK);
  });

  it.runIf(takesValue !== undefined)(
    "misuse: a flag missing its value exits 2, naming the flag",
    () => {
      const result = run(script, [takesValue!]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${name}: `);
      expect(result.stderr).toContain(takesValue!);
      expect(result.stderr).not.toMatch(STACK);
    },
  );

  it("--help still prints the usage and exits 0", () => {
    const result = run(script, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
