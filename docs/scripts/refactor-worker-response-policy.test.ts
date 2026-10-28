// Unit tests for skills/bascik-refactor/scripts/worker-response-policy.mjs: a Cloudflare Worker wrapper around the
// Worker that `bascik --build --target cloudflare` writes. It hashes each HTML response's executable inline scripts
// and inline styles into a strict CSP (no unsafe-inline), sets X-Robots-Tag and Cache-Control per response kind, and
// turns an empty 404 into a plain error page. The wrapped worker is a fake returning Response objects; no network.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildCsp,
  cacheControlFor,
  executableInlineScripts,
  inlineStyles,
  robotsHeader,
  sha256Base64,
  withResponsePolicy,
} from "../../skills/bascik-refactor/scripts/worker-response-policy.mjs";

const nodeHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("base64");

const HTML = `<!doctype html><html><head>
<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
<script type="application/json" id="data">{"plans":[1,2]}</script>
<script type="text/bascik-server">return 1</script>
<script src="/assets/app.js"></script>
<script>document.documentElement.dataset.js = "1";</script>
<script type="module">import "/assets/slider.js";</script>
<script type="text/javascript">window.ready = true;</script>
<style>.hero{color:#123}</style>
</head><body><style>.press{margin:0 auto}</style><h1>Example</h1></body></html>`;

describe("finding inline code", () => {
  it("returns only executable inline scripts: classic, text/javascript and module", () => {
    expect(executableInlineScripts(HTML)).toEqual([
      'document.documentElement.dataset.js = "1";',
      'import "/assets/slider.js";',
      "window.ready = true;",
    ]);
  });

  it("skips scripts with src, JSON, JSON-LD and Bascik server scripts", () => {
    const bodies = executableInlineScripts(HTML).join("\n");
    expect(bodies).not.toMatch(/BreadcrumbList|plans|return 1/);
  });

  it("handles unquoted type attributes in minified output", () => {
    expect(
      executableInlineScripts(
        "<script type=application/ld+json>{}</script><script type=module>a()</script>",
      ),
    ).toEqual(["a()"]);
  });

  it("hashes inline import maps and speculation rules too: browsers check them against script-src", () => {
    expect(
      executableInlineScripts(
        '<script type="importmap">{"imports":{"a":"/a.js"}}</script>' +
          '<script type=speculationrules>{"prefetch":[]}</script>' +
          '<script type="application/json">{"data":1}</script>',
      ),
    ).toEqual(['{"imports":{"a":"/a.js"}}', '{"prefetch":[]}']);
  });

  it("returns every inline <style> body", () => {
    expect(inlineStyles(HTML)).toEqual([
      ".hero{color:#123}",
      ".press{margin:0 auto}",
    ]);
  });

  // The HTML tokenizer ends a script or style at `</script` (or `</style`) followed by whitespace, `/` or `>`, then
  // skips to the next `>`. A body cut anywhere else hashes the wrong text and the browser blocks the real script.
  it("ends a body where the browser does: end tags with whitespace, attributes, a slash or any case", () => {
    expect(
      executableInlineScripts(
        "<script>a()</script >" +
          "<script>b()</script\t\n bar>" +
          "<script>c()</script/>" +
          "<SCRIPT>d()</SCRIPT>" +
          "<script>e()</ScRiPt\f>",
      ),
    ).toEqual(["a()", "b()", "c()", "d()", "e()"]);
    expect(
      inlineStyles(
        "<style>.a{}</style >" +
          "<style>.b{}</style\t\n media=x>" +
          "<style>.c{}</style/>" +
          "<STYLE>.d{}</STYLE>",
      ),
    ).toEqual([".a{}", ".b{}", ".c{}", ".d{}"]);
  });

  it("misuse: a look-alike such as </scripts> or </script-x> does not end the body", () => {
    expect(
      executableInlineScripts(
        '<script>log("</scripts>"); log("</script-x>")</script>',
      ),
    ).toEqual(['log("</scripts>"); log("</script-x>")']);
    expect(
      inlineStyles("<style>a::after{content:'</styles>'}</style>"),
    ).toEqual(["a::after{content:'</styles>'}"]);
  });

  it("misuse: a quoted attribute value holding > does not end the start tag early", () => {
    expect(
      executableInlineScripts(
        '<script data-note="a > b">go()</script><script type="x>y">{}</script>',
      ),
    ).toEqual(["go()"]);
    expect(inlineStyles(`<style data-note='a > b'>.x{}</style>`)).toEqual([
      ".x{}",
    ]);
  });
});

