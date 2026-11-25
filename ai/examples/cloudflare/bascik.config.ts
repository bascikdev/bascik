import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  // src/components is this example's chat shell (thread, sidebar, memory
  // panel). ../../components is the package's own folder: the chat pieces
  // and the starter catalog. ../../demo/src/genui holds the demo's
  // components, of which the bookshop writes book-card.
  directory: {
    components: ["src/components", "../../components", "../../demo/src/genui"],
  },
  generate: { sitemap: false, robots: false },
  // A reply streams for as long as the model writes, and a turn is capped at
  // 25 seconds (src/lib/chat.ts), well inside this.
  scripts: { timeout: 60_000 },
});
