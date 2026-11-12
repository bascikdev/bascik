import { beforeEach, describe, expect, it, vi } from "vitest";
import { initProject, type InitOptions } from "./init.ts";
import {
  CLAUDE_MD,
  SKILLS_QUESTION,
  agentsMd,
  skillsCommand,
  skillsLaterLines,
} from "./agent-setup.ts";
import { VSCODE_SETTINGS_JSON, parseJsonc } from "./vscode-settings.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const mockAccess = access as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;

vi.spyOn(console, "log").mockImplementation(() => {});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stands in for the skills CLI, so no test touches the network. */
const mockInstall = vi.fn(() => ({
  status: "pinned" as const,
  ref: "v1.2.3",
  command: skillsCommand("v1.2.3"),
}));

/** initProject with the terminal and the skills CLI replaced. Enter answers every question. */
const init = (options: InitOptions = {}) =>
  initProject({
    ask: async () => "",
    install: mockInstall,
    version: "1.2.3",
    ...options,
  });

/** A readdir entry: a file, or a folder when `dir` is set. */
const entry = (name: string, dir = false) => ({
  name,
  isDirectory: () => dir,
});

/**
 * Make readdir serve a folder tree: keys are folders relative to the project
 * ("" is the root), values the entries in them. Unlisted folders are empty.
 */
const projectTree = (
  tree: Record<string, ReturnType<typeof entry>[]>,
): void => {
  const root = process.cwd().replace(/\\/g, "/");
  mockReaddir.mockImplementation(async (dir: string) => {
    const rel = String(dir)
      .replace(/\\/g, "/")
      .slice(root.length + 1);
    return tree[rel] ?? [];
  });
};

