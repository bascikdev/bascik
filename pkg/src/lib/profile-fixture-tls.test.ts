import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureTrust, http2Request } from "../../bench/profile-tls.ts";
import { cleanGeneratorEnvironment } from "../../bench/profile-workload.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "bascik-fixture-tls-"));
  roots.push(root);
  return root;
}
async function secureServer(trust: { keyPath: string; certPath: string }) {
  const server = http2.createSecureServer({ key: await readFile(trust.keyPath), cert: await readFile(trust.certPath) }, (request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end(`exact ${request.url}`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { origin: `https://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("fixture TLS trust", () => {
  it("issues a private CA and a SAN-bearing server certificate with owner-only keys", async () => {
    const trust = await createFixtureTrust(join(await temporaryRoot(), "tls"), ["127.0.0.1"]);
    for (const path of [trust.keyPath, trust.caKeyPath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    const { X509Certificate } = await import("node:crypto");
    const certificate = new X509Certificate(await readFile(trust.certPath));
    const authority = new X509Certificate(await readFile(trust.caPath));
    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(certificate.checkIssued(authority)).toBe(true);
    expect(certificate.verify(authority.publicKey)).toBe(true);
    expect(authority.ca).toBe(true);
    expect(certificate.ca).toBe(false);
  });
  it("verifies the server with the fixture CA and rejects a wrong CA or a hostname mismatch", async () => {
    const root = await temporaryRoot();
    const trust = await createFixtureTrust(join(root, "tls"), ["127.0.0.1"]);
    const other = await createFixtureTrust(join(root, "other"), ["127.0.0.1"]);
    const mismatched = await createFixtureTrust(join(root, "mismatched"), ["localhost"]);
    const server = await secureServer(trust);
    const wrongName = await secureServer(mismatched);
    try {
      await expect(http2Request(server.origin, "/probe", await readFile(trust.caPath))).resolves.toMatchObject({ status: 200, body: Buffer.from("exact /probe") });
      await expect(http2Request(server.origin, "/probe", await readFile(other.caPath))).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
      await expect(http2Request(wrongName.origin, "/probe", await readFile(mismatched.caPath))).rejects.toThrow(/altnames|hostname|IP/i);
      await expect(http2Request(server.origin, "/probe", undefined)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
    } finally { await Promise.all([server.close(), wrongName.close()]); }
  });
  it("makes the load generator fail closed against a server it does not trust", async () => {
    const root = await temporaryRoot();
    const trust = await createFixtureTrust(join(root, "tls"), ["127.0.0.1"]);
    const other = await createFixtureTrust(join(root, "other"), ["127.0.0.1"]);
    const server = await secureServer(trust);
    const load = fileURLToPath(new URL("../../bench/profile-load.ts", import.meta.url));
    const run = async (caPath: string) => {
      const child = fork(load, [server.origin, "identity", "1", "false", "http2", caPath], { execArgv: [], env: cleanGeneratorEnvironment(process.env), stdio: ["ignore", "ignore", "pipe", "ipc"], cwd: root });
      const stderr: Buffer[] = [];
      child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("message", (message: { event: string }) => { if (message.event === "start" || message.event === "end" || message.event === "complete") child.send({ ok: true }); });
      const [code] = await once(child, "exit") as [number | null];
      return { code, stderr: Buffer.concat(stderr).toString("utf8") };
    };
    try {
      const rejected = await run(other.caPath);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toMatch(/self[- ]signed|unable to verify|certificate/i);
    } finally { await server.close(); }
  }, 20_000);
});
