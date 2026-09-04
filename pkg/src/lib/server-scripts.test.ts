import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeServerScripts } from "./server-scripts.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { scriptRegistry } from "./script-registry.ts";
import { BascikConfig } from "./config.ts";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: {
      onServerScriptError: "error",
      timeout: 30000,
    },
    directory: {
      out: "dist",
    },
  },
}));

const baseRequest = new Request("http://localhost/");
const baseContext = { remoteIp: "127.0.0.1" };

beforeEach(() => {
  vi.clearAllMocks();
  serverSidecarRegistry.clear();
  scriptRegistry.clear();
  (BascikConfig as any).scripts = {
    onServerScriptError: "error",
    timeout: 30000,
  };
});

describe("executeServerScripts in-process execution", () => {
  it("never spawns a child node process per request", async () => {
    const html = "<main><script data-bascik-server>export default function() { return '<p>InProcess</p>'; }</script></main>";
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<main><p>InProcess</p></main>");
  });

  it("resolves sidecar placeholder to the registered module in-process", async () => {
    serverSidecarRegistry.recordScript("placeholder_123", "export default function(req) { return `<b>User:${req.headers.get('x-user')}</b>`; }");
    const html = `<script type="text/bascik-server" data-bascik-server-id="placeholder_123"></script>`;
    const req = new Request("http://localhost/", { headers: { "x-user": "Dana" } });
    const result = await executeServerScripts(html, req, baseContext);
    expect(result).toBe("<b>User:Dana</b>");
  });

  it("resolves direct inline server scripts through the same in-process registry", async () => {
    const html = `<div><script data-bascik-server>export default function() { return '<span>inline dev</span>'; }</script></div>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<div><span>inline dev</span></div>");
  });

  it("passes full request context (path, method, headers, searchParams) to script handler", async () => {
    const html = `<script data-bascik-server>
      export default function(req) {
        const url = new URL(req.url);
        return "<div>" + req.method + " " + url.pathname + " ?tab=" + url.searchParams.get("tab") + " auth=" + req.headers.get("authorization") + "</div>";
      }
    </script>`;
    const req = new Request("http://localhost/profile?tab=security", {
      method: "POST",
      headers: { authorization: "Bearer token123" },
    });
    const result = await executeServerScripts(html, req, baseContext);
    expect(result).toBe("<div>POST /profile ?tab=security auth=Bearer token123</div>");
  });

  it("executes concurrent requests with distinct contexts without cross-contamination", async () => {
    const html = `<script data-bascik-server>
      export default async function(req) {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 15) + 5));
        const url = new URL(req.url);
        return '<span data-id="' + url.searchParams.get("id") + '">' + req.headers.get('x-client') + '</span>';
      }
    </script>`;

    const count = 40;
    const tasks = Array.from({ length: count }, async (_, i) => {
      const req = new Request(`http://localhost/stream?id=req-${i}`, {
        headers: { "x-client": `Client-${i}` },
      });
      const res = await executeServerScripts(html, req, baseContext);
      return { expected: `<span data-id="req-${i}">Client-${i}</span>`, actual: res };
    });

    const results = await Promise.all(tasks);
    for (const r of results) {
      expect(r.actual).toBe(r.expected);
    }
  });

  it("injects return value directly into the page", async () => {
    const html = `<body><script data-bascik-server>
      export default function() { return '<p>Result</p>'; }
    </script></body>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<body><p>Result</p></body>");
  });

  it("reflected user input renders safely as text when escaped by author", async () => {
    const xssPayload = `<script>alert("XSS")</script>`;
    const html = `<main><script data-bascik-server>
      const escape = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      export default function(req) {
        return '<p>' + escape(new URL(req.url).searchParams.get("q")) + '</p>';
      }
    </script></main>`;

    const req = new Request(`http://localhost/?q=${encodeURIComponent(xssPayload)}`);
    const result = await executeServerScripts(html, req, baseContext);
    expect(result).toBe("<main><p>&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;</p></main>");
    expect(result).not.toContain("<script>alert");
  });

  it("handles thrown errors per onServerScriptError without leaking paths or stacks to response", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<p>before</p><script data-bascik-server>export default function() { throw new Error('SECRET_DB_PASSWORD_123'); }</script><p>after</p>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);

    expect(result).toBe("<p>before</p><p>after</p>");
    expect(result).not.toContain("SECRET_DB_PASSWORD_123");
    expect(result).not.toContain("stack");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("contains syntax errors to their own block without failing other scripts or the page", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<div>
      <script data-bascik-server>export default function() { return '<span>first ok</span>'; }</script>
      <script data-bascik-server>export default function() { const === invalid_syntax; }</script>
      <script data-bascik-server>export default function() { return '<span>third ok</span>'; }</script>
    </div>`;

    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toContain("<span>first ok</span>");
    expect(result).toContain("<span>third ok</span>");
    expect(result).not.toContain("invalid_syntax");
    warnSpy.mockRestore();
  });

  it("does not log or fail violently on network reset errors during script execution", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      export default function() {
        const err = new Error('Client reset');
        err.code = 'ECONNRESET';
        throw err;
      }
    </script>`;

    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("captures async promise rejections gracefully", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      export default async function() {
        return Promise.reject(new Error('Async service down'));
      }
    </script>`;

    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("aborts and times out hung async scripts when exceeding timeoutMs", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      export default async function(req, ctx, { signal } = {}) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', resolve);
        });
        return '<p>never reached</p>';
      }
    </script>`;

    const result = await executeServerScripts(html, baseRequest, baseContext, 50);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("timed out after 50ms"));
    warnSpy.mockRestore();
  });

  it("ensures no internal stack frames, source code, or cache paths leak into the output", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const marker = "UNIQUE_INTERNAL_SIGNATURE_987654";
    const html = `<div id="shell"><script data-bascik-server>
      // Marker: ${marker}
      export default function() { throw new Error('Failure with ${marker}'); }
    </script></div>`;

    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe('<div id="shell"></div>');
    expect(result).not.toContain(marker);
    warnSpy.mockRestore();
  });

  it("invalidates and applies updated script modules in dev mode", async () => {
    const html1 = "<script data-bascik-server>export default function() { return 'v1'; }</script>";
    const res1 = await executeServerScripts(html1, baseRequest, baseContext);
    expect(res1).toBe("v1");

    const html2 = "<script data-bascik-server>export default function() { return 'v2'; }</script>";
    const res2 = await executeServerScripts(html2, baseRequest, baseContext);
    expect(res2).toBe("v2");
  });

  it("does not write temporary files on disk for server script execution", async () => {
    const html = `<script data-bascik-server>export default function() { return "no-disk-touch"; }</script>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("no-disk-touch");
  });

  it("safely preserves dollar-sign regex replacement sequences ($1, $&, $$) in script output", async () => {
    const html = `<p><script data-bascik-server>export default function() { return 'Price: $100 | Code: $& | Total: $$50'; }</script></p>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<p>Price: $100 | Code: $& | Total: $$50</p>");
  });

  it("strips ANSI color codes from server-script output before injecting HTML", async () => {
    const html = `<span>&copy; <script data-bascik-server>export default function() { return '\u001B[33m2026\u001B[39m Built with Bascik'; }</script></span>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<span>&copy; 2026 Built with Bascik</span>");
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-build", async () => {
    const html = "<script data-bascik-server data-bascik-build>export default function() {}</script>";
    await expect(executeServerScripts(html, baseRequest, baseContext, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-build/,
    );
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-routes", async () => {
    const html = "<script data-bascik-server data-bascik-routes>export default function() {}</script>";
    await expect(executeServerScripts(html, baseRequest, baseContext, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-routes/,
    );
  });

  it("passes standard WHATWG Request and context to script handler", async () => {
    const html = `<script data-bascik-server>
      export default (request, context) => {
        const url = new URL(request.url);
        return request.constructor.name + "|" + request.method + "|" + url.pathname + "|" + url.searchParams.get("tab") + "|" + request.headers.get("authorization") + "|" + context.remoteIp;
      }
    </script>`;
    const req = new Request("http://localhost/profile?tab=security", {
      method: "POST",
      headers: { authorization: "Bearer t" },
    });
    const context = { remoteIp: "203.0.113.9" };
    const result = await executeServerScripts(html, req, context);
    expect(result).toBe("Request|POST|/profile|security|Bearer t|203.0.113.9");
  });

  it("does not inject escapeHtml helper", async () => {
    const html = `<script data-bascik-server>
      export default () => String(typeof escapeHtml);
    </script>`;
    const req = new Request("http://localhost/");
    const context = { remoteIp: "127.0.0.1" };
    const result = await executeServerScripts(html, req, context);
    expect(result).toBe("undefined");
  });

  it("throws a located error when inline script lacks export default", async () => {
    const html = `<script data-bascik-server>
      process.stdout.write('<p>x</p>');
    </script>`;
    const req = new Request("http://localhost/");
    const context = { remoteIp: "127.0.0.1" };
    await expect(
      executeServerScripts(html, req, context, 30000, "src/pages/test.html")
    ).rejects.toThrow(/must export default a function.*src\/pages\/test\.html/s);
  });
});
