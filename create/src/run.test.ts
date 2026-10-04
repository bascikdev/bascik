/**
 * run.test.ts
 *
 * Boundary: the CLI flow (`run`) -> real download from a local server -> real file system in a temp
 * directory. The terminal and child processes are fakes so prompts and consent can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FixtureServer, githubArchive, startFixtureServer, tarGz } from "./archive-fixtures.js";
import { type Io, run } from "./run.js";

let server: FixtureServer;
let work: string;

beforeEach(async () => {
  server = await startFixtureServer();
  work = await mkdtemp(join(tmpdir(), "create-bascik-run-test-"));
});

afterEach(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

interface Session {
  io: Io;
  stdout: string[];
  stderr: string[];
  questions: string[];
  commands: Array<{ command: string; args: string[]; cwd: string }>;
}

function session(answers: string[] = [], overrides: Partial<Io> & { status?: number | null } = {}): Session {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const commands: Session["commands"] = [];
  const queue = [...answers];
  const io: Io = {
    ask: async (question) => {
      questions.push(question);
      if (queue.length === 0) throw new Error(`Unexpected prompt: ${question}`);
      return queue.shift() as string;
    },
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    run: (command, args, cwd) => {
      commands.push({ command, args, cwd });
      return overrides.status === undefined ? 0 : overrides.status;
    },
    cwd: () => work,
    platform: "linux",
    interactive: true,
    ...overrides,
  };
  return { io, stdout, stderr, questions, commands };
}

const text = (lines: string[]) => lines.join("");
const GITHUB = "https://github.com/acme/starter/tree/main/app";
const project = (extra: Record<string, string> = {}) =>
  githubArchive({ "app/package.json": JSON.stringify({ name: "starter", scripts: { dev: "echo dev" } }), "app/src/pages/index.html": "<h1>hi</h1>", ...extra }, "starter-main");

const withBase = { get archiveBase() { return server.base; } };

describe("help and usage errors", () => {
  it("prints usage for --help and exits 0 without prompting", async () => {
    const s = session();
    expect(await run(["--help"], s.io)).toBe(0);
    expect(text(s.stdout)).toContain("--example <name|url>");
    expect(s.questions).toEqual([]);
  });

  it("rejects an unknown option before prompting or touching the disk", async () => {
    const s = session();
    expect(await run(["--exmaple", "blog"], s.io)).toBe(1);
    expect(text(s.stderr)).toContain('Unknown option "--exmaple"');
    expect(s.questions).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });
});

describe("--example resolution", () => {
  it("rejects an unknown official id without any prompt or network request", async () => {
    const s = session();
    expect(await run(["site", "--example", "nope"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toMatch(/not an official example. Available: blog/);
    expect(server.requests).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a non-GitHub link without a network request", async () => {
    const s = session();
    expect(await run(["site", "-e", "https://example.com/x/y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("Only github.com links");
    expect(server.requests).toEqual([]);
  });

  it("validates the project name too", async () => {
    const s = session();
    expect(await run(["bad*name", "-e", "blog"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("not a valid directory name");
    expect(server.requests).toEqual([]);
  });
});

describe("a third-party GitHub example", () => {
  it("copies the folder, names the project, and warns that it is third-party", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: project() });
    const s = session(["n"]);
    expect(await run(["site", "--example", GITHUB], s.io, withBase)).toBe(0);
    expect(JSON.parse(await readFile(join(work, "site/package.json"), "utf8")).name).toBe("site");
    expect(await readFile(join(work, "site/src/pages/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(text(s.stdout)).toContain("third-party repository");
    expect(text(s.stdout)).toContain("github.com/acme/starter/tree/main/app");
  });

  it("does not install after --yes: running someone else's scripts is a separate consent", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: project() });
    const s = session();
    expect(await run(["site", "--example", GITHUB, "--yes"], s.io, withBase)).toBe(0);
    expect(s.commands).toEqual([]);
    expect(text(s.stdout)).toContain("npm install");
    expect(s.questions).toEqual([]);
  });

  it("asks before installing and defaults to no", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: project() });
    const s = session(["", ""]);
    await run(["site", "-e", GITHUB], s.io, withBase);
    expect(s.questions[0]).toContain("runs scripts from the third-party example. (y/N)");
    expect(s.commands).toEqual([]);
  });

  it("installs and starts only on explicit yes", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: project() });
    const s = session(["y", "n"]);
    expect(await run(["site", "-e", GITHUB], s.io, withBase)).toBe(0);
    expect(s.commands).toEqual([{ command: "npm", args: ["install"], cwd: join(work, "site") }]);
  });

  it("reports a failed download, creates nothing, and runs nothing", async () => {
    const s = session();
    expect(await run(["site", "-e", GITHUB, "-y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toMatch(/no archive for acme\/starter/);
    expect(text(s.stderr)).toContain("Nothing was created.");
    expect(await readdir(work)).toEqual([]);
    expect(s.commands).toEqual([]);
    expect(text(s.stdout)).not.toContain("Next steps");
  });

  it("refuses a malicious archive without leaving files", async () => {
    server.routes.set("/acme/starter/tar.gz/main", {
      body: tarGz([{ path: "starter-main", type: "dir" }, { path: "starter-main/app/package.json", type: "file", content: "{}" }, { path: "starter-main/app/x", type: "symlink", target: "/etc" }]),
    });
    const s = session();
    expect(await run(["site", "-e", GITHUB, "-y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("symbolic link");
    expect(await readdir(work)).toEqual([]);
  });

  it("will not use a folder that already has files", async () => {
    await mkdir(join(work, "site"));
    await writeFile(join(work, "site", "mine.txt"), "keep");
    const s = session();
    expect(await run(["site", "-e", GITHUB, "-y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("not empty");
    expect(await readFile(join(work, "site/mine.txt"), "utf8")).toBe("keep");
    expect(server.requests).toEqual([]);
  });

  it("uses --example-path with a bare repository link", async () => {
    server.routes.set("/acme/starter/tar.gz/HEAD", { body: project() });
    const s = session();
    expect(await run(["site", "-e", "https://github.com/acme/starter", "--example-path", "app", "-y"], s.io, withBase)).toBe(0);
    expect(server.requests).toEqual(["/acme/starter/tar.gz/HEAD"]);
    expect(await lstat(join(work, "site/package.json"))).toBeTruthy();
  });

  it("says where to look when the chosen folder is not a project", async () => {
    server.routes.set("/acme/starter/tar.gz/HEAD", { body: githubArchive({ "README.md": "x", "app/package.json": "{}" }, "starter-main") });
    const s = session();
    expect(await run(["site", "-e", "https://github.com/acme/starter", "-y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("--example-path");
    expect(await readdir(work)).toEqual([]);
  });
});

describe("an official example", () => {
  const blog = githubArchive(
    {
      "package.json": JSON.stringify({ name: "bascik-blog-template" }),
      "template.json": JSON.stringify({ license: "MIT", requirements: ["Set BASCIK_SITE_URL for production builds."], requires: { bascik: "^1.0.0-rc.3", node: ">=20.0.0" } }),
      "content/about.md": "# About",
    },
    "bascik-examples-blog",
  );

  it("downloads only the examples/<id> branch, never main, and shows its license and notes", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session(["n"]);
    expect(await run(["my-blog", "--example", "blog"], s.io, withBase)).toBe(0);
    expect(server.requests).toEqual(["/bascikdev/bascik/tar.gz/examples%2Fblog"]);
    expect(await readdir(join(work, "my-blog"))).toEqual(["content", "package.json", "template.json"]);
    const out = text(s.stdout);
    expect(out).toContain("License: MIT");
    expect(out).toContain("Works with Bascik ^1.0.0-rc.3");
    expect(out).toContain("Note: Set BASCIK_SITE_URL");
    expect(out).not.toContain("third-party");
  });

  it("installs and starts after --yes, as the default starter does", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session();
    expect(await run(["my-blog", "-e", "blog", "-y"], s.io, withBase)).toBe(0);
    expect(s.commands.map((c) => c.args)).toEqual([["install"], ["run", "dev"]]);
  });

  it("stops after install with --no-dev", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session();
    await run(["my-blog", "-e", "blog", "-y", "--no-dev"], s.io, withBase);
    expect(s.commands.map((c) => c.args)).toEqual([["install"]]);
  });

  it("does not claim success when npm install fails", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session([], { status: 7 });
    expect(await run(["my-blog", "-e", "blog", "-y"], s.io, withBase)).toBe(7);
    expect(text(s.stderr)).toContain("npm install failed with exit code 7");
    expect(s.commands).toHaveLength(1);
    expect(text(s.stdout)).not.toContain("Next steps");
  });

  it("reports an install command that cannot start", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session([], { status: null });
    expect(await run(["my-blog", "-e", "blog", "-y"], s.io, withBase)).toBe(1);
    expect(text(s.stderr)).toContain("could not be started");
  });

  it("uses npm.cmd on Windows", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: blog });
    const s = session([], { platform: "win32" });
    await run(["my-blog", "-e", "blog", "-y", "--no-dev"], s.io, withBase);
    expect(s.commands[0]?.command).toBe("npm.cmd");
  });

  it("says the example may not be published yet when its branch does not exist, and creates nothing", async () => {
    const s = session();
    expect(await run(["my-blog", "-e", "blog", "-y"], s.io, withBase)).toBe(1);
    expect(server.requests).toEqual(["/bascikdev/bascik/tar.gz/examples%2Fblog"]);
    expect(text(s.stderr)).toContain('no archive for bascikdev/bascik at "examples/blog"');
    expect(text(s.stderr)).toContain("may not be published yet");
    expect(await readdir(work)).toEqual([]);
  });

  it("never requests main, whatever else is on the server", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/main", { body: githubArchive({ "package.json": "{}" }, "bascik-main") });
    const s = session();
    expect(await run(["my-blog", "-e", "blog", "-y"], s.io, withBase)).toBe(1);
    expect(server.requests).not.toContain("/bascikdev/bascik/tar.gz/main");
  });
});

describe("the default starter", () => {
  it("is still what you get without --example, and --yes still installs", async () => {
    const s = session();
    expect(await run(["plain", "-y", "--no-dev"], s.io)).toBe(0);
    expect(await lstat(join(work, "plain/src/pages/index.html"))).toBeTruthy();
    expect(s.commands.map((c) => c.args)).toEqual([["install"]]);
    expect(server.requests).toEqual([]);
    expect(s.questions).toEqual([]);
  });

  it("asks for the name, then offers the picker, then whether to install", async () => {
    const s = session(["asked", "1", "n"]);
    expect(await run([], s.io)).toBe(0);
    // Declining the install skips "start the dev server?": it cannot start without dependencies.
    expect(s.questions).toHaveLength(3);
    expect(s.questions[0]).toContain("Project name");
    expect(s.questions[1]).toContain("Choose 1-2");
    expect(s.questions[2]).toContain("Install dependencies now? (Y/n)");
    expect(await lstat(join(work, "asked/src/pages/index.html"))).toBeTruthy();
    expect(s.commands).toEqual([]);
  });

  it("repeats the picker on an invalid answer", async () => {
    server.routes.set("/bascikdev/bascik/tar.gz/examples%2Fblog", { body: githubArchive({ "package.json": "{}" }, "bascik-examples-blog") });
    const s = session(["site", "9", "x", "2", "n"]);
    expect(await run([], s.io, withBase)).toBe(0);
    expect(text(s.stdout).match(/Please enter one of the numbers above/g)).toHaveLength(2);
    expect(await lstat(join(work, "site/package.json"))).toBeTruthy();
  });

  it("skips the picker when the name came with --yes or an example was given", async () => {
    const s = session();
    await run(["a", "-y", "--no-dev"], s.io);
    expect(s.questions).toEqual([]);
  });

  it("does not prompt without a terminal, and installs nothing", async () => {
    const s = session([], { interactive: false });
    expect(await run([], s.io)).toBe(0);
    expect(s.questions).toEqual([]);
    expect(s.commands).toEqual([]);
    expect(await lstat(join(work, "bascik-app/package.json"))).toBeTruthy();
  });
});
