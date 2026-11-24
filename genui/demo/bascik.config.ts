import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  // src/components is the chat shell. src/genui is the catalog: every
  // component in it is one the model may write (see src/lib/chat.ts).
  directory: { components: ["src/components", "src/genui"] },
  generate: { sitemap: false, robots: false },
  // A reply streams for as long as the model writes.
  scripts: { timeout: 120_000 },
  // The load test in ../stress sends everything from one address, so it runs
  // with the per-client rate limit off. Leave it on everywhere else.
  http: { rateLimit: process.env.GENUI_STRESS !== "1" },
});
