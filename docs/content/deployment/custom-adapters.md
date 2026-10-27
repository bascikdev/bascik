# Custom Adapters

Author custom deployment adapters to package Bascik builds for any serverless platform, edge runtime, container orchestrator, or custom hosting environment.

Bascik provides an open hosting adapter contract (`@bascik/bascik/adapter`) and portable runtime (`@bascik/bascik/runtime`). By writing an adapter, you can take a standard `bascik --build`, inspect the site graph, and generate production-ready deployment bundles for platforms like AWS Lambda, Fastly Compute, Deno Deploy, or custom Node containers.

This guide walks through creating your first custom adapter from scratch as a step-by-step tutorial, then provides a complete API reference for the adapter interfaces and site graph.

---

## Tutorial: Build a minimal custom adapter

In this tutorial, you will create a custom adapter that bundles a Bascik site into a self-contained Node HTTP server with its static assets placed alongside. This demonstrates the core workflow: reading the site graph, preparing public files, emitting a runtime entrypoint, and running the build.

### Step 1: Create the adapter file

Create a new file in your project at `adapters/custom-node.ts`:

```ts
import {
  defineAdapter,
  type AdapterBuildContext,
  type AdapterBuildResult,
} from "@bascik/bascik/adapter";

export default defineAdapter({
  name: "custom-node",
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    context.log("Building custom Node deployment bundle...");

    return {
      publicDir: "dist/.bascik/custom-node/public",
      notes: ["Custom adapter finished successfully."],
    };
  },
});
```

Key points:

- The adapter module exports a default object defined with `defineAdapter`.
- The `name` string identifies your target and determines its default output folder inside `dist/.bascik/<target>/`.
- The `build` function receives an `AdapterBuildContext` with paths, logger, and the full site graph.

### Step 2: Separate public static assets

Production deployments generally serve pure static files directly from object storage or a CDN, bypassing serverless compute. Bascik provides the list of all static assets in `context.graph.publicFiles`.

Update `adapters/custom-node.ts` to copy these assets into the adapter's output directory:

```ts
import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineAdapter,
  type AdapterBuildContext,
  type AdapterBuildResult,
} from "@bascik/bascik/adapter";

export default defineAdapter({
  name: "custom-node",
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    const { graph, outDir, distDir, log } = context;
    const publicDir = join(outDir, "public");

    log("Preparing public static files...");
    await mkdir(publicDir, { recursive: true });

    for (const relFile of graph.publicFiles) {
      const src = join(distDir, relFile);
      const dest = join(publicDir, relFile);
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(src, dest);
    }

    return {
      publicDir,
      notes: [
        `Copied ${graph.publicFiles.length} static assets to public output directory.`,
      ],
    };
  },
});
```

Notice that we copy files from `context.distDir` to `join(context.outDir, 'public')`. Always write files inside `context.outDir`; treat `context.distDir` as read-only.

### Step 3: Emit the runtime server entrypoint

When a site contains dynamic pages (`data-bascik-server`, `data-bascik-stream`) or API routes, requests must be handled by `@bascik/bascik/runtime`.

The runtime provides `handleRequest(webRequest, graph, context)` which accepts standard web `Request` objects and returns standard web `Response` objects.

Add the entrypoint generation to `adapters/custom-node.ts`:

```ts
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineAdapter,
  type AdapterBuildContext,
  type AdapterBuildResult,
} from "@bascik/bascik/adapter";

export default defineAdapter({
  name: "custom-node",
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    const { graph, outDir, distDir, log } = context;
    const publicDir = join(outDir, "public");

    log("Preparing public static files...");
    await mkdir(publicDir, { recursive: true });

    for (const relFile of graph.publicFiles) {
      const src = join(distDir, relFile);
      const dest = join(publicDir, relFile);
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(src, dest);
    }

    log("Emitting runtime server script...");
    const serverCode = `import { createServer } from 'node:http';
import { handleRequest } from '@bascik/bascik/runtime';

