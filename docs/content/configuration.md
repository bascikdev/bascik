# Configuration

Bascik is **completely zero configuration** by default. You do not need a config file of any kind to start building. Running `bascik` or `bascik --build` works immediately right out of the box, resolving components, scoping CSS and JS, applying production minification when building or serving, and managing routing using sensible defaults.

However, Bascik is also **highly configurable** for both development and production. Rather than forcing a single architectural opinion on your project, Bascik is designed to put control directly in your hands. Whenever a technical choice involves trade-offs, Bascik exposes fine-grained preferences so you can tailor the build pipeline to your exact workflow.

To override any default behaviors, create a `bascik.config.ts` file in your project root. Import `defineConfig` for full autocomplete and type checking on every option. Your editor will surface valid values, flag typos, and show inline docs as you type. A plain `bascik.config.js` or `bascik.config.mjs` also works and takes precedence if more than one config file exists.

## Config File Discovery

Bascik looks for its config in the project root only, in this order:

1. `--config <path>` (or `--config=<path>`): load a specific file. An explicitly passed path that does not exist is an error, mirroring the `--env-file` behavior.
2. `bascik.config.js`
3. `bascik.config.mjs`
4. `bascik.config.ts`

Bascik loads the first file it finds and ignores the rest, so a `bascik.config.js` or `bascik.config.mjs` wins over `bascik.config.ts`, and `bascik.config.js` wins over `bascik.config.mjs`. This is deliberate because many JavaScript-first projects keep a `.js` config alongside TypeScript files. If your `.ts` file appears to be ignored, check for a stray `.js` or `.mjs` file next to it. The Bascik language server and VS Code extension read the same names in the same order, so the editor and the CLI agree on which file is the config.

Only these three filenames are discovered: no `.cjs`, `.mts`, or `.cts` variants, no `config/` subdirectory, and no parent-directory search.

Bascik reads the file's `export default` object and the mode exports `dev`, `build` and `server` (see [Mode Overrides](#mode-overrides-dev-build-server)). Each one it finds must be a plain object: `export default () => ({ ... })` or `export const build = "prod"` is an error naming the export, not a config that is quietly ignored. A file whose only exports are names Bascik does not read, such as `export const config = defineConfig({ ... })`, is an error too, and a file that exports nothing prints a warning, since the built-in defaults then apply. Other named exports next to `export default` are fine.

TypeScript configs work through Node's native type stripping, which supports erasable syntax only (type annotations, interfaces, `import type`). Non-erasable constructs such as `enum` or constructor parameter properties fail at load time with a Node error. Keep the config file to plain JavaScript plus type annotations.

### Config Changes Need a Restart

The dev server does not hot-reload configuration. Bascik deep-freezes the resolved configuration at boot so worker threads, routers, and watchers all see the same values, and reloading it in place could leave them out of sync. When you edit a root config file, the dev server keeps its boot configuration and prints:

```text
[bascik] Config file changed: bascik.config.ts. Restart the server to apply configuration changes.
```

The hint watches the three root filenames `bascik.config.js`, `bascik.config.mjs`, and `bascik.config.ts`, plus the file passed with `--config` when there is one (such as `config/site.config.ts`). It watches all three root names whichever one was loaded, so editing an unused root config file prints the hint too. No hint prints during `--build`. Restart the server to apply any config change. If a restart does not help either, see [My config changes have no effect](/testing/troubleshooting#my-config-changes-have-no-effect).

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

  security.blockScriptUrl  unknown key
                           did you mean "security.blockScriptUrls"?

  pipeline.exec[0].script  scripts/gen-data.ts
                           file does not exist

5 configuration errors
```

Unknown keys are rejected with a "did you mean" suggestion when there is a near miss, so a typo like `minfy:`, `directroy:` or `security.blockScriptUrl` fails loudly instead of being silently ignored. Values are checked against their type as well: a setting that takes `true` or `false` rejects the string `"false"`, a section such as `generate` must be an object, and `scripts.cache` and each `pipeline.exec` entry's `watch`, `cwd`, `env`, `args`, and `timeout` must have the documented shape. Referenced paths (`directory.pages`, `pipeline.watchPaths`, `pipeline.exec[].script`, `assets.inlineStyles`, and TLS key/cert files when TLS is enabled) are checked for existence at startup. The `base` option is normalized to a leading and trailing slash, so `docs`, `/docs`, and `/docs/` are all accepted. Use a literal path prefix without a query, fragment, percent escape, backslash, or `.` and `..` segments; full URLs are rejected too.

## Create a Config Only for a Non-Default Requirement

Start without `bascik.config.ts`. Create one only after identifying a concrete requirement that differs from Bascik's built-in behavior. When a config is necessary, include only the non-default setting:

```ts
// bascik.config.ts (minimal example)
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  generate: { sitemapLastmod: true },
});
```

Do not create a config merely to enable production minification. `bascik --build` and `bascik --server` already enable HTML, CSS, JavaScript, and identifier minification.

## Configuration Precedence

Most Bascik settings live in `bascik.config.ts`, but per-deployment values like the site URL come from the environment. The full precedence chain is:

```text
CLI flag  >  real environment variable  >  .env file  >  config file  >  built-in default
```

Most specific and most ephemeral wins. The config file is checked into git and shared by everyone, the environment is per-deployment, and a flag is per-invocation.

The flags that override specific config keys:

| Flag                  | Env var                 | Config key      |
| --------------------- | ----------------------- | --------------- |
| `--port <n>`          | `BASCIK_SERVER_PORT`    | `http.port`     |
| `--host <name>`       | `BASCIK_SERVER_HOST`    | `http.hostname` |
| `--log-level <level>` | `BASCIK_LOG_LEVEL`      | `logging.level` |
| `--quiet`, `-q`       | `BASCIK_LOG_LEVEL=warn` | `logging.level` |

Each channel gets the config key's rule. `--port` and `BASCIK_SERVER_PORT` take whole digits from 1 to 65535: a bad `--port` is an error, and a bad `BASCIK_SERVER_PORT` such as `8080abc` is ignored with a warning, so the configured port applies instead of part of the value. `--host` and `BASCIK_SERVER_HOST` take a hostname like `localhost` or `0.0.0.0`, as `http.hostname` does: a URL such as `http://0.0.0.0` or a `host:port/path` is an error naming the flag or variable.

