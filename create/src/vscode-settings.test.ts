import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASCIK_EXTENSION_ID,
  HTML_VALIDATE_SCRIPTS,
  VSCODE_EXTENSIONS_JSON,
  VSCODE_SETTINGS_JSON,
  mergeExtensionsJson,
  mergeSettingsJson,
  parseJsonc,
  vscodeReportLines,
  writeVscodeFiles,
} from "./vscode-settings.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("VS Code settings for Bascik projects", () => {
  it("turns off VS Code's inline-script check and says why in a comment", () => {
    const parsed = parseJsonc(VSCODE_SETTINGS_JSON) as Record<string, unknown>;
    expect(parsed).toEqual({ [HTML_VALIDATE_SCRIPTS]: false });
    expect(VSCODE_SETTINGS_JSON).toContain("//");
    expect(VSCODE_SETTINGS_JSON).toContain(
      "A module cannot have multiple default exports",
    );
  });

  it("recommends the Bascik extension by its marketplace id", () => {
    expect(JSON.parse(VSCODE_EXTENSIONS_JSON)).toEqual({
      recommendations: [BASCIK_EXTENSION_ID],
    });
    expect(BASCIK_EXTENSION_ID).toBe("bascik.bascik-vscode");
  });

  it("matches the extension's real publisher and name", () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(HERE, "../../extensions/vscode-bascik/package.json"),
        "utf8",
      ),
    ) as { publisher: string; name: string };
    expect(`${pkg.publisher}.${pkg.name}`).toBe(BASCIK_EXTENSION_ID);
  });

  it("is the same file as the copy bascik init uses", () => {
    const createCopy = readFileSync(join(HERE, "vscode-settings.ts"), "utf8");
    const pkgCopy = readFileSync(
      resolve(HERE, "../../pkg/src/lib/vscode-settings.ts"),
      "utf8",
    );
    expect(pkgCopy).toBe(createCopy);
  });

  // Someone who opens examples/starter-site on its own gets the same editor setup as a new project.
  // The examples bundle skips dot folders, so add-example.mjs never copies these over a project's own files.
  it("ships in examples/starter-site as npm create bascik writes them", () => {
    const starter = resolve(HERE, "../../examples/starter-site/.vscode");
    expect(readFileSync(join(starter, "settings.json"), "utf8")).toBe(
      VSCODE_SETTINGS_JSON,
    );
    // Prettier folds the one-entry list onto one line; the content is the same.
    expect(
      JSON.parse(readFileSync(join(starter, "extensions.json"), "utf8")),
    ).toEqual(JSON.parse(VSCODE_EXTENSIONS_JSON));
  });

  it("is recommended and set in the repository's own .vscode folder", () => {
    const repo = resolve(HERE, "../../.vscode");
    const extensions = parseJsonc(
      readFileSync(join(repo, "extensions.json"), "utf8"),
    ) as { recommendations: string[] };
    expect(extensions.recommendations).toContain(BASCIK_EXTENSION_ID);
    const settings = parseJsonc(
      readFileSync(join(repo, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings[HTML_VALIDATE_SCRIPTS]).toBe(false);
  });
});

describe("parseJsonc", () => {
  it("reads comments and trailing commas the way VS Code does", () => {
    expect(
      parseJsonc(`{
        // line comment with "quotes" and a , comma
        /* block { comment } */
        "a": "has // no comment and /* none */",
        "b": [1, 2,],
      }`),
    ).toEqual({ a: "has // no comment and /* none */", b: [1, 2] });
  });

  it("returns undefined for text that is not JSON", () => {
    expect(parseJsonc("{ nope")).toBeUndefined();
    expect(parseJsonc('{ "a": 1 } trailing')).toBeUndefined();
  });

  it("keeps escaped quotes inside strings", () => {
    expect(parseJsonc('{ "a": "say \\"hi\\" // still text" }')).toEqual({
      a: 'say "hi" // still text',
    });
  });
});

