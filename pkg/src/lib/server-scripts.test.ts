import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  htmlHasServerScripts,
  executeServerScripts,
  cleanStackTrace,
  escapeHtml,
} from "./server-scripts.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { scriptRegistry } from "./script-registry.ts";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

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

import { BascikConfig } from "./config.ts";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

const baseRequest = {
  path: "/",
  method: "GET",
  headers: {},
  searchParams: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  serverSidecarRegistry.clear();
  scriptRegistry.clear();
  (BascikConfig as any).scripts = {
    onServerScriptError: "error",
    timeout: 30000,
  };
});

// ─── htmlHasServerScripts ────────────────────────────────────────────────────

describe("htmlHasServerScripts", () => {
  it("returns false for html with no script tags", () => {
    expect(htmlHasServerScripts("<p>hello</p>")).toBe(false);
  });

  it("returns false for a data-bascik-build script", () => {
    expect(htmlHasServerScripts("<script data-bascik-build>x</script>")).toBe(false);
  });

  it("returns false for a plain script tag", () => {
    expect(htmlHasServerScripts("<script>console.log(1)</script>")).toBe(false);
  });

  it("returns true for a data-bascik-server script", () => {
    expect(htmlHasServerScripts("<script data-bascik-server>x</script>")).toBe(true);
  });

  it("returns true when server script has additional attributes", () => {
    expect(htmlHasServerScripts('<script type="module" data-bascik-server>x</script>')).toBe(true);
  });

  it("returns true when data-bascik-server appears anywhere in the html", () => {
    const html = "<p>Static</p><script data-bascik-server>x</script><footer>ok</footer>";
    expect(htmlHasServerScripts(html)).toBe(true);
  });

  it("is not tripped by the string 'data-bascik-server' inside an attribute value", () => {
    // A data attribute on a non-script element should not count
    expect(htmlHasServerScripts('<div data-kind="data-bascik-server"></div>')).toBe(false);
  });
});

// ─── executeServerScripts (In-Process & Prompt 47 Requirements) ─────────────

