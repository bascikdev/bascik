/**
 * Opt-in `contentSecurityPolicy` (Collin 2026-10-28: nothing extra by
 * default, easy protection). One pure function builds the header both hosts
 * send, from the configured directives and the route's BUILD hashes
 * (csp-hashes.json, already widened for request-time components); it never
 * sees a response body. Validation is located like other config errors.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import { contentSecurityPolicyHeader } from "./content-security-policy.ts";
import {
  collectConfigWarnings,
  validateConfigShape,
} from "./config-validation.ts";

const HASHES = {
  scripts: ["'sha256-AAA='", "'sha256-BBB='"],
  styles: ["'sha256-CCC='"],
};

describe("contentSecurityPolicyHeader", () => {
  it("joins the directives in order and appends the route's hashes to script-src and style-src", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "https://cdn.example.com"],
            "style-src": ["'self'"],
          },
        },
        HASHES,
      ),
    ).toEqual({
      name: "content-security-policy",
      value:
        "default-src 'self'; script-src 'self' https://cdn.example.com 'sha256-AAA=' 'sha256-BBB='; style-src 'self' 'sha256-CCC='",
    });
  });

  it("creates script-src and style-src from default-src's sources plus hashes when absent", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "default-src": ["'self'"] } },
        HASHES,
      ).value,
    ).toBe(
      "default-src 'self'; script-src 'self' 'sha256-AAA=' 'sha256-BBB='; style-src 'self' 'sha256-CCC='",
    );
  });

  // Red team 2026-10-28: the merge used to invent script-src 'self' (and
  // style-src 'self') when the author wrote only default-src 'none', which
  // let same-origin script files run that the author's policy blocked.
  it("default-src 'none' alone: the created script-src and style-src are just the hashes (never an invented 'self')", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "default-src": ["'none'"], "img-src": ["'self'"] } },
        HASHES,
      ).value,
    ).toBe(
      "default-src 'none'; img-src 'self'; script-src 'sha256-AAA=' 'sha256-BBB='; style-src 'sha256-CCC='",
    );
  });

  it("a created directive keeps every default-src source (a CDN origin is not dropped)", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "default-src": ["'self'", "https://cdn.example.com"],
          },
        },
        { scripts: ["'sha256-AAA='"], styles: [] },
      ).value,
    ).toBe(
      "default-src 'self' https://cdn.example.com; script-src 'self' https://cdn.example.com 'sha256-AAA='",
    );
  });

  it("no script-src and no default-src: no directive is created (inline scripts already run, and an invented one would block the author's script files)", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "img-src": ["'self'"] } },
        HASHES,
      ).value,
    ).toBe("img-src 'self'");
  });

  it("default-src with 'unsafe-inline' and no script-src: no directive is created (a hash would turn 'unsafe-inline' off)", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "default-src": ["'self'", "'unsafe-inline'"] } },
        HASHES,
      ).value,
    ).toBe("default-src 'self' 'unsafe-inline'");
  });

  it("an author-written script-src is only extended: its sources stay as written, in order", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "default-src": ["'self'", "https://other.example.com"],
            "script-src": ["https://cdn.example.com"],
            "style-src": ["'self'"],
          },
        },
        HASHES,
      ).value,
    ).toBe(
      "default-src 'self' https://other.example.com; script-src https://cdn.example.com 'sha256-AAA=' 'sha256-BBB='; style-src 'self' 'sha256-CCC='",
    );
  });

  it("an author-written script-src 'none' becomes just the hashes (a header never lists 'none' beside a source)", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "script-src": ["'none'"] } },
        { scripts: ["'sha256-AAA='"], styles: [] },
      ).value,
    ).toBe("script-src 'sha256-AAA='");
  });

  it("script-src-elem and style-src-elem, when written, get the hashes too (they override script-src and style-src for <script> and <style> elements)", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "default-src": ["'none'"],
            "script-src-elem": ["'self'"],
            "style-src-elem": ["'self'"],
          },
        },
        HASHES,
      ).value,
    ).toBe(
      "default-src 'none'; script-src-elem 'self' 'sha256-AAA=' 'sha256-BBB='; style-src-elem 'self' 'sha256-CCC='; script-src 'sha256-AAA=' 'sha256-BBB='; style-src 'sha256-CCC='",
    );
  });

  it("script-src-elem with 'unsafe-inline' gets no hashes", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "script-src": ["'self'"],
            "script-src-elem": ["'self'", "'unsafe-inline'"],
          },
        },
        { scripts: ["'sha256-AAA='"], styles: [] },
      ).value,
    ).toBe(
      "script-src 'self' 'sha256-AAA='; script-src-elem 'self' 'unsafe-inline'",
    );
  });

  it("script-src-attr and style-src-attr get no hashes (an element hash never matches an attribute, and they fall back to script-src/style-src only when absent)", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "script-src": ["'self'"],
            "script-src-attr": ["'none'"],
            "style-src": ["'self'"],
            "style-src-attr": ["'none'"],
          },
        },
        HASHES,
      ).value,
    ).toBe(
      "script-src 'self' 'sha256-AAA=' 'sha256-BBB='; script-src-attr 'none'; style-src 'self' 'sha256-CCC='; style-src-attr 'none'",
    );
  });

  it("does not create a directive when the route has no hashes of that kind", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "default-src": ["'self'"] } },
        { scripts: [], styles: [] },
      ).value,
    ).toBe("default-src 'self'");
  });

  it("hashes: false sends the directives as written", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "script-src": ["'self'"] }, hashes: false },
        HASHES,
      ).value,
    ).toBe("script-src 'self'");
  });

  it("hashes: { styles: false } hashes scripts only, so style attributes keep working under the author's style-src", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "default-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'"],
          },
          hashes: { scripts: true, styles: false },
        },
        HASHES,
      ).value,
    ).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-AAA=' 'sha256-BBB='",
    );
    expect(
      contentSecurityPolicyHeader(
        {
          directives: { "default-src": ["'self'"] },
          hashes: { scripts: false },
        },
        HASHES,
      ).value,
    ).toBe("default-src 'self'; style-src 'self' 'sha256-CCC='");
  });

  it("a directive that lists 'unsafe-inline' gets no hashes (a hash would turn 'unsafe-inline' off)", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "script-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'"],
          },
        },
        HASHES,
      ).value,
    ).toBe(
      "script-src 'self' 'sha256-AAA=' 'sha256-BBB='; style-src 'self' 'unsafe-inline'",
    );
  });

  it("a route with no entry (undefined hashes) gets the directives as written", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "script-src": ["'self'"] } },
        undefined,
      ).value,
    ).toBe("script-src 'self'");
  });

  it("reportOnly names the Report-Only header", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: { "default-src": ["'self'"], "report-to": ["csp"] },
          reportOnly: true,
        },
        undefined,
      ).name,
    ).toBe("content-security-policy-report-only");
  });

  it("a directive with no sources is written alone (upgrade-insecure-requests)", () => {
    expect(
      contentSecurityPolicyHeader(
        {
          directives: {
            "upgrade-insecure-requests": [],
            "default-src": ["'self'"],
          },
        },
        undefined,
      ).value,
    ).toBe("upgrade-insecure-requests; default-src 'self'");
  });

  it("does not repeat a hash the author also listed", () => {
    expect(
      contentSecurityPolicyHeader(
        { directives: { "script-src": ["'self'", "'sha256-AAA='"] } },
        { scripts: ["'sha256-AAA='"], styles: [] },
      ).value,
    ).toBe("script-src 'self' 'sha256-AAA='");
  });

  it("is portable: no node: imports (the Worker sends the same header)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./content-security-policy.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
  });
});

describe("config validation: contentSecurityPolicy", () => {
  const shape = (csp: unknown) =>
    validateConfigShape({ contentSecurityPolicy: csp });
  const warnings = (csp: unknown) =>
    collectConfigWarnings({ contentSecurityPolicy: csp });

  it("accepts a well-formed policy", () => {
    expect(
      shape({
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "https://cdn.example.com"],
          "img-src": ["'self'", "data:", "https:"],
          "upgrade-insecure-requests": [],
        },
        hashes: true,
        reportOnly: false,
      }),
    ).toEqual([]);
  });

  it("requires directives", () => {
    const errors = shape({});
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("contentSecurityPolicy.directives");
  });

  it("an unknown directive gets a did-you-mean", () => {
    const errors = shape({ directives: { script_src: ["'self'"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("contentSecurityPolicy.directives");
    expect(errors[0].message).toBe(
      '"script_src" is not a CSP directive. Did you mean "script-src"?',
    );
  });

  it("an unquoted keyword says how to write it", () => {
    const errors = shape({ directives: { "script-src": ["self"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe(
      "contentSecurityPolicy.directives.script-src[0]",
    );
    expect(errors[0].message).toBe(
      "write self as 'self' (with single quotes).",
    );
    expect(
      shape({ directives: { "script-src": ["'self'", "unsafe-inline"] } })[0]
        .key,
    ).toBe("contentSecurityPolicy.directives.script-src[1]");
  });

  it("an unquoted keyword is caught in every source-list directive, -elem and -attr variants included", () => {
    for (const directive of [
      "default-src",
      "script-src",
      "script-src-elem",
      "script-src-attr",
      "style-src",
      "style-src-elem",
      "style-src-attr",
      "img-src",
      "font-src",
      "connect-src",
      "media-src",
      "object-src",
      "frame-src",
      "child-src",
      "worker-src",
      "manifest-src",
      "fenced-frame-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]) {
      const errors = shape({ directives: { [directive]: ["self"] } });
      expect(errors, directive).toHaveLength(1);
      expect(errors[0].key, directive).toBe(
        `contentSecurityPolicy.directives.${directive}[0]`,
      );
      expect(errors[0].message, directive).toBe(
        "write self as 'self' (with single quotes).",
      );
    }
  });

  it("an upper-case -elem directive is still a source list", () => {
    const errors = shape({ directives: { "Script-Src-Elem": ["none"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(
      "write none as 'none' (with single quotes).",
    );
  });

  it("a misspelled -elem or -attr directive gets a did-you-mean", () => {
    expect(
      shape({ directives: { "script-src-elm": ["'self'"] } })[0].message,
    ).toBe(
      '"script-src-elm" is not a CSP directive. Did you mean "script-src-elem"?',
    );
    expect(
      shape({ directives: { style_src_attr: ["'self'"] } })[0].message,
    ).toBe(
      '"style_src_attr" is not a CSP directive. Did you mean "style-src-attr"?',
    );
  });

  it("a keyword in a non-source-list directive is left alone (sandbox, require-trusted-types-for)", () => {
    expect(
      shape({
        directives: {
          sandbox: ["allow-scripts"],
          "require-trusted-types-for": ["'script'"],
        },
      }),
    ).toEqual([]);
  });

  it("a source with whitespace or ';' is refused (it would start another source or directive)", () => {
    for (const bad of [
      "'self' https://a.example",
      "https://a.example; script-src *",
    ]) {
      const errors = shape({ directives: { "script-src": [bad] } });
      expect(errors, bad).toHaveLength(1);
      expect(errors[0].key).toBe(
        "contentSecurityPolicy.directives.script-src[0]",
      );
    }
  });

  it("directive values must be arrays of strings; hashes and reportOnly booleans", () => {
    expect(shape({ directives: { "script-src": "'self'" } })[0].key).toBe(
      "contentSecurityPolicy.directives.script-src",
    );
    expect(shape({ directives: {}, hashes: "yes" })[0]).toMatchObject({
      key: "contentSecurityPolicy.hashes",
      message:
        "expected a boolean, or { scripts, styles } booleans to hash only one kind",
    });
    expect(shape({ directives: {}, reportOnly: 1 })[0].key).toBe(
      "contentSecurityPolicy.reportOnly",
    );
  });

  it("an unknown key under contentSecurityPolicy gets a did-you-mean", () => {
    const errors = shape({ directives: {}, reportonly: true });
    expect(errors[0].key).toBe("contentSecurityPolicy.reportonly");
    expect(errors[0].message).toContain(
      'did you mean "contentSecurityPolicy.reportOnly"',
    );
  });

  it("warns that 'unsafe-inline' in script-src lets injected scripts run (and gets no hashes)", () => {
    const found = warnings({
      directives: { "script-src": ["'self'", "'unsafe-inline'"] },
    });
    expect(found.map((w) => w.message)).toEqual([
      "contentSecurityPolicy.directives.script-src lists 'unsafe-inline', so every inline script runs, including one injected into a page, and Bascik adds no script hashes to it. Remove 'unsafe-inline' to allow only the scripts from your build.",
    ]);
    expect(
      warnings({
        directives: { "script-src": ["'self'", "'unsafe-inline'"] },
        hashes: false,
      }),
    ).toEqual([]);
  });

  it("warns about 'unsafe-inline', * and https: in script-src-elem too (it decides which <script> elements run)", () => {
    const found = warnings({
      directives: { "script-src-elem": ["'self'", "'unsafe-inline'", "*"] },
    });
    expect(found.map((w) => [w.key, w.message])).toEqual([
      [
        "contentSecurityPolicy.directives.script-src-elem",
        "contentSecurityPolicy.directives.script-src-elem lists 'unsafe-inline', so every inline script runs, including one injected into a page, and Bascik adds no script hashes to it. Remove 'unsafe-inline' to allow only the scripts from your build.",
      ],
      [
        "contentSecurityPolicy.directives.script-src-elem",
        "contentSecurityPolicy.directives.script-src-elem lists *, so a script from any site may run. List the origins you load scripts from instead.",
      ],
    ]);
  });

  it("'unsafe-inline' in style-src is a normal first step: no warning", () => {
    expect(
      warnings({
        directives: { "style-src": ["'self'", "'unsafe-inline'"] },
      }),
    ).toEqual([]);
  });

  it("hashes may be an object of scripts and styles booleans", () => {
    expect(shape({ directives: {}, hashes: { styles: false } })).toEqual([]);
    const errors = shape({ directives: {}, hashes: { style: false } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("contentSecurityPolicy.hashes.style");
    expect(errors[0].message).toBe(
      'did you mean "contentSecurityPolicy.hashes.styles"?',
    );
    expect(
      shape({ directives: {}, hashes: { scripts: "no" } })[0],
    ).toMatchObject({
      key: "contentSecurityPolicy.hashes.scripts",
      message: "expected a boolean",
    });
  });

  it("warns about * and https: in script-src (any site's script may run)", () => {
    for (const wide of ["*", "https:"]) {
      const found = warnings({ directives: { "script-src": [wide] } });
      expect(found, wide).toHaveLength(1);
      expect(found[0].key).toBe("contentSecurityPolicy.directives.script-src");
    }
  });

  it("warns when reportOnly has nowhere to report", () => {
    const found = warnings({
      directives: { "default-src": ["'self'"] },
      reportOnly: true,
    });
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe("contentSecurityPolicy.reportOnly");
    expect(
      warnings({
        directives: { "default-src": ["'self'"], "report-uri": ["/csp"] },
        reportOnly: true,
      }),
    ).toEqual([]);
  });

  it("no contentSecurityPolicy, no findings (default unchanged)", () => {
    expect(validateConfigShape({})).toEqual([]);
    expect(collectConfigWarnings({})).toEqual([]);
  });
});
