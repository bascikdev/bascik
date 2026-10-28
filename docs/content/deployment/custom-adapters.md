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
import { join } from "node:path";
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
      publicDir: join(context.outDir, "public"),
      notes: ["Custom adapter finished successfully."],
    };
  },
});
```

Key points:

- The adapter module exports a default object defined with `defineAdapter`.
- The `name` string identifies your adapter in build output and diagnostics.
- The `build` function receives an `AdapterBuildContext` with paths, logger, and the full site graph. `context.outDir` is the folder the adapter writes to, under `dist/.bascik/`. It is named after the `--target` value: `--target cloudflare` writes `dist/.bascik/cloudflare/`. A file path such as `./adapters/custom-node.ts` has its other characters replaced and a short hash added (`dist/.bascik/__adapters_custom-node_ts_602c65fd/`), and the build prints the folder when it finishes.

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

### Step 3: Emit the site module

When a site contains dynamic pages (`data-bascik-server`, `data-bascik-stream`) or API routes, the adapter emits the code that answers those requests. `@bascik/bascik/runtime` is not a server: it is the set of host-neutral parts the Node server and the Cloudflare adapter are built from (the execution plan scheduler, deadlines, API dispatch, route matching, response headers and the component renderer). Your host wires them to its own request and module loading.

The site graph names each script by file, not by loaded code, so the adapter turns it into a module of loaders. An inline script is staged under `outDir/.staging/`, which the build removes after `build` returns, so the adapter copies it into its own output. Replace `adapters/custom-node.ts` with:

```ts
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defineAdapter,
  type AdapterBuildContext,
  type AdapterBuildResult,
  type SiteGraphJob,
} from "@bascik/bascik/adapter";

/**
 * A loader for a job. An inline script is staged under `outDir/.staging/`,
 * which the build removes once the adapter returns, so it is copied next to
 * the server; a `src=` module is imported where it is.
 */
const jobLoader = async (
  job: SiteGraphJob,
  outDir: string,
): Promise<string> => {
  if (job.source.kind === "module")
    return `() => import(${JSON.stringify(pathToFileURL(job.source.path).href)})`;
  const name = basename(job.source.stagedPath);
  await mkdir(join(outDir, "jobs"), { recursive: true });
  await copyFile(job.source.stagedPath, join(outDir, "jobs", name));
  return `() => import(${JSON.stringify(`./jobs/${name}`)})`;
};

/** An object literal of loaders, keyed by `key`. */
const loaderTable = (entries: [string, string][]): string =>
  `{\n${entries.map(([key, loader]) => `  ${JSON.stringify(key)}: ${loader},`).join("\n")}\n}`;

export default defineAdapter({
  name: "custom-node",
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    const { graph, outDir, distDir, log } = context;
    const publicDir = join(outDir, "public");

    log("Preparing public static files...");
    for (const relFile of graph.publicFiles) {
      const dest = join(publicDir, relFile);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(distDir, relFile), dest);
    }

    log("Emitting the site module and the server...");
    const pageJobs: [string, string][] = [];
    for (const page of Object.values(graph.pages))
      for (const job of Object.values(page.jobs))
        pageJobs.push([`${page.path}#${job.id}`, await jobLoader(job, outDir)]);
    const componentJobs: [string, string][] = [];
    for (const job of Object.values(graph.components?.jobs ?? {}))
      componentJobs.push([job.id, await jobLoader(job, outDir)]);
    const apiModules = graph.apiRoutes.map((route): [string, string] => [
      route.path,
      `() => import(${JSON.stringify(pathToFileURL(route.filePath).href)})`,
    ]);
    const site = [
      `export const graph = ${JSON.stringify(graph)};`,
      `export const pageJobs = ${loaderTable(pageJobs)};`,
      `export const componentJobs = ${loaderTable(componentJobs)};`,
      `export const apiModules = ${loaderTable(apiModules)};`,
    ].join("\n\n");
    await writeFile(join(outDir, "site.mjs"), `${site}\n`, "utf8");

    // The request handler is ordinary code next to this file.
    const workerPath = join(outDir, "server.mjs");
    await copyFile(
      join(dirname(fileURLToPath(import.meta.url)), "custom-node-server.mjs"),
      workerPath,
    );

    return {
      workerPath,
      publicDir,
      // server.mjs renders component tags in script output.
      components: true,
      notes: [`Run it with: node ${workerPath}`],
    };
  },
});
```

`components: true` tells the build that this host renders component tags returned by server and stream scripts, which the handler in the next step does.

### Step 4: Write the request handler

Create `adapters/custom-node-server.mjs`. It is copied unchanged into the output and imports the generated `site.mjs` next to it:

```js
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import {
  InvalidApiPathError,
  applyOutputScope,
  composeBufferedResponse,
  createNameHasher,
  decodeOutputScope,
  dispatchApiHandler,
  dynamicPageHeaders,
  errorResponse,
  hasHiddenSegment,
  internalErrorPage,
  invokeLoadedWithDeadline,
  isUnsafePathname,
  matchApiRoute,
  pageLookupCandidates,
  renderFailureMessage,
  requestRoutePath,
  scriptTimeoutError,
  streamComposedResponse,
  stripAnsiEscapeCodes,
  wrapRunner,
} from "@bascik/bascik/runtime";
import { apiModules, componentJobs, graph, pageJobs } from "./site.mjs";

