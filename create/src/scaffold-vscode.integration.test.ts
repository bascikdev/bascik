/**
 * Runs the real scaffold on disk and checks the VS Code files every template
 * writes, including into a folder that already has its own `.vscode` files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATES, VSCODE_LAUNCH_JSON, scaffold } from "./scaffold.ts";
import {
  BASCIK_EXTENSION_ID,
  VSCODE_SETTINGS_JSON,
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
