import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  // This example lives beside the package, so it reads the parts from the
  // package's own folder. In a project of your own, `npx bascik add
  // @bascik/ai` copies them into src/components, and this line is not needed.
  directory: { components: ["src/components", "../../components"] },
  generate: { sitemap: false, robots: false },
  // A reply streams for as long as the model writes.
  scripts: { timeout: 120_000 },
});