/** Return the content written to writeFile for the given path suffix. */
const writtenTo = (suffix: string): string | undefined => {
  for (const call of mockWriteFile.mock.calls) {
    if (String(call[0]).replace(/\\/g, "/").endsWith(suffix)) {
      return call[1] as string;
    }
  }
  return undefined;
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("initProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default every access() call throws — files are absent.
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    // package.json read returns a minimal valid package by default.
    mockReadFile.mockResolvedValue('{"name":"my-app"}');
    // The project folder is empty by default.
    mockReaddir.mockResolvedValue([]);
  });

  it("creates pages and components directories", async () => {
    await init();
    const dirs = mockMkdir.mock.calls.map((c) =>
      String(c[0]).replace(/\\/g, "/"),
    );
    expect(dirs.some((d) => d.endsWith("src/pages"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("src/components"))).toBe(true);
    expect(mockMkdir.mock.calls[0][1]).toEqual({ recursive: true });
  });

  it("writes index.html when absent", async () => {
    await init();
    const html = writtenTo("index.html");
    expect(html).toBeDefined();
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("does not create bascik.config.js", async () => {
    await init();
    const cfg = writtenTo("bascik.config.js");
    expect(cfg).toBeUndefined();
  });

  it("skips index.html when it already exists", async () => {
    // Make only index.html present.
    mockAccess
      .mockResolvedValueOnce(undefined) // index.html exists
      .mockRejectedValue(new Error("ENOENT"));

    await init();

    const html = writtenTo("index.html");
    expect(html).toBeUndefined();
  });

  it("adds type:module, dependency, and dev/build scripts to package.json", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app"}');

    await init();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeDefined();
    const parsed = JSON.parse(pkgWrite!);
    expect(parsed.type).toBe("module");
    expect(parsed.dependencies["@bascik/bascik"]).toBe("^1.2.3");
    expect(parsed.scripts.dev).toBe("bascik");
    expect(parsed.scripts.build).toBe("bascik --build");
  });

  it("does not overwrite existing type or scripts in package.json", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        name: "my-app",
        type: "module",
        dependencies: { "@bascik/bascik": "latest" },
        scripts: { dev: "bascik", build: "bascik --build" },
      }),
    );

    await init();

    // writeFile should not have been called for package.json
    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  it("preserves existing scripts and only adds missing ones", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ name: "my-app", scripts: { dev: "bascik" } }),
    );

    await init();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeDefined();
    const parsed = JSON.parse(pkgWrite!);
    expect(parsed.scripts.dev).toBe("bascik"); // untouched
    expect(parsed.scripts.build).toBe("bascik --build"); // added
    expect(parsed.dependencies["@bascik/bascik"]).toBe("^1.2.3");
  });

  // `npm init -y` writes "type": "commonjs" since npm 11, so the documented
  // `npm init -y`, `npm install`, `npx bascik init` path reaches init with it.
  it('switches "type": "commonjs" to "module" when the project has no .js or .ts file', async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    projectTree({
      "": [
        entry("node_modules", true),
        entry(".git", true),
        entry("README.md"),
      ],
      node_modules: [entry("index.js")],
      ".git": [entry("hook.js")],
    });
    await init();
    const parsed = JSON.parse(writtenTo("package.json")!);
    expect(parsed.type).toBe("module");
    expect(parsed.scripts.dev).toBe("bascik");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"type": "module" instead of "commonjs"'),
    );
  });

  it("refuses a commonjs project with a .js file and names the file", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    projectTree({ "": [entry("lib", true)], lib: [entry("server.js")] });
    await expect(init()).rejects.toThrow(
      /init aborted: package\.json sets "type": "commonjs".*lib\/server\.js/,
    );
  });

  // A `.cjs` file is CommonJS whatever "type" says, so it cannot break when
  // the package switches to "module" (an `.eslintrc.cjs` in a fresh project).
  it("misuse: a commonjs project whose only code is a .cjs file still switches to module", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    projectTree({ "": [entry(".eslintrc.cjs"), entry("tool.cjs")] });
    await init();
    expect(JSON.parse(writtenTo("package.json")!).type).toBe("module");
  });

  it("refuses a commonjs project with a .ts file, which Node also reads by package type", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    projectTree({ "": [entry("build.ts")] });
    await expect(init()).rejects.toThrow(/build\.ts/);
  });

  // The abort message says nothing happened, so nothing may have happened:
  // package.json is checked before any folder or file is created.
  it("misuse: a commonjs project with code is refused before any folder or file is written", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    projectTree({ "": [entry("index.js")] });
    await expect(init()).rejects.toThrow("Nothing was written");
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('leaves an explicit "type": "module" alone and never scans the project', async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"module"}');
    await init();
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("pins @bascik/bascik to a caret range on the running version, not the latest dist-tag", async () => {
    await init({ version: "1.0.0" });
    const parsed = JSON.parse(writtenTo("package.json")!);
    expect(parsed.dependencies["@bascik/bascik"]).toBe("^1.0.0");
  });

  it("falls back to the latest dist-tag only when the running version is unknown", async () => {
    await init({ version: "unknown" });
    const parsed = JSON.parse(writtenTo("package.json")!);
    expect(parsed.dependencies["@bascik/bascik"]).toBe("latest");
  });

  it("misuse: does not add a second @bascik/bascik when it is already a devDependency", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        name: "my-app",
        devDependencies: { "@bascik/bascik": "^1.0.0" },
      }),
    );
    await init();
    const parsed = JSON.parse(writtenTo("package.json")!);
    expect(parsed.dependencies?.["@bascik/bascik"]).toBeUndefined();
    expect(parsed.devDependencies["@bascik/bascik"]).toBe("^1.0.0");
  });

  it("ignores the TLS key and certificate Bascik generates in the project folder", async () => {
    await init();
    const lines = writtenTo(".gitignore")!.split("\n");
    expect(lines).toContain("bascik-privkey.pem");
    expect(lines).toContain("bascik-cert.pem");
  });

  // A fresh folder has no .gitignore: without node_modules/ the first
  // `git add .` stages every installed package (create-bascik ignores it too).
  it("ignores node_modules/ in a new .gitignore", async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).endsWith(".gitignore")) throw new Error("ENOENT");
      return '{"name":"my-app"}';
    });
    await init();
    const lines = writtenTo(".gitignore")!.split("\n");
    expect(lines[0]).toBe("node_modules/");
    expect(lines).toContain("dist/");
  });

  it("misuse: does not add node_modules/ again when .gitignore spells it node_modules or /node_modules", async () => {
    for (const spelling of [
      "node_modules",
      "/node_modules",
      "/node_modules/",
    ]) {
      mockWriteFile.mockClear();
      mockReadFile.mockImplementation(async (path: unknown) =>
        String(path).endsWith(".gitignore")
          ? `${spelling}\n`
          : '{"name":"my-app"}',
      );
      await init();
      const lines = writtenTo(".gitignore")!.split("\n");
      expect(
        lines.filter(
          (l) => l.includes("node_modules") && !l.includes(".cache"),
        ),
      ).toEqual([spelling]);
    }
  });

  it("keeps a CRLF .gitignore CRLF, appending only the missing lines", async () => {
    const original = "node_modules/\r\ndist/\r\n.env\r\n";
    mockReadFile.mockImplementation(async (path: unknown) =>
      String(path).endsWith(".gitignore") ? original : '{"name":"my-app"}',
    );
    await init();
    const gitignore = writtenTo(".gitignore")!;
    expect(gitignore.startsWith(original)).toBe(true);
    expect(gitignore.replace(/\r\n/g, "")).not.toContain("\n");
    expect(gitignore.slice(original.length).split("\r\n")).toEqual([
      "node_modules/.cache/bascik/",
      "bascik-privkey.pem",
      "bascik-cert.pem",
      "",
    ]);
  });

  it("misuse: a CRLF .gitignore without a final newline gets one before the new lines", async () => {
    mockReadFile.mockImplementation(async (path: unknown) =>
      String(path).endsWith(".gitignore")
        ? "node_modules/\r\n.env"
        : '{"name":"my-app"}',
    );
    await init();
    expect(writtenTo(".gitignore")!).toMatch(
      /^node_modules\/\r\n\.env\r\ndist\/\r\n/,
    );
  });

  it("leaves .gitignore alone when every entry is already there", async () => {
    mockReadFile.mockImplementation(async (path: unknown) =>
      String(path).endsWith(".gitignore")
        ? "node_modules/\ndist/\nnode_modules/.cache/bascik/\nbascik-privkey.pem\nbascik-cert.pem\n"
        : '{"name":"my-app"}',
    );
    await init();
    expect(writtenTo(".gitignore")).toBeUndefined();
  });

  it("appends .gitignore entries without clobbering existing content", async () => {
    mockReadFile.mockImplementation(async (path: unknown) =>
      String(path).endsWith(".gitignore")
        ? "node_modules/\n"
        : '{"name":"my-app"}',
    );

    await init();

    const gitignore = writtenTo(".gitignore");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("node_modules/.cache/bascik/");
  });

  it("skips package.json when it cannot be read", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await init();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  it("skips package.json when it cannot be parsed", async () => {
    mockReadFile.mockResolvedValue("not json {{{{");

    await init();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  describe("VS Code files", () => {
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    /** Serve package.json and the given .vscode files; everything else is absent. */
    function files(vscode: Record<string, string> = {}): void {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/package.json")) return '{"name":"my-app"}';
        for (const [name, text] of Object.entries(vscode)) {
          if (p.endsWith(`/.vscode/${name}`)) return text;
        }
        throw enoent();
      });
    }

    const logged = (): string =>
      (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join("\n");

    it("writes settings.json with the inline-script check off, and extensions.json", async () => {
      files();
      await init();
      expect(writtenTo(".vscode/settings.json")).toBe(VSCODE_SETTINGS_JSON);
      expect(JSON.parse(writtenTo(".vscode/extensions.json")!)).toEqual({
        recommendations: ["bascik.bascik-vscode"],
      });
      expect(
        mockMkdir.mock.calls.some((c) =>
          String(c[0]).replace(/\\/g, "/").endsWith("/.vscode"),
        ),
      ).toBe(true);
      expect(logged()).toContain("created: .vscode/settings.json");
    });

    it("misuse: merges into existing files instead of overwriting them", async () => {
      files({
        "settings.json": '{\n  // mine\n  "editor.tabSize": 2\n}\n',
        "extensions.json": '{ "recommendations": ["dbaeumer.vscode-eslint"] }',
      });
      await init();
      const settings = writtenTo(".vscode/settings.json")!;
      expect(settings).toContain("// mine");
      expect(parseJsonc(settings)).toEqual({
        "html.validate.scripts": false,
        "editor.tabSize": 2,
      });
      expect(parseJsonc(writtenTo(".vscode/extensions.json")!)).toEqual({
        recommendations: ["bascik.bascik-vscode", "dbaeumer.vscode-eslint"],
      });
      expect(logged()).toContain(
        'updated: .vscode/settings.json (added "html.validate.scripts": false)',
      );
    });

    it("keeps a value the user already chose, even true", async () => {
      files({ "settings.json": '{ "html.validate.scripts": true }' });
      await init();
      expect(writtenTo(".vscode/settings.json")).toBeUndefined();
      expect(logged()).toContain("skipped: .vscode/settings.json");
    });

    it("misuse: leaves a broken settings file alone and prints the line to add", async () => {
      files({ "settings.json": "{ oops" });
      await init();
      expect(writtenTo(".vscode/settings.json")).toBeUndefined();
      expect(logged()).toContain(
        '.vscode/settings.json: left as is because it is not valid JSON. Add "html.validate.scripts": false',
      );
    });

    it("still sets up VS Code when package.json is missing", async () => {
      mockReadFile.mockRejectedValue(enoent());
      await init();
      expect(writtenTo(".vscode/settings.json")).toBe(VSCODE_SETTINGS_JSON);
    });
  });

  describe("webhint config", () => {
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    /** Serve package.json and the given root files; everything else is absent. */
    function files(root: Record<string, string> = {}): void {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        for (const [name, text] of Object.entries(root)) {
          if (p.endsWith(`/${name}`)) return text;
        }
        if (p.endsWith("/package.json")) return '{"name":"my-app"}';
        throw enoent();
      });
    }

    it("does not create Webhint config files or add a Webhint dependency", async () => {
      files();
      await init();
      expect(writtenTo("/.hintrc")).toBeUndefined();
      expect(writtenTo("/.hintrc.dist.json")).toBeUndefined();
      expect(writtenTo("/package.json")).not.toMatch(/"hint"|"webhint"/);
    });

    it("preserves an existing package.json hintConfig", async () => {
      const hintConfig = { extends: ["development"] };
      files({
        "package.json": JSON.stringify({
          name: "my-app",
          hintConfig,
        }),
      });
      await init();
      expect(writtenTo("/.hintrc")).toBeUndefined();
      expect(JSON.parse(writtenTo("/package.json")!).hintConfig).toEqual(
        hintConfig,
      );
    });

    it.each([".hintrc", ".hintrc.json", ".hintrc.js", ".hintrc.dist.json"])(
      "does not read or modify an existing %s, even if it is invalid",
      async (file) => {
        files({ [file]: "{ user-owned config" });
        await init();
        expect(writtenTo(`/${file}`)).toBeUndefined();
        expect(
          mockReadFile.mock.calls.some(([path]) =>
            String(path).replace(/\\/g, "/").endsWith(`/${file}`),
          ),
        ).toBe(false);
      },
    );

    it("does not load bascik.config just to initialize the project", async () => {
      files();
      await init();
      expect(
        mockReadFile.mock.calls.some(([path]) =>
          /bascik\.config\./.test(String(path)),
        ),
      ).toBe(false);
    });
  });

  describe("coding assistants", () => {
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const logged = (): string =>
      (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join("\n");

    /** Serve package.json and the given root files; everything else is absent. */
    function files(root: Record<string, string> = {}): void {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/package.json")) return '{"name":"my-app"}';
        for (const [name, text] of Object.entries(root)) {
          if (p.endsWith(`/${name}`)) return text;
        }
        throw enoent();
      });
    }

    it("writes AGENTS.md and a CLAUDE.md that imports it", async () => {
      files();
      await init({ skills: false });
      expect(writtenTo("/AGENTS.md")).toBe(agentsMd());
      expect(writtenTo("/CLAUDE.md")).toBe(CLAUDE_MD);
      expect(logged()).toContain("created: AGENTS.md");
      expect(logged()).toContain("created: CLAUDE.md");
    });

    it("misuse: merges into an existing AGENTS.md and CLAUDE.md instead of overwriting them", async () => {
      files({ "AGENTS.md": "# Team rules\n", "CLAUDE.md": "# Notes\n" });
      await init({ skills: false });
      expect(writtenTo("/AGENTS.md")).toMatch(/^# Team rules\n\n## Bascik\n/);
      expect(writtenTo("/CLAUDE.md")).toBe("# Notes\n\n@AGENTS.md\n");
      expect(logged()).toContain(
        'updated: AGENTS.md (added a "## Bascik" section)',
      );
      expect(logged()).toContain("updated: CLAUDE.md (added @AGENTS.md)");
    });

    it("leaves files that are already set alone, so running init twice changes nothing", async () => {
      files({ "AGENTS.md": agentsMd(), "CLAUDE.md": CLAUDE_MD });
      await init({ skills: false });
      expect(writtenTo("/AGENTS.md")).toBeUndefined();
      expect(writtenTo("/CLAUDE.md")).toBeUndefined();
      expect(logged()).toContain("skipped: AGENTS.md (already set)");
    });

    it("misuse: a file it cannot read is reported with what to add, and init carries on", async () => {
      files();
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/AGENTS.md") || p.endsWith("/CLAUDE.md")) {
          throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
        }
        throw enoent();
      });
      await init({ skills: false });
      expect(logged()).toContain("AGENTS.md: could not be written.");
      expect(logged()).toContain(
        "CLAUDE.md: could not be written. Add a line with @AGENTS.md",
      );
      expect(logged()).toContain("Done!");
    });

    it("asks about the agent skills and installs them on Enter, at this version, in the project folder", async () => {
      files();
      const ask = vi.fn(async () => "");
      await init({ ask });
      expect(ask).toHaveBeenCalledWith(SKILLS_QUESTION);
      expect(mockInstall).toHaveBeenCalledWith(process.cwd(), {
        version: "1.2.3",
      });
      expect(logged()).toContain(
        "✓ Installed the Bascik agent skills (v1.2.3) in .agents/skills/ and .claude/skills/",
      );
    });

    it("-y installs without asking", async () => {
      files();
      const ask = vi.fn(async () => "n");
      await init({ ask, yes: true });
      expect(ask).not.toHaveBeenCalled();
      expect(mockInstall).toHaveBeenCalledTimes(1);
    });

    it("--no-skills neither asks nor installs, even with -y", async () => {
      files();
      const ask = vi.fn(async () => "");
      await init({ ask, yes: true, skills: false });
      expect(ask).not.toHaveBeenCalled();
      expect(mockInstall).not.toHaveBeenCalled();
      expect(logged()).toContain("skipped: agent skills (--no-skills)");
    });

    it("answering n skips the install and prints the command for later, pinned to this version", async () => {
      files();
      await init({ ask: async () => "n" });
      expect(mockInstall).not.toHaveBeenCalled();
      expect(logged()).toContain(`    ${skillsCommand("v1.2.3")}`);
      expect(logged()).toContain(`  ${skillsLaterLines("v1.2.3")[1]}`);
    });

    it("misuse: in a project whose dev and build scripts run another tool, AGENTS.md names npx bascik instead of them", async () => {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/package.json")) {
          return '{"scripts":{"dev":"vite","build":"vite build"}}';
        }
        throw enoent();
      });
      await init({ skills: false });
      const agents = writtenTo("/AGENTS.md")!;
      expect(agents).toContain(
        "- `npx bascik`: dev server with live reload at http://localhost:8080",
      );
      expect(agents).toContain(
        "- `npx bascik --build`: production build into `dist/`",
      );
      expect(agents).not.toContain("npm run dev");
      expect(agents).not.toContain("npm run build");
      expect(logged()).toContain("npx bascik\n");
    });

    it("keeps npm run dev and npm run build in AGENTS.md when those scripts run Bascik", async () => {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/package.json")) {
          return '{"scripts":{"dev":"bascik --port 3000","build":"npx bascik --build"}}';
        }
        throw enoent();
      });
      await init({ skills: false });
      expect(writtenTo("/AGENTS.md")).toBe(agentsMd());
    });

    it("misuse: without a package.json, AGENTS.md names npx bascik, since npm run dev would fail", async () => {
      files();
      mockReadFile.mockImplementation(async () => {
        throw enoent();
      });
      await init({ skills: false });
      expect(writtenTo("/AGENTS.md")).toContain("- `npx bascik`: dev server");
    });

    it("misuse: a failed install, such as offline, is reported with the command to run later and init still finishes", async () => {
      files();
      await init({
        install: vi.fn(() => ({
          status: "failed" as const,
          ref: "v1.2.3",
          error: "Failed to connect",
          command: skillsCommand("v1.2.3"),
        })),
      });
      expect(logged()).toContain(
        "Could not install the Bascik agent skills (Failed to connect).",
      );
      expect(logged()).toContain(`  ${skillsCommand("v1.2.3")}`);
      expect(logged()).toContain("Done!");
    });
  });
});