describe("reading script attributes by whole name", () => {
  // `\bsrc` and `\btype` match after "-", so data-src and data-type read as src and type: the script still runs
  // (it has no real src or type) but got no hash, and the policy blocked it.
  it("misuse: data-src and data-type are other attributes, so the script is still hashed", () => {
    expect(
      executableInlineScripts(
        '<script data-src="/x.js">boot()</script>' +
          '<script data-type="text/plain">run()</script>' +
          "<script data-src=/y.js data-type=json>go()</script>",
      ),
    ).toEqual(["boot()", "run()", "go()"]);
  });

  it("misuse: an attribute value that reads like src= or type= is part of that value", () => {
    expect(
      executableInlineScripts(
        `<script data-note=" type=module src=/z.js">one()</script>` +
          `<script title='src="/a.js"'>two()</script>`,
      ),
    ).toEqual(["one()", "two()"]);
  });

  it("a real src or data type is still recognised, in any case and quoting, and the first type wins as in HTML", () => {
    expect(
      executableInlineScripts(
        '<script SRC="/a.js"></script>' +
          "<script defer src=/b.js></script>" +
          '<script TYPE="application/json">{}</script>' +
          '<script type="text/plain" type="module">x()</script>' +
          '<script async type="module">y()</script>',
      ),
    ).toEqual(["y()"]);
  });
});

