const { defineConfig } = require('@vscode/test-cli');
const path = require('node:path');

module.exports = defineConfig({
  files: 'dist/test/**/*.test.js',
  workspaceFolder: path.join(__dirname, 'test-fixtures', 'multi-root.code-workspace'),
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