const publicDir = join(import.meta.dirname, "public");
const encoder = new TextEncoder();
const platform = { name: "custom-node" };

/** Run one script job under the deadline and the onServerScriptError policy. */
const runJob = async (job, load, request, context, signal, timeoutMs) => {
  const result = await invokeLoadedWithDeadline(
    load,
    (mod, { signal: jobSignal }) =>
      mod.default(request, context, { signal: jobSignal }),
    { timeoutMs, signal, timeoutError: scriptTimeoutError },
  );
  if (result.ok) {
    const output = stripAnsiEscapeCodes(String(result.value ?? ""));
    // A component's script gets the component's scoped class names.
    const scope = decodeOutputScope(job.outputScope);
    return scope ? applyOutputScope(output, scope) : output;
  }
  // The client went away: nothing is delivered, nothing to report.
  if (result.aborted && !result.timedOut) return "";
  const message =
    `[bascik] server script error at "${new URL(request.url).pathname}":\n` +
    `${result.error?.stack ?? result.error}\n    in the ${job.owner}`;
  if (graph.onServerScriptError === "error") throw new Error(message);
  if (graph.onServerScriptError === "warn") console.warn(message);
  return "";
};

/** The page as an execution plan, script segments keyed by their index. */
const planFor = (page) => {
  const segments = page.segments.map((segment, index) =>
    segment.kind === "static"
      ? { kind: "static", bytes: encoder.encode(segment.text ?? "") }
      : { kind: "script", mode: page.jobs[segment.id].mode, id: String(index) },
  );
  const firstStreamIndex = segments.findIndex(
    (s) => s.kind === "script" && s.mode === "stream",
  );
  return { segments, firstStreamIndex };
};

const sha256 = (input) => createHash("sha256").update(input);
const hashName = graph.components?.manifest.identifiers
  ? createNameHasher((input) => sha256(input).digest())
  : (input) => input;