describe("sha256Base64 and buildCsp", () => {
  it("matches node:crypto's base64 SHA-256 for ASCII and non-ASCII text", async () => {
    for (const text of ["window.ready = true;", 'const label = "café";', ""]) {
      expect(await sha256Base64(text)).toBe(nodeHash(text));
    }
  });

  it("builds a strict policy from hashes with no unsafe-inline", () => {
    const csp = buildCsp({ scriptHashes: ["abc="], styleHashes: ["def="] });
    expect(csp).toContain("script-src 'self' 'sha256-abc='");
    expect(csp).toContain("style-src 'self' 'sha256-def='");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("merges extra directives and dedupes hashes", () => {
    const csp = buildCsp({
      scriptHashes: ["abc=", "abc="],
      styleHashes: [],
      directives: {
        "img-src": ["'self'", "data:", "https://images.example.com"],
        "connect-src": ["'self'", "https://api.example.com"],
      },
    });
    expect(csp.match(/'sha256-abc='/g)).toHaveLength(1);
    expect(csp).toContain("img-src 'self' data: https://images.example.com");
    expect(csp).toContain("connect-src 'self' https://api.example.com");
  });

  it("misuse: an extra directive cannot reintroduce unsafe-inline", () => {
    expect(() =>
      buildCsp({
        scriptHashes: [],
        styleHashes: [],
        directives: { "script-src": ["'self'", "'unsafe-inline'"] },
      }),
    ).toThrow(/unsafe-inline/);
  });
});

describe("robotsHeader and cacheControlFor", () => {
  it("noindex for preview environments, API, errors, redirects and PDFs", () => {
    expect(
      robotsHeader({ kind: "html", environment: "production" }),
    ).toBeNull();
    expect(
      robotsHeader({ kind: "asset", environment: "production" }),
    ).toBeNull();
    expect(robotsHeader({ kind: "html", environment: "preview" })).toBe(
      "noindex",
    );
    for (const kind of ["api", "error", "redirect", "pdf"]) {
      expect(robotsHeader({ kind, environment: "production" }), kind).toBe(
        "noindex",
      );
    }
  });

  it("caches hashed assets forever, revalidates HTML, never stores API or errors", () => {
    expect(cacheControlFor("html")).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("hashed-asset")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("api")).toBe("no-store");
    expect(cacheControlFor("error")).toBe("no-store");
  });

  it("misuse: an unknown kind is rejected by name", () => {
    expect(() => cacheControlFor("forever" as never)).toThrow(/forever/);
  });
});

describe("withResponsePolicy", () => {
  /** A fake generated Worker: routes map a pathname to the Response it returns. */
  const fakeWorker = (routes: Record<string, () => Response>) => {
    const seen: { url: string; env: unknown; ctx: unknown }[] = [];
    return {
      seen,
      worker: {
        fetch: async (request: Request, env: unknown, ctx: unknown) => {
          seen.push({ url: request.url, env, ctx });
          const route = routes[new URL(request.url).pathname];
          return route ? route() : new Response(null, { status: 404 });
        },
      },
    };
  };

  const html = (body: string, init: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      ...init,
      headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
    });

  const routes = {
    "/": () => html(HTML),
    "/assets/app-WRROEVBF.js": () =>
      new Response("console.log(1)", {
        headers: { "content-type": "text/javascript" },
      }),
    "/press/kit.pdf": () =>
      new Response("%PDF-1.7", {
        headers: { "content-type": "application/pdf" },
      }),
    "/api/contact": () =>
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      }),
    "/old-pricing": () =>
      new Response(null, { status: 301, headers: { location: "/pricing" } }),
    "/boom": () => html("<h1>Server error</h1>", { status: 500 }),
  };

  const env = { ENVIRONMENT: "production" };
  const ctx = { waitUntil: () => {} };
  /** The opt-in that hashes each response's own body: right only for a site with no request-time output. */
  const LIVE = { hashResponseBodies: true } as const;
  const get = (path: string) => new Request(`https://www.example.com${path}`);

  it("passes request, env and ctx through to the generated Worker", async () => {
    const { worker, seen } = fakeWorker(routes);
    await withResponsePolicy(worker, LIVE).fetch(get("/"), env, ctx);
    expect(seen).toEqual([{ url: "https://www.example.com/", env, ctx }]);
  });

  it("HTML gets a CSP built from its own inline script and style hashes", async () => {
    const { worker } = fakeWorker(routes);
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/"),
      env,
      ctx,
    );
    const csp = res.headers.get("content-security-policy")!;
    for (const body of executableInlineScripts(HTML))
      expect(csp).toContain(`'sha256-${nodeHash(body)}'`);
    for (const body of inlineStyles(HTML))
      expect(csp).toContain(`'sha256-${nodeHash(body)}'`);
    expect(csp).not.toContain(nodeHash('{"@type":"BreadcrumbList"}'));
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(await res.text()).toBe(HTML);
  });

  it("non-HTML passes through unchanged; a hashed asset is immutable", async () => {
    const { worker } = fakeWorker(routes);
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/assets/app-WRROEVBF.js"),
      env,
      ctx,
    );
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("console.log(1)");
  });

  it("PDFs, API responses, redirects and server errors get noindex", async () => {
    const { worker } = fakeWorker(routes);
    const policy = withResponsePolicy(worker, LIVE);
    for (const path of [
      "/press/kit.pdf",
      "/api/contact",
      "/old-pricing",
      "/boom",
    ]) {
      const res = await policy.fetch(get(path), env, ctx);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
    }
    const api = await policy.fetch(get("/api/contact"), env, ctx);
    expect(api.headers.get("cache-control")).toBe("no-store");
    const redirect = await policy.fetch(get("/old-pricing"), env, ctx);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/pricing");
  });

  it("an empty 404 becomes a plain HTML error page with noindex", async () => {
    const { worker } = fakeWorker(routes);
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/missing"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toMatch(/not found/i);
  });

  it("a 404 with the site's own 404 page keeps its body", async () => {
    const { worker } = fakeWorker({
      "/missing": () => html("<h1>Lost?</h1>", { status: 404 }),
    });
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/missing"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Lost?</h1>");
  });

  it("a 304 Not Modified passes through: no noindex, no cache rewrite, no body", async () => {
    const { worker } = fakeWorker({
      "/pricing": () =>
        new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    });
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/pricing"),
      env,
      ctx,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.body).toBeNull();
  });

  /** A Bascik streamed page: a ReadableStream body with content-encoding identity, as the generated Worker sends it. */
  const streamed = () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls === 1)
          controller.enqueue(encoder.encode("<html><head><style>.a{}</style>"));
        else {
          controller.enqueue(encoder.encode("<body>late</body></html>"));
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "identity",
      },
    });
  };

  it("a streamed page is buffered by default so its hashes are complete, and says so in the docs", async () => {
    const { worker } = fakeWorker({ "/live": streamed });
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/live"),
      env,
      ctx,
    );
    expect(res.headers.get("content-security-policy")).toContain(
      `'sha256-${nodeHash(".a{}")}'`,
    );
    expect(await res.text()).toBe(
      "<html><head><style>.a{}</style><body>late</body></html>",
    );
  });

  it('streamedHtml: "pass" keeps a streamed page streaming and sends no CSP header for it', async () => {
    const { worker } = fakeWorker({ "/live": streamed, "/": routes["/"] });
    const policy = withResponsePolicy(worker, {
      ...LIVE,
      streamedHtml: "pass",
    });
    const res = await policy.fetch(get("/live"), env, ctx);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(await res.text()).toContain("late");
    // A buffered page still gets its policy.
    const page = await policy.fetch(get("/"), env, ctx);
    expect(page.headers.get("content-security-policy")).toMatch(/sha256-/);
  });

  it("misuse: an unknown streamedHtml value is rejected at wrap time", () => {
    const { worker } = fakeWorker(routes);
    expect(() =>
      withResponsePolicy(worker, {
        ...LIVE,
        streamedHtml: "stream" as never,
      }),
    ).toThrow(/streamedHtml.*buffer.*pass/);
  });

  it("a preview environment marks every response noindex", async () => {
    const { worker } = fakeWorker(routes);
    const res = await withResponsePolicy(worker, LIVE).fetch(
      get("/"),
      { ENVIRONMENT: "preview" },
      ctx,
    );
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("extra CSP directives from options reach the header", async () => {
    const { worker } = fakeWorker(routes);
    const res = await withResponsePolicy(worker, {
      ...LIVE,
      directives: { "img-src": ["'self'", "https://images.example.com"] },
    }).fetch(get("/"), env, ctx);
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' https://images.example.com",
    );
  });

  it("misuse: wrapping something without fetch fails at wrap time with the import to use", () => {
    expect(() => withResponsePolicy({} as never, LIVE)).toThrow(
      /dist\/\.bascik\/cloudflare\/worker\.js/,
    );
  });
});

