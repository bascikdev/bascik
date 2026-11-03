import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { availableDevPort } from "./adapter-dev-platform.ts";
import { stopAdapterChild } from "./adapter-dev.ts";

let root: string | undefined;
let child: ChildProcess | undefined;
let log = "";

afterEach(async () => {
  await stopAdapterChild(child);
  child = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const waitFor = async (assertion: () => Promise<void>): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`${String(error)}\n${log}`);
      await delay(100);
    }
  }
};

it.each(["SIGINT", "runtime"] as const)(
  "rebuilds, recovers, and shuts down without a retry error on %s",
  async (shutdown) => {
    root = await mkdtemp(join(tmpdir(), "bascik-adapter-dev-"));
    await mkdir(join(root, "src/pages"), { recursive: true });
    await symlink(
      resolve("../node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "bascik.config.ts"),
      'export default { directory: { out: "output" } };',
    );
    await writeFile(join(root, "src/value.ts"), 'export default "first";');
    await writeFile(
      join(root, "src/pages/index.html"),
      `<!doctype html><html><head><title>Adapter dev</title></head><body><script data-bascik-build>import value from "../value.ts"; export default () => value;</script></body></html>`,
    );
    await writeFile(
      join(root, "local-adapter.mjs"),
      `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default {
 name: "test",
 async build({ distDir, outDir }) {
   const publicDir = join(outDir, "public");
   await mkdir(publicDir, { recursive: true });
   await writeFile(join(publicDir, "index.html"), await readFile(join(distDir, "index.html")));
   return { publicDir };
 },
 async dev({ outDir, port }) {
   return { command: process.execPath, args: [${JSON.stringify(join(root, "runtime.mjs"))}, String(port), join(outDir, "public/index.html")], cwd: ${JSON.stringify(root)} };
 }
};`,
    );
    await writeFile(
      join(root, "runtime.mjs"),
      `
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
if (process.stdin.isTTY) throw new Error("Managed runtime must not inherit terminal input");
const server = createServer(async (req, res) => {
 if (req.url === "/quit") {
   res.end("Stopping");
   server.close(() => process.exit(0));
   return;
 }
 if (req.url === "/stream") {
   res.writeHead(200, {"content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'none'; connect-src 'none'"});
   res.write("<html><head></head><body>shell");
   setTimeout(() => res.end("<p>late</p></body></html>"), 2000);
 } else {
   const body = await readFile(process.argv[3]);
   res.writeHead(200, {"content-type":"text/html","content-length":body.length});
   res.end(body);
 }
});
server.listen(Number(process.argv[2]), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    );
    const childEnv = { ...process.env };
    delete childEnv.BASCIK_SITE_URL;
    const productionBuild = spawnSync(
      process.execPath,
      [resolve("dist/index.js"), "--build", "--target", "./local-adapter.mjs"],
      { cwd: root, env: childEnv, encoding: "utf8" },
    );
    expect(productionBuild.status).not.toBe(0);
    expect(`${productionBuild.stdout}\n${productionBuild.stderr}`).toContain(
      "BASCIK_SITE_URL is not set",
    );

    const port = await availableDevPort();
    log = "";
    child = spawn(
      process.execPath,
      [
        resolve("dist/index.js"),
        "--target",
        "./local-adapter.mjs",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    child.stdout!.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      log += chunk;
    });
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("first");
    });
    const fallbackSitemap = await readFile(
      join(root, "output/sitemap.xml"),
      "utf8",
    );
    expect(fallbackSitemap).toContain(`<loc>${url}/</loc>`);
    const fallbackRobots = await readFile(
      join(root, "output/robots.txt"),
      "utf8",
    );
    expect(fallbackRobots).toContain(`Sitemap: ${url}/sitemap.xml`);
    expect((await fetch(`${url}//%`)).status).toBe(200);
    const stream = await fetch(`${url}/stream`);
    expect(stream.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(stream.headers.get("content-length")).toBeNull();
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("shell");
    expect(new TextDecoder().decode(first.value)).not.toContain("<p>late");
    await reader.cancel();
    const events = await fetch(`${url}/__bascik_adapter_dev/events`);
    const eventReader = events.body!.getReader();
    const connected = new TextDecoder().decode(
      (await eventReader.read()).value,
    );
    expect(connected).toContain('"generation":1');
    await eventReader.cancel();
    await writeFile(
      join(root, "src/value.ts"),
      'export default "bad"; throw new Error("broken edit");',
    );
    await writeFile(
      join(root, ".env"),
      "BASCIK_SITE_URL=https://configured.example\n",
    );
    await waitFor(async () => {
      expect(log).toContain("broken edit");
      expect((await fetch(url)).status).toBe(503);
    });
    await writeFile(join(root, "src/value.ts"), 'export default "second";');
    await waitFor(async () => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("second");
    });
    const configuredSitemap = await readFile(
      join(root, "output/sitemap.xml"),
      "utf8",
    );
    expect(configuredSitemap).toContain(
      "<loc>https://configured.example/</loc>",
    );
    const output = await readFile(join(root, "output/index.html"), "utf8");
    expect(output).not.toContain("__bascik_adapter_dev");
    if (shutdown === "SIGINT") child.kill("SIGINT");
    else await fetch(`${url}/quit`);
    await once(child, "exit");
    expect(log).not.toContain("Local test runtime exited");
    child = undefined;
    await waitFor(async () => {
      await expect(fetch(url)).rejects.toThrow();
    });
  },
  90_000,
);
