/**
 * The generated public/_headers on Cloudflare: static files are served by the
 * asset layer without the Worker, so the build writes the security headers
 * (`security.headers`, `security.hsts`) as one site-wide `/*` rule, and the
 * opt-in CSP as one exact-path rule per static page, merged with the
 * author's own rules.
 *
 * Cloudflare's asset layer (workers-shared, which miniflare runs) reads the
 * file as a record keyed by path, so a second rule with the same path
 * replaces the first; matching rules apply in file order; a header two
 * matching rules set is joined with a comma; and `! Name` in a rule removes
 * what earlier rules set. The builder never writes a second rule for a path
 * the author already has, puts the site-wide rule first, and gives an
 * author's rule that sets one of these headers a `! Name` line, so the
 * author's value replaces Bascik's instead of being joined to it.
 * cloudflare.test.ts checks the same file in workerd.
 */
import { describe, expect, it } from "vitest";
import type { ResponseSecurity } from "@bascik/bascik/runtime";
import {
  buildHeadersFile,
  CLOUDFLARE_HEADERS_LINE_LIMIT,
  CLOUDFLARE_HEADERS_RULE_LIMIT,
  countHeadersRules,
  workerPageHeaderOverrides,
} from "./headers-file.ts";

const DEFAULT_SECURITY: ResponseSecurity = {
  headers: {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "cross-origin",
  },
  hsts: "max-age=31536000",
  privateDynamicPages: true,
};

const SITE_WIDE = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: SAMEORIGIN",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "  Cross-Origin-Opener-Policy: same-origin-allow-popups",
  "  Cross-Origin-Resource-Policy: cross-origin",
  "  Strict-Transport-Security: max-age=31536000",
];

const NONE: ResponseSecurity = {
  headers: {},
  hsts: null,
  privateDynamicPages: true,
};

const policy = {
  directives: { "default-src": ["'self'"], "script-src": ["'self'"] },
};

