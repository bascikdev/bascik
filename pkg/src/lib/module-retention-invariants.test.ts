import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanGeneratorEnvironment } from "../../bench/profile-workload.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function nativeInvariant(body: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bascik-retention-invariant-"));
  directories.push(directory);
  await writeFile(join(directory, "bascik.config.ts"), 'export default { pipeline: { workers: false }, logging: { level: "error" }, minify: false };');
  const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  const source = `
    import assert from "node:assert/strict";
    import { writeFile } from "node:fs/promises";
    import { resolve } from "node:path";
    import { scriptRegistry } from ${moduleUrl("./script-registry.ts")};
    import { mem } from ${moduleUrl("./mem.ts")};
    import { planServerScripts, executeServerScriptPlan, streamServerScripts } from ${moduleUrl("./server-scripts.ts")};
    import { installModuleGraphHook } from ${moduleUrl("./module-graph.ts")};
    const hook = installModuleGraphHook({ projectRoot: process.cwd(), isDev: true });
    const context = { remoteIp: "127.0.0.1" };
    const request = (name = "current") => new Request("http://localhost/?request=" + name);
    const html = source => '<script data-bascik-server>' + source.replace('export default', '\\nexport default') + '</script>';
    const run = async plan => (await executeServerScriptPlan(plan, request(), context, 5000, resolve("page.html"))).toString();
    const owned = () => ({ cache: Reflect.get(scriptRegistry, "cache").size, graph: scriptRegistry.graph.size });
    const store = async (name, source) => {
      await mem.storePage({ relativePagePath: name + ".html", absolutePagePath: resolve(name + ".html"), pageContent: source });
      const plan = mem.getPageExact("/" + name).serverScriptPlan;
      assert(plan && !("error" in plan));
      return plan;
    };
    try { ${body} } finally { hook.deregister(); }
  `;
  const environment = cleanGeneratorEnvironment(process.env);
  for (const key of Object.keys(environment)) {
    if (key.startsWith("BASCIK_") || key.startsWith("VITEST") || key === "NODE_ENV") delete environment[key];
  }
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: directory, env: environment, timeout: 20_000, maxBuffer: 256 * 1024,
  });
  expect(result.stderr).toBe("");
}

