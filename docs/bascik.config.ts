import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  directory: {
    // The repo-root examples/ components render live on /example-components/* pages. They are the only copy: the pages,
    // /assets/examples.json, and the tests all read the same files.
    components: ["src/components", "../examples/components"],
  },
  components: {
    // <heading-anchors> comes from @zachleat/heading-anchors and is demonstrated on
    // /how-to/third-party-web-components. It is not a Bascik component file.
    external: ["heading-anchors"],
  },
  pipeline: {
    // Every file a page reads at build time must be covered here (or be a page or component), or editing it in
    // dev never re-renders the page. docs/scripts/watch-paths.test.ts checks this.
    watchPaths: [
      "../CHANGELOG.md",
      "../pkg/package.json",
      "../examples/starter-site/",
      "scripts/",
      "content/",
      "src/diagrams/",
      "src/lib/",
      "src/css/",
      "../pkg/test-coverage.json",
      "../pkg/e2e-test-coverage.json",
      "../create/test-coverage.json",
      "../extensions/vscode-bascik/test-coverage.json",
      "../adapters/cloudflare/test-coverage.json",
      "test-coverage.json",
      "build-timings.json",
    ],
    exec: [
      // Copies the npm custom element into dist/assets/vendor/. 'pre' so it exists before pages load it.
      { script: "scripts/publish-heading-anchors.ts", phase: "pre" },
      {
        script: "scripts/generate-search-index.ts",
        phase: "parallel",
        watch: ["content/"],
        // Fetched by the browser. Completion does not trigger compilation.
      },
      {
        script: "scripts/publish-agent-skill.ts",
        phase: "parallel",
        watch: ["../skills/"],
        // Publishes the agent skills from the repo-root skills/ directory: /assets/skills.tar.gz (every skill)
        // and /assets/SKILL.md (the core skill, the one intentional Markdown download). Static asset copying
        // denies .md by design; the authored skills are watched, the generated outputs never are.
      },
      {
        script: "scripts/publish-examples.ts",
        phase: "parallel",
        watch: ["../examples/"],
        // Publishes /assets/examples.json for skills/bascik/scripts/add-example.mjs.
      },
      {
        script: "scripts/generate-press-kit.ts",
        phase: "parallel",
        watch: [
          "src/pages/assets/bascik-logo.svg",
          "src/pages/assets/favicon.svg",
        ],
        // Generates the brand kit (logos, PNG exports, social images, and the zip) into dist/assets/press/.
        // Only the two authored logo SVGs are watched; the generated kit never is.
      },
    ],
  },
  assets: {
    inlineStyles: ["src/css/styles.css"],
  },
  scripts: {
    cache: {
      // Example pages read example files through markers in their Markdown, which the cache key cannot see.
      // <build-breakdown> counts pages and components by reading directories, which it cannot see either.
      // <docs-search> hashes the search index built from content/, which the cache key cannot see, and a stale
      // hash would let browsers keep an old index for a year.
      exclude: [
        "src/pages/example-components/**",
        "src/components/build-breakdown/**",
        "src/components/docs-search/**",
      ],
    },
  },
});

export const dev = defineConfig({
  assets: {
    symlink: true,
  },
  pipeline: {
    workers: true,
  },
});

export const build = defineConfig({
  pipeline: {
    // Compile pages across CPU cores, matching the dev server.
    workers: true,
    exec: [
      { script: "scripts/publish-heading-anchors.ts", phase: "pre" },
      { script: "scripts/generate-search-index.ts", phase: "parallel" },
      { script: "scripts/publish-agent-skill.ts", phase: "parallel" },
      { script: "scripts/publish-examples.ts", phase: "parallel" },
      { script: "scripts/generate-press-kit.ts", phase: "parallel" },
      { script: "scripts/generate-llms-txt.ts", phase: "parallel" },
      { script: "scripts/generate-og-images.ts", phase: "parallel" },
      // Cloudflare Pages cache rules for the versioned demo images. Build only: dev has no CDN.
      { script: "scripts/generate-pages-headers.ts", phase: "parallel" },
      // Git-derived <lastmod> for sitemap.xml and TechArticle dates in pages. Post phase: it edits the
      // sitemap and pages Bascik writes. Build only.
      { script: "scripts/generate-git-dates.ts", phase: "post" },
      // Per-page CSP <meta> with the page's inline script hashes. Post phase, after the other post scripts,
      // because it hashes the final emitted script text. Build only.
      { script: "scripts/generate-csp-meta.ts", phase: "post" },
    ],
  },
});