describe("withResponsePolicy with the build's csp-hashes.json", () => {
  const sha = (text: string) => `sha256-${nodeHash(text)}`;
  /** dist/.bascik/csp-hashes.json as `generate.cspHashes` writes it: route -> hash sources. */
  const MANIFEST = {
    "/": { scripts: [sha("home()")], styles: [sha(".h{}")] },
    "/search": { scripts: [sha("app()")], styles: [] },
    "/blog/one": { scripts: [sha("blog()")], styles: [] },
    "/404": { scripts: [], styles: [sha(".lost{}")] },
  };
  const env = { ENVIRONMENT: "production" };
  const ctx = { waitUntil: () => {} };
  const get = (path: string) => new Request(`https://www.example.com${path}`);
  const page = (body: string, init: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      ...init,
      headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
    });
  /** A server-rendered search page that reflects ?q= unescaped: the bug CSP exists to contain. */
  const reflecting = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/missing")
        return page("<style>.lost{}</style>", { status: 404 });
      const q = url.searchParams.get("q") ?? "";
      return page(`<p>Results for ${q}</p><script>app()</script>`);
    },
  };

  it("misuse: a script injected into server output gets no hash: the policy lists the route's build-time hashes only", async () => {
    const res = await withResponsePolicy(reflecting, {
      cspHashes: MANIFEST,
    }).fetch(
      get(`/search?q=${encodeURIComponent("<script>steal()</script>")}`),
      env,
      ctx,
    );
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`'${sha("app()")}'`);
    expect(csp).not.toContain(nodeHash("steal()"));
    expect(csp).not.toContain("unsafe-inline");
  });

  it("the opt-in that hashes response bodies does allow the injected script, which is why it is opt-in", async () => {
    const res = await withResponsePolicy(reflecting, {
      hashResponseBodies: true,
    }).fetch(
      get(`/search?q=${encodeURIComponent("<script>steal()</script>")}`),
      env,
      ctx,
    );
    expect(res.headers.get("content-security-policy")).toContain(
      nodeHash("steal()"),
    );
  });

  it("finds the route the way the build keys it: trailing slash, .html, index.html and the base path", async () => {
    const worker = { fetch: async () => page("<p>x</p>") };
    const policy = withResponsePolicy(worker, { cspHashes: MANIFEST });
    for (const [path, hash] of [
      ["/", sha("home()")],
      ["/index.html", sha("home()")],
      ["/blog/one", sha("blog()")],
      ["/blog/one/", sha("blog()")],
      ["/blog/one.html", sha("blog()")],
      ["/blog/one/index.html", sha("blog()")],
    ]) {
      const csp = (await policy.fetch(get(path), env, ctx)).headers.get(
        "content-security-policy",
      );
      expect(csp, path).toContain(`'${hash}'`);
    }
    const based = withResponsePolicy(worker, {
      cspHashes: MANIFEST,
      base: "/docs/",
    });
    const csp = (
      await based.fetch(get("/docs/blog/one"), env, ctx)
    ).headers.get("content-security-policy");
    expect(csp).toContain(`'${sha("blog()")}'`);
  });

  it("a 404 gets the 404 page's hashes", async () => {
    const res = await withResponsePolicy(reflecting, {
      cspHashes: MANIFEST,
    }).fetch(get("/missing"), env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toContain(
      `'${sha(".lost{}")}'`,
    );
  });

  it("misuse: a route the build never recorded fails closed, with no hashes", async () => {
    const worker = { fetch: async () => page("<script>who()</script>") };
    const csp = (
      await withResponsePolicy(worker, { cspHashes: MANIFEST }).fetch(
        get("/not-built"),
        env,
        ctx,
      )
    ).headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/sha256-/);
  });

  it("a streamed page keeps streaming and still gets its policy: the hashes are known before the body", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(
          encoder.encode(pulls === 1 ? "<p>a</p>" : "<p>b</p>"),
        );
        if (pulls === 2) controller.close();
      },
    });
    const worker = {
      fetch: async () =>
        new Response(body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "identity",
          },
        }),
    };
    const res = await withResponsePolicy(worker, {
      cspHashes: MANIFEST,
    }).fetch(get("/search"), env, ctx);
    expect(res.headers.get("content-security-policy")).toContain(
      `'${sha("app()")}'`,
    );
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(pulls).toBeLessThan(2);
    expect(await res.text()).toBe("<p>a</p><p>b</p>");
  });

  it("misuse: no hash source at all is rejected at wrap time, naming both options", () => {
    expect(() => withResponsePolicy(reflecting)).toThrow(
      /csp-hashes\.json[\s\S]*hashResponseBodies/,
    );
  });

  it("misuse: a manifest that is not the parsed JSON (a path string, an array) is rejected at wrap time", () => {
    for (const bad of ["dist/.bascik/csp-hashes.json", [], null]) {
      expect(
        () => withResponsePolicy(reflecting, { cspHashes: bad as never }),
        String(bad),
      ).toThrow(/cspHashes/);
    }
  });

  it("misuse: both a manifest and body hashing is ambiguous and rejected", () => {
    expect(() =>
      withResponsePolicy(reflecting, {
        cspHashes: MANIFEST,
        hashResponseBodies: true,
      }),
    ).toThrow(/either/);
  });
});

