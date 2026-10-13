# Debugging Reference

## Source locations

- **Build, routes, server, and stream scripts:** errors report the line and column in the file the script was written in, not a temporary module. Components work too, even though their markup and styles move before the script runs. `src=` scripts and imported helpers keep their own paths.
- **Client component scripts:** padded so DevTools lines match the component file while JavaScript is unminified (dev server, or `minify.js: false`).
- **TypeScript helpers:** Node 22.18+ strips types natively, so breakpoints in `.ts` files pause with full scope.

## VS Code launch configurations

Projects created with `npm create bascik@latest` include `.vscode/launch.json`:

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

### Server and build scripts

1. Set a breakpoint inside the script block or the imported `.ts` helper.
2. Start **Debug Dev Server** (F5).
3. Load the page in the browser. Execution pauses in VS Code with variables, the call stack, and the Debug Console.

### Unit tests

Set a breakpoint inside an `it()` block and start **Debug Unit Tests**.

### Browser scripts

Start the dev server, then **Launch Chrome**. Set breakpoints in the component `.html` file in VS Code, or open the virtual file `src/components/<name>.html` in Chrome DevTools.

## Common symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| Only the first instance of a component responds | `querySelector('.cls')` in the component script | `id` plus `getElementById` |
| Style missing on slotted or script-created elements | Element selectors apply only to template markup | Wrapper class plus `:is(h2)`; clone a `<template>` instead of `createElement` |
| Custom tag still in `dist/` | No component file matches, or a typo | `bascik --check`; declare real custom elements in `components.external` |
| Build script output stale | Cache cannot see network or directory reads | `scripts.cache.exclude`, or delete `node_modules/.cache/bascik/script-cache` |
| Works in dev, breaks in production | Script ran before a later element existed (scripts move to the end when minified), or a test used a scoped name | Look up elements in handlers or after `DOMContentLoaded`; use role or test-id locators |
| `Failed to resolve module specifier` in the browser | Bare npm import in a client script | Bundle with an exec script, load from `/assets/...` |
| Build fails asking for a site URL | Sitemap or robots generation is on | `BASCIK_SITE_URL=https://example.com`, `--site-url`, or `.env` |
| Helper edit does not rebuild | Helper folder not watched | Add it to `pipeline.watchPaths` |
| Error about a leading `/` import | `import x from '/lib/x.ts'` | `@/lib/x.ts` or `./lib/x.ts` |

## Validate dist against the HTML spec

```ts
// src/lib/dist-sanity.test.ts (run after bascik --build)
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type ParserError } from 'parse5';

const DIST_DIR = path.resolve(process.cwd(), 'dist');

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

describe('dist HTML', () => {
  it('has no WHATWG parse errors', async () => {
    const failures: string[] = [];
    for (const file of await walk(DIST_DIR)) {
      const errors: ParserError[] = [];
      parse(await readFile(file, 'utf8'), { sourceCodeLocationInfo: true, onParseError: (e) => errors.push(e) });
      for (const err of errors) failures.push(`${path.relative(DIST_DIR, file)}:${err.startLine}:${err.startCol} [${err.code}]`);
    }
    expect(failures, failures.join('\n')).toHaveLength(0);
  });
});
```

This catches corrupted script bodies, mismatched tags, and leftover tokens that string assertions miss.