describe("mergeSettingsJson", () => {
  it("writes the full file when there is none", () => {
    expect(mergeSettingsJson(undefined)).toEqual({
      status: "created",
      text: VSCODE_SETTINGS_JSON,
    });
  });

  it("treats an empty or blank file as no file", () => {
    expect(mergeSettingsJson("").status).toBe("created");
    expect(mergeSettingsJson("  \n").text).toBe(VSCODE_SETTINGS_JSON);
  });

  it("adds the setting to an existing file and keeps its settings and comments", () => {
    const existing = `{
  // my comment
  "editor.tabSize": 4,
  "files.exclude": { "dist": true },
}
`;
    const result = mergeSettingsJson(existing);
    expect(result.status).toBe("updated");
    expect(result.text).toContain("// my comment");
    expect(result.text).toContain('"editor.tabSize": 4');
    expect(parseJsonc(result.text)).toEqual({
      [HTML_VALIDATE_SCRIPTS]: false,
      "editor.tabSize": 4,
      "files.exclude": { dist: true },
    });
  });

  it("adds the setting to an empty object", () => {
    const result = mergeSettingsJson("{}");
    expect(result.status).toBe("updated");
    expect(parseJsonc(result.text)).toEqual({ [HTML_VALIDATE_SCRIPTS]: false });
  });

  it("adds the setting after a byte order mark and a leading comment", () => {
    const result = mergeSettingsJson('﻿// top { brace\n{ "a": 1 }');
    expect(result.status).toBe("updated");
    expect(result.text.startsWith("﻿// top { brace\n{")).toBe(true);
    expect(parseJsonc(result.text)).toEqual({
      [HTML_VALIDATE_SCRIPTS]: false,
      a: 1,
    });
  });

  it("keeps a CRLF file on CRLF", () => {
    const result = mergeSettingsJson('{\r\n  "a": 1\r\n}\r\n');
    expect(result.text).not.toMatch(/[^\r]\n/);
  });

  it("leaves the user's own choice alone, even true", () => {
    for (const value of [false, true]) {
      const existing = `{ "${HTML_VALIDATE_SCRIPTS}": ${value} }`;
      expect(mergeSettingsJson(existing)).toEqual({
        status: "unchanged",
        text: existing,
      });
    }
  });

  it("treats a file of only comments as empty, the way VS Code does, and keeps the comments", () => {
    for (const existing of [
      "// nothing yet\n",
      "/* later */",
      "// a\r\n// b\r\n",
    ]) {
      const result = mergeSettingsJson(existing);
      expect(result.status, existing).toBe("updated");
      expect(result.text.startsWith(existing), existing).toBe(true);
      expect(parseJsonc(result.text), existing).toEqual({
        [HTML_VALIDATE_SCRIPTS]: false,
      });
    }
  });

  it("misuse: does not touch a file it cannot read as JSON", () => {
    for (const broken of ['{ "a": 1', "[1, 2]", '"text"', "{ a: 1 }"]) {
      expect(mergeSettingsJson(broken), broken).toEqual({
        status: "invalid",
        text: broken,
      });
    }
  });
});

describe("mergeExtensionsJson", () => {
  it("writes the full file when there is none", () => {
    expect(mergeExtensionsJson(undefined)).toEqual({
      status: "created",
      text: VSCODE_EXTENSIONS_JSON,
    });
  });

  it("adds the Bascik extension to an existing list and keeps the others", () => {
    const existing = `{
  // team picks
  "recommendations": ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"]
}
`;
    const result = mergeExtensionsJson(existing);
    expect(result.status).toBe("updated");
    expect(result.text).toContain("// team picks");
    expect(parseJsonc(result.text)).toEqual({
      recommendations: [
        BASCIK_EXTENSION_ID,
        "esbenp.prettier-vscode",
        "dbaeumer.vscode-eslint",
      ],
    });
  });

  it("fills an empty list", () => {
    const result = mergeExtensionsJson('{ "recommendations": [] }');
    expect(parseJsonc(result.text)).toEqual({
      recommendations: [BASCIK_EXTENSION_ID],
    });
  });

  it("adds a recommendations list when the file has none", () => {
    const result = mergeExtensionsJson(
      '{ "unwantedRecommendations": ["x.y"] }',
    );
    expect(result.status).toBe("updated");
    expect(parseJsonc(result.text)).toEqual({
      recommendations: [BASCIK_EXTENSION_ID],
      unwantedRecommendations: ["x.y"],
    });
  });

  it("finds the top-level list, not a same-named key inside another object", () => {
    const result = mergeExtensionsJson(
      '{ "other": { "recommendations": ["a.b"] }, "recommendations": ["c.d"] }',
    );
    expect(parseJsonc(result.text)).toEqual({
      other: { recommendations: ["a.b"] },
      recommendations: [BASCIK_EXTENSION_ID, "c.d"],
    });
  });

  it("leaves the file alone when it already recommends Bascik", () => {
    const existing = `{ "recommendations": ["${BASCIK_EXTENSION_ID}"] }`;
    expect(mergeExtensionsJson(existing).status).toBe("unchanged");
  });

  it("respects a project that marked Bascik unwanted", () => {
    const existing = `{ "recommendations": [], "unwantedRecommendations": ["${BASCIK_EXTENSION_ID}"] }`;
    expect(mergeExtensionsJson(existing)).toEqual({
      status: "unchanged",
      text: existing,
    });
  });

  it("treats a file of only comments as empty and keeps the comments", () => {
    const existing = "// nothing yet\n";
    const result = mergeExtensionsJson(existing);
    expect(result.status).toBe("updated");
    expect(result.text.startsWith(existing)).toBe(true);
    expect(parseJsonc(result.text)).toEqual({
      recommendations: [BASCIK_EXTENSION_ID],
    });
  });

  it("matches extension ids without regard to case, as VS Code does", () => {
    for (const existing of [
      '{ "unwantedRecommendations": ["BASCIK.bascik-vscode"] }',
      '{ "recommendations": ["Bascik.Bascik-VSCode"] }',
    ]) {
      expect(mergeExtensionsJson(existing), existing).toEqual({
        status: "unchanged",
        text: existing,
      });
    }
  });

  it("puts the id on its own line in a list that spans lines, with no trailing space", () => {
    const existing = `{
  "recommendations": [
    "esbenp.prettier-vscode",
  ]
}
`;
    const result = mergeExtensionsJson(existing);
    expect(result.text).toBe(`{
  "recommendations": [
    "${BASCIK_EXTENSION_ID}",
    "esbenp.prettier-vscode",
  ]
}
`);
    expect(result.text).not.toMatch(/[ \t]\r?\n/);
  });

  it("keeps a one-line list on one line", () => {
    const result = mergeExtensionsJson('{ "recommendations": ["a.b"] }');
    expect(result.text).toBe(
      `{ "recommendations": ["${BASCIK_EXTENSION_ID}", "a.b"] }`,
    );
  });

  it("misuse: does not touch a file it cannot read, or a list that is not a list", () => {
    for (const broken of [
      '{ "recommendations": "x" ',
      '{ "recommendations": "x" }',
    ]) {
      expect(mergeExtensionsJson(broken).status, broken).toBe("invalid");
      expect(mergeExtensionsJson(broken).text).toBe(broken);
    }
  });
});

