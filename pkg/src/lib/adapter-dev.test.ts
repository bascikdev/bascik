import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterDevHtmlTransform,
  adapterDevCsp,
  startAdapterDev,
} from "./adapter-dev.ts";
import type { CliFlags } from "./cli.ts";

const transform = async (chunks: Buffer[]): Promise<string> => {
  const stream = Readable.from(chunks).pipe(new AdapterDevHtmlTransform(7));
  let result = "";
  for await (const chunk of stream) result += chunk;
  return result;
};

describe("adapter dev HTTP boundary", () => {
  it("injects one same-origin external client across split head and UTF-8 bytes", async () => {
    const html =
      "<!doctype html><html><head><title>café</title></head><body>ok</body></html>";
    const bytes = Buffer.from(html);
    const result = await transform(
      [...bytes].map((byte) => Buffer.from([byte])),
    );
    expect(result).toContain(
      '<head><script data-bascik-live-reload src="/__bascik_adapter_dev/client.js?v=7" defer></script><title>café</title>',
    );
    expect(result.match(/data-bascik-live-reload/g)).toHaveLength(1);
    expect(result).toContain("<body>ok</body>");
  });

  it("passes HTML fragments through unchanged", async () => {
    expect(await transform([Buffer.from("<p>API fragment</p>")])).toBe(
      "<p>API fragment</p>",
    );
  });

  it("does not hold the initial shell until the response ends", async () => {
    const stream = new AdapterDevHtmlTransform(1);
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    stream.write(Buffer.from("<html><head></head><body>shell"));
    expect(chunks.join("")).toContain("shell");
    stream.end(Buffer.from("<p>late</p></body></html>"));
    expect(chunks.join("")).toContain("<p>late</p>");
  });

  it("allows only same-origin dev transport while preserving policy restrictions", () => {
    const policy = adapterDevCsp(
      "default-src 'none'; script-src 'sha256-abc'; connect-src https://api.example; img-src data:",
    );
    expect(policy).toContain("script-src 'sha256-abc' 'self'");
    expect(policy).toContain("connect-src https://api.example 'self'");
    expect(policy).toContain("script-src-elem 'sha256-abc' 'self'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
  });
});

// Finding 127: a custom adapter without a dev hook failed `bascik --target`
// with "does not support local development" and no pointer to the hook that
// adds it, which the Custom Adapters page did not document either.
describe("startAdapterDev without a dev hook", () => {
  it("misuse: names the missing dev hook and the docs section that adds one", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-adapter-no-dev-"));
    await writeFile(
      join(root, "no-dev.mjs"),
      'export default { name: "custom-node", build: async () => ({ publicDir: "public" }) };\n',
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const error = await startAdapterDev([], {
        target: "./no-dev.mjs",
      } as CliFlags).then(
        () => undefined,
        (caught: Error) => caught,
      );
      expect(error?.message).toBe(
        '[bascik] Adapter "custom-node" has no dev() hook, so `bascik --target ./no-dev.mjs` cannot run it locally.\n' +
          "  Add one: https://bascik.dev/deployment/custom-adapters#step-7-add-local-development\n" +
          "  Or build and run the output yourself: bascik --build --target ./no-dev.mjs",
      );
    } finally {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