describe("buildHeadersFile: the site-wide security rule", () => {
  it("defaults: one /* rule with the five headers and one-year HSTS without includeSubDomains", () => {
    expect(
      buildHeadersFile({ authored: "", security: DEFAULT_SECURITY, base: "/" }),
    ).toBe(`${SITE_WIDE.join("\n")}\n`);
  });

  it("a build whose graph has no responseSecurity (an older pkg) gets the defaults, as its Worker does", () => {
    expect(buildHeadersFile({ authored: "", base: "/" })).toBe(
      `${SITE_WIDE.join("\n")}\n`,
    );
  });

  it("security.headers false and hsts false: no rule, and no file when the author wrote none", () => {
    expect(buildHeadersFile({ authored: "", security: NONE, base: "/" })).toBe(
      "",
    );
  });

  it("an object changes or removes single headers; hsts settings are the resolved value", () => {
    const text = buildHeadersFile({
      authored: "",
      security: {
        headers: {
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        },
        hsts: "max-age=600; includeSubDomains; preload",
        privateDynamicPages: true,
      },
      base: "/",
    });
    expect(text).toBe(
      [
        "/*",
        "  X-Content-Type-Options: nosniff",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: no-referrer",
        "  Strict-Transport-Security: max-age=600; includeSubDomains; preload",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("Cross-Origin");
  });

  it("hsts false alone keeps the five headers and drops Strict-Transport-Security", () => {
    const text = buildHeadersFile({
      authored: "",
      security: { ...DEFAULT_SECURITY, hsts: null },
      base: "/",
    });
    expect(text).toContain("  X-Frame-Options: SAMEORIGIN");
    expect(text).not.toContain("Strict-Transport-Security");
  });

  it("stays /* under a non-root base: every URL of the site is under it", () => {
    const text = buildHeadersFile({
      authored: "",
      security: DEFAULT_SECURITY,
      base: "/shop/",
    });
    expect(text.split("\n")[0]).toBe("/*");
  });
});

describe("buildHeadersFile: the author's own rules", () => {
  it("are kept as written after the site-wide rule, comments and blank lines included", () => {
    const authored =
      "# cache fonts\n/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/old\n  X-Robots-Tag: noindex\n";
    const text = buildHeadersFile({
      authored,
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(text).toBe(`${SITE_WIDE.join("\n")}\n\n${authored}`);
  });

  it("an author's /* rule gets the headers it does not set, its own value wins, and it is never written twice", () => {
    const text = buildHeadersFile({
      authored: "/*\n  X-Frame-Options: DENY\n  X-Custom: 1\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(text.match(/^\/\*$/gm)).toHaveLength(1);
    expect(text).toContain("  X-Frame-Options: DENY");
    expect(text).not.toContain("SAMEORIGIN");
    expect(text).toContain("  X-Custom: 1");
    expect(text).toContain(
      "  Referrer-Policy: strict-origin-when-cross-origin",
    );
    expect(text).toContain("  Strict-Transport-Security: max-age=31536000");
  });

  it("an author's /* rule that removes a header (! Name) keeps it removed", () => {
    const text = buildHeadersFile({
      authored: "/*\n  ! Referrer-Policy\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(text).not.toContain("Referrer-Policy: ");
    expect(text).toContain("  ! Referrer-Policy");
  });

  it("an author's /* rule written after other rules is moved first, so a more specific rule can still replace a header", () => {
    const text = buildHeadersFile({
      authored: "/embed/*\n  X-Frame-Options: ALLOWALL\n/*\n  X-Custom: 1\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("/*");
    expect(lines.indexOf("/embed/*")).toBeGreaterThan(lines.indexOf("/*"));
    expect(lines.filter((l) => l === "/*")).toHaveLength(1);
  });

  it("a more specific rule that sets one of the headers gets ! Name first, so Cloudflare replaces Bascik's value instead of joining it", () => {
    const text = buildHeadersFile({
      authored: "/embed/*\n  X-Frame-Options: ALLOWALL\n  X-Custom: 1\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(text).toBe(
      [
        ...SITE_WIDE,
        "",
        "/embed/*",
        "  ! X-Frame-Options",
        "  X-Frame-Options: ALLOWALL",
        "  X-Custom: 1",
        "",
      ].join("\n"),
    );
  });

  it("header names match without regard to case, and a rule that already removes the header gets no second line", () => {
    const text = buildHeadersFile({
      authored:
        "/a\n  x-frame-options: DENY\n/b\n  ! X-Frame-Options\n  X-Frame-Options: DENY\n/c\n  strict-transport-security: max-age=60\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    const rule = (path: string) =>
      text.split(/\n(?=\/)/).find((r) => r.startsWith(`${path}\n`)) ?? "";
    expect(rule("/a")).toBe("/a\n  ! X-Frame-Options\n  x-frame-options: DENY");
    expect(rule("/b").match(/! X-Frame-Options/g)).toHaveLength(1);
    expect(rule("/c")).toContain("  ! Strict-Transport-Security");
  });

  it("a header line written without indentation still belongs to its rule, as Cloudflare reads it", () => {
    const text = buildHeadersFile({
      authored: "/a\nX-Frame-Options: DENY\n",
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(text).toContain("/a\n  ! X-Frame-Options\nX-Frame-Options: DENY");
  });

  it("with every header off, the author's file is written back unchanged", () => {
    const authored = "/embed/*\n  X-Frame-Options: ALLOWALL\n";
    expect(buildHeadersFile({ authored, security: NONE, base: "/" })).toBe(
      authored,
    );
  });
});

describe("buildHeadersFile: contentSecurityPolicy rules for static pages", () => {
  it("writes one exact-path rule per static page with that page's hashes, after the site-wide rule", () => {
    const text = buildHeadersFile({
      authored: "",
      security: NONE,
      base: "/",
      csp: {
        policy,
        hashes: {
          "/": { scripts: ["'sha256-A='"], styles: [] },
          "/docs": { scripts: [], styles: ["'sha256-S='"] },
        },
        staticRoutes: ["/", "/docs"],
      },
    });
    expect(text).toBe(
      [
        "/",
        "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-A='",
        "/docs",
        "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'sha256-S='",
        "",
      ].join("\n"),
    );
  });

  it("default-src 'none' alone: a static page's rule creates script-src and style-src from the hashes only, never 'self'", () => {
    const text = buildHeadersFile({
      authored: "",
      security: NONE,
      base: "/",
      csp: {
        policy: {
          directives: { "default-src": ["'none'"], "img-src": ["'self'"] },
        },
        hashes: { "/": { scripts: ["'sha256-A='"], styles: ["'sha256-S='"] } },
        staticRoutes: ["/"],
      },
    });
    expect(text).toBe(
      [
        "/",
        "  Content-Security-Policy: default-src 'none'; img-src 'self'; script-src 'sha256-A='; style-src 'sha256-S='",
        "",
      ].join("\n"),
    );
  });

  it("prefixes page rules with a non-root base and uses the Report-Only name with reportOnly", () => {
    const text = buildHeadersFile({
      authored: "",
      security: DEFAULT_SECURITY,
      base: "/shop/",
      csp: {
        policy: { ...policy, reportOnly: true },
        hashes: {},
        staticRoutes: ["/"],
      },
    });
    expect(text).toContain("\n/shop/\n  Content-Security-Policy-Report-Only: ");
    expect(text.startsWith("/*\n")).toBe(true);
  });

  it("a page the author already has a rule for gets the CSP line in that rule, not a second rule that would replace it", () => {
    const text = buildHeadersFile({
      authored: "/docs\n  X-Custom: 1\n",
      security: NONE,
      base: "/",
      csp: { policy, hashes: {}, staticRoutes: ["/docs"] },
    });
    expect(text.match(/^\/docs$/gm)).toHaveLength(1);
    expect(text).toContain("/docs\n  Content-Security-Policy: ");
    expect(text).toContain("  X-Custom: 1");
  });

  it("an author's own CSP for that exact page wins", () => {
    const text = buildHeadersFile({
      authored: "/docs\n  Content-Security-Policy: default-src 'none'\n",
      security: NONE,
      base: "/",
      csp: { policy, hashes: {}, staticRoutes: ["/docs"] },
    });
    expect(text).toBe("/docs\n  Content-Security-Policy: default-src 'none'\n");
  });
});

describe("buildHeadersFile: an author rule that matches a static page by wildcard", () => {
  const csp = (staticRoutes: string[]) => ({
    policy,
    hashes: { "/blog/post": { scripts: ["'sha256-A='"], styles: [] } },
    staticRoutes,
  });

  it("an author's /blog/* CSP decides the CSP on /blog/post: Bascik writes no rule there, so the page never gets two policies", () => {
    const text = buildHeadersFile({
      authored: "/shop/blog/*\n  Content-Security-Policy: default-src *\n",
      security: DEFAULT_SECURITY,
      base: "/shop/",
      csp: csp(["/blog/post", "/about"]),
    });
    expect(text).not.toMatch(/^\/shop\/blog\/post$/m);
    // The page it does not match still gets Bascik's rule.
    expect(text).toMatch(/^\/shop\/about\n {2}Content-Security-Policy: /m);
    // The author's rule replaces any earlier value instead of joining it.
    expect(text).toContain(
      "/shop/blog/*\n  ! Content-Security-Policy\n  Content-Security-Policy: default-src *",
    );
  });

  it("an author's /* CSP decides it on every static page", () => {
    const text = buildHeadersFile({
      authored: "/*\n  Content-Security-Policy: default-src 'self'\n",
      security: NONE,
      base: "/",
      csp: csp(["/blog/post", "/"]),
    });
    expect(text).toBe("/*\n  Content-Security-Policy: default-src 'self'\n");
  });

  it("an author rule that removes the header (! Name) on a matching page also decides it", () => {
    const text = buildHeadersFile({
      authored: "/blog/*\n  ! Content-Security-Policy\n",
      security: NONE,
      base: "/",
      csp: csp(["/blog/post"]),
    });
    expect(text).toBe("/blog/*\n  ! Content-Security-Policy\n");
  });

  it("placeholders match one segment, as Cloudflare's do", () => {
    const text = buildHeadersFile({
      authored: "/:section/post\n  Content-Security-Policy: default-src *\n",
      security: NONE,
      base: "/",
      csp: csp(["/blog/post", "/blog/post/more"]),
    });
    expect(text).not.toMatch(/^\/blog\/post$/m);
    expect(text).toMatch(/^\/blog\/post\/more$/m);
  });

  it("a Report-Only policy is decided only by an author rule for the Report-Only header", () => {
    const text = buildHeadersFile({
      authored: "/blog/*\n  Content-Security-Policy: default-src *\n",
      security: NONE,
      base: "/",
      csp: { ...csp(["/blog/post"]), policy: { ...policy, reportOnly: true } },
    });
    expect(text).toMatch(
      /^\/blog\/post\n {2}Content-Security-Policy-Report-Only: /m,
    );
  });

  it("the CSP rules come right after the site-wide rule, before the author's rules", () => {
    const text = buildHeadersFile({
      authored:
        "https://example.com/blog/*\n  Content-Security-Policy: default-src *\n",
      security: DEFAULT_SECURITY,
      base: "/",
      csp: csp(["/blog/post"]),
    });
    const lines = text.split("\n");
    expect(lines.indexOf("/blog/post")).toBeGreaterThan(lines.indexOf("/*"));
    expect(lines.indexOf("/blog/post")).toBeLessThan(
      lines.indexOf("https://example.com/blog/*"),
    );
    // A host rule cannot be matched at build time: it replaces Bascik's
    // value on its host instead of joining it.
    expect(text).toContain(
      "https://example.com/blog/*\n  ! Content-Security-Policy\n",
    );
  });
});

describe("buildHeadersFile: the author's own overlapping rules combine the same way under every security setting", () => {
  const authored =
    "/embed/*\n  X-Frame-Options: ALLOWALL\n\n/*\n  X-Frame-Options: DENY\n\n/fonts/*\n  Cache-Control: max-age=60\n";
  const settings: [string, ResponseSecurity, boolean][] = [
    ["defaults", DEFAULT_SECURITY, false],
    [
      "X-Frame-Options off",
      {
        ...DEFAULT_SECURITY,
        headers: Object.fromEntries(
          Object.entries(DEFAULT_SECURITY.headers).filter(
            ([n]) => n !== "x-frame-options",
          ),
        ),
      },
      false,
    ],
    ["headers off, hsts on", { ...NONE, hsts: "max-age=60" }, false],
    ["headers and hsts off, CSP on", NONE, true],
  ];

  /** Which value of a header a URL gets, applying the rules as Cloudflare does. */
  const valueAt = (text: string, path: string, name: string) => {
    const rules: { path: string; set: [string, string][]; unset: string[] }[] =
      [];
    const byPath = new Map<string, (typeof rules)[number]>();
    let rule: (typeof rules)[number] | undefined;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("/")) {
        rule = { path: line, set: [], unset: [] };
        if (byPath.has(line)) Object.assign(byPath.get(line)!, rule);
        else {
          byPath.set(line, rule);
          rules.push(rule);
        }
        rule = byPath.get(line)!;
        continue;
      }
      if (line.startsWith("! ")) rule!.unset.push(line.slice(2).toLowerCase());
      else {
        const i = line.indexOf(":");
        rule!.set.push([
          line.slice(0, i).toLowerCase(),
          line.slice(i + 1).trim(),
        ]);
      }
    }
    let value: string | undefined;
    for (const r of rules) {
      const re = new RegExp(`^${r.path.replace(/\*/g, ".*")}$`);
      if (!re.test(path)) continue;
      if (r.unset.includes(name)) value = undefined;
      for (const [n, v] of r.set)
        if (n === name) value = value === undefined ? v : `${value}, ${v}`;
    }
    return value;
  };

  it.each(settings)(
    "%s: the more specific /embed/* rule replaces the author's own /* value",
    (_, security, withCsp) => {
      const text = buildHeadersFile({
        authored,
        security,
        base: "/",
        csp: withCsp ? { policy, hashes: {}, staticRoutes: ["/"] } : undefined,
      });
      expect(valueAt(text, "/embed/x", "x-frame-options")).toBe("ALLOWALL");
      expect(valueAt(text, "/", "x-frame-options")).toBe("DENY");
      expect(valueAt(text, "/fonts/a", "cache-control")).toBe("max-age=60");
      expect(text.match(/^\/\*$/gm)).toHaveLength(1);
      // The moved rule leaves no run of blank lines behind.
      expect(text).not.toMatch(/\n\n\n/);
    },
  );

  it("with nothing for Bascik to write (headers, hsts and CSP off), the author's file ships as written", () => {
    expect(buildHeadersFile({ authored, security: NONE, base: "/" })).toBe(
      authored,
    );
  });
});

describe("buildHeadersFile: Cloudflare's 2000-character line limit", () => {
  const manyHashes = Array.from(
    { length: 45 },
    (_, i) => `'sha256-${String(i).padStart(43, "A")}='`,
  );

  it("a static page whose CSP line is over the limit fails the build, naming the page, the length and the fix", () => {
    const run = (variant: "pages" | "workers") => () =>
      buildHeadersFile({
        authored: "",
        security: DEFAULT_SECURITY,
        base: "/shop/",
        csp: {
          policy,
          hashes: { "/many": { scripts: manyHashes, styles: [] } },
          staticRoutes: ["/many"],
        },
        variant,
      });
    expect(run("workers")).toThrow(
      /Content-Security-Policy line for the static page \/shop\/many is \d{4} characters.*2000.*run_worker_first.*inline scripts and styles/s,
    );
    expect(run("pages")).toThrow(
      /--target cloudflare-workers.*run_worker_first/s,
    );
  });

  it("a line just under the limit is written", () => {
    const hashes = manyHashes.slice(0, 30);
    expect(
      buildHeadersFile({
        authored: "",
        security: NONE,
        base: "/",
        csp: {
          policy,
          hashes: { "/p": { scripts: hashes, styles: [] } },
          staticRoutes: ["/p"],
        },
      })
        .split("\n")
        .every((l) => l.length <= CLOUDFLARE_HEADERS_LINE_LIMIT),
    ).toBe(true);
  });

  it("an author's own line over the limit fails too, when Bascik rewrites the file", () => {
    expect(() =>
      buildHeadersFile({
        authored: `/a\n  X-Long: ${"x".repeat(2100)}\n`,
        security: DEFAULT_SECURITY,
        base: "/",
      }),
    ).toThrow(/your _headers is \d+ characters.*2000/s);
  });

  it("exports Cloudflare's limit", () => {
    expect(CLOUDFLARE_HEADERS_LINE_LIMIT).toBe(2000);
  });
});

describe("buildHeadersFile: Cloudflare's 100-rule limit", () => {
  const authoredRules = (n: number) =>
    Array.from({ length: n }, (_, i) => `/a${i}\n  X-Custom: ${i}`).join("\n");

  it("counts path lines as Cloudflare does: a path written twice counts twice; comments and empty rules do not count", () => {
    expect(
      countHeadersRules("# c\n/a\n  X: 1\n/b\nY: 2\n/a\n  Z: 3\n/empty\n"),
    ).toBe(3);
  });

  it("the site-wide rule counts: 99 authored rules plus it is accepted, 100 plus it fails with the count and where it comes from", () => {
    expect(() =>
      buildHeadersFile({
        authored: authoredRules(99),
        security: DEFAULT_SECURITY,
        base: "/",
      }),
    ).not.toThrow();
    expect(() =>
      buildHeadersFile({
        authored: authoredRules(100),
        security: DEFAULT_SECURITY,
        base: "/",
      }),
    ).toThrow(
      /needs 101 rules \(1 site-wide rule for security\.headers and security\.hsts, 100 already in your _headers\), but Cloudflare reads at most 100/,
    );
  });

  it("duplicate author paths count once per path line, so 101 path lines over 51 paths are over the limit with the site-wide rule", () => {
    const dup = Array.from(
      { length: 101 },
      (_, i) => `/p${i % 50}\n  X-Custom: ${i}`,
    ).join("\n");
    const authored = `${dup}\n/blog/*\n  X-Frame-Options: DENY\n`;
    expect(countHeadersRules(authored)).toBe(102);
    expect(() =>
      buildHeadersFile({ authored, security: DEFAULT_SECURITY, base: "/" }),
    ).toThrow(/needs 103 rules/);
  });

  it("an earlier /* duplicate the build removes is not counted", () => {
    const authored = `/*\n  X-A: 1\n${authoredRules(98)}\n/*\n  X-B: 2\n`;
    expect(countHeadersRules(authored)).toBe(100);
    const text = buildHeadersFile({
      authored,
      security: DEFAULT_SECURITY,
      base: "/",
    });
    expect(countHeadersRules(text)).toBe(99);
  });

  it("an author's /* rule adds no rule of its own", () => {
    expect(() =>
      buildHeadersFile({
        authored: `/*\n  X-Custom: 1\n${authoredRules(99)}`,
        security: DEFAULT_SECURITY,
        base: "/",
      }),
    ).not.toThrow();
  });

  it("99 static pages with CSP plus the site-wide rule fit; 100 do not, and the message says the most and the fix", () => {
    const build = (pages: number) => () =>
      buildHeadersFile({
        authored: "",
        security: DEFAULT_SECURITY,
        base: "/",
        csp: {
          policy,
          hashes: {},
          staticRoutes: Array.from({ length: pages }, (_, i) => `/p${i}`),
        },
      });
    expect(build(99)).not.toThrow();
    expect(build(100)).toThrow(
      /needs 101 rules \(100 for contentSecurityPolicy, one for each static page, 1 site-wide rule.*\), but Cloudflare reads at most 100.*run_worker_first": true/s,
    );
  });

  it("exports Cloudflare's limit", () => {
    expect(CLOUDFLARE_HEADERS_RULE_LIMIT).toBe(100);
  });
});

describe("workerPageHeaderOverrides", () => {
  it("names an author rule that sets a security header on a page the Worker renders", () => {
    const warnings = workerPageHeaderOverrides({
      authored:
        "/shop/embed/*\n  X-Frame-Options: ALLOWALL\n/shop/fonts/*\n  Cache-Control: max-age=60\n/shop/other\n  X-Frame-Options: DENY\n",
      base: "/shop/",
      workerPages: ["/embed/dyn", "/fonts/dyn"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /rule \/shop\/embed\/\* sets X-Frame-Options.*\/shop\/embed\/dyn is rendered by the Worker.*security\.headers/s,
    );
  });

  it("is silent when no rule reaches a Worker page", () => {
    expect(
      workerPageHeaderOverrides({
        authored: "/embed/*\n  X-Frame-Options: ALLOWALL\n",
        base: "/",
        workerPages: ["/dyn"],
      }),
    ).toEqual([]);
  });
});
