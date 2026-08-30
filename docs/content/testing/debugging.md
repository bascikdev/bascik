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
      "name": "Debug Build Scripts",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["bascik", "--build"],
      "console": "integratedTerminal",
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

### 1. Build-Time Scripts (`data-bascik-build`)

To step through build-time scripts or page-aware helpers:

1. Set a breakpoint in your helper module (such as `src/lib/canonical.ts` or `src/lib/md-renderer.ts`).
2. Select **Debug Build Scripts** in VS Code's **Run and Debug** panel and press `F5`.
3. The build runs under the Node.js inspector and pauses at your breakpoint before generating output files.

### 2. Request-Time Server Scripts (`data-bascik-server`)

To debug server scripts running during incoming HTTP requests:

1. Open your component template or exported backend service file in VS Code.
2. Set a breakpoint on your request handling line.
3. Select **Debug Dev Server** in VS Code and press `F5`.
4. Trigger the page request in your browser. Execution pauses at your breakpoint in VS Code.

### 3. Unit Tests

To step through Vitest unit tests:

1. Set a breakpoint inside your test file (such as `formatters.test.ts`).
2. Select **Debug Unit Tests** in VS Code and press `F5`.
3. Vitest runs under the debugger and pauses at your breakpoint.

### 4. Client Component Scripts

To debug browser scripts in Google Chrome or Microsoft Edge directly from VS Code:

1. Launch your dev server (`npm run dev`).
2. Select **Launch Chrome** in VS Code and press `F5`.
3. Set breakpoints inside your component `.html` files in VS Code, or open Chrome DevTools (`F12`), press `Cmd + P` (or `Ctrl + P`), and select virtual files like `src/components/counter.html`.
