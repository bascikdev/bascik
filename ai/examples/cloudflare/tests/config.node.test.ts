/**
 * The configs agree, and the built Worker holds nothing that cannot run on
 * Workers. Needs `yarn build` first (`yarn unit` runs it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "dist", ".bascik", "cloudflare");
const read = (path: string) =>
  parse(readFileSync(path, "utf8"), [], { allowTrailingComma: true }) as Record<
    string,
    any
  >;

describe("configs", () => {
  const authored = read(join(root, "wrangler.jsonc"));
  const wrapper = read(join(root, "wrangler.wrapper.jsonc"));

  it("the deployed config names the same Worker, settings and vars as the build's", () => {
    for (const key of [
      "name",
      "compatibility_date",
      "compatibility_flags",
      "vars",
    ]) {
      expect(wrapper[key], key).toEqual(authored[key]);
    }
  });

  it("has no routes and no hostname: the owner adds them", () => {
    expect(wrapper.routes).toBeUndefined();
    expect(wrapper.route).toBeUndefined();
    expect(authored.routes).toBeUndefined();
  });

  it("binds the three Durable Objects, each a SQLite class", () => {
    const classes = wrapper.durable_objects.bindings.map(
      (binding: { class_name: string }) => binding.class_name,
    );
    expect(classes.sort()).toEqual([
      "Budget",
      "ConversationLive",
      "ReaderData",
    ]);
    expect(wrapper.migrations[0].new_sqlite_classes.sort()).toEqual(
      classes.sort(),
    );
    const tests = read(join(root, "tests", "wrangler.test.jsonc"));
    expect(tests.durable_objects).toEqual(wrapper.durable_objects);
  });

  it("caps requests per address with the rate limiter the tests run against", () => {
    expect(wrapper.ratelimits).toEqual([
      expect.objectContaining({ name: "REQUESTS" }),
    ]);
    const tests = read(join(root, "tests", "wrangler.test.jsonc"));
    expect(tests.ratelimits).toEqual(wrapper.ratelimits);
  });

  it("sends the build's own list of paths to the Worker first", () => {
    const generatedPath = join(generatedDir, "wrangler.jsonc");
    expect(existsSync(generatedPath), "run `yarn build` first").toBe(true);
    const generated = read(generatedPath);
    expect(wrapper.assets.run_worker_first).toEqual(
      generated.assets.run_worker_first,
    );
    // The bindings and settings the generated Worker was built for.
    for (const key of [
      "name",
      "compatibility_date",
      "compatibility_flags",
      "vars",
    ]) {
      expect(wrapper[key], key).toEqual(generated[key]);
    }
    // Every binding the generated config declares, the wrapper declares the same.
    for (const key of [
      "kv_namespaces",
      "r2_buckets",
      "d1_databases",
      "durable_objects",
      "services",
    ]) {
      if (generated[key] !== undefined) {
        expect(wrapper[key], key).toEqual(generated[key]);
      }
    }
    expect(wrapper.assets.binding).toBe(generated.assets.binding);
    expect(wrapper.assets.not_found_handling).toBe(
      generated.assets.not_found_handling,
    );
  });
});

describe("the built Worker", () => {
  it("imports nothing Workers cannot run, and none of the Node demo's modules", () => {
    const bundle = readFileSync(join(generatedDir, "worker.js"), "utf8");
    for (const banned of [
      "node:sqlite",
      "child_process",
      "readdir(",
      "import.meta.dirname",
      "process.cwd",
      // Markers of ai/demo/src/lib/models.ts, chat.ts and the voice relays.
      "GENUI_LOCAL_MODELS",
      "AZURE_VOICE_LIVE",
      "genuiVoices",
    ]) {
      expect(bundle.includes(banned), banned).toBe(false);
    }
  });

  it("fits the free plan's 3 MB (gzip) script limit by a wide margin", () => {
    const info = read(join(generatedDir, "build-info.json"));
    const bundle = readFileSync(join(generatedDir, "worker.js"));
    // build-info.json reports the bundle it wrote.
    expect(info.bundleBytes).toBe(bundle.byteLength);
    // The budget: 1.5 MB before compression, 1 MB after.
    expect(info.bundleBytes).toBeLessThan(1.5 * 1024 * 1024);
    expect(gzipSync(bundle).byteLength).toBeLessThan(1024 * 1024);
  });
});
