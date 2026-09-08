import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface FixtureTrust { caPath: string; caKeyPath: string; keyPath: string; certPath: string }

/**
 * Issues a private fixture certificate authority and one server certificate whose SAN covers `hosts`.
 * Harness clients trust only `caPath`; nothing is installed globally and no verification is bypassed.
 * The directory is created owner-only and private keys are chmod 0600. Requires `openssl` on PATH.
 */
export async function createFixtureTrust(directory: string, hosts: string[]): Promise<FixtureTrust> {
  assert(hosts.length > 0 && hosts.every((host) => /^[A-Za-z0-9.:-]+$/.test(host)), "fixture trust hosts must be plain hostnames or IP literals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const trust: FixtureTrust = { caPath: join(directory, "ca.pem"), caKeyPath: join(directory, "ca-key.pem"), keyPath: join(directory, "server-key.pem"), certPath: join(directory, "server.pem") };
  const request = join(directory, "server.csr");
  const extensions = join(directory, "server.ext");
  const altNames = hosts.map((host) => `${/^[\d.]+$|:/.test(host) ? "IP" : "DNS"}:${host}`).join(",");
  await writeFile(extensions, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${altNames}\n`, { mode: 0o600 });
  await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=bascik-fixture-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", trust.caKeyPath, "-out", trust.caPath]);
  await execFile("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=bascik-fixture-server", "-keyout", trust.keyPath, "-out", request]);
  await execFile("openssl", ["x509", "-req", "-sha256", "-days", "2", "-in", request, "-CA", trust.caPath, "-CAkey", trust.caKeyPath, "-CAcreateserial", "-extfile", extensions, "-out", trust.certPath]);
  await Promise.all([trust.caKeyPath, trust.keyPath].map((path) => chmod(path, 0o600)));
  return trust;
}

export interface Http2Response { status: number; headers: http2.IncomingHttpHeaders; body: Buffer }

/** One verified HTTP/2 request using only the supplied CA; the session is always destroyed afterwards. */
export async function http2Request(origin: string, path: string, ca: Buffer | undefined, headers: http2.OutgoingHttpHeaders = {}, timeoutMs = 10_000): Promise<Http2Response> {
  const session = http2.connect(origin, { ca });
  const deadline = setTimeout(() => session.destroy(new Error(`HTTP/2 request deadline exceeded for ${path}`)), timeoutMs);
  try {
    return await new Promise<Http2Response>((resolve, reject) => {
      session.once("error", reject);
      const stream = session.request({ ":path": path, ...headers });
      let status = 0;
      let responseHeaders: http2.IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      stream.once("error", reject);
      stream.on("response", (received) => { status = Number(received[":status"]); responseHeaders = received; });
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) }));
      stream.end();
    });
  } finally { clearTimeout(deadline); session.destroy(); }
}