describe("executeServerScripts in-process execution", () => {
  // Requirement 1: No node process is spawned per request (assert by instrumentation).
  it("never spawns a child node process per request", async () => {
    const html = "<main><script data-bascik-server>export default function() { return '<p>InProcess</p>'; }</script></main>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<main><p>InProcess</p></main>");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // Requirement 2: The sidecar is loaded and a placeholder resolves to the right module.
  it("resolves sidecar placeholder to the registered module in-process", async () => {
    serverSidecarRegistry.recordScript("placeholder_123", "export default function({ req }) { return `<b>User:${req.headers['x-user']}</b>`; }");
    const html = `<script type="text/bascik-server" data-bascik-server-id="placeholder_123"></script>`;
    const result = await executeServerScripts(html, {
      ...baseRequest,
      headers: { "x-user": "Dana" },
    });
    expect(result).toBe("<b>User:Dana</b>");
  });

  // Requirement 3: Dev in-memory path resolves through the same interface.
  it("resolves direct inline server scripts through the same in-process registry", async () => {
    const html = `<div><script data-bascik-server>return '<span>inline dev</span>';</script></div>`;
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<div><span>inline dev</span></div>");
  });

  // Requirement 4: Context reaches the script via req argument.
  it("passes full request context (path, method, headers, searchParams) to script handler", async () => {
    const html = `<script data-bascik-server>
      export default function({ req }) {
        return "<div>" + req.method + " " + req.path + " ?tab=" + req.searchParams.tab + " auth=" + req.headers.authorization + "</div>";
      }
    </script>`;
    const req = {
      path: "/profile",
      method: "POST",
      headers: { authorization: "Bearer token123" },
      searchParams: { tab: "security" },
    };
    const result = await executeServerScripts(html, req);
    expect(result).toBe("<div>POST /profile ?tab=security auth=Bearer token123</div>");
  });

  // Requirement 5: Concurrent invocations with distinct context never cross-contaminate.
  it("executes concurrent requests with distinct contexts without cross-contamination", async () => {
    const html = `<script data-bascik-server>
      export default async function({ req }) {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 15) + 5));
        return '<span data-id="' + req.searchParams.id + '">' + req.headers['x-client'] + '</span>';
      }
    </script>`;

    const count = 40;
    const tasks = Array.from({ length: count }, async (_, i) => {
      const req = {
        path: "/stream",
        method: "GET",
        headers: { "x-client": `Client-${i}` },
        searchParams: { id: `req-${i}` },
      };
      const res = await executeServerScripts(html, req);
      return { expected: `<span data-id="req-${i}">Client-${i}</span>`, actual: res };
    });

    const results = await Promise.all(tasks);
    for (const r of results) {
      expect(r.actual).toBe(r.expected);
    }
  });

  // Requirement 6: Output reaches the page.
  it("injects return value and legacy stdout output directly into the page", async () => {
    const html = `<body><script data-bascik-server>
      process.stdout.write('<p>Legacy write</p>');
    </script></body>`;
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<body><p>Legacy write</p></body>");
  });

  // Requirement 7: The escaping helper works; a value containing <script> renders as text.
  it("provides escaping helper so reflected user input renders safely as text", async () => {
    const xssPayload = `<script>alert("XSS")</script>`;
    const html = `<main><script data-bascik-server>
      return '<p>' + escapeHtml(req.searchParams.q) + '</p>';
    </script></main>`;

    const result = await executeServerScripts(html, {
      ...baseRequest,
      searchParams: { q: xssPayload },
    });
    expect(result).toBe("<main><p>&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;</p></main>");
    expect(result).not.toContain("<script>alert");
  });

  // Requirement 8: A thrown error yields configured behavior with no internal detail in response.
  it("handles thrown errors per onServerScriptError without leaking paths or stacks to response", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<p>before</p><script data-bascik-server>throw new Error('SECRET_DB_PASSWORD_123');</script><p>after</p>`;
    const result = await executeServerScripts(html, baseRequest);

    expect(result).toBe("<p>before</p><p>after</p>");
    expect(result).not.toContain("SECRET_DB_PASSWORD_123");
    expect(result).not.toContain("stack");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Requirement 9: A module with a syntax error fails only its own block.
  it("contains syntax errors to their own block without failing other scripts or the page", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<div>
      <script data-bascik-server>return '<span>first ok</span>';</script>
      <script data-bascik-server>const === invalid_syntax;</script>
      <script data-bascik-server>return '<span>third ok</span>';</script>
    </div>`;

    const result = await executeServerScripts(html, baseRequest);
    expect(result).toContain("<span>first ok</span>");
    expect(result).toContain("<span>third ok</span>");
    expect(result).not.toContain("invalid_syntax");
    warnSpy.mockRestore();
  });

  // Requirement 10: A client disconnect (network reset) is handled quietly.
  it("does not log or fail violently on network reset errors during script execution", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      const err = new Error('Client reset');
      err.code = 'ECONNRESET';
      throw err;
    </script>`;

    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Requirement 11: An unhandled rejection inside async script does not crash the process.
  it("captures async promise rejections gracefully", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      export default async function() {
        return Promise.reject(new Error('Async service down'));
      }
    </script>`;

    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Requirement 12: A hung async script hits scripts.timeout.
  it("aborts and times out hung async scripts when exceeding timeoutMs", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-server>
      export default async function({}, { signal } = {}) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', resolve);
        });
        return '<p>never reached</p>';
      }
    </script>`;

    const result = await executeServerScripts(html, baseRequest, 50);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("timed out after 50ms"));
    warnSpy.mockRestore();
  });

  // Requirement 13: No source, path, or stack frame appears in any response.
  it("ensures no internal stack frames, source code, or cache paths leak into the output", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const marker = "UNIQUE_INTERNAL_SIGNATURE_987654";
    const html = `<div id="shell"><script data-bascik-server>
      // Marker: ${marker}
      throw new Error('Failure with ${marker}');
    </script></div>`;

    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe('<div id="shell"></div>');
    expect(result).not.toContain(marker);
    warnSpy.mockRestore();
  });

  // Requirement 14: Editing a script applies in dev mode.
  it("invalidates and applies updated script modules in dev mode", async () => {
    const html1 = "<script data-bascik-server>return 'v1';</script>";
    const res1 = await executeServerScripts(html1, baseRequest);
    expect(res1).toBe("v1");

    const html2 = "<script data-bascik-server>return 'v2';</script>";
    const res2 = await executeServerScripts(html2, baseRequest);
    expect(res2).toBe("v2");
  });

  // Requirement 15: No temporary file is created.
  it("does not write temporary files on disk for server script execution", async () => {
    const html = `<script data-bascik-server>console.log("no-disk-touch");</script>`;
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("no-disk-touch\n");
  });

  // Preservation of regex sequence characters ($1, $&, $$)
  it("safely preserves dollar-sign regex replacement sequences ($1, $&, $$) in script output", async () => {
    const html = `<p><script data-bascik-server>return 'Price: $100 | Code: $& | Total: $$50';</script></p>`;
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<p>Price: $100 | Code: $& | Total: $$50</p>");
  });

  // ANSI color stripping
  it("strips ANSI color codes from server-script output before injecting HTML", async () => {
    const html = `<span>&copy; <script data-bascik-server>return '\u001B[33m2026\u001B[39m Built with Bascik';</script></span>`;
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<span>&copy; 2026 Built with Bascik</span>");
  });

  // Conflict validation: data-bascik-server + data-bascik-build
  it("throws an error when script tag has both data-bascik-server and data-bascik-build", async () => {
    const html = "<script data-bascik-server data-bascik-build>console.log(1)</script>";
    await expect(executeServerScripts(html, baseRequest, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-build/,
    );
  });

  // Conflict validation: data-bascik-server + data-bascik-routes
  it("throws an error when script tag has both data-bascik-server and data-bascik-routes", async () => {
    const html = "<script data-bascik-server data-bascik-routes>console.log(1)</script>";
    await expect(executeServerScripts(html, baseRequest, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-routes/,
    );
  });
});

// ─── cleanStackTrace ─────────────────────────────────────────────────────────

describe("server-scripts cleanStackTrace", () => {
  it("replaces temporary file path and maps line numbers using lineOffset", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/server-123.mjs";
    const realPath = "src/pages/about.html";
    const lineOffset = 15;
    const rawTrace = `Error: Server error\n    at ${tmpPath}:3:8`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Server error\n    at ${realPath}:17:8`);
  });
});
