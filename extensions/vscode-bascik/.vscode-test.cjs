const { defineConfig } = require("@vscode/test-cli");
const path = require("node:path");

const workspaceFolder = path.join(
  __dirname,
  "test-fixtures",
  "multi-root.code-workspace",
);
const mocha = {
  ui: "tdd",
  timeout: 20000,
};

module.exports = defineConfig([
  {
    label: "editor",
    files: "out/test/**/*.test.js",
    workspaceFolder,
    mocha,
  },
  {
    // The control for the TypeScript checks: the same page with bascik.typescript.enabled off.
    label: "typescript-off",
    files: "out/test-typescript-off/**/*.test.js",
    workspaceFolder,
    mocha,
  },
  {
    // The bascik.typescript settings: the path setting's TypeScript, its fallbacks, and changes close together.
    label: "typescript-settings",
    files: "out/test-typescript-settings/**/*.test.js",
    workspaceFolder,
    mocha: { ...mocha, timeout: 120000 },
  },
  {
    // The html.validate.scripts prompt, and the TypeScript errors, with the built-in HTML language features off.
    label: "no-html-features",
    files: "out/test-no-html/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-extension", "vscode.html-language-features"],
    mocha,
  },
]);
