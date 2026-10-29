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

  it("a real src or data type is still recognized, in any case and quoting, and the first type wins as in HTML", () => {
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

// The regex scan this file replaced, kept as the oracle for the equivalence fuzz below. Its attribute alternation
// retried from every "<script" or "<style" and walked to the end of the input each time: quadratic on a response
// body that holds visitor input.
const OLD_SCRIPT_RE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;
const OLD_STYLE_RE =
  /<style\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/style(?:[\t\n\f\r /][^>]*)?>/gi;
const OLD_ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
const oldAttributesOf = (attrs: string) => {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(OLD_ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
};
const oldExecutableInlineScripts = (html: string) => {
  const bodies: string[] = [];
  for (const m of html.matchAll(OLD_SCRIPT_RE)) {
    const attrs = oldAttributesOf(m[1]);
    if (attrs.has("src")) continue;
    const type = (attrs.get("type") ?? "").trim();
    if (
      type === "" ||
      /^(module|importmap|speculationrules)$/i.test(type) ||
      /^(text|application)\/(x-)?(java|ecma)script$/i.test(type)
    )
      bodies.push(m[2]);
  }
  return bodies;
};
const oldInlineStyles = (html: string) =>
  [...html.matchAll(OLD_STYLE_RE)].map((m) => m[2]);

/** A seeded PRNG (mulberry32), so a failing input can be regenerated from its seed. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A well-formed page: text and other elements around script and style elements in every spelling HTML allows. */
const wellFormedPage = (random: () => number) => {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  const caseOf = (name: string) =>
    [...name].map((c) => (random() < 0.3 ? c.toUpperCase() : c)).join("");
  const ws = () => pick([" ", " ", "  ", "\t", "\n", "\r\n", "\f"]);
  const text = () =>
    pick([
      "hello",
      "a > b",
      "x < y",
      "</scripts>",
      "</script-x>",
      "</styles>",
      "<scripts>",
      "<stylesheet>",
      '"quoted"',
      "'single'",
      "<div>",
      "</div>",
      '<p class="a > b">',
      "&amp;",
      "\n",
      "<!-- c -->",
      "<img alt='x'>",
      '<a title="<script>">',
      "café",
      "",
    ]);
  const value = (name: string) => {
    const raw =
      name.toLowerCase() === "type"
        ? pick([
            "module",
            "importmap",
            "speculationrules",
            "text/javascript",
            "application/ecmascript",
            "application/json",
            "application/ld+json",
            "text/bascik-server",
            "",
            " module ",
          ])
        : pick([
            "x",
            "/a.js",
            "a > b",
            "type=module",
            "<script>",
            "</script>",
            "it's",
            'say "hi"',
            "",
          ]);
    const quoted = [];
    if (!raw.includes('"')) quoted.push(`"${raw}"`);
    if (!raw.includes("'")) quoted.push(`'${raw}'`);
    if (/^[\w/.+:-]+$/.test(raw)) quoted.push(raw);
    return pick(quoted);
  };
  const attrs = () => {
    let out = "";
    const count = Math.floor(random() * 4);
    for (let i = 0; i < count; i++) {
      const name = pick([
        "type",
        "TYPE",
        "src",
        "data-src",
        "data-type",
        "id",
        "async",
        "defer",
        "nonce",
        "title",
        "media",
      ]);
      out += ws() + name;
      if (random() < 0.8)
        out +=
          (random() < 0.2 ? ws() : "") +
          "=" +
          (random() < 0.2 ? ws() : "") +
          value(name);
    }
    if (random() < 0.1) out += ws() + "/";
    else if (random() < 0.15) out += ws();
    return out;
  };
  const body = () => {
    let out = "";
    const count = Math.floor(random() * 4);
    for (let i = 0; i < count; i++)
      out += pick([
        "a()",
        "x > y",
        "if (a < b) {}",
        '"</scripts>"',
        "'</script-x>'",
        "'</styles>'",
        "<script>",
        "<style>",
        "<!-- -->",
        "\n",
        "</div>",
        ".a{color:red}",
        "é",
      ]);
    return out;
  };
  const end = (name: string) =>
    `</${caseOf(name)}${pick([">", ">", " >", "\t\n bar>", "/>", "\f>", ' x="y">'])}`;
  const element = (name: string) =>
    `<${caseOf(name)}${attrs()}>${body()}${end(name)}`;
  let page = "";
  const parts = 1 + Math.floor(random() * 6);
  for (let i = 0; i < parts; i++) {
    const r = random();
    page += r < 0.4 ? element("script") : r < 0.6 ? element("style") : text();
  }
  return page;
};

describe("scanning for inline code without regular-expression backtracking", () => {
  it("finds the same scripts and styles as the regex scan it replaced on 50,000 well-formed pages", () => {
    const differences: string[] = [];
    for (let seed = 1; seed <= 50_000; seed++) {
      const html = wellFormedPage(prng(seed));
      const scripts = executableInlineScripts(html);
      const styles = inlineStyles(html);
      if (
        JSON.stringify(scripts) !==
          JSON.stringify(oldExecutableInlineScripts(html)) ||
        JSON.stringify(styles) !== JSON.stringify(oldInlineStyles(html))
      )
        differences.push(`seed ${seed}: ${JSON.stringify(html)}`);
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it("finds something on most generated pages, so the fuzz above compares real matches", () => {
    let withScripts = 0;
    let withStyles = 0;
    for (let seed = 1; seed <= 2_000; seed++) {
      const html = wellFormedPage(prng(seed));
      if (executableInlineScripts(html).length) withScripts++;
      if (inlineStyles(html).length) withStyles++;
    }
    expect(withScripts).toBeGreaterThan(800);
    expect(withStyles).toBeGreaterThan(600);
  });

  // Intended differences, all on markup the HTML tokenizer reads differently from the old regex.
  it("misuse: a custom element named script-x or style-x is not a script or a style", () => {
    const html =
      "<script-x>x()</script><style-x>.x{}</style><script.y>y()</script>";
    expect(executableInlineScripts(html)).toEqual([]);
    expect(inlineStyles(html)).toEqual([]);
  });

  it("misuse: a quote inside an attribute name or an unquoted value opens nothing, as in the browser", () => {
    expect(
      executableInlineScripts(
        `<script a"b>one()</script><script x=a'b>two()</script>`,
      ),
    ).toEqual(["one()", "two()"]);
    expect(inlineStyles(`<style a"b>.a{}</style>`)).toEqual([".a{}"]);
  });

  it("misuse: an unclosed start tag or a script with no end tag yields nothing, and does not hide earlier code", () => {
    expect(
      executableInlineScripts(`<script>ok()</script><script a="never closed>`),
    ).toEqual(["ok()"]);
    expect(
      executableInlineScripts(`<script>ok()</script><script>runs to EOF`),
    ).toEqual(["ok()"]);
    expect(inlineStyles(`<style>.ok{}</style><style>.x{}</style `)).toEqual([
      ".ok{}",
    ]);
  });
});

/**
 * Linear-time check, after pkg/src/lib/linear-time.test-helper.ts (the docs typecheck cannot take files outside docs/):
 * times a quarter-size and a full-size input in this thread's CPU time, repeated until a sample takes `MIN_SAMPLE_MS`
 * or `TICKS_PER_SAMPLE` steps of the clock (Windows counts CPU time in ticks of about 15.6 ms, and a sample one tick
 * long reads 0), keeps the fastest of `SAMPLES` interleaved samples of each, plus up to `EXTRA_SAMPLES` more while the
 * growth is in the band load reaches on linear work, and requires the growth to stay under `MAX_GROWTH`. Linear work
 * grows about 4 times; quadratic about 16. Growth does not depend on the machine's speed, so a loaded runner does not
 * flake it.
 */
const MAX_GROWTH = 8;
const MIN_SAMPLE_MS = 25;
const TICKS_PER_SAMPLE = 16;
const MAX_RUNS = 2_000;
const NOISE_FLOOR_MS = 5;
const CEILING_MS = 2_000;
const SAMPLES = 3;
const EXTRA_SAMPLES = 6;
const RESAMPLE_ABOVE = 5;
const RESAMPLE_BELOW = 12;
const LINEAR_TIME_TIMEOUT_MS = 60_000;

// This thread's CPU time (Node 23.9 and later), else the process's: the process's also counts V8's GC threads.
const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
const msOf = ({ user, system }: NodeJS.CpuUsage) => (user + system) / 1000;
const cpuMs = (run: () => unknown) => {
  const start = threadCpuUsage();
  run();
  return msOf(threadCpuUsage(start));
};
// The smallest step the clock moves by: microseconds on macOS and Linux, a scheduler tick on Windows.
const clockResolutionMs = (() => {
  const deadline = performance.now() + 250;
  let smallest = Infinity;
  let last = msOf(threadCpuUsage());
  for (let steps = 0; steps < 5 && performance.now() < deadline;) {
    const now = msOf(threadCpuUsage());
    if (now === last) continue;
    smallest = Math.min(smallest, now - last);
    last = now;
    steps++;
  }
  return Number.isFinite(smallest) ? smallest : 0;
})();
const TARGET_MS = Math.max(MIN_SAMPLE_MS, TICKS_PER_SAMPLE * clockResolutionMs);
const FLOOR_MS = Math.max(NOISE_FLOOR_MS, clockResolutionMs);

const expectLinearTime = (
  input: (size: number) => string,
  size: number,
  run: (html: string) => unknown,
  label: string,
) => {
  const small = input(size / 4);
  const large = input(size);
  const sample = (html: string, runs: number) =>
    cpuMs(() => {
      for (let i = 0; i < runs; i++) run(html);
    });
  sample(small, 1);
  let runs = 1;
  let ms = sample(small, runs);
  while (ms < TARGET_MS && runs < MAX_RUNS) {
    runs = Math.min(
      MAX_RUNS,
      // A step that read nothing says nothing about how short the run is: double rather than jump to MAX_RUNS.
      ms <= 0
        ? runs * 2
        : Math.max(runs * 2, Math.ceil((runs * TARGET_MS * 1.5) / ms)),
    );
    ms = sample(small, runs);
  }
  let smallMs = ms;
  let largeMs = Infinity;
  const growth = () => largeMs / Math.max(smallMs, FLOOR_MS);
  for (let i = 0; i < SAMPLES + EXTRA_SAMPLES; i++) {
    if (
      i >= SAMPLES &&
      !(growth() > RESAMPLE_ABOVE && growth() < RESAMPLE_BELOW)
    )
      break;
    if (i > 0) smallMs = Math.min(smallMs, sample(small, runs));
    largeMs = Math.min(largeMs, sample(large, runs));
  }
  const what = `${label}: ${(smallMs / runs).toFixed(2)} ms at a quarter size, ${(largeMs / runs).toFixed(2)} ms at full size, ${runs} runs per sample`;
  expect(growth(), `${what} (growth)`).toBeLessThan(MAX_GROWTH);
  expect(largeMs / runs, `${what} (ceiling)`).toBeLessThan(CEILING_MS);
};

const repeatTo = (unit: string, size: number) =>
  unit.repeat(Math.ceil(size / unit.length));

describe("hostile response bodies take linear time", () => {
  // A server or stream script can reflect visitor input into the body, and with hashResponseBodies: true every HTML
  // response is scanned on the request path: super-linear work here is a per-request denial of service.
  const HOSTILE: [string, (size: number) => string][] = [
    ["start tags that never close", (n) => repeatTo("<script ", n)],
    ["style start tags that never close", (n) => repeatTo("<style ", n)],
    ["an attribute list with no >", (n) => `<script${repeatTo(' a="b"', n)}`],
    ["quote-opening attribute values", (n) => repeatTo('<script a="', n)],
    ["single quotes after =", (n) => repeatTo("<script a='", n)],
    ["quotes in attribute names", (n) => repeatTo(`<script "'`, n)],
    ["start tags with no end tag", (n) => repeatTo("<script>", n)],
    ["style start tags with no end tag", (n) => repeatTo("<style>", n)],
    [
      "end-tag look-alikes with no >",
      (n) => `<script>${repeatTo("</script ", n)}`,
    ],
    [
      "style end-tag look-alikes with no >",
      (n) => `<style>${repeatTo("</style\t", n)}`,
    ],
    ["near-miss end tags", (n) => `<script>${repeatTo("</scrip</scripts", n)}`],
    ["a flood of <", (n) => repeatTo("<", n)],
    ["a flood of </", (n) => `<script>${repeatTo("</", n)}`],
    [
      "one closed tag with a long attribute list",
      (n) => `<script${repeatTo(' a="b" c=d e', n)}>x()</script>`,
    ],
    [
      "one closed tag with long runs of = and whitespace",
      (n) => `<script a${repeatTo("= \t=", n)}>x()</script>`,
    ],
    ["many small scripts", (n) => repeatTo("<script>a()</script>", n)],
    ["many small styles", (n) => repeatTo("<style>.a{}</style>", n)],
    ["nested quoted start tags", (n) => repeatTo(`<script a="<script b='`, n)],
  ];
  it.each(HOSTILE)(
    "%s",
    (label, input) => {
      expectLinearTime(
        input,
        200_000,
        (html) => {
          executableInlineScripts(html);
          inlineStyles(html);
        },
        label,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
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
