/**
 * Runs the real scaffold on disk and checks the VS Code files every template
 * writes, including into a folder that already has its own `.vscode` files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TEMPLATES, VSCODE_LAUNCH_JSON, scaffold } from "./scaffold.ts";
import {
  BASCIK_EXTENSION_ID,
  DEFAULT_SOURCE_DIRECTORIES,
  EDITOR_LINTERS_URL,
  VSCODE_SETTINGS_JSON,
  hintDistJson,
  hintrcJson,
  parseJsonc,
} from "./vscode-settings.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bascik-scaffold-vscode-"));
  tempDirs.push(dir);
  return dir;
}

const read = (path: string) => readFile(path, "utf8");

describe("scaffold writes VS Code settings on disk", () => {
  for (const template of TEMPLATES) {
    it(`${template} template: settings, extensions and launch files`, async () => {
      const parent = await createTempDir();
      const result = await scaffold("site", parent, { template });
      const vscode = join(parent, "site", ".vscode");
      expect(await read(join(vscode, "settings.json"))).toBe(
        VSCODE_SETTINGS_JSON,
      );
      expect(parseJsonc(await read(join(vscode, "settings.json")))).toEqual({
        "html.validate.scripts": false,
      });
      expect(JSON.parse(await read(join(vscode, "extensions.json")))).toEqual({
        recommendations: [BASCIK_EXTENSION_ID],
      });
      expect(await read(join(vscode, "launch.json"))).toBe(VSCODE_LAUNCH_JSON);
      expect(result.notes).toEqual([]);
    });
  }

  it("misuse: scaffolding into a folder with .vscode files merges them and keeps launch.json", async () => {
    const parent = await createTempDir();
    const vscode = join(parent, "site", ".vscode");
    await mkdir(vscode, { recursive: true });
    const launch = '{ "version": "0.2.0", "configurations": [] }\n';
    await writeFile(join(vscode, "launch.json"), launch);
    await writeFile(
      join(vscode, "settings.json"),
      '{\n  // team setting\n  "editor.tabSize": 4,\n}\n',
    );
    await writeFile(
      join(vscode, "extensions.json"),
      '{ "recommendations": ["esbenp.prettier-vscode"] }',
    );

    const result = await scaffold("site", parent);

    const settings = await read(join(vscode, "settings.json"));
    expect(settings).toContain("// team setting");
    expect(parseJsonc(settings)).toEqual({
      "html.validate.scripts": false,
      "editor.tabSize": 4,
    });
    expect(parseJsonc(await read(join(vscode, "extensions.json")))).toEqual({
      recommendations: [BASCIK_EXTENSION_ID, "esbenp.prettier-vscode"],
    });
    expect(await read(join(vscode, "launch.json"))).toBe(launch);
    expect(result.notes).toEqual([
      '.vscode/settings.json: added "html.validate.scripts": false',
      `.vscode/extensions.json: added ${BASCIK_EXTENSION_ID}`,
    ]);
  });

  it("misuse: a .vscode file in place of the folder is reported, and the rest still scaffolds", async () => {
    const parent = await createTempDir();
    await mkdir(join(parent, "site"));
    await writeFile(join(parent, "site", ".vscode"), "not a folder");
    const result = await scaffold("site", parent);
    expect(await read(join(parent, "site", ".vscode"))).toBe("not a folder");
    expect(await read(join(parent, "site", "package.json"))).toContain(
      '"name": "site"',
    );
    const text = result.notes.join("\n");
    expect(text).toContain('"html.validate.scripts": false');
    expect(text).toContain(BASCIK_EXTENSION_ID);
    expect(text).toContain("launch.json");
  });
});

describe("scaffold writes the webhint config on disk", () => {
  for (const template of TEMPLATES) {
    it(`${template} template: .hintrc for the editor and .hintrc.dist.json for dist/`, async () => {
      const parent = await createTempDir();
      const result = await scaffold("site", parent, { template });
      const root = join(parent, "site");
      expect(await read(join(root, ".hintrc"))).toBe(
        hintrcJson(DEFAULT_SOURCE_DIRECTORIES),
      );
      expect(await read(join(root, ".hintrc.dist.json"))).toBe(hintDistJson());
      // Strict JSON: the webhint extension's quick fixes JSON.parse .hintrc,
      // and VS Code opens .hintrc.dist.json as plain JSON.
      for (const file of [".hintrc", ".hintrc.dist.json"]) {
        expect(() =>
          JSON.parse(readFileSync(join(root, file), "utf8")),
        ).not.toThrow();
      }
      // The starter's pages get charset and viewport from <site-meta />, which
      // webhint cannot see in the source: the pattern must cover them.
      const config = parseJsonc(await read(join(root, ".hintrc"))) as {
        ignoredUrls: Array<{ domain: string }>;
      };
      const pattern = new RegExp(config.ignoredUrls[0].domain, "i");
      // webhint tests the pattern against the file:/// URL, forward slashes on Windows too.
      const page = pathToFileURL(join(root, "src", "pages", "index.html"));
      expect(pattern.test(page.href)).toBe(true);
      // The touch icons sit in a head component, a fragment with no <head>.
      const components = join(root, "src", "components");
      for (const name of existsSync(components)
        ? readdirSync(components)
        : []) {
        const file = join(components, name, `${name}.html`);
        if (!existsSync(file)) continue;
        expect(pattern.test(pathToFileURL(file).href), name).toBe(true);
      }
      const built = pathToFileURL(join(root, "dist", "index.html"));
      expect(pattern.test(built.href)).toBe(false);
      expect(result.notes).toEqual([]);
    });
  }

  it("misuse: merges into a .hintrc with comments instead of replacing it", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, ".hintrc"),
      '{\n  // team config\n  "extends": ["web-recommended"],\n  "hints": { "button-type": "off" },\n}\n',
    );
    const result = await scaffold("site", parent);
    const text = await read(join(root, ".hintrc"));
    expect(text).toContain("// team config");
    const config = parseJsonc(text) as {
      extends: string[];
      hints: Record<string, unknown>;
      ignoredUrls: unknown[];
    };
    expect(config.extends).toEqual(["web-recommended"]);
    expect(config.hints["button-type"]).toBe("off");
    expect(config.hints["axe/text-alternatives"]).toBeDefined();
    expect(config.ignoredUrls).toHaveLength(1);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toBe(
      `.hintrc: added the Bascik source-file exceptions (${EDITOR_LINTERS_URL})`,
    );
    // The webhint extension's quick fixes JSON.parse the file.
    expect(result.notes[1]).toContain("quick fixes");
  });

  it("misuse: a comment-free .hintrc stays strict JSON, so the webhint extension's quick fixes keep working", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, ".hintrc"),
      JSON.stringify({ extends: ["development"] }, null, 2) + "\n",
    );
    const result = await scaffold("site", parent);
    const config = JSON.parse(await read(join(root, ".hintrc"))) as {
      ignoredUrls: unknown[];
    };
    expect(config.ignoredUrls).toHaveLength(1);
    expect(result.notes).toEqual([
      `.hintrc: added the Bascik source-file exceptions (${EDITOR_LINTERS_URL})`,
    ]);
  });

  it("misuse: merges into an existing .hintrc.json and writes no .hintrc that would hide it", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, ".hintrc.json"),
      '{ "extends": ["development"] }',
    );
    await scaffold("site", parent);
    await expect(read(join(root, ".hintrc"))).rejects.toThrow();
    expect(
      parseJsonc(await read(join(root, ".hintrc.json"))) as object,
    ).toHaveProperty("ignoredUrls");
    expect(await read(join(root, ".hintrc.dist.json"))).toBe(hintDistJson());
  });

  it("misuse: leaves a .hintrc.js alone and tells the user what to add", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".hintrc.js"), "module.exports = {};\n");
    const result = await scaffold("site", parent);
    expect(await read(join(root, ".hintrc.js"))).toBe("module.exports = {};\n");
    await expect(read(join(root, ".hintrc"))).rejects.toThrow();
    expect(result.notes.join("\n")).toContain(EDITOR_LINTERS_URL);
    // The dist config does not extend the editor config, so it is written anyway.
    expect(await read(join(root, ".hintrc.dist.json"))).toBe(hintDistJson());
  });

  it("misuse: an old .hintrc that turned the charset and viewport hints off is noted, and the dist config stands alone", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, ".hintrc"),
      `{
  "extends": ["development"],
  "hints": { "meta-viewport": "off", "meta-charset-utf-8": "off" },
  "ignoredUrls": [
    { "domain": ".*(e2e|dist|test-results|coverage|hint-report).*", "hints": ["*"] }
  ]
}
`,
    );
    const result = await scaffold("site", parent);
    const notes = result.notes.join("\n");
    expect(notes).toContain("meta-viewport");
    expect(notes).toContain("meta-charset-utf-8");
    const dist = parseJsonc(await read(join(root, ".hintrc.dist.json"))) as {
      extends: string[];
      ignoredUrls?: unknown;
    };
    expect(dist.extends).toEqual(["development"]);
    expect(dist.ignoredUrls).toBeUndefined();
  });

  it("misuse: a broken .hintrc stays as it is and is reported", async () => {
    const parent = await createTempDir();
    const root = join(parent, "site");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".hintrc"), "{ oops");
    const result = await scaffold("site", parent);
    expect(await read(join(root, ".hintrc"))).toBe("{ oops");
    expect(result.notes.join("\n")).toContain("not valid JSON");
  });
});
