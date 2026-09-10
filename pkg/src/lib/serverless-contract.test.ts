/**
 * Prompt 131: the serverless contract.
 *
 * Pins two facts that adapter work depends on:
 *
 * 1. A host-neutral request execution graph exists and bundles for a Web
 *    platform with zero Node resolution errors. `esbuild` with
 *    `platform: "browser"` is the located negative-control oracle: it has no
 *    `node:*` builtins, so any Node import in the graph is a hard error. This
 *    is an import-hygiene guard, not a Workers acceptance test (134/135 own
 *    that).
 * 2. The Node runtime modules (`server-scripts.ts`, `api-runtime.ts`) are NOT
 *    in that graph. They own module loading, sockets, and Buffer sinks and are
 *    expected to keep failing the boundary. If one day they pass, the negative
 *    control has stopped proving anything and this test must be revisited.
 *
 * Also pins the documentation contract: no docs page may claim that handlers
 * run "without modification" on other hosts or list hosts as if an adapter
 * existed for them.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type Message } from "esbuild";

const here = resolve(import.meta.dirname);
const docsContent = resolve(here, "../../../docs/content");

const bundleForWeb = async (entry: string): Promise<{ errors: Message[]; bytes: number }> => {
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
      // Nothing is external: every import must resolve inside the graph.
      external: [],
    });
    return { errors: result.errors, bytes: result.outputFiles?.[0]?.contents.byteLength ?? 0 };
  } catch (err) {
    const failure = err as { errors?: Message[] };
    return { errors: failure.errors ?? [], bytes: 0 };
  }
};

const nodeBuiltinErrors = (errors: Message[]): string[] =>
  errors
    .map((e) => e.text)
    .filter((text) => /Could not resolve "(node:)?[a-z_/]+"/.test(text))
    .map((text) => text.match(/Could not resolve "([^"]+)"/)?.[1] ?? text);

describe("serverless contract: host-neutral runtime boundary", () => {
  it("positive control: a plain Request/Response handler bundles for the Web", async () => {
    const { errors, bytes } = await bundleForWeb(resolve(here, "__fixtures__/portable-handler.ts"));
    expect(errors).toEqual([]);
    expect(bytes).toBeGreaterThan(0);
  });

  it("the portable request-execution graph has no Node resolution errors", async () => {
    const entries = [
      resolve(here, "request-execution.ts"),
      resolve(here, "web-response.ts"),
      resolve(here, "route-matching.ts"),
    ];
    for (const entry of entries) {
      const { errors } = await bundleForWeb(entry);
      expect(nodeBuiltinErrors(errors), `${entry} leaks Node builtins`).toEqual([]);
      expect(errors, `${entry} does not bundle for the Web`).toEqual([]);
    }
  });

  it("negative control: the Node runtime entrypoints still fail the boundary", async () => {
    // These modules own fs/module loading and Node I/O. They MUST stay outside
    // the portable graph; a pass here means the control is broken.
    for (const entry of ["server-scripts.ts", "api-runtime.ts", "server.ts"]) {
      const { errors } = await bundleForWeb(resolve(here, entry));
      expect(nodeBuiltinErrors(errors).length, `${entry} unexpectedly bundled for the Web`).toBeGreaterThan(0);
    }
  });
});

describe("serverless contract: documentation says what works today", () => {
  const read = (rel: string) => readFile(resolve(docsContent, rel), "utf8");

  it("api-routes.md does not claim unconditional cross-host portability", async () => {
    const md = await read("api-routes.md");
    expect(md).not.toMatch(/completely portable/i);
    expect(md).not.toMatch(/without modification on serverless/i);
    // The former unconditional host list is gone; hosts appear only next to
    // the support matrix language.
    expect(md).not.toMatch(/^- Fastly Compute$/m);
    expect(md).toMatch(/serverless/i);
  });

  it("deployment/index.md gates static hosting on every request-time feature, not only data-bascik-server", async () => {
    const md = await read("deployment/index.md");
    const staticSection = md.slice(md.indexOf("## Static hosting"));
    expect(staticSection).toMatch(/data-bascik-stream/);
    expect(staticSection).toMatch(/API route/i);
  });

  it("server-scripts.md and stream-scripts.md name the serverless target", async () => {
    for (const page of ["server-scripts.md", "stream-scripts.md"]) {
      const md = await read(page);
      expect(md, page).toMatch(/serverless|Cloudflare/i);
    }
  });
});
