/**
 * Integration test for request origin reconstruction behind trusted reverse proxies
 * across real HTTP/1.1 and HTTP/2 wire transports.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    http: {
      httpCache: false,
      compression: false,
      rateLimit: false,
      tls: { enabled: false },
      trustProxy: false,
      maxBodySize: 1024,
      apiTimeout: 10000,
    },
    scripts: { timeout: 30000, onServerScriptError: "error" },
    logging: { level: "silent", requests: false },
    isProdServer: false,
    directory: { pages: "src/pages", components: ["src/components"], api: "src/api", out: "" },
    minify: { identifiers: false },
  },
}));

vi.mock("./config.js", () => ({
  shouldLog: () => false,
  BascikConfig: configState,
}));

import { adaptHttp1 } from "./http.ts";
import { adaptHttp2 } from "./http2.ts";
import { createRequestHandler } from "./server.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { buildApiRouteTree } from "./api-routes.ts";
import { executeServerScriptPlan, planServerScripts } from "./server-scripts.ts";
import { createWebRequest, requestOrigin } from "./api-runtime.ts";

interface Reply {
  status: number;
  body: string;
  data?: any;
}

const API = "/app/src/api";

describe("trusted proxy origin reconstruction over HTTP/1.1 and HTTP/2", () => {
  let h1: http.Server;
  let h2: http2.Http2Server;
  let h1Port: number;
  let h2Port: number;
  const originalRoutes = (apiRouteRegistry as any).routes;

  beforeAll(async () => {
    (apiRouteRegistry as any).routes = buildApiRouteTree([`${API}/origin.ts`], API);

    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath: string) => {
      if (filePath.startsWith("data:")) {
        return (scriptRegistry.constructor.prototype as any).load.call(scriptRegistry, filePath);
      }
      return {
        filePath,
        version: 0,
        module: {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return Response.json({
              url: req.url,
              origin: url.origin,
              protocol: url.protocol,
              host: url.host,
              pathname: url.pathname,
              search: url.search,
            });
          },
        },
      };
    });

    const handle = createRequestHandler();

    h1 = http.createServer((reqMsg, resMsg) => {
      const { req, res } = adaptHttp1(reqMsg, resMsg);
      handle(req, res).catch(() => {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch {}
      });
    });
    await new Promise<void>((r) => h1.listen(0, "127.0.0.1", r));
    h1Port = (h1.address() as AddressInfo).port;

    h2 = http2.createServer();
    h2.on("stream", (stream, headers) => {
      const { req, res } = adaptHttp2(stream, headers);
      handle(req, res).catch(() => {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch {}
      });
    });
    await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
    h2Port = (h2.address() as AddressInfo).port;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    (apiRouteRegistry as any).routes = originalRoutes;
    await new Promise<void>((r) => h1.close(() => r()));
    await new Promise<void>((r) => h2.close(() => r()));
  });

  const viaHttp1 = (path: string, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: h1Port,
          path,
          method: "GET",
          headers: { ...headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let data: any;
            try {
              data = JSON.parse(body);
            } catch {}
            resolve({ status: res.statusCode ?? 0, body, data });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

  const viaHttp2 = (path: string, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const client = http2.connect(`http://127.0.0.1:${h2Port}`);
      client.on("error", reject);
      const req = client.request({
        ":method": "GET",
        ":path": path,
        ...headers,
      });
      let status = 0;
      const chunks: Buffer[] = [];
      req.on("response", (hdrs) => {
        status = Number(hdrs[":status"]);
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        client.close();
        const body = Buffer.concat(chunks).toString("utf8");
        let data: any;
        try {
          data = JSON.parse(body);
        } catch {}
        resolve({ status, body, data });
      });
      req.on("error", reject);
      req.end();
    });

  describe("when trustProxy is false (default)", () => {
    beforeAll(() => {
      configState.http.trustProxy = false;
    });

    it("HTTP/1.1 strictly ignores forwarded headers", async () => {
      const res = await viaHttp1("/api/origin?test=1", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example.com:8443",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("http:");
      expect(res.data.host).toBe(`127.0.0.1:${h1Port}`);
      expect(res.data.origin).toBe(`http://127.0.0.1:${h1Port}`);
      expect(res.data.pathname).toBe("/api/origin");
      expect(res.data.search).toBe("?test=1");
    });

    it("HTTP/2 strictly ignores forwarded headers", async () => {
      const res = await viaHttp2("/api/origin?test=2", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example.com:8443",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("http:");
      expect(res.data.host).toBe(`127.0.0.1:${h2Port}`);
      expect(res.data.origin).toBe(`http://127.0.0.1:${h2Port}`);
      expect(res.data.pathname).toBe("/api/origin");
      expect(res.data.search).toBe("?test=2");
    });
  });

  describe("when trustProxy is true", () => {
    beforeAll(() => {
      configState.http.trustProxy = true;
    });

    afterAll(() => {
      configState.http.trustProxy = false;
    });

    it("HTTP/1.1 reconstructs external https scheme and authority", async () => {
      const res = await viaHttp1("/api/origin?active=true", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com:8443",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("https:");
      expect(res.data.host).toBe("app.example.com:8443");
      expect(res.data.origin).toBe("https://app.example.com:8443");
      expect(res.data.url).toBe("https://app.example.com:8443/api/origin?active=true");
    });

    it("HTTP/2 reconstructs external https scheme and authority", async () => {
      const res = await viaHttp2("/api/origin?active=true", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com:8443",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("https:");
      expect(res.data.host).toBe("app.example.com:8443");
      expect(res.data.origin).toBe("https://app.example.com:8443");
      expect(res.data.url).toBe("https://app.example.com:8443/api/origin?active=true");
    });

    it("HTTP/1.1 extracts the rightmost entry for multi-hop / spoofed headers", async () => {
      const res = await viaHttp1("/api/origin", {
        "x-forwarded-proto": "http, https",
        "x-forwarded-host": "spoofed.attacker.com, trusted.public.com",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("https:");
      expect(res.data.host).toBe("trusted.public.com");
      expect(res.data.origin).toBe("https://trusted.public.com");
    });

    it("HTTP/2 extracts the rightmost entry for multi-hop / spoofed headers", async () => {
      const res = await viaHttp2("/api/origin", {
        "x-forwarded-proto": "http, https",
        "x-forwarded-host": "spoofed.attacker.com, trusted.public.com",
      });
      expect(res.status).toBe(200);
      expect(res.data.protocol).toBe("https:");
      expect(res.data.host).toBe("trusted.public.com");
      expect(res.data.origin).toBe("https://trusted.public.com");
    });

    it("HTTP/1.1 safely falls back when forwarded host contains path or userinfo injection", async () => {
      const res = await viaHttp1("/api/origin", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "bad/host/path",
      });
      expect(res.status).toBe(200);
      // Falls back to local authority
      expect(res.data.protocol).toBe("https:");
      expect(res.data.host).toBe(`127.0.0.1:${h1Port}`);
      expect(res.data.origin).toBe(`https://127.0.0.1:${h1Port}`);
    });

    it("server scripts share the exact same reconstructed request origin", async () => {
      const rawReq = {
        method: "GET",
        path: "/page?q=hello",
        headers: {
          host: "127.0.0.1:3000",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "scripts.example.com",
        },
        remoteIp: "10.0.0.1",
      };
      const webReq = createWebRequest(rawReq, requestOrigin(rawReq, configState as any));

      const plan = planServerScripts(
        `<p id="test"><script data-bascik-server>export default function(req) { return new URL(req.url).origin; }</script></p>`
      );
      const output = await executeServerScriptPlan(plan, webReq, { remoteIp: "10.0.0.1" }, 1000, "page.html");
      expect(output.toString()).toContain("https://scripts.example.com");
    });
  });
});
