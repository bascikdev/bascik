import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { emitServerlessArtifacts } from "./serverless-artifacts.ts";
import { SIDECAR_SCHEMA_VERSION } from "./server-sidecar.ts";

describe("adapter contract and execution", () => {
  it("runs reference fixture adapter, stages inline sources, writes build-info.json and cleans staging", async () => {
    const testDir = join(tmpdir(), `bascik-contract-test-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });

    // static file
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    // dynamic file with inline script
    await writeFile(
      join(distDir, "dyn.html"),
      `<p>Hi</p><script type="text/bascik-server" data-bascik-server-id="s1"></script>`,
      "utf8",
    );
    const sidecar = {
      schema: SIDECAR_SCHEMA_VERSION,
      scripts: {
        s1: {
          mode: "server",
          source: 'console.log("hello");',
          sourceFile: "src/pages/dyn.html",
        },
      },
    };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    try {
      const result = await emitServerlessArtifacts(
        resolve(import.meta.dirname, "__fixtures__/reference-adapter.ts"),
        {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        },
      );

      expect(result.target).toBe(resolve(import.meta.dirname, "__fixtures__/reference-adapter.ts"));
      expect(result.publicDir).toBe(join(result.outDir, "public"));

      // build-info.json written by core
      const buildInfoRaw = await readFile(join(result.outDir, "build-info.json"), "utf8");
      const buildInfo = JSON.parse(buildInfoRaw);
      expect(buildInfo.adapter).toBe("reference");
      expect(buildInfo.bascikVersion).toBe("1.0.0");
      expect(buildInfo.notes).toContain("reference adapter execution completed");
      expect(buildInfo).not.toHaveProperty("compatibilityDate");
      expect(buildInfo).not.toHaveProperty("compatibilityFlags");
      expect(buildInfo).not.toHaveProperty("invocationRoutes");

      // Verify .staging is cleaned up
      await expect(readFile(join(result.outDir, ".staging"), "utf8")).rejects.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("stages inline script sources in .staging and cleans up after build", async () => {
    const testDir = join(tmpdir(), `bascik-contract-staging-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });

    await writeFile(
      join(distDir, "stream.html"),
      `<p>Live</p><script type="text/bascik-server" data-bascik-server-id="st1" data-bascik-stream></script>`,
      "utf8",
    );
    const sidecar = {
      schema: SIDECAR_SCHEMA_VERSION,
      scripts: {
        st1: {
          mode: "stream",
          source: 'export default () => "staged content";',
          sourceFile: "src/pages/stream.html",
        },
      },
    };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    const inspectAdapterPath = join(testDir, "inspect-adapter.mjs");
    await writeFile(
      inspectAdapterPath,
      `
      import { readFile } from "node:fs/promises";
      export default {
        name: "inspect",
        async build(context) {
          const job = context.graph.pages["/stream"].jobs["st1"];
          if (job && job.source.kind === "inline") {
            const content = await readFile(job.source.stagedPath, "utf8");
            globalThis.__bascik_staged_test = { stagedPath: job.source.stagedPath, content };
          }
          return { publicDir: context.outDir };
        }
      };
      `,
      "utf8",
    );

    try {
      await emitServerlessArtifacts("./inspect-adapter.mjs", {
        version: "1.0.0",
        projectRoot: testDir,
        distDir,
      });

      const stagedInfo = (globalThis as unknown as { __bascik_staged_test?: { stagedPath: string; content: string } }).__bascik_staged_test;
      delete (globalThis as unknown as { __bascik_staged_test?: unknown }).__bascik_staged_test;

      expect(stagedInfo).toBeDefined();
      expect(stagedInfo?.stagedPath).toContain(".staging");
      expect(stagedInfo?.content).toContain("staged content");

      // Verify staging was cleaned up
      await expect(readFile(stagedInfo!.stagedPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("fails when an installed adapter package cannot be resolved from projectRoot", async () => {
    const testDir = join(tmpdir(), `bascik-contract-absent-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "package.json"), JSON.stringify({ name: "absent-test" }));
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");

    try {
      await expect(
        emitServerlessArtifacts("@nonexistent/adapter-custom", {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        }),
      ).rejects.toThrow(/could not resolve adapter package "@nonexistent\/adapter-custom"/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects an adapter that writes outside its target outDir", async () => {
    const testDir = join(tmpdir(), `bascik-contract-escape-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });

    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    const sidecar = { schema: SIDECAR_SCHEMA_VERSION, scripts: {} };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    const escapingAdapterPath = join(testDir, "escaping-adapter.mjs");
    await writeFile(
      escapingAdapterPath,
      `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        name: "escape",
        async build(context) {
          // Attempt to write outside outDir
          await writeFile(join(context.projectRoot, "escaped.txt"), "hacked", "utf8");
          return {
            publicDir: context.outDir,
            workerPath: join(context.projectRoot, "escaped.txt"),
          };
        }
      };
      `,
      "utf8",
    );

    try {
      await expect(
        emitServerlessArtifacts("./escaping-adapter.mjs", {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        }),
      ).rejects.toThrow(/Adapter wrote path outside target output directory/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects an adapter that creates a symlink pointing outside outDir", async () => {
    const testDir = join(tmpdir(), `bascik-contract-symlink-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });

    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    const sidecar = { schema: SIDECAR_SCHEMA_VERSION, scripts: {} };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    const outsideFile = join(testDir, "sensitive.txt");
    await writeFile(outsideFile, "secret", "utf8");

    const symlinkAdapterPath = join(testDir, "symlink-adapter.mjs");
    await writeFile(
      symlinkAdapterPath,
      `
      import { symlink, mkdir } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        name: "symlink-escape",
        async build(context) {
          const publicDir = join(context.outDir, "public");
          await mkdir(publicDir, { recursive: true });
          await symlink(join(context.projectRoot, "sensitive.txt"), join(publicDir, "leak.txt"));
          return {
            publicDir,
          };
        }
      };
      `,
      "utf8",
    );

    try {
      await expect(
        emitServerlessArtifacts("./symlink-adapter.mjs", {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        }),
      ).rejects.toThrow(/Adapter wrote path outside target output directory/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects an adapter that mutates existing dist files outside outDir", async () => {
    const testDir = join(tmpdir(), `dist-read-only-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    await mkdir(bascikHiddenDir, { recursive: true });

    const distFile = join(distDir, "index.html");
    await writeFile(distFile, "<h1>Original</h1>", "utf8");
    const sidecar = { schema: SIDECAR_SCHEMA_VERSION, scripts: {} };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    const mutatingAdapterPath = join(testDir, "mutating-adapter.mjs");
    await writeFile(
      mutatingAdapterPath,
      `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        name: "mutator",
        async build(context) {
          // Mutate dist/index.html which is read-only for adapters
          await writeFile(join(context.distDir, "index.html"), "<h1>Mutated</h1>", "utf8");
          return {
            publicDir: context.outDir,
          };
        }
      };
      `,
      "utf8",
    );

    try {
      await expect(
        emitServerlessArtifacts("./mutating-adapter.mjs", {
          version: "1.0.0",
          projectRoot: testDir,
          distDir,
        }),
      ).rejects.toThrow(/Adapter modified dist\/ which is read-only/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects build when public assets collide with generated control files or static API routes", async () => {
    const testDir = join(tmpdir(), `bascik-collision-test-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    const srcApiDir = join(testDir, "src/api");
    await mkdir(bascikHiddenDir, { recursive: true });
    await mkdir(srcApiDir, { recursive: true });

    // Colliding public file with API route
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    await mkdir(join(distDir, "api"), { recursive: true });
    await writeFile(join(distDir, "api/hello"), "colliding file", "utf8");
    await writeFile(join(srcApiDir, "hello.ts"), "export const GET = () => new Response('hi');", "utf8");

    const sidecar = { schema: SIDECAR_SCHEMA_VERSION, scripts: {} };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    try {
      await expect(
        emitServerlessArtifacts(
          resolve(import.meta.dirname, "__fixtures__/reference-adapter.ts"),
          {
            version: "1.0.0",
            projectRoot: testDir,
            distDir,
          },
        ),
      ).rejects.toThrow(/public file "api\/hello" shadows API route "\/api\/hello"/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