/** The page's job runner, rendering component tags in its output. */
const runnerFor = (page, plan, request, context) => {
  const run = (index, signal) => {
    const id = page.segments[Number(index)].id;
    const load = pageJobs[`${page.path}#${id}`];
    return runJob(
      page.jobs[id],
      load,
      request,
      context,
      signal,
      graph.scriptTimeoutMs,
    );
  };
  if (!graph.components) return run;
  return wrapRunner(run, plan, {
    manifest: graph.components.manifest,
    hashName,
    hashHex: (input) => sha256(input).digest("hex"),
    httpPath: requestRoutePath(request.url),
    timeoutMs: graph.scriptTimeoutMs,
    runComponentJob: (id, signal, timeoutMs) =>
      runJob(
        graph.components.jobs[id],
        componentJobs[id],
        request,
        context,
        signal,
        timeoutMs,
      ),
    externalTags: () => false,
    // A render failure (a budget, the depth limit) follows the policy too.
    onRenderError: (error) => {
      const message = renderFailureMessage(error, request.url);
      if (graph.onServerScriptError === "error") throw new Error(message);
      if (graph.onServerScriptError === "warn") console.warn(message);
    },
  });
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** A file from public/, the way a CDN would serve it. */
const serveStatic = async (pathname) => {
  for (const candidate of [
    pathname,
    `${pathname}.html`,
    `${pathname}/index.html`,
  ]) {
    try {
      const body = await readFile(join(publicDir, candidate));
      const type = TYPES[extname(candidate)] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": type } });
    } catch {
      // Not this candidate; try the next one.
    }
  }
  // The site's own 404 page when it has one, as bascik --server does.
  const notFound = await readFile(join(publicDir, "404.html")).catch(
    () => null,
  );
  if (!notFound) return errorResponse(404, "Not Found");
  return new Response(notFound, {
    status: 404,
    headers: { "content-type": TYPES[".html"] },
  });
};

const handle = async (request, remoteIp) => {
  const url = new URL(request.url);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return errorResponse(400, "Bad Request");
  }
  if (isUnsafePathname(pathname)) return errorResponse(400, "Bad Request");
  if (hasHiddenSegment(pathname)) return errorResponse(404, "Not Found");

  let api;
  try {
    api = matchApiRoute(graph.apiRoutes, pathname, url.pathname);
  } catch (error) {
    if (error instanceof InvalidApiPathError)
      return errorResponse(400, "Bad Request");
    throw error;
  }
  if (api) {
    const mod = await apiModules[api.route.path]();
    return dispatchApiHandler(
      mod,
      request,
      { params: api.params, remoteIp, platform },
      {
        timeoutMs: graph.apiTimeoutMs,
        signal: request.signal,
        onError: (message, error) => console.error(message, error ?? ""),
      },
    );
  }

  const page = pageLookupCandidates(pathname)
    .map((candidate) => graph.pages[candidate])
    .find(Boolean);
  if (!page) return serveStatic(pathname);
  const isHead = request.method === "HEAD";
  if (request.method !== "GET" && !isHead)
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });

  const status = page.is404 ? 404 : 200;
  const plan = planFor(page);
  const run = runnerFor(page, plan, request, { remoteIp, platform });
  if (plan.firstStreamIndex === -1 || isHead) {
    try {
      const body = await composeBufferedResponse(plan, run, request.signal);
      const headers = dynamicPageHeaders({ contentLength: body.byteLength });
      return new Response(isHead ? null : body, { status, headers });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return internalErrorPage(graph.custom500);
    }
  }
  // Server scripts settle before the status is sent; stream scripts after.
  const streamer = streamComposedResponse(plan, run, undefined, {
    signal: request.signal,
    onStreamError: (error) =>
      console.error(error instanceof Error ? error.message : error),
  });
  try {
    await streamer.ready;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return internalErrorPage(graph.custom500);
  }
  const body = streamer.toReadableStream();
  return new Response(body, { status, headers: dynamicPageHeaders() });
};