describe("writeVscodeFiles", () => {
  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "bascik-vscode-files-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("creates .vscode with both files in a new folder", async () => {
    await withDir(async (dir) => {
      const report = await writeVscodeFiles(dir);
      expect(report).toEqual({ settings: "created", extensions: "created" });
      expect(await readFile(join(dir, ".vscode/settings.json"), "utf8")).toBe(
        VSCODE_SETTINGS_JSON,
      );
      expect(await readFile(join(dir, ".vscode/extensions.json"), "utf8")).toBe(
        VSCODE_EXTENSIONS_JSON,
      );
    });
  });

  it("merges into files a folder already has", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".vscode"));
      await writeFile(
        join(dir, ".vscode/settings.json"),
        '{ "editor.tabSize": 4 }',
      );
      await writeFile(
        join(dir, ".vscode/extensions.json"),
        `{ "recommendations": ["${BASCIK_EXTENSION_ID}"] }`,
      );
      const report = await writeVscodeFiles(dir);
      expect(report).toEqual({ settings: "updated", extensions: "unchanged" });
      expect(
        parseJsonc(await readFile(join(dir, ".vscode/settings.json"), "utf8")),
      ).toEqual({ [HTML_VALIDATE_SCRIPTS]: false, "editor.tabSize": 4 });
    });
  });

  it("misuse: leaves a broken file as it is and reports it", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".vscode"));
      await writeFile(join(dir, ".vscode/settings.json"), "{ oops");
      const report = await writeVscodeFiles(dir);
      expect(report.settings).toBe("invalid");
      expect(await readFile(join(dir, ".vscode/settings.json"), "utf8")).toBe(
        "{ oops",
      );
    });
  });

  it("misuse: reports, rather than throws, when .vscode is a file", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, ".vscode"), "not a folder");
      const report = await writeVscodeFiles(dir);
      expect(report).toEqual({ settings: "failed", extensions: "failed" });
    });
  });
});

describe("vscodeReportLines", () => {
  it("stays quiet when both files were written fresh or already right", () => {
    expect(
      vscodeReportLines({ settings: "created", extensions: "unchanged" }),
    ).toEqual([]);
  });

  it("names what it added to an existing file", () => {
    const lines = vscodeReportLines({
      settings: "updated",
      extensions: "updated",
    });
    expect(lines.join("\n")).toContain(
      `.vscode/settings.json: added "${HTML_VALIDATE_SCRIPTS}": false`,
    );
    expect(lines.join("\n")).toContain(
      `.vscode/extensions.json: added ${BASCIK_EXTENSION_ID}`,
    );
  });

  it("misuse: tells the user the exact line to add by hand", () => {
    const text = vscodeReportLines({
      settings: "invalid",
      extensions: "failed",
    }).join("\n");
    expect(text).toContain(".vscode/settings.json");
    expect(text).toContain(`"${HTML_VALIDATE_SCRIPTS}": false`);
    expect(text).toContain(".vscode/extensions.json");
    expect(text).toContain(BASCIK_EXTENSION_ID);
  });
});