One setting has a flag and an environment variable but no config key: `--no-pin`, or `BASCIK_PIN_SERVER_URL=0`, turns off [pinning the server address](/developer-experience#what-you-see-in-the-terminal). It describes your own terminal, and the config file is shared by everyone on the project.

One setting has an environment variable only: `BASCIK_MAX_CHILD_PROCESSES=<n>` caps how many build-script child processes (`data-bascik-build` and `data-bascik-routes`) run at once. By default the cap comes from the CPU count and the memory available on the machine, and with `pipeline.workers` on it is shared across the page worker threads. Set it when that estimate is wrong for a particular machine or CI runner. It describes the machine the build runs on, not the project, which is why it has no config key.

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
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  directory: {
    pages: "src/pages",
    components: "src/components",
    out: "dist",
    api: "src/api",
  },
  components: {
    external: [],
    expansionLimits: {
      maxInstances: 10000, // component instances on one page
      maxPageLength: 52428800, // characters in one expanded page (50 Mi)
    },
  },
  scoping: {
    scriptBlocks: true,
    inheritAttributes: true,
    attributes: {
      class: true,
      id: true,
      name: false,
    },
    preserve: ["code"],
    deduplicateCss: true,
  },
  minify: {
    html: false, // false in dev; true in --build and --server
    css: false, // false in dev; true in --build and --server
    js: false, // false in dev; true in --build and --server
    identifiers: false, // false in dev; true in --build and --server
  },
  assets: {
    inlineStyles: false,
    exclude: [],
    symlink: false, // set true to link unchanged static assets in development
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
    onExecError: "warn", // 'warn' in dev; 'error' in --build
  },
  scripts: {
    cache: { enabled: true },
    typescript: true, // Node's strip-only mode; false or a compiler function
    onBuildScriptError: "error",
    onRoutesScriptError: "error",
    onServerScriptError: "error",
    timeout: 30000,
    importRoot: "src",
    stripAnsi: true, // remove terminal color codes from server and stream output
    renderLimits: {
      maxInstances: 1000,
      maxOutputLength: 4194304, // 4 Mi characters
      maxNestedScripts: 64,
      maxDepth: 4,
      rescanFactor: 16,
      rescanBase: 33554432, // 32 Mi characters
    },
  },
  onMinifyError: "warn", // 'warn' in dev; 'error' in --build and --server
  http: {
    httpCache: false, // false in dev; true in --server (ETag, 304 and cacheControl)
    port: undefined, // auto-selected port
    hostname: "localhost", // use '0.0.0.0' to bind all interfaces
    tls: {
      enabled: false, // set true for HTTP/2 HTTPS
    },
    rateLimit: true,
    trustProxy: false,
    cacheControl: "public, max-age=3600", // string or per-extension map: { '.woff2': 'public, max-age=31536000, immutable' }
    compression: true,
    precompress: false, // emit verified .br/.gz sidecars at build time
    timeouts: { request: 30000, headers: 10000, keepAlive: 5000, drain: 5000 },
    maxBodySize: 1048576,
    apiTimeout: 10000,
  },
  logging: {
    level: "info", // silent | error | warn | info | debug
    requests: true,
    copies: true,
    deletes: true,
    transpiles: true,
  },
  base: "/",
  contentSecurityPolicy: undefined, // no header until you set it
  security: {
    blockScriptUrls: true,
    blockCodeBindings: true,
    headers: true,
    hsts: true, // max-age=31536000, over HTTPS only
    privateDynamicPages: true,
    stripDirectiveScripts: true,
    hideDotfiles: true,
  },
});
```

## The Power of Preference

Here are just a few ways Bascik puts architectural choices back in your hands:

- **Style Deduplication (`scoping.deduplicateCss`):** Choose between clean, single-definition scoped stylesheets for optimal payload sizes, or individual per-instance styling for seamless local script querying.
- **Custom Minification (`minify`):** Toggle HTML, CSS, and JS minifiers independently, or plug in your own custom async minifiers (like esbuild or terser). TypeScript in referenced `.ts` companions and `type="text/typescript"` blocks is stripped automatically before minification, so no minifier configuration is needed for it.
- **Granular Attribute Scoping (`scoping.attributes`):** Control exactly which attributes (classes, IDs, or name attributes) are scoped. If you are using Tailwind CSS, you can disable class scoping entirely while keeping ID scoping active.
- **Exec Failure Behavior (`pipeline.onExecError`):** Choose whether a failing `pipeline.exec` script stops the run (`'error'`) or is reported while it continues (`'warn'`). Defaults to `'warn'` in dev and `'error'` for `--build`.
- **Parallel Builds (`pipeline.workers`):** Optimize build speeds on larger sites by opting into a multi-core CPU worker pool, or stick to main-thread processing for smaller projects. Defaults to `false` to avoid worker startup overhead on small sites; in dev mode, Bascik advises enabling it when single-threaded transpilation of at least 20 page jobs takes 2.0s or longer on 4+ CPU cores.
- **Error Behavior (`scripts`):** Control error handling separately for `onBuildScriptError`, `onRoutesScriptError`, and `onServerScriptError` (`'error'`, `'warn'`, or `'ignore'`).
- **Environment Overrides (`dev`, `build`, `server`):** Easily define mode-specific overrides while keeping development logs detailed and verbose.

## Configuration Reference

### `base`

Set the URL path where the built site will be mounted. The default `/` is a complete no-op and produces byte-identical output to a build without base-path handling.

```ts
base: '/docs/',
```

Bascik normalizes `docs`, `/docs`, and `/docs/` to `/docs/`. Nested paths such as `/products/docs` normalize to `/products/docs/`. An empty value is treated as `/`, while full URLs such as `https://example.com/docs` are rejected. Use `BASCIK_SITE_URL` for the origin instead.

For a non-root base, the build rewrites root-relative URLs in HTML URL attributes, `srcset`, inline and hoisted CSS, copied stylesheets, and web app manifest URL fields. Absolute URLs, protocol-relative URLs, other schemes, fragments, and already-relative paths remain unchanged. Serving the resulting site under this prefix is described in [Deployment Overview](/deployment).

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

`directory.components` accepts one directory or an array of directories. Every listed root is scanned recursively for components, watched in dev mode, and known to `bascik --check`. Roots may point outside the project root, which is how several sites in one repository share a components directory:

```ts
directory: {
  components: ['../../shared/components', 'src/components'],
}
```

Rules that apply across all roots:

- **Names are unique across all roots.** A component's tag comes from its filename, so two roots (or two subfolders) that both contain `hero.html` fail the build with the same collision error, listing every path. Rename one, for example `marketing-hero.html`.
- **`bascik add` targets the first listed root** and prints where the files landed. A team can keep vendored components separate from hand-written ones by listing a dedicated root first, for example `['src/vendor-components', 'src/components']`.
- **Roots may not be nested inside one another.** `['src/components', 'src/components/shared']` is rejected at startup because the parent already includes the child.
- **Duplicate roots are detected by real path**, so a symlink to an already-listed directory is rejected, not scanned twice.
- **A listed root must exist.** A missing root fails the build and `bascik --check` with a message that names it, since a missing root is usually a typo. Only the default, `src/components`, may be absent: the project then has no components.
- **Symlinks inside a root are followed.** A symlinked directory or file under a components root is discovered and watched like any other; a dangling link or a link cycle prints one warning and is skipped.

`directory.out` is emptied at the start of every build and dev session, so it must be a folder of its own inside the project. A value that is the project root, resolves outside it, or holds a source folder (`directory.pages`, a `directory.components` root, `directory.api`, or `scripts.importRoot`) is a config error that names the folder it would delete, and so is an output directory inside the pages, components, or API folder, where the build output would be read back as source. `out: "src"` with the default layout is rejected before anything is deleted; `out: "build"` or `out: "src/dist"` is fine.

`directory.pages` is the publish tree. Place images, fonts, downloads, standalone browser JavaScript, CSS, and other public assets beside pages or in subdirectories such as `src/pages/assets/`. Eligible files copy to `directory.out` with their relative paths preserved, while CSS and JavaScript are processed by the configured minifiers. In development, `assets.symlink: true` can link unchanged assets instead.

The following built-in exclusions always apply:

