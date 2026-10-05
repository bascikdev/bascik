# Package Exports

Bascik ships as a single npm package, `@bascik/bascik`, with a small set of subpath exports. There is no large SDK surface: the package exposes configuration helpers for your build, a hosting adapter contract for deployment targets, and a portable request-execution runtime for serverless hosts. Everything else is the `bascik` CLI.

## Export map

| Import specifier | Purpose | Where it is documented |
| --- | --- | --- |
| `@bascik/bascik` | Main entry: `defineConfig`, `composeSiteUrl`, and CLI helpers (`runCli`, `readVersion`, `installProcessCrashHandlers`, `resolveBuildLogPath`, `setupBuildLogging`) | [Configuration](/configuration), [Command Line Interface](/cli) |
| `@bascik/bascik/config` | `defineConfig` plus the full `BascikConfig` type for `bascik.config.ts` | [Configuration](/configuration) |
| `@bascik/bascik/runtime` | Host-neutral request execution: buffered and streamed page composition, deadline-bounded invocation, and API route dispatch | [Custom Adapters](/deployment/custom-adapters), [Server Architecture](/internals/server) |
| `@bascik/bascik/adapter` | Hosting adapter contract: `defineAdapter`, the `SiteGraph` types, and site-graph readers | [Custom Adapters](/deployment/custom-adapters) |

## `@bascik/bascik`

The main entry re-exports the configuration helper and a few programmatic CLI utilities. Most projects only ever import `defineConfig` from it (or from `/config`).

```ts
import { defineConfig, composeSiteUrl } from '@bascik/bascik';

export default defineConfig({
  base: '/docs/',
});
```

- `defineConfig(config)` returns the config unchanged, typed as `BascikConfig`, so your editor surfaces every option with inline docs.
- `composeSiteUrl(base, siteUrl)` composes a site URL from a base path and origin.
- `runCli(args)` runs the CLI programmatically; `readVersion()`, `installProcessCrashHandlers()`, `resolveBuildLogPath(args)`, and `setupBuildLogging(path)` support embedding the CLI in custom tooling.

## `@bascik/bascik/config`

The config subpath is the recommended import for `bascik.config.ts`. It exports `defineConfig` and re-exports every configuration type, including `BascikConfig`.

```ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: { sitemapLastmod: true },
});
```

## `@bascik/bascik/runtime`

The runtime subpath is the portable request-execution engine that the built-in Node server and every hosting adapter share. It has zero Node builtins, so it bundles cleanly for serverless and edge platforms. Adapter authors use it to serve dynamic pages and API routes from a compiled site graph.

Key functions:

- `composeBufferedResponse(plan, run, signal)` composes a fully buffered `Uint8Array` body for a page whose `data-bascik-server` jobs all resolve before the response starts.
- `streamComposedResponse(plan, run, writer, options)` drives the two-phase streamer: `server` jobs resolve before commit, `stream` jobs run with bounded lookahead after headers are sent. Returns a `ComposedStreamer` with `ready`, `commit`, `done`, `signal`, and `toReadableStream()`.
- `invokeWithDeadline(handler, options)` runs a handler under a timeout and an upstream `AbortSignal`, settling exactly once.
- `dispatchApiHandler(module, request, context, options)` dispatches a web `Request` to an API route module's exported methods, handling `HEAD`, `OPTIONS`, and the `Allow` header.

The runtime also exports the shared response policy (`dynamicPageHeaders`, `mergeHandlerHeaders`, `stripRepresentationHeaders`, `errorResponse`, `internalErrorPage`, `SECURITY_HEADERS`) and pure route matching (`matchApiRoute`, `sortApiRoutes`, `pageLookupCandidates`, `isUnsafePathname`, `hasHiddenSegment`).

## `@bascik/bascik/adapter`

The adapter subpath defines the hosting adapter contract. A custom adapter is a module whose default export is created with `defineAdapter`; `bascik --build --target <name>` loads it and calls its `build` hook with an `AdapterBuildContext` containing the compiled site graph.

```ts
import { defineAdapter, type AdapterBuildContext, type AdapterBuildResult } from '@bascik/bascik/adapter';

export default defineAdapter({
  name: 'my-cloud',
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    // Read context.graph, copy context.distDir assets, emit a runtime entrypoint.
    return { publicDir: `${context.outDir}/public` };
  },
});
```

It also exports the site-graph readers used inside adapters: `readSiteGraph`, `pageAliasesFor`, `detectPublicCollisions`, `isPublicAssetPath`, and `splitDistPageIntoSegments`.

See [Custom Adapters](/deployment/custom-adapters) for the full tutorial and API reference.