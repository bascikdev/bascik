# Custom Adapters

Author custom deployment adapters to target any serverless platform, edge runtime, container orchestrator, or static hosting provider using Bascik's hosting adapter contract (`@bascik/bascik/adapter`).

## What adapters do

A hosting adapter packages Bascik's build output for a specific host or cloud platform. Running `bascik --build --target <adapter>` performs a complete static build in `dist/` and then passes the compiled site metadata to the adapter.

The adapter writes platform-specific configuration and compiled entry points into `dist/.bascik/<target>/`:

- **Public static assets:** copied or linked into `dist/.bascik/<target>/public/` for CDN edge distribution;
- **Serverless functions or edge scripts:** bundled JavaScript handlers containing compiled `data-bascik-server` scripts, `data-bascik-stream` scripts, API routes, and page templates;
- **Platform configuration:** routing manifests, function descriptors, or manifests (e.g. `_routes.json`, `wrangler.jsonc`, or platform-specific YAML/JSON manifests).

## Target resolution

The `--target` flag accepts three kinds of targets:

1. **Official target names:** shorthand names such as `cloudflare-pages` or `cloudflare-workers` that resolve to `@bascik/adapter-cloudflare`;
2. **Npm package names:** any installed adapter package (e.g. `npm install --save-dev my-bascik-adapter` followed by `bascik --build --target my-bascik-adapter`);
3. **Local script files:** relative or absolute file paths to an adapter script (e.g. `bascik --build --target ./adapters/aws.ts`).

```sh
# Local custom adapter script
bascik --build --target ./adapters/aws-lambda.ts

# Published custom adapter package
bascik --build --target @acme/adapter-fastly
```

Target resolution loads the default ESM export from the adapter module.

## The adapter contract

Export a default `HostingAdapter` object using the `defineAdapter` helper from `@bascik/bascik/adapter`:

```ts
// adapters/aws-lambda.ts
import { defineAdapter, type HostingAdapter, type AdapterBuildContext, type AdapterBuildResult } from '@bascik/bascik/adapter';

export default defineAdapter({
  name: 'aws-lambda',
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    context.log('Building AWS Lambda serverless bundle...');

    // Read context.graph and write deployment artifacts to context.outDir
    // ...

    return {
      publicDir: 'dist/.bascik/aws-lambda/public',
      notes: ['Lambda handler written to dist/.bascik/aws-lambda/index.mjs'],
    };
  },
});
```

### `HostingAdapter` interface

| Property | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Unique identifier for the adapter, used in diagnostic logs and output directory paths. |
| `build` | `(context: AdapterBuildContext) => Promise<AdapterBuildResult>` | Async function executed at the end of `bascik --build`. |

### `AdapterBuildContext` reference

The `context` object passed to `build()` contains read-only build metadata and output path assignments:

| Property | Type | Description |
| :--- | :--- | :--- |
| `graph` | `SiteGraph` | Complete graph of compiled pages, jobs, API routes, and public files. |
| `distDir` | `string` | Absolute path to the read-only static build folder (`dist/`). |
| `outDir` | `string` | Absolute path assigned to this adapter output (`dist/.bascik/<target>/`). Adapters must write all generated files inside this directory. |
| `projectRoot` | `string` | Absolute path to the project root directory containing `package.json`. |
| `variant` | `string \| undefined` | Optional variant string specified by official targets (e.g. `'pages'` or `'workers'`). |
| `runtimeEntry` | `string` | Resolved file path to `@bascik/bascik/runtime` containing portable request execution helpers. |
| `log` | `(message: string) => void` | Logger function for reporting build progress to standard output. |

### `AdapterBuildResult` reference

The `build()` method must return an object describing the emitted artifacts:

```ts
export interface AdapterBuildResult {
  /** Optional path to the primary generated worker/handler bundle. */
  workerPath?: string;
  /** Relative or absolute path to the directory containing public static files. */
  publicDir: string;
  /** Total size in bytes of the generated serverless bundle. */
  bundleBytes?: number;
  /** Informational notes or post-build warnings printed to the CLI. */
  notes?: string[];
}
```

## Understanding `SiteGraph`

The `context.graph` object provides everything needed to route and execute per-request code:

```ts
export interface SiteGraph {
  base: string; // configured site base path (default '/')
  release: string; // deterministic release ID hash for this build
  scriptTimeoutMs: number; // configured timeout for server scripts
  apiTimeoutMs: number; // configured timeout for API route handlers
  onServerScriptError: 'error' | 'warn' | 'ignore';
  publicFiles: string[]; // dist-relative paths of all static assets
  pages: Record<string, SiteGraphPage>; // dynamic pages keyed by canonical route path
  apiRoutes: SiteGraphApiRoute[]; // sorted list of API route handlers
  custom500?: string; // path to custom 500.html template if authored
  importRoot: string; // import root path for module resolution
}
```

