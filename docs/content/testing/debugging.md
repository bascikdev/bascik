# Debugging & VS Code Integration

Bascik operates directly on vanilla HTML, CSS, and JavaScript, making step-debugging seamless across Node.js servers, unit tests, and browser engines.

## VS Code Launch Profiles (`.vscode/launch.json`)

Scaffolded Bascik projects include a `.vscode/launch.json` file configured for debugging with press-to-run (`F5`) simplicity:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Dev Server",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["bascik"],
      "console": "integratedTerminal",
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Unit Tests",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["vitest", "run"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Launch Chrome",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:8080",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

## Debugging Workflow

### 1. Server Scripts and Build Steps

To debug server scripts (`<script data-bascik-server>`) or build scripts (`<script data-bascik-build>`):

1. Open your component template or exported `.ts` file in VS Code.
2. Click to the left of a line number to set a breakpoint.
3. Select **Debug Dev Server** in VS Code's **Run and Debug** panel and press `F5`.
4. Trigger the page request in your browser. Execution pauses at your breakpoint in VS Code.

### 2. Unit Tests

To step through Vitest unit tests:

1. Set a breakpoint inside your test file (such as `formatters.test.ts`).
2. Select **Debug Unit Tests** in VS Code and press `F5`.
3. Vitest runs under the debugger and pauses at your breakpoint.

### 3. Client Component Scripts

To debug browser scripts in Google Chrome or Microsoft Edge directly from VS Code:

1. Launch your dev server (`npm run dev`).
2. Select **Launch Chrome** in VS Code and press `F5`.
3. Set breakpoints inside your component `.html` files in VS Code, or open Chrome DevTools (`F12`), press `Cmd + P` (or `Ctrl + P`), and select virtual files like `src/components/counter.html`.
