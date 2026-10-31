import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_IMPORT,
  CLAUDE_MD,
  OPT_IN_SKILLS,
  PROJECT_SKILLS,
  SKILLS_CLI,
  SKILLS_QUESTION,
  SKILLS_REPO,
  SKILLS_SOURCE_ENV,
  agentFilesReportLines,
  agentsMd,
  agentsSection,
  answeredNo,
  createPrompter,
  installSkills,
  mergeAgentsMd,
  mergeClaudeMd,
  npxInvocation,
  skillsAddArgs,
  skillsCommand,
  skillsLaterLines,
  skillsRef,
  skillsReportLines,
  writeAgentFiles,
} from "./agent-setup.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../..");

describe("the two copies", () => {
  it("pkg/src/lib/agent-setup.ts is identical to this one, so bascik init and npm create bascik set projects up the same way", () => {
    expect(readFileSync(join(REPO, "pkg/src/lib/agent-setup.ts"), "utf8")).toBe(
      readFileSync(join(HERE, "agent-setup.ts"), "utf8"),
    );
  });
});

describe("the project skill list", () => {
  it("is every folder in the repository's skills/ minus the opt-in ones, because the skills CLI ignores an unknown name", () => {
    const folders = readdirSync(join(REPO, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of OPT_IN_SKILLS) expect(folders).toContain(name);
    expect([...PROJECT_SKILLS].sort()).toEqual(
      folders.filter(
        (name) => !(OPT_IN_SKILLS as readonly string[]).includes(name),
      ),
    );
  });

  it("names a folder with a SKILL.md for every project skill", () => {
    for (const name of PROJECT_SKILLS) {
      expect(
        readFileSync(join(REPO, "skills", name, "SKILL.md"), "utf8"),
      ).toMatch(new RegExp(`^---[\\s\\S]*?name: ${name}\\b`));
    }
  });

  it("leaves bascik-refactor out", () => {
    expect(PROJECT_SKILLS).not.toContain("bascik-refactor");
    expect(skillsCommand()).not.toContain("bascik-refactor");
  });
});

describe("the skills CLI command", () => {
  it("pins the release tag for a release version", () => {
    expect(skillsRef("1.0.0-rc.10")).toBe("v1.0.0-rc.10");
    expect(skillsRef("1.2.3")).toBe("v1.2.3");
  });

  it("misuse: an unknown or garbled version gets no tag, so the default branch is used", () => {
    expect(skillsRef(undefined)).toBeUndefined();
    expect(skillsRef("unknown")).toBeUndefined();
    expect(skillsRef("^1.0.0")).toBeUndefined();
    expect(skillsRef("1.0.0; rm -rf /")).toBeUndefined();
  });

  it("installs into .agents/skills and .claude/skills as copies, without prompts, naming each skill", () => {
    expect(skillsAddArgs("bascikdev/bascik#v1.0.0")).toEqual([
      "add",
      "bascikdev/bascik#v1.0.0",
      "-a",
      "universal",
      "-a",
      "claude-code",
      "--copy",
      "-y",
      "--skill",
      ...PROJECT_SKILLS,
    ]);
  });

  it("prints the command to run later, with or without a tag", () => {
    expect(skillsCommand()).toBe(
      `npx skills add bascikdev/bascik -a universal -a claude-code --copy -y --skill ${PROJECT_SKILLS.join(" ")}`,
    );
    expect(skillsCommand("v2.0.0")).toContain(
      "npx skills add bascikdev/bascik#v2.0.0 -a",
    );
  });

  it("goes through cmd.exe on Windows, where npx is a .cmd file", () => {
    expect(npxInvocation(["-y", "skills"], "linux", {})).toEqual({
      command: "npx",
      args: ["-y", "skills"],
    });
    expect(npxInvocation(["-y", "skills"], "win32", {})).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx", "-y", "skills"],
    });
    expect(
      npxInvocation([], "win32", { ComSpec: "C:\\Windows\\cmd.exe" }).command,
    ).toBe("C:\\Windows\\cmd.exe");
  });
});