### Page structure (`SiteGraphPage`)

Pages with request-time scripts (`data-bascik-server` or `data-bascik-stream`) are included in `graph.pages`:

```ts
export interface SiteGraphPage {
  path: string; // e.g. '/dashboard' or '/products/:id'
  is404: boolean; // whether this is the 404 page template
  segments: DistPageSegment[]; // ordered template chunks (static HTML vs script placeholders)
  jobs: Record<string, SiteGraphJob>; // Map of job ID to script metadata
}
```

### API routes (`SiteGraphApiRoute`)

```ts
export interface SiteGraphApiRoute {
  path: string; // e.g. '/api/users' or '/api/users/:id'
  filePath: string; // absolute path to compiled handler module
  paramNames: string[]; // extracted path parameter names
  isDynamic: boolean; // true if route contains path parameters
}
```

## Executing request-time code (`@bascik/bascik/runtime`)

Adapters bundle `@bascik/bascik/runtime` into the platform's function entry point. The portable runtime handles request parsing, route matching, API dispatch, server script execution, and response streaming.

### Standard Request/Response model

Handlers take standard Web `Request` objects and return standard Web `Response` objects. To process an incoming HTTP request in your adapter's generated handler:

```ts
import { handleRequest } from '@bascik/bascik/runtime';

export async function processFetch(request: Request, platformEnv: Record<string, unknown>): Promise<Response> {
  const context = {
    params: {},
    remoteIp: request.headers.get('x-forwarded-for') ?? '127.0.0.1',
    platform: {
      name: 'my-custom-platform',
      env: platformEnv,
    },
  };

  // Pass request, route graph, and execution context to the runtime
  return handleRequest(request, siteGraph, context);
}
```

If the requested path matches a static asset in `graph.publicFiles`, return the asset from your platform's static file store or CDN. If the path matches a page with request-time scripts or an API route, pass the request to `handleRequest`.

## Step-by-step custom adapter example

Below is a complete, minimal adapter script that generates a standalone Node server bundle for custom container environments:

```ts
// adapters/custom-node.ts
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter, type HostingAdapter, type AdapterBuildContext } from '@bascik/bascik/adapter';

export default defineAdapter({
  name: 'custom-node',
  async build(context: AdapterBuildContext) {
    const { graph, outDir, distDir, log } = context;
    const publicDir = join(outDir, 'public');

    log('Creating output directories...');
    await mkdir(publicDir, { recursive: true });

    log('Copying static assets to public output directory...');
    for (const relFile of graph.publicFiles) {
      const src = join(distDir, relFile);
      const dest = join(publicDir, relFile);
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(src, dest);
    }

    log('Generating server entry file...');
    const serverCode = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleRequest } from '@bascik/bascik/runtime';

const graph = ${JSON.stringify(graph, null, 2)};
const publicDir = join(import.meta.dirname, 'public');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host ?? 'localhost'}\`);
  
  // Standard Web Request/Response conversion
  const webReq = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });

  const webRes = await handleRequest(webReq, graph, {
    params: {},
    remoteIp: req.socket.remoteAddress ?? '127.0.0.1',
    platform: { name: 'custom-node' },
  });

  res.statusCode = webRes.status;
  webRes.headers.forEach((val, key) => res.setHeader(key, val));
  
  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));
`;

    const serverPath = join(outDir, 'server.mjs');
    await writeFile(serverPath, serverCode, 'utf8');

    return {
      workerPath: serverPath,
      publicDir,
      notes: [
        `Custom Node server generated at ${serverPath}`,
        `Static assets copied to ${publicDir}`,
      ],
    };
  },
});
```

To run this build:

```sh
bascik --build --target ./adapters/custom-node.ts
```

## Testing and publishing guidelines

1. **Isolation:** Always write build outputs inside `context.outDir` (`dist/.bascik/<target>/`). Never mutate `dist/` directly or write into the user's `src/` directory.
2. **Static Asset Verification:** Ensure `graph.publicFiles` are uploaded to the target CDN or static asset bucket. Requests for static assets should never invoke the serverless function.
3. **Error Isolation:** Ensure unhandled handler errors are trapped gracefully and return a `500` status with `graph.custom500` if provided.
4. **Publishing:** Publish your adapter as an npm package (e.g. `bascik-adapter-aws`). Export the `HostingAdapter` instance as the package's default export so users can pass `--target bascik-adapter-aws`.

> **Next:** [Cloudflare Adapter](/deployment/cloudflare) provides a full example of a production serverless adapter. [Overview](/deployment) covers static hosting and built-in production server configuration.
