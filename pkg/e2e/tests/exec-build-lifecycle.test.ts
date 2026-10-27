import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";
import { defaultOutDir } from "./helpers/out-dir.ts";

const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

for (const workers of [false, true]) {
  for (const fail of [false, true]) {
    test(`build joins parallel after compilation and post, workers=${workers}, failure=${fail}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "bascik-exec-build-"));
      // The build script below gets no BASCIK_OUT_DIR, so it reads this path.
      const preJson = JSON.stringify(join(defaultOutDir(root), "pre.json"));
      try {
        await mkdir(join(root, "src/pages"), { recursive: true });
        await mkdir(join(root, "src/components"), { recursive: true });
        await writeFile(
          join(root, "bascik.config.ts"),
          `export default {
          generate: { sitemap: false, robots: false },
          pipeline: { workers: ${workers}, exec: [
            { script: 'pre.mjs', phase: 'pre' },
            { script: 'parallel.mjs', phase: 'parallel', timeout: 5000 },
            { script: 'post.mjs', phase: 'post' }
          ] }, minify: { identifiers: false }
        };`,
        );
        await writeFile(
          join(root, "pre.mjs"),
          `import { mkdir, writeFile } from 'node:fs/promises';
          import { join } from 'node:path';
          const out = process.env.BASCIK_OUT_DIR;
          await mkdir(out, { recursive: true }); await writeFile(join(out, 'pre.json'), 'ready');`,
        );
        await writeFile(
          join(root, "src/pages/index.html"),
          `<!DOCTYPE html><html lang="en"><head><title>Phases</title></head><body>
          <p data-testid="pre"><script data-bascik-build>import { readFileSync } from 'node:fs'; export default () => readFileSync(${preJson},'utf8');</script></p>
          </body></html>`,
        );
        await writeFile(
          join(root, "post.mjs"),
          `import { readFile, writeFile } from 'node:fs/promises';
          import { join } from 'node:path';
          const out = process.env.BASCIK_OUT_DIR;
          const html = await readFile(join(out, 'index.html'),'utf8');
          if (!html.includes('ready')) throw new Error('post ran before compile');
          await writeFile(join(out, 'post.json'),'done');`,
        );
        await writeFile(
          join(root, "parallel.mjs"),
          `import { watch, existsSync } from 'node:fs';
          import { writeFile } from 'node:fs/promises';
          import { join } from 'node:path';
          const out = process.env.BASCIK_OUT_DIR;
          const post = join(out, 'post.json');
          await new Promise(resolve => {
            const watcher = watch(out, () => { if (existsSync(post)) { watcher.close(); resolve(); } });
            if (existsSync(post)) { watcher.close(); resolve(); }
          });
          await writeFile(join(out, 'parallel.json'),'joined');
          ${fail ? "throw new Error('parallel failure after post');" : ""}`,
        );
        const result = await new Promise<{
          code: number | null;
          output: string;
        }>((resolve, reject) => {
          const child = spawn(process.execPath, [entry, "--build"], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += stripVTControlCharacters(chunk.toString("utf8"));
          });
          child.stderr.on("data", (chunk) => {
            output += stripVTControlCharacters(chunk.toString("utf8"));
          });
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code, output }));
        });
        expect(
          await readFile(join(defaultOutDir(root), "post.json"), "utf8").catch(
            () => result.output,
          ),
        ).toBe("done");
        expect(
          await readFile(join(defaultOutDir(root), "parallel.json"), "utf8"),
        ).toBe("joined");
        if (fail) {
          expect(result.code).not.toBe(0);
          expect(result.output).toContain("parallel failure after post");
          expect(result.output).not.toContain("Build complete");
        } else {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain("Build complete");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