describe("installSkills", () => {
  const ok = {
    status: 0,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
  };
  const fail = (stderr: string) => ({ ...ok, status: 1, stderr });

  it("runs the pinned skills CLI at the release tag in the project folder", () => {
    const spawn = vi.fn((_command: string, _args: string[]) => ok);
    const result = installSkills("/work/app", {
      version: "1.0.0-rc.10",
      platform: "linux",
      env: { PATH: "/bin" },
      spawn,
    });
    expect(result).toEqual({
      status: "pinned",
      ref: "v1.0.0-rc.10",
      command: skillsCommand("v1.0.0-rc.10"),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "npx",
      [
        "--prefer-offline",
        "-y",
        SKILLS_CLI,
        ...skillsAddArgs(`${SKILLS_REPO}#v1.0.0-rc.10`),
      ],
      expect.objectContaining({
        cwd: "/work/app",
        env: expect.objectContaining({ PATH: "/bin" }),
      }),
    );
  });

  it("tells npm not to retry or wait long, so an offline first run fails in seconds, not minutes", () => {
    const spawn = vi.fn(
      (_command: string, _args: string[], _options: { env?: object }) => ok,
    );
    installSkills("/work/app", { platform: "linux", env: {}, spawn });
    const options = spawn.mock.calls[0][2] as {
      env: NodeJS.ProcessEnv;
      timeout: number;
    };
    expect(options.env.npm_config_fetch_retries).toBe("0");
    expect(Number(options.env.npm_config_fetch_timeout)).toBeLessThanOrEqual(
      30_000,
    );
    expect(options.timeout).toBeLessThanOrEqual(90_000);
  });

  it("keeps the user's own npm fetch settings", () => {
    const spawn = vi.fn(
      (_command: string, _args: string[], _options: { env?: object }) => ok,
    );
    installSkills("/work/app", {
      platform: "linux",
      env: { npm_config_fetch_retries: "3" },
      spawn,
    });
    const options = spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.npm_config_fetch_retries).toBe("3");
  });

  it.each([
    "npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\n",
    "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/skills failed\n",
    "npm error code EAI_AGAIN\n",
    "npm ERR! code ETIMEDOUT\n",
  ])(
    "misuse: offline before the skills CLI even starts (%#), it tries once instead of again from the default branch",
    (stderr) => {
      const spawn = vi.fn(() => fail(stderr));
      const result = installSkills("/work/app", {
        version: "1.0.0",
        platform: "linux",
        env: {},
        spawn,
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/E[A-Z_]+/);
    },
  );

  it("misuse: a run that times out is not tried again", () => {
    const spawn = vi.fn(() => ({
      ...ok,
      status: null,
      signal: "SIGTERM" as const,
      error: Object.assign(new Error("spawnSync npx ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    }));
    const result = installSkills("/work/app", {
      version: "1.0.0",
      platform: "linux",
      env: {},
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
  });

  it("falls back to the default branch when the tag install fails, such as before the tag is pushed", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce(fail("Remote branch v9.9.9 not found"))
      .mockReturnValueOnce(ok);
    const result = installSkills("/work/app", {
      version: "9.9.9",
      platform: "linux",
      env: {},
      spawn,
    });
    expect(result.status).toBe("latest");
    expect(spawn.mock.calls.map((call) => call[1][4])).toEqual([
      "bascikdev/bascik#v9.9.9",
      "bascikdev/bascik",
    ]);
    expect(skillsReportLines(result)[0]).toMatch(
      /from the default branch, because the v9\.9\.9 skills could not be installed/,
    );
  });

  it("misuse: offline, both attempts fail and the result names the reason and the command to run later", () => {
    const spawn = vi.fn(() =>
      fail("\u001b[31m■  Failed to connect to github.com\u001b[0m\n"),
    );
    const result = installSkills("/work/app", {
      version: "1.0.0",
      platform: "linux",
      env: {},
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "failed",
      error: "Failed to connect to github.com",
    });
    const lines = skillsReportLines(result);
    expect(lines[0]).toBe(
      "Could not install the Bascik agent skills (Failed to connect to github.com).",
    );
    expect(lines).toContain(`  ${skillsCommand("v1.0.0")}`);
  });

  it("misuse: the command to run later keeps the release tag, so a later install matches the scaffolded version", () => {
    const result = installSkills("/work/app", {
      version: "1.0.0-rc.10",
      platform: "linux",
      env: {},
      spawn: vi.fn(() => fail("npm error code ECONNREFUSED")),
    });
    expect(result.command).toBe(skillsCommand("v1.0.0-rc.10"));
    expect(skillsReportLines(result)).toEqual([
      "Could not install the Bascik agent skills (npm error code ECONNREFUSED).",
      "Run this in the project folder when you are online:",
      ...skillsLaterLines("v1.0.0-rc.10"),
    ]);
  });

  it("names the tagged command first, and how to drop the tag if it does not exist", () => {
    expect(skillsLaterLines("v1.0.0")).toEqual([
      `  ${skillsCommand("v1.0.0")}`,
      "(If the v1.0.0 tag is not found, run it without #v1.0.0.)",
    ]);
    expect(skillsLaterLines(undefined)).toEqual([`  ${skillsCommand()}`]);
  });

  it("misuse: npx missing from PATH is reported, not thrown", () => {
    const spawn = vi.fn(() => ({
      ...ok,
      status: null,
      error: new Error("spawn npx ENOENT"),
    }));
    const result = installSkills("/work/app", {
      platform: "linux",
      env: {},
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      error: "spawn npx ENOENT",
    });
  });

  it("misuse: a run that prints nothing reports its exit code", () => {
    const result = installSkills("/work/app", {
      platform: "linux",
      env: {},
      spawn: vi.fn(() => ({ ...ok, status: 2 })),
    });
    expect(result.error).toBe("skills CLI exited with 2");
  });

  it(`installs from ${SKILLS_SOURCE_ENV} as given, once, with no tag`, () => {
    const spawn = vi.fn((_command: string, _args: string[]) => ok);
    const result = installSkills("/work/app", {
      version: "1.0.0",
      platform: "linux",
      env: { [SKILLS_SOURCE_ENV]: "/repo" },
      spawn,
    });
    expect(result.status).toBe("custom");
    expect(spawn.mock.calls[0][1]).toContain("/repo");
    expect(skillsReportLines(result)).toEqual([
      "✓ Installed the Bascik agent skills in .agents/skills/ and .claude/skills/",
    ]);
  });

  it("reports a pinned install with its tag", () => {
    expect(
      skillsReportLines({ status: "pinned", ref: "v1.0.0", command: "" }),
    ).toEqual([
      "✓ Installed the Bascik agent skills (v1.0.0) in .agents/skills/ and .claude/skills/",
    ]);
  });
});

describe("AGENTS.md", () => {
  const brief = agentsMd();

  it("stays short, under about 60 lines", () => {
    expect(brief.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("names the commands: dev, build, check and preview", () => {
    expect(brief).toContain("`npm run dev`");
    expect(brief).toContain("`npm run build`");
    expect(brief).toContain("`npx bascik --check`");
    expect(brief).toContain("`npx bascik --server`");
    const cloudflare = agentsMd({ template: "cloudflare" });
    expect(cloudflare).toContain("`npm run preview`");
    expect(cloudflare).not.toContain("--server");
  });

  it("misuse: says the build needs the site URL, so an agent building a fresh project knows the fix", () => {
    const line = brief
      .split("\n")
      .find((l) => l.startsWith("- `npm run build`"));
    expect(line).toContain("`BASCIK_SITE_URL`");
    expect(line).toContain("`.env`");
    expect(line).toContain(
      "https://bascik.dev/cli#environment-files-and-the-site-url",
    );
  });

  it("misuse: names npx bascik when the project's npm scripts run something else, so an agent never mistakes them for Bascik", () => {
    const section = agentsSection({
      commands: { dev: "npx bascik", build: "npx bascik --build" },
    });
    expect(section).toContain(
      "- `npx bascik`: dev server with live reload at http://localhost:8080",
    );
    expect(section).toContain(
      "- `npx bascik --build`: production build into `dist/`",
    );
    expect(section).not.toContain("npm run dev");
    expect(section).not.toContain("npm run build");
  });

  it("states each house rule", () => {
    expect(brief).toMatch(/list of tag names/);
    expect(brief).toMatch(/do not split further/);
    expect(brief).toMatch(/instead of handing props down/);
    expect(brief).toMatch(/TypeScript, browser scripts included/);
    expect(brief).toContain('<script type="text/typescript">');
    expect(brief).toContain("`.ts` companion file");
    expect(brief).toMatch(/esbuild through \[`scripts\.typescript`\]/);
    expect(brief).toContain("`html` from `@bascik/bascik/html`");
    expect(brief).toContain("`data-testid`");
    expect(brief).toMatch(/Run `npx bascik --check`.*before calling work done/);
  });

  it("says where the skills live and how to move them to a new release, since skills update keeps the pinned tag", () => {
    expect(brief).toContain("`.agents/skills/`");
    expect(brief).toContain("`.claude/skills/`");
    expect(brief).toContain("`npx skills update` keeps that version");
    expect(brief).toContain(skillsCommand("v<version>"));
  });

  it("links docs pages that exist instead of restating them", () => {
    const links = [
      ...brief.matchAll(/\]\(https:\/\/bascik\.dev(\/[^)#]*)?(#[^)]*)?\)/g),
    ];
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const [, page, hash] of links) {
      if (!page) continue;
      const file = join(REPO, "docs/content", `${page}.md`);
      const text = readFileSync(file, "utf8");
      if (hash) {
        const slugs = [...text.matchAll(/^#+\s+(.+)$/gm)].map((m) =>
          m[1]
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, "")
            .trim()
            .replace(/\s+/g, "-"),
        );
        expect(slugs, `${page}${hash}`).toContain(hash.slice(1));
      }
    }
  });

  it("has no @ text Claude Code would take for an import outside code", () => {
    const outsideCode = brief
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "");
    expect(outsideCode).not.toMatch(/(^|\s)@[\w./-]/);
  });

  it("creates the file when there is none, or it is empty", () => {
    expect(mergeAgentsMd(undefined)).toEqual({
      status: "created",
      text: brief,
    });
    expect(mergeAgentsMd("  \n").status).toBe("created");
  });

  it("appends the Bascik section to an existing file, keeping its content and line endings", () => {
    const existing = "# My rules\r\n\r\nUse tabs.\r\n";
    const { status, text } = mergeAgentsMd(existing);
    expect(status).toBe("updated");
    expect(
      text.startsWith("# My rules\r\n\r\nUse tabs.\r\n\r\n## Bascik\r\n"),
    ).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text.endsWith(agentsSection().replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("leaves a file that already has a Bascik section alone, so a second run changes nothing", () => {
    const once = mergeAgentsMd("# Rules\n").text;
    expect(mergeAgentsMd(once)).toEqual({ status: "unchanged", text: once });
  });

  it("misuse: a ## Bascik heading inside a code fence does not count", () => {
    const existing = "# Rules\n\n```md\n## Bascik\n```\n";
    expect(mergeAgentsMd(existing).status).toBe("updated");
  });
});

describe("CLAUDE.md", () => {
  it("imports AGENTS.md on a line of its own, outside code, first", () => {
    expect(CLAUDE_MD.split("\n")[0]).toBe("@AGENTS.md");
    expect(CLAUDE_MD).not.toContain("`@AGENTS.md`");
  });

  it("adds the import to an existing CLAUDE.md, keeping its content", () => {
    expect(mergeClaudeMd("# Notes\n\nBe terse.")).toEqual({
      status: "updated",
      text: "# Notes\n\nBe terse.\n\n@AGENTS.md\n",
    });
  });

  it("leaves a CLAUDE.md that already imports AGENTS.md alone", () => {
    for (const existing of ["@AGENTS.md\n", "# x\n\n@./AGENTS.md\n"]) {
      expect(mergeClaudeMd(existing).status).toBe("unchanged");
    }
  });

  it("misuse: an @AGENTS.md shown in code or mid-sentence is not an import, so the line is still added", () => {
    for (const existing of [
      "```\n@AGENTS.md\n```\n",
      "Mention @AGENTS.md here.\n",
    ]) {
      expect(mergeClaudeMd(existing).status).toBe("updated");
    }
  });
});

describe("writeAgentFiles", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes both files into an empty folder and reports nothing to fix", async () => {
    dir = await mkdtemp(join(tmpdir(), "bascik-agent-files-"));
    const report = await writeAgentFiles(dir, { template: "cloudflare" });
    expect(report).toEqual({ agents: "created", claude: "created" });
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(
      agentsMd({ template: "cloudflare" }),
    );
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
    expect(agentFilesReportLines(report)).toEqual([]);
  });

  it("merges into files a folder already has and says what it added; a second run changes nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "bascik-agent-files-"));
    await writeFile(join(dir, "AGENTS.md"), "# Team rules\n");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude notes\n");
    const report = await writeAgentFiles(dir);
    expect(report).toEqual({ agents: "updated", claude: "updated" });
    expect(agentFilesReportLines(report)).toEqual([
      'AGENTS.md: added a "## Bascik" section',
      `CLAUDE.md: added ${CLAUDE_IMPORT}`,
    ]);
    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Team rules\n\n## Bascik\n")).toBe(true);
    expect(await writeAgentFiles(dir)).toEqual({
      agents: "unchanged",
      claude: "unchanged",
    });
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("misuse: a folder named AGENTS.md is reported with what to add, not thrown", async () => {
    dir = await mkdtemp(join(tmpdir(), "bascik-agent-files-"));
    await mkdir(join(dir, "AGENTS.md"));
    await mkdir(join(dir, "CLAUDE.md"));
    const report = await writeAgentFiles(dir);
    expect(report).toEqual({ agents: "failed", claude: "failed" });
    const lines = agentFilesReportLines(report);
    expect(lines[0]).toMatch(
      /^AGENTS\.md: could not be written\. Add a "## Bascik" section/,
    );
    expect(lines[1]).toMatch(
      /^CLAUDE\.md: could not be written\. Add a line with @AGENTS\.md/,
    );
  });

  it("misuse: a missing project folder is reported, not thrown", async () => {
    const report = await writeAgentFiles(
      join(tmpdir(), "bascik-no-such-dir-x9"),
    );
    expect(report).toEqual({ agents: "failed", claude: "failed" });
  });
});

describe("prompts", () => {
  it("treats Enter and anything but n or no as yes", () => {
    for (const answer of ["", "y", "Y", "yes", " ", "sure"]) {
      expect(answeredNo(answer), answer).toBe(false);
    }
    for (const answer of ["n", "N", "no", " No "]) {
      expect(answeredNo(answer), answer).toBe(true);
    }
  });

  it("asks the skills question with Y as the default", () => {
    expect(SKILLS_QUESTION).toBe(
      "Install the Bascik agent skills for coding assistants (Claude Code, Copilot, Cursor, Codex...)? (Y/n) ",
    );
  });

  const streams = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => (printed += String(chunk)));
    return { input, output, printed: () => printed };
  };

  it("answers questions from piped lines, even ones that arrive before their question", async () => {
    const { input, output, printed } = streams();
    const prompter = createPrompter(input, output);
    input.write("my-site\nn\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(await prompter.ask("Name? ")).toBe("my-site");
    expect(await prompter.ask("Skills? ")).toBe("n");
    const third = prompter.ask("Install? ");
    input.write("y\n");
    expect(await third).toBe("y");
    prompter.close();
    expect(printed()).toBe("Name? my-site\nSkills? n\nInstall? y\n");
  });

  it("misuse: once input ends every question gets its default instead of hanging or exiting 13", async () => {
    const { input, output, printed } = streams();
    const prompter = createPrompter(input, output);
    const first = prompter.ask("Name? ");
    input.end();
    expect(await first).toBe("");
    expect(await prompter.ask(SKILLS_QUESTION)).toBe("");
    expect(await prompter.ask("Install? ")).toBe("");
    prompter.close();
    expect(printed()).toBe(`Name? \n${SKILLS_QUESTION}\nInstall? \n`);
  });

  it("keeps a last line that has no newline before input ends", async () => {
    const { input, output } = streams();
    const prompter = createPrompter(input, output);
    input.end("n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(await prompter.ask("Skills? ")).toBe("n");
    expect(await prompter.ask("Install? ")).toBe("");
    prompter.close();
  });
});

describe("the setup docs", () => {
  const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

  it("agent-skills.md shows the question, the command to run later, and the pinned update command as the code has them", () => {
    const text = read("docs/content/agent-skills.md");
    expect(text).toContain(SKILLS_QUESTION.trim());
    // The command to run later is pinned to a release, as the code prints it.
    const [before, after] = skillsCommand("v0.0.0").split("v0.0.0");
    const escape = (part: string) =>
      part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(text).toMatch(
      new RegExp(
        `${escape(before)}v\\d+\\.\\d+\\.\\d+[-.\\w]*${escape(after)}`,
      ),
    );
    expect(text).toContain(skillsCommand("v<version>"));
    expect(text).toContain("## Project Brief");
    expect(text).toContain(`\`\`\`md\n${CLAUDE_IMPORT}\n\`\`\``);
  });

  it.each([
    "docs/content/cli.md",
    "docs/content/getting-started.md",
    "docs/content/internals/create-app.md",
    "create/README.md",
  ])(
    "%s documents --no-skills and no longer says the skills are bundled",
    (rel) => {
      const text = read(rel);
      expect(text).toContain("--no-skills");
      expect(text).not.toMatch(
        /assets\/skills|prepack|copying the latest agent skills/,
      );
    },
  );
});
