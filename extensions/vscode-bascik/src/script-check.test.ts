import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAMES,
  CONFIG_GLOB,
  decideFolder,
  HTML_LANGUAGE_FEATURES,
  HTML_VALIDATE_SCRIPTS,
  promptMessage,
  type SettingInspection,
} from "./script-check";

/** The language server's config file list, read from its source because the extension's tsc build stops at src/. */
const lspConfigNames = (() => {
  const source = readFileSync(
    join(__dirname, "..", "..", "..", "lsp", "src", "project.ts"),
    "utf8",
  );
  const list = /CONFIG_FILE_CANDIDATES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  return Array.from(list.matchAll(/"([^"]+)"/g), (match) => match[1]);
})();

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { contributes?: Record<string, unknown> };

describe("decideFolder", () => {
  it("asks in a Bascik folder where nobody set the value and it resolves to true", () => {
    expect(decideFolder(true, { defaultValue: true })).toBe("ask");
    expect(decideFolder(true, {})).toBe("ask");
    expect(decideFolder(true, undefined)).toBe("ask");
  });

  // With the built-in "HTML Language Features" extension disabled, nothing checks inline scripts, the false error
  // cannot appear, and "html.validate.scripts" is not even a registered setting, so writing it would only add an
  // unknown setting to the folder's settings.json.
  it("does not ask when VS Code's HTML language features are not running", () => {
    expect(decideFolder(true, { defaultValue: true }, false)).toBe(
      "no-html-check",
    );
    expect(decideFolder(true, {}, false)).toBe("no-html-check");
    expect(decideFolder(true, undefined, false)).toBe("no-html-check");
  });

  it("still reports a folder without a Bascik config as not Bascik when the HTML features are off", () => {
    expect(decideFolder(false, undefined, false)).toBe("not-bascik");
  });

  it("never asks in a folder without a Bascik config", () => {
    expect(decideFolder(false, { defaultValue: true })).toBe("not-bascik");
  });

  for (const level of [
    "globalValue",
    "workspaceValue",
    "workspaceFolderValue",
  ] as const) {
    for (const value of [true, false]) {
      it(`never asks when ${level} is ${value}`, () => {
        expect(decideFolder(true, { defaultValue: true, [level]: value })).toBe(
          "already-set",
        );
      });
    }
  }

  it("does not ask when the value already resolves to false by default", () => {
    expect(decideFolder(true, { defaultValue: false })).toBe("already-off");
  });

  // "html.validate.scripts" is not a language-overridable setting: VS Code refuses to write it under "[html]" ("not a
  // resource language setting"), and its HTML language server ignores a hand-written "[html]" value, so the false
  // error still shows. A value set only there must not stop the prompt either.
  for (const level of [
    "defaultLanguageValue",
    "globalLanguageValue",
    "workspaceLanguageValue",
    "workspaceFolderLanguageValue",
  ]) {
    it(`still asks when only ${level} is false`, () => {
      expect(
        decideFolder(true, {
          defaultValue: true,
          [level]: false,
        } as SettingInspection),
      ).toBe("ask");
    });
  }
});

describe("promptMessage", () => {
  it("says what VS Code reports, why it is wrong, and what the button changes", () => {
    const message = promptMessage(["primary"]);
    expect(message).toContain(
      '"A module cannot have multiple default exports"',
    );
    expect(message).toContain("Bascik runs each script on its own");
    expect(message).toContain(`"${HTML_VALIDATE_SCRIPTS}": false`);
    expect(message).toContain('"primary"');
    expect(message).toContain("only VS Code's check of code inside <script>");
  });

  it("names every folder it covers", () => {
    expect(promptMessage(["a", "b"])).toContain('"a", "b"');
  });
});

describe("Bascik project detection", () => {
  it("looks for the same config files as the language server", () => {
    expect(lspConfigNames.length).toBeGreaterThan(0);
    expect(CONFIG_FILE_NAMES).toEqual(lspConfigNames);
    for (const name of CONFIG_FILE_NAMES) {
      const extension = name.split(".").pop()!;
      expect(CONFIG_GLOB).toContain(extension);
    }
  });
});

describe("package.json", () => {
  // A configurationDefaults entry would switch the check off in every HTML file of every workspace.
  it("contributes no default for html.validate.scripts", () => {
    expect(manifest.contributes?.configurationDefaults).toBeUndefined();
    expect(JSON.stringify(manifest.contributes)).not.toContain(
      HTML_VALIDATE_SCRIPTS,
    );
  });
});

describe("HTML_LANGUAGE_FEATURES", () => {
  it("is the built-in extension that contributes html.validate.scripts", () => {
    expect(HTML_LANGUAGE_FEATURES).toBe("vscode.html-language-features");
  });
});
