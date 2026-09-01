# Configuration

Bascik is **completely zero configuration** by default. You do not need a config file of any kind to start building. Running `bascik` or `bascik --build` works immediately right out of the box, resolving components, scoping CSS and JS, minifying files, and managing routing using sensible, production ready defaults.

However, Bascik is also **highly configurable** for both development and production. Rather than forcing a single architectural opinion on your project, Bascik is designed to put control directly in your hands. Whenever a technical choice involves trade-offs, Bascik exposes fine-grained preferences so you can tailor the build pipeline to your exact workflow.

To override any default behaviors, create a `bascik.config.ts` file in your project root. Import `defineConfig` for full autocomplete and type checking on every option. Your editor will surface valid values, flag typos, and show inline docs as you type. A plain `bascik.config.js` also works and takes precedence if both files exist.

## Config File Discovery

Bascik looks for its config in the project root only, in this order:

1. `--config <path>` (or `--config=<path>`): load a specific file. An explicitly passed path that does not exist is an error, mirroring the `--env-file` behavior.
2. `bascik.config.js`
3. `bascik.config.ts`

When both files exist, `bascik.config.js` wins. This is deliberate because many JavaScript-first projects keep a `.js` config alongside TypeScript files. If your `.ts` file appears to be ignored, check for a stray `.js` file next to it.

Only these two filenames are supported: no `.mjs`, `.cjs`, `.mts`, or `.cts` variants, no `config/` subdirectory, and no parent-directory search.

TypeScript configs work through Node's native type stripping, which supports erasable syntax only (type annotations, interfaces, `import type`). Non-erasable constructs such as `enum` or constructor parameter properties fail at load time with a Node error. Keep the config file to plain JavaScript plus type annotations.

## Configuration Validation

Bascik validates your configuration at startup, before anything reads it. Every problem is reported together in one aggregated error rather than one fix at a time. Each entry names the key, the received value, and what was expected:

```text
Configuration errors in bascik.config.ts

  http.port                70000
                           expected an integer between 1 and 65535

  minify.js                "esbuild"
                           expected true, false, or a function

  scripts.onBuildScriptErr unknown key
                           did you mean "scripts.onBuildScriptError"?

  pipeline.exec[0].script  scripts/gen-data.ts
                           file does not exist

4 configuration errors
```

Unknown keys are rejected with a "did you mean" suggestion when there is a near miss, so a typo like `minfy:` or `directroy:` fails loudly instead of being silently ignored. Referenced paths (`directory.pages`, `pipeline.watchPaths`, `pipeline.exec[].script`, `assets.inlineStyles`, and TLS key/cert files when TLS is enabled) are checked for existence at startup. The `base` option is normalized to a leading and trailing slash, so `docs`, `/docs`, and `/docs/` are all accepted; only a full URL is rejected.

## Minimal Configuration Example (Recommended)

Because Bascik is zero-config, you only need to specify settings that differ from built-in defaults. Keep your `bascik.config.ts` clean and minimal:

```ts
// bascik.config.ts (minimal example)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: { sitemapLastmod: true },
});

// Production build overrides (applied only during `bascik --build` and `bascik --server`)
export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});
```

## Configuration Precedence

Most Bascik settings live in `bascik.config.ts`, but per-deployment values like the site URL come from the environment. The full precedence chain is:

```text
CLI flag  >  real environment variable  >  .env file  >  config file  >  built-in default
```

Most specific and most ephemeral wins. The config file is checked into git and shared by everyone, the environment is per-deployment, and a flag is per-invocation.

The flags that override specific config keys:

| Flag | Env var | Config key |
| --- | --- | --- |
| `--port <n>` | `BASCIK_SERVER_PORT` | `http.port` |
| `--host <name>` | `BASCIK_SERVER_HOST` | `http.hostname` |
| `--log-level <level>` | `BASCIK_LOG_LEVEL` | `logging.level` |

