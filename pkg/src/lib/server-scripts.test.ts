import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  executeServerScripts,
  pageHasServerScripts,
  planServerScripts,
  streamServerScripts,
} from "./server-scripts.ts";
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
    const html =
      "<main><script data-bascik-server>export default function() { return '<p>InProcess</p>'; }</script></main>";
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<main><p>InProcess</p></main>");
  });

  it("resolves sidecar placeholder to the registered module in-process", async () => {
    serverSidecarRegistry.recordScript(
      "placeholder_123",
      "export default function(req) { return `<b>User:${req.headers.get('x-user')}</b>`; }",
    );
    const html = `<script type="text/bascik-server" data-bascik-server-id="placeholder_123"></script>`;
    const req = new Request("http://localhost/", {
      headers: { "x-user": "Dana" },
    });
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
    expect(result).toBe(
      "<div>POST /profile ?tab=security auth=Bearer token123</div>",
    );
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
      return {
        expected: `<span data-id="req-${i}">Client-${i}</span>`,
        actual: res,
      };
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

    const req = new Request(
      `http://localhost/?q=${encodeURIComponent(xssPayload)}`,
    );
    const result = await executeServerScripts(html, req, baseContext);
    expect(result).toBe(
      "<main><p>&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;</p></main>",
    );
    expect(result).not.toContain("<script>alert");
  });

  it("handles thrown errors per onServerScriptError without leaking paths or stacks to response", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = `<script data-bascik-server>
      export default async function(req, ctx, { signal } = {}) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', resolve);
        });
        return '<p>never reached</p>';
      }
    </script>`;

    const result = await executeServerScripts(
      html,
      baseRequest,
      baseContext,
      50,
    );
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("timed out after 50ms"),
    );
    warnSpy.mockRestore();
  });

  it("ensures no internal stack frames, source code, or cache paths leak into the output", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const html1 =
      "<script data-bascik-server>export default function() { return 'v1'; }</script>";
    const res1 = await executeServerScripts(html1, baseRequest, baseContext);
    expect(res1).toBe("v1");

    const html2 =
      "<script data-bascik-server>export default function() { return 'v2'; }</script>";
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

  it("scripts.stripAnsi: false keeps ANSI codes in server-script output", async () => {
    (BascikConfig as any).scripts.stripAnsi = false;
    const html = `<span><script data-bascik-server>export default function() { return '\u001B[33m2026\u001B[39m kept'; }</script></span>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<span>\u001B[33m2026\u001B[39m kept</span>");
  });

  it("scripts.stripAnsi: true (explicit) strips as the default does", async () => {
    (BascikConfig as any).scripts.stripAnsi = true;
    const html = `<span><script data-bascik-server>export default function() { return '\u001B[1mbold\u001B[22m'; }</script></span>`;
    const result = await executeServerScripts(html, baseRequest, baseContext);
    expect(result).toBe("<span>bold</span>");
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-build", async () => {
    const html =
      "<script data-bascik-server data-bascik-build>export default function() {}</script>";
    await expect(
      executeServerScripts(
        html,
        baseRequest,
        baseContext,
        30000,
        "src/pages/index.html",
      ),
    ).rejects.toThrow(/has both data-bascik-server and data-bascik-build/);
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-routes", async () => {
    const html =
      "<script data-bascik-server data-bascik-routes>export default function() {}</script>";
    await expect(
      executeServerScripts(
        html,
        baseRequest,
        baseContext,
        30000,
        "src/pages/index.html",
      ),
    ).rejects.toThrow(/has both data-bascik-server and data-bascik-routes/);
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
      executeServerScripts(html, req, context, 30000, "src/pages/test.html"),
    ).rejects.toThrow(
      /must export default a function.*src\/pages\/test\.html/s,
    );
  });
});

describe("return values (prompt 158 R3-04, F060): arrays join like html, mistakes are located", () => {
  const page = (body: string, mode = "data-bascik-server") =>
    `<p>before</p>\n<script ${mode}>\n${body}\n</script>\n<p>after</p>`;
  // A production warning is logged once per script start position for the
  // life of the process, so each production test names its own file: two
  // tests sharing one would see each other's dedupe and depend on order.
  const run = (
    body: string,
    url = "http://localhost/catalog",
    file = "src/pages/catalog.html",
  ) =>
    executeServerScripts(
      page(body),
      new Request(url),
      baseContext,
      30000,
      file,
    );

  const saved = {
    isProdServer: (BascikConfig as any).isProdServer,
    isBuild: (BascikConfig as any).isBuild,
  };
  beforeEach(() => {
    (BascikConfig as any).isProdServer = false;
    (BascikConfig as any).isBuild = false;
  });
  afterAll(() => {
    (BascikConfig as any).isProdServer = saved.isProdServer;
    (BascikConfig as any).isBuild = saved.isBuild;
  });

  it("an array of strings from .map is joined with no separator, not with commas", async () => {
    const result = await run(
      `export default () => ["Milk frother", "Kettle"].map((name) => "<li>" + name + "</li>");`,
    );
    expect(result).toBe(
      "<p>before</p>\n<li>Milk frother</li><li>Kettle</li>\n<p>after</p>",
    );
    expect(result).not.toContain("</li>,<li>");
  });

  it("an array of html values is joined with no separator, nested arrays flattened and null holes empty", async () => {
    const result = await run(`import { html } from "@bascik/bascik/html";
export default () => [html\`<li>\${"a<"}</li>\`, null, [html\`<li>b</li>\`, ["<li>c</li>"]], undefined];`);
    expect(result).toBe(
      "<p>before</p>\n<li>a&lt;</li><li>b</li><li>c</li>\n<p>after</p>",
    );
  });

  it("an empty array prints nothing; a number prints its digits", async () => {
    expect(await run(`export default () => [];`)).toBe(
      "<p>before</p>\n\n<p>after</p>",
    );
    expect(await run(`export default () => 42;`)).toBe(
      "<p>before</p>\n42\n<p>after</p>",
    );
  });

  it("ANSI escapes inside array items are stripped like a string's", async () => {
    const result = await run(
      `export default () => ["\\u001b[31m<b>red</b>\\u001b[0m", "<i>x</i>"];`,
    );
    expect(result).toBe("<p>before</p>\n<b>red</b><i>x</i>\n<p>after</p>");
  });

  for (const [label, body, received] of [
    // A returned Promise is awaited (the handler's result is), so a forgotten
    // await reaches the page only inside an array.
    [
      "a forgotten await inside an array",
      `const loadList = async () => "<ul></ul>";\nexport default () => ["<h2>Items</h2>", loadList()];`,
      "returned an array holding a Promise at [1]",
    ],
    [
      "an async .map",
      `export default () => ["a", "b"].map(async (n) => "<li>" + n + "</li>");`,
      "returned an array holding a Promise at [0]",
    ],
    [
      "a Response",
      `export default () => new Response("<p>x</p>");`,
      "returned a Response",
    ],
    [
      "a plain object",
      `export default () => ({ name: "Milk frother" });`,
      "returned an object ([object Object])",
    ],
    [
      "a function",
      `export default () => () => "<p>x</p>";`,
      "returned a function",
    ],
    ["a symbol", `export default () => Symbol("x");`, "returned a symbol"],
    [
      "a caught Error returned instead of thrown",
      `export default () => { try { throw new TypeError("db SECRET_DETAIL"); } catch (e) { return e; } };`,
      "returned an Error (TypeError)",
    ],
  ] as const) {
    it(`misuse: ${label} is a located error in dev under "error", naming the route, the script and the received type`, async () => {
      const failure = run(body).then(
        () => null,
        (error: Error) => error,
      );
      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect(error!.name).toBe("ServerScriptError");
      expect(error!.message).toMatch(
        /^\[bascik\] server script error at "\/catalog":\n/,
      );
      expect(error!.message).toMatch(
        /The server script in src\/pages\/catalog\.html:\d+ /,
      );
      expect(error!.message).toContain(received);
      expect(error!.message).not.toMatch(/\[object (Promise|Response)\]/);
      expect(error!.message).not.toContain("SECRET_DETAIL");
    });
  }

  it('misuse: dev under "warn" logs the located message on every request and leaves the slot empty', async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = `export default () => ({ name: "dev-warn" });`;
    for (let i = 0; i < 2; i++) {
      const result = await run(body);
      expect(result).toBe("<p>before</p>\n\n<p>after</p>");
      expect(result).not.toContain("[object");
    }
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]![0]).toContain(
      "returned an object ([object Object])",
    );
    warnSpy.mockRestore();
  });

  it('misuse: dev under "ignore" leaves the slot empty and logs nothing', async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "ignore" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(
      `export default () => new Response("dev-ignore");`,
    );
    expect(result).toBe("<p>before</p>\n\n<p>after</p>");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('misuse: production under "error" never fails the page: the slot is empty and the warning is logged once per script', async () => {
    (BascikConfig as any).isProdServer = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = `export default () => ({ name: "prod-once" });`;
    for (let i = 0; i < 3; i++) {
      const result = await run(
        body,
        `http://localhost/catalog?i=${i}`,
        "src/pages/prod-once.html",
      );
      expect(result).toBe("<p>before</p>\n\n<p>after</p>");
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]![0]);
    expect(message).toMatch(
      /^\[bascik\] server script error at "\/catalog":\n/,
    );
    expect(message).toMatch(
      /The server script in src\/pages\/prod-once\.html:\d+ returned an object/,
    );
    expect(message).toContain("The slot is empty");
    // A script in another file is its own warning.
    await executeServerScripts(
      page(`export default () => ({ name: "prod-other" });`),
      new Request("http://localhost/other"),
      baseContext,
      30000,
      "src/pages/other.html",
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]![0])).toContain(
      "The server script in src/pages/other.html:",
    );
    warnSpy.mockRestore();
  });

  it("misuse: a returned object whose own toString throws fails like a throw from the script, under the policy and located", async () => {
    const body = `export default () => ({ toString() { throw new Error("toString SECRET_DETAIL"); } });`;
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run(body);
    expect(result).toBe("<p>before</p>\n\n<p>after</p>");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(
      /^\[bascik\] server script error at "\/catalog":\n[\s\S]*toString SECRET_DETAIL/,
    );
    warnSpy.mockRestore();
    (BascikConfig as any).scripts = { onServerScriptError: "error" };
    await expect(run(body)).rejects.toMatchObject({
      name: "ServerScriptError",
      message: expect.stringContaining("toString SECRET_DETAIL"),
    });
  });

  it('misuse: production under "ignore" leaves the slot empty and logs nothing', async () => {
    (BascikConfig as any).isProdServer = true;
    (BascikConfig as any).scripts = { onServerScriptError: "ignore" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run(
      `export default () => Symbol("prod-ignore");`,
      "http://localhost/catalog",
      "src/pages/prod-ignore.html",
    );
    expect(result).toBe("<p>before</p>\n\n<p>after</p>");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('misuse: a stream script that returns a Promise in dev under "error" is logged at error severity and its slot is empty, never a 500', async () => {
    const html = page(
      `export default async () => ["<li>a</li>"].map(async (x) => x);`,
      "data-bascik-stream",
    );
    const plan = planServerScripts(html, "src/pages/catalog.html");
    const chunks: Buffer[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const streamer = streamServerScripts(
      plan,
      new Request("http://localhost/catalog"),
      baseContext,
      30000,
      "src/pages/catalog.html",
      { write: async (chunk) => void chunks.push(Buffer.from(chunk)) },
    );
    await expect(streamer.ready).resolves.toBeUndefined();
    streamer.commit();
    await streamer.done;
    const body = Buffer.concat(chunks).toString("utf8");
    expect(body).toBe("<p>before</p>\n\n<p>after</p>");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toMatch(
      /The stream script in src\/pages\/catalog\.html:\d+ returned an array holding a Promise at \[0\]/,
    );
    errorSpy.mockRestore();
  });

  it("a stream script that returns an array is joined like a server script's", async () => {
    const html = page(
      `export default async () => ["<li>a</li>", ["<li>b</li>"]];`,
      "data-bascik-stream",
    );
    const plan = planServerScripts(html, "src/pages/catalog.html");
    const chunks: Buffer[] = [];
    const streamer = streamServerScripts(
      plan,
      new Request("http://localhost/catalog"),
      baseContext,
      30000,
      "src/pages/catalog.html",
      { write: async (chunk) => void chunks.push(Buffer.from(chunk)) },
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "<p>before</p>\n<li>a</li><li>b</li>\n<p>after</p>",
    );
  });
});

describe("planServerScripts: default export forms and src= with a body", () => {
  it.each([
    [
      "a re-exported local",
      "function handler() { return '<p>x</p>'; }\nexport { handler as default };",
    ],
    ["a re-export from a module", 'export { default } from "./helper.ts";'],
    [
      "a renamed re-export in a list",
      'export { a, b as default } from "./helper.ts";',
    ],
    ["a namespace default", 'export * as default from "./helper.ts";'],
    [
      "a default export mid-line",
      "const h = () => '<p>x</p>'; export default h;",
    ],
  ])("accepts %s as the default export", (_label, body) => {
    const plan = planServerScripts(
      `<script data-bascik-server>\n${body}\n</script>`,
      "src/pages/test.html",
    );
    expect(plan.segments.some((segment) => segment.kind === "script")).toBe(
      true,
    );
  });

  it.each([
    ["no export at all", "function handler() { return '<p>x</p>'; }"],
    [
      "a default export only in a comment",
      "// export default handler\nfunction handler() {}",
    ],
    [
      "a default export only in a string",
      'const text = "export default handler";',
    ],
    [
      "a named export renamed from default",
      'export { default as handler } from "./helper.ts";',
    ],
  ])("still rejects %s with the located message", (_label, body) => {
    expect(() =>
      planServerScripts(
        `<script data-bascik-server>\n${body}\n</script>`,
        "src/pages/test.html",
      ),
    ).toThrow(
      /must export default a function in "src\/pages\/test\.html" at line 1\./,
    );
  });

  it.each(["data-bascik-server", "data-bascik-stream"])(
    "rejects a %s tag with both src= and an inline body, naming both",
    (directive) => {
      expect(() =>
        planServerScripts(
          `<main>\n<script ${directive} src="./nav.ts">\nexport default () => "<p>inline</p>";\n</script></main>`,
          "src/pages/test.html",
        ),
      ).toThrow(
        /<script> tag has both src="\.\/nav\.ts" and an inline body in "src\/pages\/test\.html" at line 2\. A script with src= runs only that file, as in a browser: move the body into "\.\/nav\.ts" or remove src=\./,
      );
    },
  );

  it("accepts src= with a whitespace-only body", () => {
    const plan = planServerScripts(
      `<script data-bascik-server src="./nav.ts">\n  \n</script>`,
      "src/pages/test.html",
    );
    expect(plan.segments.some((segment) => segment.kind === "script")).toBe(
      true,
    );
  });
});

describe("pageHasServerScripts (the dev manifest decision)", () => {
  const both = (html: string) => [html, Buffer.from(html)];

  it("is true for a page with a server script, a stream script or a sidecar placeholder, as a string or a Buffer", () => {
    for (const html of [
      `<main><script data-bascik-server>export default () => "x";</script></main>`,
      `<p>a</p><script type="text/bascik-server" data-bascik-stream data-bascik-server-id="s1"></script>`,
      `<script type="text/bascik-server" data-bascik-server-id="abc"></script>`,
    ])
      for (const page of both(html))
        expect(pageHasServerScripts(page)).toBe(true);
  });

  it("is false for a page that only mentions the attribute in its text, as docs do, Buffer or string", () => {
    for (const html of [
      `<p>Add <code>data-bascik-server</code> to a script.</p>`,
      `<pre><code>&lt;script data-bascik-server&gt;export default () =&gt; "x";&lt;/script&gt;</code></pre>`,
      `<p>The placeholder is <code>text/bascik-server</code>.</p>`,
      `<main>no scripts</main>`,
    ])
      for (const page of both(html))
        expect(pageHasServerScripts(page)).toBe(false);
  });
});

describe("sidecar placeholders in every spelling a browser reads as the same attributes", () => {
  const SOURCE = "export default () => '<b>ran</b>';";
  const spellings = [
    // html-minifier-terser --remove-attribute-quotes
    `<script type=text/bascik-server data-bascik-server-id=ph_1></script>`,
    `<script type='text/bascik-server' data-bascik-server-id='ph_1'></script>`,
    `<script data-bascik-server-id="ph_1" type="text/bascik-server"></script>`,
    `<script  type = "text/bascik-server"\n\tdata-bascik-server-id = "ph_1" ></script>`,
    `<SCRIPT TYPE="TEXT/BASCIK-SERVER" DATA-BASCIK-SERVER-ID="ph_1"></SCRIPT>`,
    `<script type=" text/bascik-server " data-bascik-server-id=ph_1></script>`,
    `<script data-note="a > b" type=text/bascik-server data-bascik-server-id=ph_1></script>`,
  ];

  for (const tag of spellings)
    it(`runs the script for ${JSON.stringify(tag)}, as a string or a Buffer page`, async () => {
      serverSidecarRegistry.recordScript("ph_1", SOURCE);
      const html = `<main>${tag}</main>`;
      expect(pageHasServerScripts(html)).toBe(true);
      expect(pageHasServerScripts(Buffer.from(html))).toBe(true);
      expect(await executeServerScripts(html, baseRequest, baseContext)).toBe(
        "<main><b>ran</b></main>",
      );
    });

  it("keeps an unquoted stream marker", async () => {
    serverSidecarRegistry.recordScript(
      "ph_s",
      SOURCE,
      undefined,
      undefined,
      undefined,
      "stream",
    );
    const html = `<script type=text/bascik-server data-bascik-server-id=ph_s data-bascik-stream></script>`;
    const plan = planServerScripts(html);
    const scripts = plan.segments.filter((s) => s.kind === "script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].kind === "script" && scripts[0].mode).toBe("stream");
  });

  it("misuse: a type that only looks like the placeholder's is not one", () => {
    for (const html of [
      `<script data-type="text/bascik-server" data-bascik-server-id="ph_1"></script>`,
      `<script type="text/bascik-server-x" data-bascik-server-id="ph_1"></script>`,
      `<script type=text/bascik-serverx data-bascik-server-id=ph_1></script>`,
      `<script data-x='type=text/bascik-server' data-bascik-server-id="ph_1"></script>`,
      `<script data-x="a type=text/bascik-server" data-bascik-server-id="ph_1"></script>`,
    ]) {
      expect(pageHasServerScripts(html), html).toBe(false);
      expect(pageHasServerScripts(Buffer.from(html)), html).toBe(false);
    }
  });
});
