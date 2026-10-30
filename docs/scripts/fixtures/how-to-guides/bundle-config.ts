// bascik.config.ts: run the bundler as a pre-transpile exec step.
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: "build-bundle.ts",
        phase: "pre",
        watch: ["src/client/"],
      },
    ],
  },
});