const server = createServer(async (req, res) => {
  // Abort every running script when the client goes away.
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    for (const item of [value].flat())
      if (item !== undefined) headers.append(name, item);
  const method = req.method ?? "GET";
  const request = new Request(
    new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`),
    {
      method,
      headers,
      signal: controller.signal,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: Readable.toWeb(req), duplex: "half" }),
    },
  );
  const response = await handle(request, req.socket.remoteAddress ?? "");
  const outgoing = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing["set-cookie"] = cookies;
  res.writeHead(response.status, outgoing);
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening on http://localhost:${port}`));
```

What each part does:

- **Paths.** The decoded pathname is refused when it is unsafe (`isUnsafePathname`) or names a dotfile (`hasHiddenSegment`), as on every Bascik host. This handler assumes the site's `base` is `/`; under another base, strip `graph.base` from the pathname before page lookup, as the Cloudflare adapter does.
- **API routes.** `matchApiRoute` finds the route and its params; `dispatchApiHandler` applies the method rules (405 with `Allow`, derived `HEAD`, automatic `OPTIONS`), the `graph.apiTimeoutMs` deadline and the generic 500.
- **Pages.** `pageLookupCandidates` tries every alias of a page path. A page with no stream script, or a `HEAD` request, is composed in full with `composeBufferedResponse`. Otherwise `streamComposedResponse` waits for the server scripts, so a failure there is still a 500 page, and then streams the rest. Only `graph.custom500` or the generic page reaches the client on failure; the message goes to the log.
- **Scripts.** `invokeLoadedWithDeadline` runs a script under `graph.scriptTimeoutMs` and reports the same timeout message as `bascik --server` (`scriptTimeoutError`). The output is stripped of ANSI escapes, and a component's script gets its class names through `applyOutputScope`. A failure follows `graph.onServerScriptError`: `"error"` throws (a 500 before the status is sent, an empty slot after), `"warn"` logs and leaves the slot empty, `"ignore"` leaves it empty.
- **Components.** `wrapRunner` renders component tags in script output with the build's manifest. Script segments are keyed by their index in the page, as on the other hosts, because the key is part of every request-time instance ID; with the same keys, this server sends the same bytes as `bascik --server`. See [Rendering component tags](#rendering-component-tags-sitegraphcomponents) for each field.
- **Static files.** `public/` is served from disk so the server runs on its own. In production, serve it from a CDN or object storage instead.

### Step 5: Run the build with your custom adapter

You can point the `--target` flag directly to your local TypeScript file. Bascik runs on Node.js 22.18 or newer, which natively executes the TypeScript adapter without extra build configuration:

```sh
bascik --build --target ./adapters/custom-node.ts
```

When the build finishes, it prints the output folder:

```text
dist/.bascik/__adapters_custom-node_ts_602c65fd/
  public/
  jobs/
  site.mjs
  server.mjs
```

### Step 6: Test the output

Run the generated server with Node from the project folder, so its imports of `@bascik/bascik/runtime` and of your scripts' packages resolve from `node_modules`:

```sh
node dist/.bascik/__adapters_custom-node_ts_602c65fd/server.mjs
```

Open `http://localhost:3000` in your browser. Dynamic pages render per request, stream script output arrives as each script resolves, and a page whose scripts return component tags is rendered the way `bascik --server` renders it.

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

| Field             | What to pass                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`        | `graph.components.manifest`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `hashName`        | Identity when `manifest.identifiers` is false; otherwise `createNameHasher(digest)`, the build's scoped-name hash, where `digest` returns a string's SHA-256 as a `Uint8Array`. The wrong one renders class names the stylesheet does not define.                                                                                                                                                                                           |
| `hashHex`         | A SHA-256 hex digest of a string, used for instance IDs.                                                                                                                                                                                                                                                                                                                                                                                    |
| `httpPath`        | `requestRoutePath(request.url)`, the percent-decoded route, so IDs match every other host.                                                                                                                                                                                                                                                                                                                                                  |
| `timeoutMs`       | `graph.scriptTimeoutMs`. Nested jobs get what is left of it.                                                                                                                                                                                                                                                                                                                                                                                |
| `runComponentJob` | `(id, signal, timeoutMs) => Promise<string>`: run `graph.components.jobs[id]` with the same request, deadline handling, `onServerScriptError` policy, and `outputScope` as a page job.                                                                                                                                                                                                                                                      |
| `externalTags`    | A matcher for `components.external`. It only silences the development log, so a production host can pass `() => false`.                                                                                                                                                                                                                                                                                                                     |
| `warnOnce`        | Optional. Omit it in production; the renderer logs nothing per request without it.                                                                                                                                                                                                                                                                                                                                                          |
| `onRenderError`   | `(error) => void`: apply `graph.onServerScriptError` to a render failure (an instance, size, depth or nested-job budget, or a `failed during <stage>` failure). Under `"error"` throw `renderFailureMessage(error, request.url)`; under `"warn"` log it and return; under `"ignore"` return. Returning leaves the job's slot empty, and the renderer aborts the job's other nested scripts. Without it, every render failure fails the job. |

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

Adapters bundle `@bascik/bascik/runtime` into their function entry points. It uses only Web APIs (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `AbortSignal`), so it runs on Node, Cloudflare Workers, Deno and other Web-standard runtimes. It does not route a request by itself: the host decides which page or API route a request is for and calls these parts, as the [tutorial handler](#step-4-write-the-request-handler) and the [Cloudflare adapter source](https://github.com/bascikdev/bascik/tree/main/adapters/cloudflare/src) do.

| Area                | Exports                                                                                                                                                                                                                                              |
| :------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page composition    | `composeBufferedResponse(plan, run, signal)`, `streamComposedResponse(plan, run, writer, options)`, and the `ExecutionPlan`, `ExecutionSegment` and `ScriptJobRunner` types. A runner resolves one script job to its output; throwing fails the job. |
| Deadlines           | `invokeLoadedWithDeadline(load, call, options)`, `invokeWithDeadline(call, options)`, `scriptTimeoutError(ms)`, `createAbortGate(signal)`. A fired deadline or client abort wins over a late result.                                                 |
| API routes          | `matchApiRoute(routes, pathname, rawPathname)`, `dispatchApiHandler(mod, request, context, options)`, `allowHeaderFor(mod)`, `InvalidApiPathError`, and the `ApiHandlerContext` and `PlatformContext` types.                                         |
| Paths               | `pageLookupCandidates(pathname)`, `normalizePagePathname(pathname)`, `isUnsafePathname(pathname)`, `hasHiddenSegment(pathname, base)`, `GENERATED_CONTROL_PATHS`.                                                                                    |
| Responses           | `dynamicPageHeaders(options)`, `errorResponse(status, body, options)`, `internalErrorPage(custom500, options)`, `mergeHandlerHeaders(headers, options)`, `stripRepresentationHeaders(headers)`, `SECURITY_HEADERS`.                                  |
| Component rendering | `wrapRunner(run, plan, host)`, `RenderHost`, `requestRoutePath(url)`, `renderFailureMessage(error, url)`, `RequestRenderError`, `REQUEST_RENDER_LIMITS`, `createNameHasher(digest)`.                                                                 |
| Script output       | `applyOutputScope(output, scope)`, `decodeOutputScope(encoded)`, `stripAnsiEscapeCodes(text)`.                                                                                                                                                       |

A buffered page response for a page without stream scripts, given a `page` from `graph.pages` and a `run` like the tutorial's:

```ts
import {
  composeBufferedResponse,
  dynamicPageHeaders,
  internalErrorPage,
  type ExecutionPlan,
} from "@bascik/bascik/runtime";

const encoder = new TextEncoder();
const plan: ExecutionPlan = {
  segments: page.segments.map((segment, index) =>
    segment.kind === "static"
      ? { kind: "static", bytes: encoder.encode(segment.text ?? "") }
      : {
          kind: "script",
          mode: page.jobs[segment.id!].mode,
          id: String(index),
        },
  ),
  firstStreamIndex: -1,
};
try {
  const body = await composeBufferedResponse(plan, run, request.signal);
  return new Response(body, {
    status: page.is404 ? 404 : 200,
    headers: dynamicPageHeaders({ contentLength: body.byteLength }),
  });
} catch {
  return internalErrorPage(graph.custom500);
}
```

## Testing and publishing guidelines

1. **Isolation:** Always write build outputs inside `context.outDir` (`dist/.bascik/<target>/`). Never mutate `dist/` directly or write into the user's `src/` directory.
2. **Static Asset Verification:** Ensure `graph.publicFiles` are uploaded to the target CDN or static asset bucket. Requests for static assets should never invoke the serverless function.
3. **Error Isolation:** Ensure unhandled handler errors are trapped gracefully and return a `500` status with `graph.custom500` if provided.
4. **Publishing:** Publish your adapter as an npm package (e.g. `bascik-adapter-aws`). Export the `HostingAdapter` instance as the package's default export so users can pass `--target bascik-adapter-aws`.

> **Next:** [Cloudflare Adapter](/deployment/cloudflare) provides a full example of a production serverless adapter. [Overview](/deployment) covers static hosting and built-in production server configuration.