describe("inline plan ownership and dependency freshness", () => {
  it("keeps a newer same-owner load after an older load rejects late", async () => {
    await nativeInvariant(`
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      globalThis.retentionGate = { entered: entered.resolve, release: release.promise };
      const owner = {};
      const oldSource = 'globalThis.retentionGate.entered(); await globalThis.retentionGate.release; throw new Error("late rejection");';
      const oldUrl = 'data:text/javascript,' + encodeURIComponent(oldSource);
      const currentUrl = 'data:text/javascript,' + encodeURIComponent('export default () => "current";');
      const oldLoad = scriptRegistry.load(oldUrl, owner);
      const rejected = assert.rejects(oldLoad, /late rejection/);
      await entered.promise;
      const current = await scriptRegistry.load(currentUrl, owner);
      release.resolve();
      await rejected;
      assert.strictEqual(await scriptRegistry.load(currentUrl, owner), current, "late rejection must not discard the newer owner's load");
      assert.equal(current.module.default(), "current");
      assert.deepEqual(owned(), { cache: 0, graph: 0 });
      delete globalThis.retentionGate;
    `);
  });

  it.each(["tracked-helper computed import", "literal dynamic import"])("keeps dependencies fresh through %s without mutating the plan", async scenario => {
    await nativeInvariant(`
      await writeFile("leaf.mjs", "export const value = 0;");
      await writeFile("helper.mjs", 'const target = "./leaf.mjs"; const {value} = await import(target); export {value};');
      const source = ${JSON.stringify(scenario)} === "tracked-helper computed import"
        ? 'import {value} from "./helper.mjs"; export default () => String(value);'
        : 'export default async () => String((await import("./leaf.mjs")).value);';
      const plan = await store("page", html(source));
      const original = JSON.stringify(plan);
      assert.equal(await run(plan), "0");
      await writeFile("leaf.mjs", "export const value = 1;");
      assert(scriptRegistry.invalidate(resolve("leaf.mjs")));
      assert.equal(await run(plan), "1");
      assert.equal(JSON.stringify(plan), original, "execution must not mutate the retained plan");
    `);
  });

  it("keeps the global cache and graph free of inline history at a fixed twenty live pages", async () => {
    await nativeInvariant(`
      const shared = html('let count = 0; export default function sharedComponent() { return "shared:" + ++count; }');
      for (let revision = 0; revision < 3; revision++) {
        for (let page = 0; page < 20; page++) {
          const plan = await store("page-" + page, html('export default () => "page-' + page + '-revision-' + revision + '";') + shared);
          assert.equal(await run(plan), "page-" + page + "-revision-" + revision + "shared:" + (revision * 20 + page + 1));
        }
        assert.equal(mem.pages().length, 20);
        assert.deepEqual(owned(), { cache: 0, graph: 0 }, "inline loads belong to live jobs, not global source history");
      }
    `);
  });

  it.each(["unchanged", "reverted"])("reloads a three-level helper through %s inline source", async scenario => {
    await nativeInvariant(`
      await writeFile("leaf.mjs", "export const value = 0;");
      await writeFile("middle.mjs", 'export { value } from "./leaf.mjs";');
      await writeFile("helper.mjs", 'export { value } from "./middle.mjs";');
      const original = html('import { value } from "./helper.mjs"; export default () => "original:" + value;');
      const plan = await store("page", original);
      assert.equal(await run(plan), "original:0");
      await writeFile("leaf.mjs", "export const value = 1;");
      assert(scriptRegistry.invalidate(resolve("leaf.mjs")));
      if (${JSON.stringify(scenario)} === "reverted") {
        const changed = await store("page", html('import { value } from "./helper.mjs"; export default () => "changed:" + value;'));
        assert.equal(await run(changed), "changed:1");
        assert.equal(await run(await store("page", original)), "original:1", "original source must not recover stale linked helpers");
      } else {
        assert.equal(await run(plan), "original:1", "unchanged inline body must observe the edited transitive helper");
      }
    `);
  });

  it("lets a suspended old request finish without publishing its retired inline load", async () => {
    await nativeInvariant(`
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      globalThis.retentionGate = { entered: entered.resolve, release: release.promise };
      const old = await store("page", html('globalThis.retentionGate.entered(); await globalThis.retentionGate.release; export default request => "old:" + new URL(request.url).searchParams.get("request");'));
      const loading = executeServerScriptPlan(old, request("accepted"), context, 5000, resolve("page.html"));
      await entered.promise;
      const current = await store("page", html('export default () => "new";'));
      assert.equal(await run(current), "new");
      release.resolve();
      assert.equal((await loading).toString(), "old:accepted");
      assert.equal(await run(current), "new");
      assert.deepEqual(owned(), { cache: 0, graph: 0 }, "retired load must not publish globally");
      delete globalThis.retentionGate;
    `);
  });

  it("starts delayed stream jobs from the accepted plan after replacement without republishing history", async () => {
    await nativeInvariant(`
      const blocked = Promise.withResolvers();
      const release = Promise.withResolvers();
      globalThis.retentionDelayedStarted = false;
      const old = await store("page", '<p>start</p><script data-bascik-stream>export default () => "first";</script><script data-bascik-stream>export default () => "second";</script><script data-bascik-stream>export default request => { globalThis.retentionDelayedStarted = true; return "old:" + new URL(request.url).searchParams.get("request"); }</script>' + html('export default () => "";'));
      const chunks = [];
      const stream = streamServerScripts(old, request("accepted"), context, 5000, resolve("page.html"), {
        async write(chunk) { chunks.push(chunk.toString()); if (chunks.length === 1) { blocked.resolve(); await release.promise; } }
      });
      await stream.ready;
      stream.commit();
      await blocked.promise;
      assert.equal(globalThis.retentionDelayedStarted, false);
      const current = await store("page", html('export default () => "new";'));
      assert.equal(await run(current), "new");
      release.resolve();
      await stream.done;
      assert.equal(chunks.join(""), "<p>start</p>firstsecondold:accepted");
      assert.equal(globalThis.retentionDelayedStarted, true);
      assert.deepEqual(owned(), { cache: 0, graph: 0 }, "delayed old jobs must not republish globally");
      delete globalThis.retentionDelayedStarted;
    `);
  });

  it("preserves an inline singleton when only an unrelated helper changes", async () => {
    await nativeInvariant(`
      await writeFile("helper.mjs", "export const value = 0;");
      await writeFile("unrelated.mjs", "export default () => 0;");
      const plan = await store("page", html('import { value } from "./helper.mjs"; let count = 0; export default () => value + ":" + ++count;'));
      assert.equal(await run(plan), "0:1");
      await scriptRegistry.load(resolve("unrelated.mjs"));
      await writeFile("unrelated.mjs", "export default () => 1;");
      assert(scriptRegistry.invalidate(resolve("unrelated.mjs")));
      assert.equal(await run(plan), "0:2");
    `);
  });
});