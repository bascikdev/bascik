/**
 * The dev summary's build-script counts include the pages that failed.
 *
 * Per-page counts travel in the page result, which a page that fails does
 * not return, so its script was missing from `(N build scripts ran, M from
 * cache)`: with pages index and good2 (one build script each) and bad
 * (whose script throws), the first boot said "2 build scripts ran" though 3
 * ran, and the second "0 build scripts ran, 2 from cache" though bad's ran
 * again. Each test runs the real dev server twice on one project.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGKILL");
  children.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const page = (title: string, script: string): string =>
  `<!doctype html>\n<html lang="en">\n<head><title>${title}</title></head>\n<body>\n<script data-bascik-build>\n${script}\n</script>\n</body>\n</html>\n`;

const project = async (workers: boolean): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-script-summary-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}',
    "bascik.config.js": `export default { pipeline: { workers: ${workers} }, generate: { sitemap: false, robots: false } };`,
    "src/pages/index.html": page("Home", 'export default () => "<p>home</p>";'),
    "src/pages/good2.html": page("Good", 'export default () => "<p>good</p>";'),
    "src/pages/bad.html": page(
      "Bad",
      'export default () => {\n  throw new Error("bad page script");\n};',
    ),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

/** Boot the dev server, return its summary line, and stop it. */
const bootSummary = async (root: string, port: number): Promise<string> => {
  const child = spawn(
    process.execPath,
    [CLI, "--port", String(port), "--no-pin"],
    {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", VITEST: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const summary = /✓ \d+ pages? transpiled in [^\n]*/;
  const deadline = Date.now() + 60_000;
  while (!summary.test(output) && child.exitCode === null) {
    if (Date.now() > deadline) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  const exited = new Promise((done) => child.once("close", done));
  if (child.exitCode === null) child.kill("SIGINT");
  await exited;
  const line = summary.exec(output)?.[0];
  if (!line) throw new Error(`no summary line:\n${output}`);
  return line;
};

describe("the dev summary counts the build scripts of pages that failed", () => {
  it.each([
    ["one thread", false, 24614],
    ["pipeline.workers", true, 24616],
  ])("%s", { timeout: 150_000 }, async (_label, workers, port) => {
    const root = await project(workers);
    expect(await bootSummary(root, port)).toMatch(
      /\(3 build scripts ran, 0 from cache\)$/,
    );
    // The failed script cached nothing, so it runs again; the others are cached.
    expect(await bootSummary(root, port + 1)).toMatch(
      /\(1 build script ran, 2 from cache\)$/,
    );
  });
});
