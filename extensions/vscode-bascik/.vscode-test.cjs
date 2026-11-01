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
    // The html.validate.scripts prompt with the built-in HTML language features turned off.
    label: "no-html-features",
    files: "out/test-no-html/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-extension", "vscode.html-language-features"],
    mocha,
  },
]);
