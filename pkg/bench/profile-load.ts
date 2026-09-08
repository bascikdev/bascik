import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { assetBytes, apiBody, streamBody } from "./profile-fixture.ts";
import { digest, validateResponses, type ExpectedResponse, type ObservedResponse } from "./profile-workload.ts";

const [origin, encoding, roundsText, injectFailure, scenario, fixtureCaPath] = process.argv.slice(2);
const rounds = Number(roundsText);
const agent = new http.Agent({ keepAlive: true, maxSockets: 12 });
assert(scenario !== "http2" || fixtureCaPath, "HTTP/2 load requires the fixture CA path; peer verification is never bypassed");
// The session trusts only the private fixture CA that signed the subject's server certificate.
const session = scenario === "http2" ? http2.connect(origin, { ca: readFileSync(fixtureCaPath) }) : undefined;
session?.on("error", (error) => { console.error(error); process.exitCode = 1; });
async function request(path: string, id: string): Promise<ObservedResponse> {
  const start = performance.now();
  if (session) return new Promise((resolve, reject) => {
    const req = session.request({ ":path": path, "accept-encoding": encoding });
    let status = 0;
    let responseEncoding = "identity";
    const chunks: Buffer[] = [];
    req.on("response", (headers) => { status = Number(headers[":status"]); responseEncoding = String(headers["content-encoding"] ?? "identity"); });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`request timeout ${id}`)));
    req.on("end", () => resolve({ id, status, encoding: responseEncoding, body: Buffer.concat(chunks), durationMs: performance.now() - start }));
    req.end();
  });
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}${path}`, { agent, headers: { "accept-encoding": encoding } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ id, status: response.statusCode ?? 0, encoding: String(response.headers["content-encoding"] ?? "identity"), body: Buffer.concat(chunks), durationMs: performance.now() - start }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error(`request timeout ${id}`)));
    req.on("error", reject);
  });
}
function percentile(values: number[], quantile: number) {
  return values.toSorted((left, right) => left - right)[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0;
}
try {
  assert(!process.env.NODE_OPTIONS && process.execArgv.length === 0, "load generator must be uninstrumented");
  const phases = [];
  const asset = assetBytes();
  const distinctAssets = Array.from({ length: 8 }, (_, index) => assetBytes(index + 1));
  for (const phase of ["cache-cold", "cache-warm", scenario === "static" ? "static-page" : "api-stream", ...(["http1", "http2"].includes(scenario) ? ["distinct-assets"] : [])]) {
    const acknowledgment = once(process, "message");
    process.send!({ phase, event: "start" });
    await acknowledgment;
    const startedAt = Date.now();
    const start = performance.now();
    const expected: ExpectedResponse[] = [];
    const responses: ObservedResponse[] = [];
    await Promise.all(Array.from({ length: 4 }, async (_, lane) => {
      for (let round = 0; round < rounds; round++) {
        const paths = phase === "distinct-assets" ? [`/asset-${lane * 2}.txt`, `/asset-${lane * 2 + 1}.txt`, "/_health/ready"] : phase === "static-page" ? ["/page-0.html"] : phase === "api-stream" ? [lane % 2 === 0 || scenario === "dev" ? "/api/probe" : "/stream"] : ["/asset.txt", scenario === "static" ? "/readiness.json" : "/_health/ready"];
        const visit = async (path: string) => {
          const id = `${phase}:${lane}:${round}:${path}`;
          const distinct = /^\/asset-(\d+)\.txt$/.exec(path);
          const body = distinct ? distinctAssets[Number(distinct[1])] : path === "/asset.txt" ? asset : path === "/page-0.html" ? await readFileAsync("dist/page-0.html") : Buffer.from(path === "/api/probe" ? apiBody : path === "/stream" ? streamBody : '{"status":"ok","ready":true}');
          expected.push({ id, body, encoding: path.endsWith(".txt") ? encoding : "identity" });
          responses.push(await request(injectFailure === "true" && lane === 0 && round === 0 ? "/injected-failure" : path, id));
        };
        if (phase === "distinct-assets") await Promise.all(paths.map(visit));
        else for (const path of paths) await visit(path);
      }
    }));
    const durationMs = performance.now() - start;
    const acceptance = validateResponses(expected, responses);
    const phaseResult = {
      phase, startedAt, endedAt: Date.now(), durationMs, ...acceptance,
      latency: Object.fromEntries(["/asset.txt", "/_health/ready", "/api/probe", "/stream"].map((path) => {
        const values = responses.filter((response) => response.id.endsWith(path)).map((response) => response.durationMs);
        return [path, { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) }];
      })),
      tasks: responses.map(({ body, ...response }) => ({ ...response, bytes: body.length, sha256: digest(body) })),
    };
    phases.push(phaseResult);
    const endAcknowledgment = once(process, "message");
    process.send!({ event: "end", phase });
    await endAcknowledgment;
  }
  const completionAcknowledgment = once(process, "message");
  process.send!({ event: "complete", phases, generator: { pid: process.pid, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null } });
  await completionAcknowledgment;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  agent.destroy();
  session?.destroy();
  process.disconnect();
}