const graph = ${JSON.stringify(graph, null, 2)};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host ?? 'localhost'}\`);

  // Convert Node incoming request to standard Web Request
  const webReq = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });

  // Execute request against Bascik runtime
  const webRes = await handleRequest(webReq, graph, {
    params: {},
    remoteIp: req.socket.remoteAddress ?? '127.0.0.1',
    platform: { name: 'custom-node' },
  });

  // Send response back through Node HTTP
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

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
server.listen(port, () => {
  console.log(\`Server listening on http://localhost:\${port}\`);
});
`;

    const workerPath = join(outDir, "server.mjs");
    await writeFile(workerPath, serverCode, "utf8");

    return {
      workerPath,
      publicDir,
      notes: [
        `Server bundle written to ${workerPath}`,
        `Public assets written to ${publicDir}`,
      ],
    };
  },
});
```

### Step 4: Run the build with your custom adapter

You can point the `--target` flag directly to your local TypeScript file. Bascik runs on Node.js 22.18 or newer, which natively executes the TypeScript adapter without extra build configuration:

```sh
bascik --build --target ./adapters/custom-node.ts
```

When the build finishes, inspect the output in `dist/.bascik/custom-node/`:

```text
dist/.bascik/custom-node/
  public/
    styles.css
    logo.svg
  server.mjs
```

### Step 5: Test the output

Run your generated server with Node to verify dynamic rendering and streaming:

```sh
node dist/.bascik/custom-node/server.mjs
```

Open `http://localhost:3000` in your browser. All dynamic pages render through the runtime handler, and stream script chunks flush progressively as they resolve.

---

## Target resolution

The `--target` flag resolves in three ways:

1. **Local file paths:** relative or absolute path to a script file (e.g. `bascik --build --target ./adapters/custom-node.ts`).
2. **Official target names:** shorthand aliases like `cloudflare` or `cloudflare-workers` that map to official adapters like `@bascik/adapter-cloudflare`.
3. **Npm package names:** any third-party adapter installed in your project:
   ```sh
   npm install --save-dev bascik-adapter-fastly
   bascik --build --target bascik-adapter-fastly
   ```

Bascik dynamically imports the resolved module and reads its default export.

---

## Packaging and publishing adapters

To share your adapter with other developers or use it across multiple repositories, publish it as an npm package.

### Package layout

```text
my-adapter/
  package.json
  src/
    index.ts
  README.md
```

### Exporting the adapter

In your package entrypoint (`src/index.ts`), export the adapter as the default export:

```ts
import {
  defineAdapter,
  type AdapterBuildContext,
  type AdapterBuildResult,
} from "@bascik/bascik/adapter";

export interface MyAdapterOptions {
  memoryMb?: number;
  region?: string;
}

export function createAdapter(options: MyAdapterOptions = {}) {
  return defineAdapter({
    name: "my-cloud",
    async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
      context.log(
        `Building with ${options.memoryMb ?? 128}MB memory in ${options.region ?? "auto"}...`,
      );
      // Build platform bundles...
      return {
        publicDir: `${context.outDir}/public`,
      };
    },
  });
}

// Default export used when invoked via CLI: bascik --build --target my-adapter
export default createAdapter();
```

Users can either pass the package name via CLI:

```sh
bascik --build --target my-adapter
```

Or configure it with options in their `bascik.config.ts`:

```ts
import { defineConfig } from "@bascik/bascik";
import { createAdapter } from "my-adapter";

export default defineConfig({
  // Configuration options
});
```

---

## Architecture and best practices

Follow these principles when authoring adapters:

1. **Filesystem isolation:** Write all generated files inside `context.outDir` (`dist/.bascik/<target>/`). Never mutate `dist/` directly, and never write into `src/`.
2. **CDN-first routing:** Pure static pages and assets in `graph.publicFiles` should be served directly by the platform CDN or object storage. Route only API endpoints and dynamic page routes to serverless compute.
3. **Template encapsulation:** Pages containing `data-bascik-server` or `data-bascik-stream` are excluded from `public/`. Their templates live in `graph.pages`. If a static layer route accidentally matches them, it produces a 404 rather than leaking unrendered placeholder tags.
4. **Error handling:** Respect `graph.onServerScriptError` and provide a fallback response using `graph.custom500` if present when an unhandled runtime error occurs.

---

## Reference: Adapter API

### `HostingAdapter` interface

```ts
export interface HostingAdapter {
  name: string;
  build(context: AdapterBuildContext): Promise<AdapterBuildResult>;
}

export function defineAdapter(adapter: HostingAdapter): HostingAdapter;
```

| Property | Type                                                            | Description                                                                  |
| :------- | :-------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| `name`   | `string`                                                        | Unique identifier for the adapter, used in diagnostic logs and output paths. |
| `build`  | `(context: AdapterBuildContext) => Promise<AdapterBuildResult>` | Async hook called after static build completes.                              |

### `AdapterBuildContext`

The build context provides read-only information about the project, paths, and compiled site graph:

| Property       | Type                        | Description                                                                     |
| :------------- | :-------------------------- | :------------------------------------------------------------------------------ |
| `graph`        | `SiteGraph`                 | Complete metadata graph of compiled pages, jobs, API routes, and public files.  |
| `distDir`      | `string`                    | Absolute path to the read-only static build folder (`dist/`).                   |
| `outDir`       | `string`                    | Assigned output directory (`dist/.bascik/<target>/`). Write all artifacts here. |
| `projectRoot`  | `string`                    | Absolute path to the root directory containing `package.json`.                  |
| `variant`      | `string \| undefined`       | Optional variant string specified by the caller or target mapping.              |
| `runtimeEntry` | `string`                    | File path to `@bascik/bascik/runtime` for bundlers that resolve ESM modules.    |
| `log`          | `(message: string) => void` | Logging utility for emitting CLI build status lines.                            |

### `AdapterBuildResult`

```ts
export interface AdapterBuildResult {
  /** Path to primary generated handler or worker bundle. */
  workerPath?: string;
  /** Directory containing static files to deploy to static storage or CDN. */
  publicDir: string;
  /** Size in bytes of the generated worker bundle. */
  bundleBytes?: number;
  /** Informational notes or post-build instructions printed to stdout. */
  notes?: string[];
  /** True when the runtime renders component tags in script output (graph.components). */
  components?: boolean;
}
```