describe("the header comment a reader copies from", () => {
  it("shows the wrapper import and the root wrangler.jsonc for the Cloudflare target", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL(
        "../../skills/bascik-refactor/scripts/worker-response-policy.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    const header = src.slice(0, src.search(/^import |^export /m));
    expect(header).toContain("./dist/.bascik/cloudflare/worker.js");
    expect(header).toContain("bascik --build --target cloudflare");
    expect(header).toMatch(
      /"directory":\s*"dist\/\.bascik\/cloudflare\/public"/,
    );
    expect(header).toMatch(/"binding":\s*"ASSETS"/);
    expect(header).toMatch(/"run_worker_first":\s*\[\s*"\/\*"\s*\]/);
    // Without it ASSETS answers a missing page with an empty 404 and the site's own 404.html is never served.
    expect(header).toMatch(/"not_found_handling":\s*"404-page"/);
    // The generated deploy script deploys dist/.bascik/cloudflare and would bypass the wrapper.
    expect(header).toMatch(/wrangler deploy/);
    // Streaming pages lose progressive delivery while buffered: the header says so.
    expect(header).toMatch(/stream/i);
    // The build's hashes are the default source, imported in the wrapper.
    expect(header).toMatch(
      /import cspHashes from "\.\/dist\/\.bascik\/csp-hashes\.json"/,
    );
    expect(header).toMatch(/generate: \{ cspHashes: true \}/);
    // Body hashing is documented as giving no protection against injected markup.
    expect(header).toMatch(/hashResponseBodies[\s\S]*injected/);
  });

  it("imports nothing, so a reader can copy the one file into scripts/", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL(
        "../../skills/bascik-refactor/scripts/worker-response-policy.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
