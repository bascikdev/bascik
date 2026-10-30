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
  writeFile: vi.fn(async () => undefined),
}));

import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const mockAccess = access as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
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
    expect(parsed.dependencies["@bascik/bascik"]).toBe("latest");
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
    expect(parsed.dependencies["@bascik/bascik"]).toBe("latest");
  });

  it("refuses to overwrite package type commonjs", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    await expect(init()).rejects.toThrow("init aborted");
  });

  it("appends .gitignore entries without clobbering existing content", async () => {
    // access(index) throws, .gitignore read succeeds.
    mockReadFile
      .mockResolvedValueOnce("node_modules/\n")
      .mockResolvedValueOnce('{"name":"my-app"}');

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