Return `components: true` only when your runtime renders `graph.components` as described in [Rendering component tags](#rendering-component-tags-sitegraphcomponents). When the graph has components that can be rendered and the result does not declare it, the build still succeeds and prints a warning naming the adapter and the affected components:

```terminal
[bascik] --target my-platform: adapter "my-platform" does not declare components: true, so component tags returned by server and stream scripts are not rendered on this host and reach the client as written (dist/.bascik/components.json lists <product-card>). Upgrade the adapter, or keep component tags out of script output for this target.
```

---

## Reference: `SiteGraph`

The `SiteGraph` contains all metadata needed to route requests, execute server scripts, and stream responses:

```ts
export interface SiteGraph {
  base: string; // Configured site base path (default '/')
  release: string; // Deterministic release ID hash for the build
  scriptTimeoutMs: number; // Configured timeout for server scripts
  apiTimeoutMs: number; // Configured timeout for API routes
  onServerScriptError: "error" | "warn" | "ignore";
  publicFiles: string[]; // Relative paths of all static assets in dist/
  pages: Record<string, SiteGraphPage>; // Dynamic pages keyed by route path
  apiRoutes: SiteGraphApiRoute[]; // Sorted list of API route handlers
  custom500?: string; // Content or path of custom 500.html template if present
  importRoot: string; // Absolute path to project source import root
  components?: SiteGraphComponents; // Present when the build wrote dist/.bascik/components.json
}

export interface SiteGraphComponents {
  manifest: ComponentManifest; // The parsed dist/.bascik/components.json
  jobs: Record<string, SiteGraphJob>; // Server and stream scripts inside components, by job ID
}
```

### `SiteGraphPage`

Dynamic pages with `data-bascik-server` or `data-bascik-stream` scripts:

```ts
export interface SiteGraphPage {
  path: string; // Route path, e.g. '/dashboard' or '/products/:id'
  is404: boolean; // True if this template serves custom 404s
  segments: DistPageSegment[]; // Interleaved static HTML chunks and script markers
  jobs: Record<string, SiteGraphJob>; // Map of job ID to script metadata
}

export interface DistPageSegment {
  kind: "static" | "script";
  text?: string; // HTML markup for static segment
  id?: string; // Job ID for script segment
}
```

### `SiteGraphJob`

Describes an individual request-time script execution:

```ts
export interface SiteGraphJob {
  id: string; // Unique job ID within the page
  mode: "server" | "stream"; // Blocking server script vs streaming chunk script
  source:
    | { kind: "module"; path: string }
    | { kind: "inline"; code: string; stagedPath: string };
  owner: string; // Authoring source location for diagnostic traces
  outputScope?: string; // A component's class mapping for this job's output, when the job is inside a component
}
```

A job with `outputScope` is a script inside a component. Apply it to the job's output with `applyOutputScope(output, decodeOutputScope(job.outputScope))` from `@bascik/bascik/runtime`, so the returned markup gets the component's scoped class names, as on Node.

### Rendering component tags (`SiteGraph.components`)

A server or stream script may return component tags, and the runtime renders them per request (see [Returning component tags](/server-scripts#returning-component-tags)). `graph.components` is present when the site has any server or stream script; a static-only site has none, and an adapter can ignore the field entirely for it. It holds:

- `manifest`: every component recorded as a scoping template, with its CSS, its staged scripts, and, for the ones that cannot be rendered, the reason.
- `jobs`: the server and stream scripts inside components, keyed by job ID. They belong to no page, because any page's script may return any component. Stage and bundle them like page jobs; inline sources are staged under the same rules.

To render, wrap the page's job runner with `wrapRunner(run, plan, host)` from `@bascik/bascik/runtime`. It returns `run` unchanged when the manifest has nothing to render. The host supplies:

| Field             | What to pass                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`        | `graph.components.manifest`                                                                                                                                                                                                                       |
| `hashName`        | Identity when `manifest.identifiers` is false; otherwise `createNameHasher(digest)`, the build's scoped-name hash, where `digest` returns a string's SHA-256 as a `Uint8Array`. The wrong one renders class names the stylesheet does not define. |
| `hashHex`         | A SHA-256 hex digest of a string, used for instance IDs.                                                                                                                                                                                          |
| `httpPath`        | `requestRoutePath(request.url)`, the percent-decoded route, so IDs match every other host.                                                                                                                                                        |
| `timeoutMs`       | `graph.scriptTimeoutMs`. Nested jobs get what is left of it.                                                                                                                                                                                      |
| `runComponentJob` | `(id, signal, timeoutMs) => Promise<string>`: run `graph.components.jobs[id]` with the same request, deadline handling, `onServerScriptError` policy, and `outputScope` as a page job.                                                            |
| `externalTags`    | A matcher for `components.external`. It only silences the development log, so a production host can pass `() => false`.                                                                                                                           |
| `warnOnce`        | Optional. Omit it in production; the renderer logs nothing per request without it.                                                                                                                                                                |

Key script segments by their index in the page, as the Node server and the Cloudflare adapter do: the job key is part of every request-time instance ID, so the same keys give the same bytes on every host. The [Cloudflare adapter source](https://github.com/bascikdev/bascik/tree/main/adapters/cloudflare/src) is a complete host, and its tests compare its output with `bascik --server` byte for byte.

### `SiteGraphApiRoute`

Describes a discovered serverless API endpoint:

```ts
export interface SiteGraphApiRoute {
  path: string; // URL route path, e.g. '/api/users/:id'
  filePath: string; // Absolute path to compiled handler file
  paramNames: string[]; // List of dynamic path parameters
  isDynamic: boolean; // True if route contains parameterized segments
}
```

---

## Reference: Portable Runtime (`@bascik/bascik/runtime`)

Adapters bundle `@bascik/bascik/runtime` into their function entry points. The runtime handles routing, parameter extraction, script execution, error trapping, and chunk streaming:

```ts
import { handleRequest } from "@bascik/bascik/runtime";

const response = await handleRequest(request, graph, {
  params: {},
  remoteIp: request.headers.get("x-forwarded-for") ?? "127.0.0.1",
  platform: {
    name: "my-platform",
    env: process.env,
  },
});
```

The runtime accepts standard Web `Request` objects and returns standard Web `Response` objects (with `ReadableStream` bodies for streaming pages), making it compatible with Cloudflare Workers, Fastly Compute, Deno, Bun, and Node 18+.

> **Next:** Inspect the [Cloudflare Adapter](/deployment/cloudflare) guide for a production example with asset routing and Wrangler configuration, or return to [Deployment Overview](/deployment).
> const publicDir = join(import.meta.dirname, 'public');

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

````

To run this build:

```sh
bascik --build --target ./adapters/custom-node.ts
````

## Testing and publishing guidelines

1. **Isolation:** Always write build outputs inside `context.outDir` (`dist/.bascik/<target>/`). Never mutate `dist/` directly or write into the user's `src/` directory.
2. **Static Asset Verification:** Ensure `graph.publicFiles` are uploaded to the target CDN or static asset bucket. Requests for static assets should never invoke the serverless function.
3. **Error Isolation:** Ensure unhandled handler errors are trapped gracefully and return a `500` status with `graph.custom500` if provided.
4. **Publishing:** Publish your adapter as an npm package (e.g. `bascik-adapter-aws`). Export the `HostingAdapter` instance as the package's default export so users can pass `--target bascik-adapter-aws`.

> **Next:** [Cloudflare Adapter](/deployment/cloudflare) provides a full example of a production serverless adapter. [Overview](/deployment) covers static hosting and built-in production server configuration.