See [Command Line Interface](/cli#cli-reference) for the full flag reference.

This mirrors the tools you already know:

- **Node `--env-file`:** "If the same variable is defined in the environment and in the file, the value from the environment takes precedence." Multiple `--env-file` arguments are allowed, and subsequent files override variables defined in previous files.
- **Node configuration priority:** command-line options and `NODE_OPTIONS` beat dotenv `NODE_OPTIONS`, which beats the configuration file.
- **npm:** CLI flags, then `npm_config_*` env vars, then project `.npmrc`, then user `.npmrc`, then global `.npmrc`, then built-in defaults.
- **dotenv:** `override: false` is the default, so a `.env` file never clobbers a real environment variable.

### The site URL

`siteUrl` is **not a config key**. It is a per-deployment value, and putting it in a checked-in file would force CI to mutate source in order to build for staging. Three sources, in precedence order:

```text
--site-url flag  >  BASCIK_SITE_URL env var  >  .env file
```

```sh
# 1. Per-invocation flag
bascik --build --site-url https://staging.example.com

# 2. Environment variable
BASCIK_SITE_URL=https://example.com bascik --build

# 3. .env file in the project root (loaded automatically when present)
echo 'BASCIK_SITE_URL=https://example.com' >> .env
```

The value must be an absolute `http` or `https` URL; anything else is rejected with an error naming what was received. Bascik loads `./.env` automatically and silently skips it when absent. Pass `--env-file <path>` (repeatable, later files win) to load additional files; a missing explicit file is an error.

## Full Configuration Reference (Built-In Defaults)

You do not need to populate default options in `bascik.config.ts`. The reference below displays all available configuration options populated with their built-in default values for illustrative purposes only.

```ts
// bascik.config.ts (reference showing all default values)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    pages: 'src/pages',
    components: 'src/components',
    out: 'dist',
    api: 'src/api',
  },
  scoping: {
    scriptBlocks: true,
    inheritAttributes: true,
    attributes: {
      class: true,
      id: true,
      name: true,
    },
    preserve: ['code'],
    deduplicateCss: true,
  },
  minify: {
    html: false,        // false in dev; true in --build and --server
    css: false,         // false in dev; true in --build and --server
    js: false,          // false in dev; true in --build and --server
    identifiers: false, // false in dev; true in --build and --server
  },
  assets: {
    inlineStyles: false,
    exclude: [],
  },
  generate: {
    sitemap: true,
    robots: true,
    sitemapLastmod: false,
    cspHashes: false,
    manifest: false,
  },
  pipeline: {
    watchPaths: [],
    exec: [],
    workers: false,
  },
  scripts: {
    cache: { enabled: true },
    onBuildScriptError: 'error',
    onRoutesScriptError: 'error',
    onServerScriptError: 'error',
    timeout: 30000,
  },
  onMinifyError: 'warn', // 'warn' in dev; 'error' in --build and --server
  http: {
    port: undefined,      // auto-selected port
    hostname: 'localhost',// use '0.0.0.0' to bind all interfaces
    tls: {
      enabled: false,     // set true for HTTP/2 HTTPS
    },
    rateLimit: true,
    trustProxy: false,
    cacheControl: 'public, max-age=3600',
    compression: true,
    maxBodySize: 1048576,
    apiTimeout: 10000,
  },
  logging: {
    level: 'info',        // silent | error | warn | info | debug
    requests: true,
    copies: true,
    deletes: true,
    transpiles: true,
  },
  base: '/',
});

export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});
```

## The Power of Preference

Here are just a few ways Bascik puts architectural choices back in your hands:

- **Style Deduplication (`scoping.deduplicateCss`):** Choose between clean, single-definition scoped stylesheets for optimal payload sizes, or individual per-instance styling for seamless local script querying.
- **Custom Minification (`minify`):** Toggle HTML, CSS, and JS minifiers independently. You can even plug in your own custom async minifiers (like esbuild or terser) or configure Node's built-in type stripper for native TypeScript compilation.
- **Granular Attribute Scoping (`scoping.attributes`):** Control exactly which attributes (classes, IDs, or name attributes) are scoped. If you are using Tailwind CSS, you can disable class scoping entirely while keeping ID scoping active.
- **Parallel Builds (`pipeline.workers`):** Optimize build speeds on larger sites by opting into a multi-core CPU worker pool, or stick to main-thread processing for smaller projects.
- **Error Behavior (`scripts`):** Control error handling separately for `onBuildScriptError`, `onRoutesScriptError`, and `onServerScriptError` (`'error'`, `'warn'`, or `'ignore'`).
- **Environment Overrides (`dev`, `build`, `server`):** Easily define mode-specific overrides while keeping development logs detailed and verbose.

## Configuration Reference

### `directory`

Paths to your pages, components, output, and API routes directories, relative to the project root.

```ts
directory: {
  pages: 'src/pages',           // default: HTML routes and publishable assets
  components: 'src/components', // default: component .html and .css templates
  out: 'dist',                  // default: output build directory
  api: 'src/api',               // default: API route handlers directory
}
```

`directory.pages` is the publish tree. Place images, fonts, downloads, standalone browser JavaScript, CSS, and other public assets beside pages or in subdirectories such as `src/pages/assets/`. Eligible files copy to `directory.out` with their relative paths preserved, while CSS and JavaScript are processed by the configured minifiers.

The following built-in exclusions always apply:

- Any dotfile or file inside a dot-directory
- Any file inside `node_modules`
- `.html`, `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.map`, and `.md` files
- Test files matching `*.test.*` or `*.spec.*`
- Stylesheets configured in `assets.inlineStyles`

Files in `directory.components` are source-only and are never copied directly.

### `scoping`

Control component scoping behaviors, attribute scoping, element content preservation, and style deduplication.

```ts
scoping: {
  scriptBlocks: true,      // wrap component <script> tags in IIFEs
  inheritAttributes: true, // merge usage tag attributes onto component root
  attributes: {
    class: true, // scope class attributes
    id: true,    // scope id attributes
    name: true,  // scope name attributes
  },
  preserve: ['code'],      // elements whose inner content is left untouched
  deduplicateCss: true,    // deduplicate component CSS output
}
```

### `scoping.scriptBlocks`

Wrap component `<script>` tags in an IIFE and rewrite scoped attribute references. Set to `false` if you want raw unmodified script output.

### `scoping.inheritAttributes`

Control whether non-`data-bascik-*` attributes on a component usage tag are merged onto the component root element. Defaults to `true`.

### `scoping.attributes`

Control which HTML attribute types are scoped independently. Useful if you're using Tailwind (`class: false`) or don't need name scoping.

### `scoping.deduplicateCss`

When `true` (default), all instances of the same component share the same scoped class names so the compiled `<style>` block is emitted only once per component type, regardless of how many times the component appears on the page.

When `false`, every instance gets its own unique per-instance class names (the same scheme used for `id` scoping). This means a `querySelector('.myClass')` inside a component script will naturally target only elements inside that specific instance, but each instance emits its own `<style>` block.

### `scoping.preserve`

An array of HTML element names whose inner content is left untouched by the scoping pipeline. Attribute values, element-selector class injection, and JS selector rewriting are all skipped for any HTML found *inside* these elements.

Defaults to `['code']`.

### `minify` (BYOMinifier)

Configure minification toggles for HTML, CSS, and JS outputs. All three default to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.

Bascik supports **BYOMinifier (Bring Your Own Minifier)**: both `css` and `js` accept custom async-capable minifier or transformer functions. Plug in PostCSS with Autoprefixer, LightningCSS, esbuild, terser, or Node's built-in TypeScript type stripper:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import { transform } from 'esbuild';

export const build = defineConfig({
  minify: {
    html: true,
    css: async (css) => {
      const result = await postcss([autoprefixer]).process(css, { from: undefined });
      return result.css;
    },
    js: async (code) => {
      const result = await transform(code, { minify: true, loader: 'js' });
      return result.code;
    },
  },
});
```

### `minify.identifiers`

Hash generated class, ID, and name attributes to short alphanumeric strings instead of the verbose `bascik__component__id__name` format. Enabled by default in builds.

### `assets`

Asset pipeline configuration.

```ts
assets: {
  inlineStyles: ['src/css/styles.css'], // global stylesheets to inline into <head>
  exclude: ['drafts/**'],               // default: []; page-relative exclusion globs
}
```

`assets.exclude` patterns match paths relative to `directory.pages` and provide project-specific exclusions. They do not weaken the built-in deny-list, which always applies. Keep tests and source-only helpers outside `directory.pages`. To copy a separate external asset tree, use a `pipeline.exec` script that writes intentionally selected files to `directory.out`.

### `generate`

Control which build artifacts are generated during `bascik --build`.

```ts
generate: {
  sitemap: true,         // write sitemap.xml
  robots: true,          // write robots.txt
  sitemapLastmod: false, // include lastmod timestamps
  cspHashes: false,      // generate CSP hash manifest
  manifest: false,       // write build manifest
}
```

### `pipeline`

Pipeline options for file watching, build scripts execution, and concurrency.

```ts
pipeline: {
  watchPaths: ['scripts/', 'data/'], // extra paths to watch in dev mode
  exec: [                            // lifecycle scripts
    { script: 'scripts/generate-search-index.ts', phase: 'parallel' },
  ],
  workers: false,                    // enable multi-threaded worker pool
}
```

### `scripts`

Script execution configuration and error handling.

```ts
scripts: {
  cache: { enabled: true },     // cache build script output
  onBuildScriptError: 'error',  // 'error' | 'warn' | 'ignore'
  onRoutesScriptError: 'error', // 'error' | 'warn' | 'ignore'
  onServerScriptError: 'error', // 'error' | 'warn' | 'ignore'
  timeout: 30000,               // execution timeout in ms
}
```

### `http`

Configure the HTTP/HTTPS server started by `bascik` and `bascik --server`.

```ts
http: {
  port: 8080,               // HTTP port (default: auto)
  hostname: 'localhost',    // hostname to bind
  tls: {
    enabled: false,         // enable HTTP/2 TLS
    keyFile: undefined,     // path to TLS private key
    certFile: undefined,    // path to TLS certificate
  },
  rateLimit: true,          // per-IP rate limiting
  trustProxy: false,        // trust X-Forwarded-* headers
  cacheControl: 'public, max-age=3600',
  compression: true,
  maxBodySize: 1048576,
  apiTimeout: 10000,
}
```

### `logging`

Log levels and verbosity configuration.

```ts
logging: {
  level: 'info',       // silent | error | warn | info | debug
  requests: true,      // log HTTP requests
  copies: true,        // log asset copies
  deletes: true,       // log asset deletions
  transpiles: true,    // log page transpilation
}
```

## Mode Overrides (`dev`, `build`, `server`)

Exporting `dev`, `build`, or `server` mode configuration objects lets you specify mode-specific overrides that merge on top of `default`:

```ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: { sitemapLastmod: true },
});

export const dev = defineConfig({
  logging: { level: 'debug' },
});

export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});

export const server = defineConfig({
  http: {
    port: 9443,
    tls: { enabled: true },
  },
});
```