- Any dotfile or file inside a dot-directory, except a top-level `.well-known/` (turn this off with [`security.hideDotfiles`](#security))
- Any file inside `node_modules`
- `.html`, `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.map`, and `.md` files
- Test files matching `*.test.*` or `*.spec.*`
- Stylesheets configured in `assets.inlineStyles`

Files in `directory.components` are source-only and are never copied directly.

### `components`

```ts
components: {
  external: [], // hyphenated tags owned by a custom element or library, not a Bascik component
  expansionLimits: { maxInstances: 10000, maxPageLength: 52428800 },
}
```

### `components.external`

An array of hyphenated tag names that belong to a browser custom element or a third-party library rather than a file in `directory.components`. Entries are exact tag names or `*` wildcard patterns, matched case-insensitively with the same rules as [`scoping.preserve`](#scopingpreserve).

```ts
export default defineConfig({
  components: {
    external: ["heading-anchors", "model-viewer", "vendor-*"],
  },
});
```

By default, any hyphenated tag with no component file prints `Unresolved component tag` during every transpile and appears under "Components with no matching file" in `bascik --check`. Declaring a tag here removes it from both. Typos such as `<my-crd>` are still reported, so keep the list to tags you own on purpose.

This option changes diagnostics only. A declared tag is passed to the browser unchanged. If a real component file has the same name, the component still expands. It does not stop `id`, `name`, or `class` scoping inside the element; use [`scoping.preserve`](#scopingpreserve) for that. The two options are independent, and most external elements need only `components.external`.

### `components.expansionLimits`

A runaway guard for component expansion when pages are built and compiled in dev. A component that contains its own tag, directly or through another component, would otherwise expand forever. Reaching either limit stops that page with an error that names this setting.

| Key             | Default            | What it bounds                            |
| --------------- | ------------------ | ----------------------------------------- |
| `maxInstances`  | `10000`            | Component instances expanded on one page. |
| `maxPageLength` | `52428800` (50 Mi) | Characters in one page's expanded HTML.   |

Both are positive whole numbers. A page that really has more than 10,000 component instances can raise `maxInstances`; a recursive component should be fixed instead. Partial objects keep the other default. This setting applies when pages are built, so set it in the default or `build` export; in the `server` export it has no effect and Bascik warns.

```ts
components: {
  expansionLimits: { maxInstances: 20000 },
}
```

### `scoping`

Control component scoping behaviors, attribute scoping, element content preservation, and style deduplication.

```ts
scoping: {
  scriptBlocks: true,      // wrap component <script> tags in IIFEs
  inheritAttributes: true, // merge usage tag attributes onto component root
  attributes: {
    class: true, // scope class attributes
    id: true,    // scope id attributes
    name: false, // name ships as written; true scopes it per instance
  },
  preserve: ['code'],      // elements and subtrees left unscoped
  deduplicateCss: true,    // deduplicate component CSS output
}
```

### `scoping.scriptBlocks`

Wrap component `<script>` tags in an IIFE and rewrite scoped attribute references. Set to `false` if you want raw unmodified script output.

### `scoping.inheritAttributes`

Control whether non-`data-bascik-*` attributes on a component usage tag are merged onto the component root element. Defaults to `true`.

### `scoping.attributes`

Control which HTML attribute types are scoped independently. Useful if you're using Tailwind (`class: false`).

### `scoping.attributes.name`

Defaults to `false`: every `name` attribute ships as written, on every element, at build time and at request time, on Node and on the Cloudflare Worker. A `name` is a contract with the rest of the page, not a private identifier: it is the key a form field is submitted under, the group of a set of radios or an exclusive `<details>` accordion, the target of a link or form for an `<iframe>`, and the map an `<img usemap>` uses. See [Component Best Practices](/component-best-practices#name-form-controls-and-groups).

Set it to `true` to scope `name` per component instance, which was the default before. Every `name` except `<meta name>` is then rewritten to `bascik__<component>__<instance>__<name>`, `usemap="#x"` follows a `<map name="x">` in the same component, `getElementsByName("x")` in a component script is rewritten to match, and `data-bascik-preserve="name"` keeps one element or subtree literal. Turn it on only when a site has many components that each hold a whole radio group or accordion and you would rather opt the few page-wide names out than give each component its own `<form>` or a name prop. Field names a server reads then need `data-bascik-preserve="name"`, and a `data-bascik-attr-name` or `data-bascik-attr-usemap` binding is then left for the build to render, so a component with one is not rendered at request time (`attr-binding-to-scoped-attribute`).

```ts
export default defineConfig({
  scoping: { attributes: { name: true } },
});
```

### `scoping.deduplicateCss`

When `true` (default), all instances of the same component share the same scoped class names so the compiled `<style>` block is emitted only once per component type, regardless of how many times the component appears on the page.

When `false`, every instance gets its own unique per-instance class names (the same scheme used for `id` scoping). This means a `querySelector('.myClass')` inside a component script will naturally target only elements inside that specific instance, but each instance emits its own `<style>` block.

### `scoping.preserve`

An array of HTML element names whose `id`, `name`, and `class` attributes, contents, and descendants are left untouched by the scoping pipeline.

Defaults to `['code']`.

Entries can be exact tag names or wildcard patterns. A `*` matches any run of tag-name characters, so `preserve: ['vendor-*']` preserves every tag whose name starts with `vendor-`, `['*-widget']` matches a suffix, and `['*']` preserves every tag. Wildcards use the exact same semantics as exact names.

```ts
export default defineConfig({
  scoping: {
    preserve: ["code", "vendor-*"],
  },
});
```

Multiple tags are safe to preserve together. For example, `preserve: ['pre', 'code']` keeps each element's own content intact even when inline component styles trigger overlapping compiler passes.

For one element rather than every matching tag, use `data-bascik-preserve` or a space-separated subset such as `data-bascik-preserve="name"`. Preserve scopes inherit through descendants and nesting only widens. Preserving an `id` also stops Bascik from rewriting references inside the preserved region, so a link and its target must be both preserved or both scoped. Preserve does not silence unresolved-tag warnings; use [`components.external`](#componentsexternal) for that. See [Preserve Scoping](/preserve).

### `minify` (BYOMinifier)

Configure minification toggles for HTML, CSS, and JS outputs. All three default to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.

`minify: true` or `minify: false` sets all four (`html`, `css`, `js`, `identifiers`) at once. It is shorthand for that object, so a mode export can refine it: `export default { minify: false }` with `export const build = { minify: { identifiers: true } }` builds with only identifier minification on.

`minify.html: false` disables HTML minification for both page templates and component templates. Component whitespace and script placement remain as authored when it is off.

Bascik supports **BYOMinifier (Bring Your Own Minifier)**: both `css` and `js` accept custom async-capable minifier or transformer functions. Plug in PostCSS with Autoprefixer, LightningCSS, esbuild, or terser. A `minify.js` function always receives valid JavaScript: browser TypeScript on the supported paths (`.ts` companions, `type="text/typescript"` blocks) is stripped before this hook runs, and Bascik holds back its `//# sourceURL` directive and re-attaches it on its own line after the function returns.

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";
import autoprefixer from "autoprefixer";
import postcss from "postcss";
import { transform } from "esbuild";

export const build = defineConfig({
  minify: {
    css: async (css) => {
      const result = await postcss([autoprefixer]).process(css, {
        from: undefined,
      });
      return result.css;
    },
    js: async (code) => {
      const result = await transform(code, { minify: true, loader: "js" });
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
  symlink: false,                       // link unchanged page assets in development
}
```

`assets.exclude` patterns match paths relative to `directory.pages` and provide project-specific exclusions. They do not weaken the built-in deny-list, which always applies. Keep tests and source-only helpers outside `directory.pages`. To copy a separate external asset tree, use a `pipeline.exec` script that writes intentionally selected files to `directory.out`.

Set `assets.symlink` to `true` to use relative links for unchanged development assets, including images, SVGs, PDFs, fonts, media, JSON, and XML. Bascik still copies assets it transforms, such as minified CSS or JavaScript and rewritten web manifests. Every production build, including a targeted `--only` build, writes regular files. If Windows denies symlink creation, Bascik warns once and falls back to copying.

### `generate`

Control which build artifacts are generated during `bascik --build`.

```ts
generate: {
  sitemap: true,         // write sitemap.xml
  robots: true,          // write robots.txt
  sitemapLastmod: false, // include lastmod timestamps
  cspHashes: false,      // generate CSP hash manifest (contentSecurityPolicy turns it on)
  manifest: false,       // write .bascik/dist/manifest.json build manifest
}
```

When `generate.manifest` is enabled (default `false`), Bascik records every emitted file in `directory.out` and writes `.bascik/dist/manifest.json`. The manifest contains the Bascik version and an inventory of all emitted files with forward-slash output-relative paths, SHA-256 content hashes, and byte sizes, sorted byte-wise by path. The manifest lists the files in `dist/`, what a deploy publishes; it lives in the private build folder beside `dist/`, so it is never deployed or served (see [What is the `.bascik/` folder?](/faq#what-is-the-bascik-folder)).

### `pipeline`

Pipeline options for file watching, build scripts execution, and concurrency.

```ts
pipeline: {
  watchPaths: ['scripts/', 'data/'], // extra paths to watch in dev mode
  exec: [                            // lifecycle scripts
    {
      script: 'scripts/generate-search-index.ts',
      phase: 'parallel',             // 'pre' | 'post' | 'parallel'
      cwd: '.',                      // working directory
      args: ['--full'],              // argv passed to the script
      env: { CUSTOM: '1' },          // extra env variables
      timeout: 60000,                // timeout in ms
      watch: ['content/'],           // re-run on changes in dev mode
    },
  ],
  workers: false,                    // enable multi-threaded worker pool (defaults to false; dev advises true on large multi-core workloads)
  onExecError: 'warn',               // 'warn' | 'error'. Default: 'warn' in dev, 'error' for --build
}
```

`pipeline.onExecError` sets what a failing exec script does. With `'error'`, a build stops and exits 1 and a dev session exits 1. With `'warn'`, the failure is reported and the run continues. The default is `'warn'` for the dev server (a typo in a script should not end your session) and `'error'` for `--build` (a failed script must not produce a build that looks successful). See [When a script fails](/exec-scripts#when-a-script-fails).

`pipeline.exec[].watch` selects scripts after matching source edits. Pages, components, `pipeline.watchPaths`, and exec inputs share one phase-ordered rebuild when exec watches are configured: pre completes before compilation, parallel starts alongside it, and post starts after compilation and disk writes finish. Only matching scripts rerun; exec-only inputs can rebuild associated pages without duplicate `pipeline.watchPaths`. Completion never starts another compile. Write generated artifacts only to `dist/`, never sources or watched paths, and never watch generated outputs. There is no `outputs` option. Build helpers under `scripts.importRoot` and external `assets.inlineStyles` need a source watch. See [Exec Scripts](/exec-scripts).

### `scripts`

Script execution configuration and error handling.

```ts
scripts: {
  cache: {
    enabled: true,
    include: ['src/pages/**'],  // optional project-root-relative globs
    exclude: ['src/pages/live/**'],
  },
  typescript: true,             // browser TS compiler: true | false | function
  onBuildScriptError: 'error',  // 'error' | 'warn' | 'ignore'
  onRoutesScriptError: 'error', // 'error' | 'warn' | 'ignore'
  onServerScriptError: 'error', // 'error' | 'warn' | 'ignore'
  timeout: 30000,               // execution timeout in ms
  importRoot: 'src',            // directory that @/ resolves against
  stripAnsi: true,              // remove terminal color codes from script output
  renderLimits: { maxInstances: 1000 }, // request-time render limits (see below)
}
```

`scripts.cache.include` and `scripts.cache.exclude` are matched against project-root-relative script source paths. For example, `src/pages/live/**` excludes scripts in that directory whether the compiler supplies a relative or absolute source path. A `**/src/pages/live/**` pattern remains supported for projects that already use that form.

### `scripts.typescript`

Selects the compiler for TypeScript in scripts: a component's `.ts`/`.mts` companion, a page's own `<script src="name.ts">`, an inline `<script type="text/typescript">`, and a build, routes, server, or stream script whose `src=` names a `.ts`/`.mts` file or whose tag is marked `type="text/typescript"`. Browser scripts are compiled before scoping and before `minify.js`, in dev and build alike, on the main thread and in worker threads.

- `true` (default): Node's built-in strip-only mode (Node 22.22+). Erasable syntax only; line structure is preserved so `//# sourceURL` line numbers match the source. No dependencies.
- `false`: Bascik does not transform browser TypeScript. Marked blocks, `.ts` companions, and a page's `<script src="name.ts">` are emitted exactly as authored, `type` attribute included. Use this when another tool has already compiled the output that Bascik reads. Build, routes, server, and stream scripts written in TypeScript are still stripped, since nothing else compiles them before they run.
- A function `(code, { sourcePath, kind, runtime }) => string | Promise<string>`: bring your own compiler. `kind` is `'companion'` (then `sourcePath` is the `.ts` file) or `'inline'` (then `sourcePath` is the `.html` file containing the block). `runtime` is `'browser'` for a browser script and `'server'` for a build, routes, server, or stream script, which runs as an ES module: keep its `import` and `export`. The function must return plain JavaScript; a throw or non-JavaScript result fails the build with the source path. Use this for non-erasable syntax (`enum`, parameter properties, decorators), for downleveling to an older browser target, or to run the same compiler you use elsewhere.

A server or stream script's `src=` `.ts` module is imported by Node, which strips its types itself, unless this option is a function: then its compiled text runs in its place. API route files and the modules a script imports are always loaded by Node directly; pass Node flags such as `--experimental-transform-types` through `NODE_OPTIONS` if those files need more than erasable syntax. The Cloudflare adapter bundles server and stream scripts with esbuild, which compiles a `.ts` module by its extension. The unmarked-`<script>` TypeScript diagnostic is independent of this setting and always runs.

Regardless of which compiler runs, if the resulting JavaScript still contains a static `import`/`export` declaration and the target `<script>` tag isn't `type="module"`, the build fails fast rather than emitting a classic-script IIFE that would throw a SyntaxError in the browser. Mark the tag `type="module"`, or have your compiler (or a bundler step beforehand) resolve the module graph so no `import`/`export` remains. See [TypeScript in Component Scripts](/scoped-javascript#typescript-in-component-scripts). A `type="module"` `.ts` script whose output still imports a relative, `@/`, or `.ts` path fails the build too, since Bascik inlines it without bundling; a bundling compiler such as esbuild with `bundle: true` clears it.

The demo below sets esbuild as the compiler, so a page can use an `enum`, which Node's strip-only mode rejects. Install esbuild in the project first (`npm install --save-dev esbuild`).

<!-- demo:ts-config-esbuild -->

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";
import { transform } from "esbuild";

export default defineConfig({
  scripts: {
    typescript: async (code, { sourcePath }) => {
      const result = await transform(code, {
        loader: "ts",
        target: "es2020",
        sourcefile: sourcePath,
      });
      return result.code;
    },
  },
});
```

<!-- demo:ts-config-usage -->

```html
<!-- src/pages/sizes.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Sizes</title>
  </head>
  <body>
    <output id="size"></output>
    <script type="text/typescript">
      enum Size {
        Small = "S",
        Medium = "M",
      }
      const output = document.getElementById("size") as HTMLOutputElement;
      output.value = Size.Medium;
    </script>
  </body>
</html>
```

The Output is the page's `<body>` from `bascik --build` with this config and minification off: esbuild turned the `enum` into plain JavaScript. There is no Preview because this docs site uses the default compiler, which rejects an `enum`.

<!-- demo:ts-config-output-html -->

```html
<output id="size"></output>
<script>
  var Size = /* @__PURE__ */ ((Size2) => {
    Size2["Small"] = "S";
    Size2["Medium"] = "M";
    return Size2;
  })(Size || {});
  const output = document.getElementById("size");
  output.value = "M"; /* Medium */
</script>
```

### `scripts.onServerScriptError`

Controls error handling for both `data-bascik-server` and `data-bascik-stream` scripts (`'error'`, `'warn'`, or `'ignore'`).

- For a `data-bascik-server` script under `'error'`, execution halts and the server responds with an HTTP 500. Under `'warn'`, the error is logged to stderr and the tag is replaced with an empty string. Under `'ignore'`, the tag is replaced with an empty string silently.
- For a `data-bascik-stream` script, response headers are already committed before stream output begins, so `'error'` cannot produce an HTTP 500. Instead, it logs the error to stderr and shows the dev overlay during development, emits an empty string for the script slot, and completes the document stream. Under `'warn'`, it logs to stderr without the dev overlay. Under `'ignore'`, the slot emits an empty string silently.

### `scripts.importRoot`

The directory that `@/` import specifiers (and `src="…"` values) resolve against inside `data-bascik-build`, `data-bascik-server`, and `data-bascik-routes` scripts. A bare leading `/` is not an alias and is rejected with an error that points at `@/` or `./`. Default `'src'`, relative to the project root. With the default, `import { x } from '@/lib/x.ts'` means `src/lib/x.ts` from any page or component, so you can paste the same import into any file regardless of its nesting depth. See [Script Imports](/script-imports#import-root-aliases) for the alias rules.

Pages, components, and the import root are **three independent directories**. Bascik never derives one from another and none of them need to share a parent, which is what makes a monorepo layout work:

```ts
// sites/marketing/bascik.config.ts: one repo, several sites, shared code
export default defineConfig({
  directory: { components: ["../../shared/components", "src/components"] },
  scripts: { importRoot: "../../shared/scripts" },
});
```

Unlike `directory.out`, the import root is read-only, so a value that resolves outside the project root is accepted. It must be a non-empty string; if the directory does not exist Bascik prints a warning at startup rather than an error, because a project with no shared helpers is valid. The import root directory is watched automatically in dev mode with `directory.pages` and `directory.components` excluded when nested inside it. See [Monorepos](/how-to/monorepos).

### `scripts.stripAnsi`

Default `true`. Removes ANSI terminal color codes (`\u001b[31m` and the like) from what server, stream and component scripts return, before it reaches the page. A library that colors its output for a terminal would otherwise put invisible control characters in your HTML. This is tidy-up, not a security protection, so it lives here and not under `security`. Set it to `false` to send the output exactly as the script returned it. It does not change what scripts log to the terminal, and build script output is never changed by it.

### `scripts.renderLimits`

Limits on what one server or stream script's output may render when it returns component tags (see [Returning component tags](/server-scripts#returning-component-tags)). They stop a runaway or hostile output, such as unescaped visitor text full of tags, from tying up the server. Past a limit, the script fails with a message that names the setting and the configured number, and the failure follows `scripts.onServerScriptError` like a script that throws.

| Key                | Default            | What it bounds                                                                                          |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `maxInstances`     | `1000`             | Component instances one script output may expand to.                                                    |
| `maxOutputLength`  | `4194304` (4 Mi)   | Characters in one script output that has component tags, before and after rendering.                    |
| `maxNestedScripts` | `64`               | Component scripts one response may run for the components its scripts return.                           |
| `maxDepth`         | `4`                | Levels of a script returning a component whose script returns a component.                              |
| `rescanFactor`     | `16`               | Characters the renderer may read again per character of output (for tags left unclosed or nested deep). |
| `rescanBase`       | `33554432` (32 Mi) | Characters the renderer may read again on top of `rescanFactor` times the output's length.              |

Each is a positive whole number, and a partial object keeps the other defaults. These are server settings, so the `server` export can set them for `bascik --server`; the dev server reads the default and `dev` exports. The Cloudflare Worker has no config of its own and uses the values from the build. Raise a limit only for output you expect; paginating a long list is usually the better fix.

```ts
export const server = defineConfig({
  scripts: { renderLimits: { maxInstances: 2000 } },
});
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
  rateLimit: true,          // boolean or { window?: number, max?: number } (default: 500 req / 10s)
  trustProxy: false,        // trust X-Forwarded-For, X-Forwarded-Proto, and X-Forwarded-Host behind reverse proxy/CDN
  cacheControl: 'public, max-age=3600',
  compression: true,
  precompress: false,       // emit .br/.gz sidecars with .bmeta provenance at build time
  timeouts: {
    request: 30000,         // time to receive a whole request, body included (ms)
    headers: 10000,         // time to receive a request's headers (ms); at most request
    keepAlive: 5000,        // how long an idle connection waits for its next request (ms)
    drain: 5000,            // graceful shutdown drain window (ms)
  },
  maxBodySize: 1048576,     // maximum API request body size in bytes (1 MB default)
  apiTimeout: 10000,        // maximum execution time for API route handlers in ms (10s default)
}
```

`timeouts` bounds how long a client may take, so a slow or stalled client cannot hold a connection open. Each value is a positive whole number of milliseconds (`drain` may be any positive number), and a partial object keeps the other defaults. The dev server and `bascik --server` both apply them.

- `request` is the time to receive the whole request, headers and body, measured from its first byte. A client still sending when it passes gets `408 Request Timeout` and the connection closes. It covers receiving the request only: once the request is in, a response may take as long as it needs, so streaming responses, stream scripts and the dev server's live-reload events are never cut off by it. Raise it if you raise `maxBodySize` for uploads from slow connections: at the defaults, a 1 MB body has 30 seconds to arrive.
- `headers` is the time to receive the request line and headers, which stops a client that opens a connection and then trickles its headers (slowloris). It must not be more than `request`, because the headers are part of the request. Left unset, it is 10000 or `request`, whichever is lower, so lowering only `request` works. A config that sets `headers` higher than `request` fails at startup with an error naming both values, for each of the dev server and `bascik --server` that would run with that pair.
- `keepAlive` is how long a connection waits, idle between responses, for its next request before the server closes it. It never applies while a response is being sent.
- `drain` is how long in-flight requests get to finish on shutdown (see [Production Server](/production-server)).

`maxBodySize` is a whole number of bytes; a request body over it gets `413 Payload Too Large`, and `0` turns the limit off. `apiTimeout` is a number of milliseconds up to 2147483647, the longest delay a timer can wait; `0` turns it off. `httpCache` is `true` or `false`. Any other value, such as `maxBodySize: "1mb"`, is a config error, so a typo can never leave API routes without a body limit.

With `tls.enabled`, `request` and `headers` apply to clients that negotiate HTTP/1.1. HTTP/2 has no per-request equivalent in Node, so for an HTTP/2 connection only `keepAlive` applies: once it has had no open request for that long, the server closes it with a `GOAWAY` and the browser opens a new one for its next request. A request still open, such as a live-reload event stream, keeps the connection open however quiet it is.

`cacheControl` sets the `Cache-Control` header on static files when `httpCache` is on (the default under `bascik --server`). A string applies to every file; an object maps a file extension, with or without the dot, to its value, and files whose extension is not listed get `public, max-age=3600`. Keys match regardless of letter case, so `".PNG"` applies to `photo.png`; when two keys differ only in case, the one in the extension's exact case wins. Each key is one extension such as `".css"`: a glob like `"*.css"` or a path would never match, so it is a config error.

```ts
http: {
  cacheControl: {
    ".woff2": "public, max-age=31536000, immutable",
    ".png": "public, max-age=86400",
  },
}
```

`compression` negotiates Brotli or gzip on demand for compressible static assets up to 2 MiB. `precompress` is a build-time option: when `true`, `bascik --build` writes `<asset>.br`, `<asset>.gz`, and matching `.bmeta` provenance files next to each compressible asset of at least 512 bytes, so `bascik --server` serves them without compressing on demand. It is off by default because it adds two max-quality codec passes per asset to the build and roughly doubles the on-disk size of compressible assets. Both options must be booleans.

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

At `info`, the default, Bascik prints a line for each page it transpiles, each asset it copies, links, or deletes, each request the server answers, each exec script that starts and finishes, and each file it generates, such as `sitemap.xml`. At `warn`, which is what `bascik --quiet` selects, those lines are hidden and only warnings and errors remain. Most people who want less output want this, and it is the one setting you can flip for a single run without editing the config.

A few lines print at every level, because they say the work is done and where to find it: `✓ N pages transpiled in 18ms`, `✓ Build complete` or `✓ All tasks completed`, and `Server running at`. The notice printed when you press `Ctrl+C` does too. Output from your own scripts is also never filtered, because it is not Bascik's to hide. A quiet dev server therefore prints those lines at boot, says nothing while you edit, and speaks again only for a warning, an error, or shutdown.

```sh
bascik --quiet                      # dev server, boot summary only
bascik --build -q                   # build, summary only
BASCIK_LOG_LEVEL=warn bascik        # the same, from the environment
```

Use `requests`, `copies`, `deletes`, and `transpiles` to keep one kind of line while hiding another. For example, `export const server = { logging: { requests: false } }` quiets a deployed server's access log without touching any start script.

### `contentSecurityPolicy`

Opt in to a Content-Security-Policy header on every HTML response. Unset (the default), no header is sent.

```ts
contentSecurityPolicy: {
  directives: {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://cdn.example.com"],
  },
  hashes: true,      // append each route's inline script and style hashes (default)
                     // { scripts: true, styles: false } hashes scripts only
  reportOnly: false, // true sends Content-Security-Policy-Report-Only
}
```

`directives` maps each directive to its sources, written as in a header, with keywords such as `'self'` and `'none'` in single quotes. With `hashes` on, Bascik appends each route's inline script hashes to `script-src` and style hashes to `style-src` from `.bascik/dist/csp-hashes.json`, so setting the option turns on `generate.cspHashes`. A directive you wrote is only extended (a lone `'none'` is replaced by the hashes), and `script-src-elem` and `style-src-elem` get the hashes too when you write them. A missing `script-src` or `style-src` is created from your `default-src` sources plus the hashes, so `default-src 'none'` yields a directive with only the hashes; with no `default-src` either, none is created. Bascik never adds a source you did not write. `hashes: { scripts: true, styles: false }` hashes one kind only, and a directive that lists `'unsafe-inline'` gets no hashes, because a hash would turn `'unsafe-inline'` off; either keeps inline `style="..."` attributes working under `style-src 'self' 'unsafe-inline'`. The hashes come from the build, never from a response body. The dev server, `bascik --server` and the Cloudflare Worker send the header; on Cloudflare, static pages get exact-path rules in the generated `public/_headers`. See [Content Security Policy](/how-to/content-security-policy) for a recipe per host.

The option is validated at startup with the location of each problem:

- `contentSecurityPolicy.directives: "script_src" is not a CSP directive. Did you mean "script-src"?`
- `contentSecurityPolicy.directives.script-src[0]: write self as 'self' (with single quotes).` The keyword check covers every directive that takes sources: each `-src` directive, `script-src-elem`, `script-src-attr`, `style-src-elem`, `style-src-attr`, `base-uri`, `form-action` and `frame-ancestors`.
- A source with a space, `;` or `,` (each source is its own string), `hashes` that is not a boolean or `{ scripts, styles }` booleans (a misspelled key gets a did-you-mean), and `reportOnly` that is not a boolean.
- Warnings: `contentSecurityPolicy.directives.script-src lists 'unsafe-inline', so every inline script runs, including one injected into a page, and Bascik adds no script hashes to it.`, `*` or `https:` in `script-src`, the same two warnings for `script-src-elem`, and `reportOnly` with no `report-to` or `report-uri` directive.

### `security`

Bascik changes what you wrote only to protect it, and every such change has a switch here. Each one is on by default, so a site whose author has never heard of it is protected, and an author who knows better can turn one off by name. There is no master switch: `security: false` is an error.

**The default rule.** A protection is on by default when it cannot break a correct site and needs no setup. It is off by default when the right setting depends on the site and needs setup. That is why everything below is on, while `contentSecurityPolicy`, `http.trustProxy` and `generate.cspHashes` are off until you configure them: a content security policy has to list the sites your pages load from, and `trustProxy` is only right behind a proxy you control.

| Key                     | Default | What it protects                                                                                                                                                                                                                                          | What turning it off means                                                                                                                                                                                                                                                              |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockScriptUrls`       | `true`  | A prop bound to a URL attribute (`href`, `src`, `srcset`, ...) or inherited onto an `<object data>` cannot hold script URLs such as `javascript:`, which runs code when the link is clicked or the frame loads; it becomes `about:invalid`.               | Every bound URL is written as given, with no warning.                                                                                                                                                                                                                                  |
| `blockCodeBindings`     | `true`  | A prop never becomes an event handler (`on*`), `srcdoc`, a `<meta http-equiv>` value, an SVG animation target, an unsafe `style`, or the text of a `<script>` or `<style>`.                                                                               | Those props are bound and filled as written. An attribute value is still escaped so it stays one attribute; a `<script>` or `<style>` gets the text unchanged except that `</script` (or `</style`) is written `<\/script` so it cannot end the element. This lets a prop become code. |
| `headers`               | `true`  | Five response headers that stop browsers from guessing file types, keep other sites from framing your pages, trim the referrer sent to other sites, and keep pages you open in a popup from reaching back into yours (see below).                         | `false` sends none of them; an object changes or removes single headers.                                                                                                                                                                                                               |
| `hsts`                  | `true`  | `Strict-Transport-Security: max-age=31536000` over HTTPS, so browsers keep using HTTPS for a year. Without it, someone on the same network as a visitor, such as public Wi-Fi, can intercept the first plain-HTTP request and keep the visitor off HTTPS. | No HSTS header; an object sets `maxAge`, `includeSubDomains` and `preload`.                                                                                                                                                                                                            |
| `privateDynamicPages`   | `true`  | `cache-control: private, no-store` on pages with server or stream scripts, so a shared cache never stores one visitor's page.                                                                                                                             | Bascik sends no `cache-control` on those pages and your host or CDN decides. A shared cache can show one visitor's page to another.                                                                                                                                                    |
| `stripDirectiveScripts` | `true`  | A `<script data-bascik-build>`, `data-bascik-server` or similar printed by a build script (for example from CMS HTML) is removed.                                                                                                                         | Printed directive scripts stay and run like ones you wrote, at build time or on your server.                                                                                                                                                                                           |
| `hideDotfiles`          | `true`  | Requests for a path with a dot segment (`/.env`, `/.git/config`) get 404, except `/.well-known/`; dotfiles in `src/pages` are not published.                                                                                                              | Dotfiles in `src/pages` are published and served. `/.bascik/` stays private and unsafe paths still get 400.                                                                                                                                                                            |

Which keys apply when:

- `blockScriptUrls`, `blockCodeBindings` and `stripDirectiveScripts` act on pages and components at build time. The build records the two binding settings in the component manifest, so the components your server scripts return at request time follow the same rules on every host. Set them in the default or `build` export; in the `server` export they have no effect and Bascik warns.
- `headers`, `hsts` and `privateDynamicPages` act on responses. The dev server and `bascik --server` read their own config, so the `server` export can change them. The Cloudflare Worker has no config at request time: it uses the values from the build (the default export plus `build`), as it does for `scripts.timeout`. On Cloudflare, static files are served by the platform, not the Worker, so the build writes `headers` and `hsts` into the generated `public/_headers` for them; see [Security settings on Cloudflare](/deployment/cloudflare#security-settings-on-cloudflare).
- `hideDotfiles` acts twice: the build decides whether dotfiles in `src/pages` are published, and the server whether it answers them. Set it in the default export so both agree; when the `build` and `server` exports give it different values, Bascik warns, because dotfiles are then either left out of the build or published but answered with 404.

See [Turning protections off](/security#turning-protections-off) for when turning one off is reasonable.

### `security.headers`

`true` (the default) sends these five headers on every response from the dev server and `bascik --server`, and on every response the Cloudflare Worker answers. Static files on Cloudflare (pages without server scripts, images, CSS) are served by the platform without the Worker, so the build writes the same headers into one site-wide rule in the generated `public/_headers`; see [Security settings on Cloudflare](/deployment/cloudflare#security-settings-on-cloudflare).

| Header                         | Value                             | What it does                                                                                                                                                            |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-content-type-options`       | `nosniff`                         | The browser uses the file type the server states and never guesses, so an uploaded text file cannot be run as a script.                                                 |
| `x-frame-options`              | `SAMEORIGIN`                      | Only your own site can show your pages in a frame, so another site cannot overlay them to trick visitors into clicking. Removing it lets any site frame your pages.     |
| `referrer-policy`              | `strict-origin-when-cross-origin` | A link to another site tells it only your domain, not the full page address with its query string.                                                                      |
| `cross-origin-opener-policy`   | `same-origin-allow-popups`        | A page from another site that opens yours, or that yours opens, cannot reach into your page's window. Popups you open, such as a payment or sign-in window, still work. |
| `cross-origin-resource-policy` | `cross-origin`                    | Other sites can load your images, scripts and styles, as from a CDN. This is the open setting; `same-origin` would allow only your own site.                            |

`false` sends none of them. An object changes single headers and keeps the rest: a string replaces the value, and `false` removes the header. Names are matched without regard to case.

```ts
security: {
  headers: { "x-frame-options": "DENY" },  // refuse framing entirely
}
```

```ts
security: {
  headers: { "x-frame-options": false },   // let any site frame your pages
}
```

Only these five names are accepted. `strict-transport-security` is set with [`security.hsts`](#securityhsts) and `content-security-policy` with [`contentSecurityPolicy`](#contentsecuritypolicy); any other header is sent from your host or an API route. A value must be a non-empty string of printable ASCII or Latin-1 characters, without line breaks or control characters (a dash or curly quote pasted from a document is refused, because no host can send it), and each header may be named once. An API route's own headers still win over these.

### `security.hsts`

**Changed default.** Bascik used to send `max-age=31536000; includeSubDomains`. It now sends `max-age=31536000` without `includeSubDomains`, because `includeSubDomains` forces every subdomain of your site onto HTTPS for a year, including ones Bascik does not serve and that may not have a certificate. Browsers that already received the old header keep it until it expires.

The header is sent only over HTTPS: on a TLS server (`http.tls.enabled` with `bascik --server`), on a request whose scheme is `https`, or under `http.trustProxy` when the proxy says `x-forwarded-proto: https`. The Cloudflare Worker sends it on `https://` requests it answers. Static files on Cloudflare are served by the platform without the Worker, so the build writes the header into the site-wide rule of the generated `public/_headers`, which sends it on every response; a browser ignores HSTS over plain HTTP. See [Security settings on Cloudflare](/deployment/cloudflare#security-settings-on-cloudflare).

```ts
security: {
  hsts: { includeSubDomains: true }, // max-age=31536000; includeSubDomains
}
```

| Setting                                                              | Header sent                                    |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| `hsts: true` (default)                                               | `max-age=31536000`                             |
| `hsts: false`                                                        | none                                           |
| `hsts: { includeSubDomains: true }`                                  | `max-age=31536000; includeSubDomains`          |
| `hsts: { maxAge: 0 }`                                                | `max-age=0`                                    |
| `hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }` | `max-age=63072000; includeSubDomains; preload` |

`maxAge` is a whole number of seconds, 0 or more (31536000 is one year). Opt in to `includeSubDomains: true` only when every subdomain serves HTTPS. `maxAge: 0` sends `max-age=0`, which tells browsers to drop a policy they remembered, for example the old `includeSubDomains` one. `preload` asks to be on the browsers' built-in HTTPS list; the list requires `includeSubDomains` and a `maxAge` of at least one year, and Bascik warns when either is missing. Getting off that list takes months, so add it last.

## Mode Overrides (`dev`, `build`, `server`)

Exporting `dev`, `build`, or `server` mode configuration objects lets you specify mode-specific overrides that merge on top of `default`:

```ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  generate: { sitemapLastmod: true },
});

export const dev = defineConfig({
  logging: { level: "debug" },
});

export const build = defineConfig({
  minify: {
    identifiers: false,
  },
});

export const server = defineConfig({
  http: {
    port: 9443,
    tls: { enabled: true },
  },
});
```
