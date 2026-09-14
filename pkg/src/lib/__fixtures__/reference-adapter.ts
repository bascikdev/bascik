import type { HostingAdapter, AdapterBuildContext, AdapterBuildResult } from "../adapter-contract.ts";
import { join } from "node:path";
import { mkdir, copyFile, writeFile } from "node:fs/promises";

export const referenceAdapter: HostingAdapter = {
  name: "reference",
  async build(context: AdapterBuildContext): Promise<AdapterBuildResult> {
    const publicDir = join(context.outDir, "public");
    await mkdir(publicDir, { recursive: true });

    // Copy public files
    for (const rel of context.graph.publicFiles) {
      const from = join(context.distDir, rel);
      const to = join(publicDir, rel);
      await mkdir(join(to, ".."), { recursive: true });
      await copyFile(from, to);
    }

    // Write a manifest listing pages and routes
    const manifest = {
      base: context.graph.base,
      release: context.graph.release,
      pages: Object.keys(context.graph.pages),
      apiRoutes: context.graph.apiRoutes.map((r) => r.path),
    };
    await writeFile(join(context.outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    return {
      publicDir,
      workerPath: join(context.outDir, "manifest.json"),
      bundleBytes: 1234,
      notes: ["reference adapter execution completed"],
    };
  },
};

export default referenceAdapter;
