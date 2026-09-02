import { describe, it, expect, vi } from "vitest";

// userConfig is mocked so config.ts can be imported without top-level await
vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import {
  validateConfigShape,
  validateConfigPaths,
  validateUserConfig,
  formatConfigErrors,
  normalizeBasePath,
} from "./config-validation.ts";
import { initBascikConfig } from "./config.ts";

/** fs stub where every path exists, is a directory, and is readable. */
const allowAllFs = {
  existsSync: () => true,
  isDirectory: () => true,
  isReadableFile: () => true,
};

describe("unknown keys", () => {
  it("rejects an unknown top-level key with a near-miss suggestion", () => {
    const errors = validateConfigShape({ directroy: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directroy");
    expect(errors[0].message).toContain('did you mean "directory"');
  });

  it("rejects a minify typo and suggests minify", () => {
    const errors = validateConfigShape({ minfy: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("minfy");
    expect(errors[0].message).toContain('did you mean "minify"');
  });

  it("rejects an unknown nested key with a full-path suggestion", () => {
    const errors = validateConfigShape({ scripts: { onBuildScriptErr: "error" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.onBuildScriptErr");
    expect(errors[0].message).toContain(
      'did you mean "scripts.onBuildScriptError"',
    );
  });

  it("does not suggest anything for an unrelated key", () => {
    const errors = validateConfigShape({ zzzzzz: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("zzzzzz");
    expect(errors[0].message).not.toContain("did you mean");
  });

  it("rejects unknown keys nested two levels deep", () => {
    const errors = validateConfigShape({ http: { tls: { keyfile: "k.pem" } } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.tls.keyfile");
    expect(errors[0].message).toContain('did you mean "http.tls.keyFile"');
  });

  it("rejects unknown keys inside exec entries", () => {
    const errors = validateConfigShape({
      pipeline: { exec: [{ script: "a.js", scirpt: "b.js" }] },
    });
    expect(errors.some((e) => e.key === "pipeline.exec[0].scirpt")).toBe(true);
  });
});

describe("http.port", () => {
  it("rejects a port above 65535, naming key and value", () => {
    const errors = validateConfigShape({ http: { port: 70000 } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.port");
    expect(errors[0].value).toBe(70000);
    expect(errors[0].message).toContain("integer between 1 and 65535");
  });

  it("rejects a string port", () => {
    const errors = validateConfigShape({ http: { port: "8080" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.port");
    expect(errors[0].value).toBe("8080");
  });

  it("rejects zero and fractional ports", () => {
    expect(validateConfigShape({ http: { port: 0 } })).toHaveLength(1);
    expect(validateConfigShape({ http: { port: 3.5 } })).toHaveLength(1);
  });

  it("accepts a valid port", () => {
    expect(validateConfigShape({ http: { port: 8080 } })).toHaveLength(0);
  });
});

describe("http.hostname", () => {
  it("rejects a URL as hostname", () => {
    const errors = validateConfigShape({ http: { hostname: "https://example.com" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.hostname");
    expect(errors[0].value).toBe("https://example.com");
  });

  it("rejects a path as hostname", () => {
    expect(validateConfigShape({ http: { hostname: "/tmp/host" } })).toHaveLength(1);
  });

  it("accepts plain hostnames", () => {
    expect(validateConfigShape({ http: { hostname: "localhost" } })).toHaveLength(0);
    expect(validateConfigShape({ http: { hostname: "example.com" } })).toHaveLength(0);
    expect(validateConfigShape({ http: { hostname: "0.0.0.0" } })).toHaveLength(0);
  });
});

describe("scripts.timeout", () => {
  it("rejects zero and negative timeouts", () => {
    expect(validateConfigShape({ scripts: { timeout: 0 } })[0].key).toBe("scripts.timeout");
    expect(validateConfigShape({ scripts: { timeout: -5 } })).toHaveLength(1);
  });

  it("rejects a non-number timeout", () => {
    const errors = validateConfigShape({ scripts: { timeout: "30" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe("30");
  });

  it("accepts a positive timeout", () => {
    expect(validateConfigShape({ scripts: { timeout: 30000 } })).toHaveLength(0);
  });
});

describe("minify.css and minify.js", () => {
  it("rejects a string minify.js, naming key and value", () => {
    const errors = validateConfigShape({ minify: { js: "esbuild" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("minify.js");
    expect(errors[0].value).toBe("esbuild");
    expect(errors[0].message).toContain("true, false, or a function");
  });

  it("rejects a string minify.css", () => {
    expect(validateConfigShape({ minify: { css: "lightningcss" as any } })).toHaveLength(1);
  });

  it("accepts booleans and functions", () => {
    expect(validateConfigShape({ minify: { css: true, js: (c: string) => c } })).toHaveLength(0);
    expect(validateConfigShape({ minify: true })).toHaveLength(0);
  });

  it("rejects a non-boolean non-object minify", () => {
    expect(validateConfigShape({ minify: "yes" as any })).toHaveLength(1);
  });
});

describe("error action enums", () => {
  it("rejects a typo in scripts.onBuildScriptError", () => {
    const errors = validateConfigShape({ scripts: { onBuildScriptError: "erorr" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.onBuildScriptError");
    expect(errors[0].value).toBe("erorr");
    expect(errors[0].message).toContain('"warn", "error", or "ignore"');
  });

  it("rejects invalid onRoutesScriptError and onServerScriptError", () => {
    expect(validateConfigShape({ scripts: { onRoutesScriptError: "halt" as any } })).toHaveLength(1);
    expect(validateConfigShape({ scripts: { onServerScriptError: "halt" as any } })).toHaveLength(1);
  });

  it("rejects ignore for onMinifyError (only warn or error)", () => {
    const errors = validateConfigShape({ onMinifyError: "ignore" as any });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("onMinifyError");
    expect(errors[0].message).toContain('"warn" or "error"');
  });

  it("accepts all valid values", () => {
    expect(
      validateConfigShape({
        scripts: {
          onBuildScriptError: "warn",
          onRoutesScriptError: "ignore",
          onServerScriptError: "error",
        },
        onMinifyError: "error",
      }),
    ).toHaveLength(0);
  });
});

describe("pipeline.workers", () => {
  it("rejects a string workers value", () => {
    const errors = validateConfigShape({ pipeline: { workers: "4" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("pipeline.workers");
    expect(errors[0].message).toContain("true, false, or a positive integer");
  });

  it("rejects zero and negative integers", () => {
    expect(validateConfigShape({ pipeline: { workers: 0 } })).toHaveLength(1);
    expect(validateConfigShape({ pipeline: { workers: -2 } })).toHaveLength(1);
  });

  it("accepts booleans and positive integers", () => {
    expect(validateConfigShape({ pipeline: { workers: true } })).toHaveLength(0);
    expect(validateConfigShape({ pipeline: { workers: 4 } })).toHaveLength(0);
  });
});

describe("pipeline.exec phase", () => {
  it("rejects an unknown exec phase, folded into the validation pass", () => {
    const errors = validateConfigShape({
      pipeline: { exec: [{ script: "scripts/a.js", phase: "invalid-phase" as any }] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("pipeline.exec[0].phase");
    expect(errors[0].value).toBe("invalid-phase");
    expect(errors[0].message).toContain('"pre", "post", or "parallel"');
  });

  it("accepts the known phases and an omitted phase", () => {
    expect(
      validateConfigShape({
        pipeline: {
          exec: [
            { script: "a.js", phase: "pre" },
            { script: "b.js", phase: "post" },
            { script: "c.js", phase: "parallel" },
            { script: "d.js" },
          ],
        },
      }),
    ).toHaveLength(0);
  });
});

describe("directory paths (fs half)", () => {
  const missingFs = {
    existsSync: () => false,
    isDirectory: () => false,
    isReadableFile: () => false,
  };

  it("rejects a pages directory that does not exist, naming key and value", () => {
    const errors = validateConfigPaths(
      { directory: { pages: "src/page" } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.pages");
    expect(errors[0].value).toBe("src/page");
    expect(errors[0].message).toContain("does not exist");
  });

  it("rejects a pages path that exists but is not a directory", () => {
    const errors = validateConfigPaths(
      { directory: { pages: "README.md" } },
      { fs: { ...allowAllFs, isDirectory: () => false }, cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.pages");
    expect(errors[0].message).toContain("expected a directory");
  });

  it("rejects directory.public as an unknown configuration key", () => {
    const errors = validateConfigShape(
      { directory: { public: "static" } } as any,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.public");
    expect(errors[0].unknownKey).toBe(true);
  });

  it("does not check directory paths the user did not set", () => {
    expect(validateConfigPaths({}, { fs: missingFs, cwd: "/project" })).toHaveLength(0);
  });

  it("accepts existing directories", () => {
    expect(
      validateConfigPaths(
        { directory: { pages: "src/pages" } },
        { fs: allowAllFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
  });
});

describe("directory.out escape check", () => {
  it("rejects an out directory that escapes the project root", () => {
    const errors = validateConfigShape(
      { directory: { out: "../../.." } },
      { cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.out");
    expect(errors[0].value).toBe("../../..");
    expect(errors[0].message).toContain("outside the project root");
  });

  it("accepts out directories inside the project root", () => {
    expect(
      validateConfigShape({ directory: { out: "dist" } }, { cwd: "/project" }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({ directory: { out: "/project/dist" } }, { cwd: "/project" }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({ directory: { out: "../shared/dist" } }, { cwd: "/project" }),
    ).toHaveLength(1);
  });
});

describe("referenced files (fs half)", () => {
  const missingFs = {
    existsSync: () => false,
    isDirectory: () => false,
    isReadableFile: () => false,
  };

  it("rejects watchPaths entries that do not exist", () => {
    const errors = validateConfigPaths(
      { pipeline: { watchPaths: ["src/missing"] } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("pipeline.watchPaths[0]");
    expect(errors[0].value).toBe("src/missing");
    expect(errors[0].message).toContain("does not exist");
  });

  it("rejects inlineStyles entries that do not exist", () => {
    const errors = validateConfigPaths(
      { assets: { inlineStyles: ["src/css/missing.css"] } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("assets.inlineStyles[0]");
  });

  it("rejects an exec script that does not exist, with an indexed key", () => {
    const errors = validateConfigPaths(
      { pipeline: { exec: [{ script: "scripts/gen-data.ts" }] } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("pipeline.exec[0].script");
    expect(errors[0].value).toBe("scripts/gen-data.ts");
    expect(errors[0].message).toContain("file does not exist");
  });

  it("checks TLS key and cert files only when TLS is enabled", () => {
    const tls = { enabled: true, keyFile: "certs/key.pem", certFile: "certs/cert.pem" };
    const errors = validateConfigPaths({ http: { tls } }, { fs: missingFs, cwd: "/project" });
    expect(errors).toHaveLength(2);
    expect(errors[0].key).toBe("http.tls.keyFile");
    expect(errors[1].key).toBe("http.tls.certFile");
    expect(errors[0].message).toContain("not readable");

    const disabled = { enabled: false, keyFile: "certs/key.pem" };
    expect(
      validateConfigPaths({ http: { tls: disabled } }, { fs: missingFs, cwd: "/project" }),
    ).toHaveLength(0);
  });

  it("validates http.trustProxy and http.rateLimit options", () => {
    const invalidErrors = validateConfigShape({
      http: {
        trustProxy: "yes" as any,
        rateLimit: { window: -10, max: "500" as any },
      },
    });
    expect(invalidErrors.some((e) => e.key === "http.trustProxy")).toBe(true);
    expect(invalidErrors.some((e) => e.key === "http.rateLimit.window")).toBe(true);
    expect(invalidErrors.some((e) => e.key === "http.rateLimit.max")).toBe(true);

    const validErrors = validateConfigShape({
      http: {
        trustProxy: true,
        rateLimit: { window: 5000, max: 100 },
      },
    });
    expect(validErrors).toHaveLength(0);
  });

  it("accepts referenced files that all exist", () => {
    expect(
      validateConfigPaths(
        {
          pipeline: { watchPaths: ["content/"], exec: [{ script: "scripts/gen.ts" }] },
          assets: { inlineStyles: ["src/css/styles.css"] },
          http: { tls: { enabled: true, keyFile: "k.pem", certFile: "c.pem" } },
        },
        { fs: allowAllFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
  });
});

describe("base normalization", () => {
  it("normalizes leading and trailing slashes", () => {
    expect(normalizeBasePath("/sub")).toBe("/sub/");
    expect(normalizeBasePath("sub")).toBe("/sub/");
    expect(normalizeBasePath("/sub/")).toBe("/sub/");
    expect(normalizeBasePath("/a/b")).toBe("/a/b/");
  });

  it("keeps the root base as-is", () => {
    expect(normalizeBasePath("/")).toBe("/");
  });

  it("rejects an absolute URL instead of normalizing it", () => {
    const errors = validateConfigShape({ base: "https://example.com/sub/" });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("base");
    expect(errors[0].value).toBe("https://example.com/sub/");
    expect(errors[0].message).toContain("not a URL");
  });

  it.each([
    "/docs?mode=preview",
    "/docs#top",
    "/../docs",
    "/docs/./preview",
    "docs\\preview",
    "/docs\u0000preview",
  ])("rejects a base that is not a URL path prefix: %j", (base) => {
    const errors = validateConfigShape({ base });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("base");
    expect(errors[0].message).toContain("path prefix");
  });

  it("accepts normalizable base values", () => {
    expect(validateConfigShape({ base: "/sub" })).toHaveLength(0);
    expect(validateConfigShape({ base: "sub" })).toHaveLength(0);
    expect(validateConfigShape({ base: "/" })).toHaveLength(0);
  });
});

describe("scoping.preserve and assets.exclude", () => {
  it("rejects a malformed preserve entry", () => {
    const errors = validateConfigShape({ scoping: { preserve: ["code", "div span"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scoping.preserve[1]");
    expect(errors[0].value).toBe("div span");
    expect(errors[0].message).toContain("tag name");
  });

  it("accepts plausible tag names including custom elements", () => {
    expect(
      validateConfigShape({ scoping: { preserve: ["code", "pre", "my-element"] } }),
    ).toHaveLength(0);
  });

  it("rejects invalid exclude glob entries", () => {
    expect(validateConfigShape({ assets: { exclude: [""] } })).toHaveLength(1);
    expect(validateConfigShape({ assets: { exclude: [42 as any] } })).toHaveLength(1);
    expect(validateConfigShape({ assets: { exclude: ["dist/**", "unbalanced["] } })).toHaveLength(1);
  });

  it("accepts valid exclude globs", () => {
    expect(
      validateConfigShape({ assets: { exclude: ["dist/**", "**/*.map", "assets/[0-9].png"] } }),
    ).toHaveLength(0);
  });
});

describe("site URL in the same pass", () => {
  it("reports an invalid BASCIK_SITE_URL alongside config errors", () => {
    const errors = validateUserConfig(
      { http: { port: 70000 } },
      {},
      { fs: allowAllFs, env: { BASCIK_SITE_URL: "example.com" } },
    );
    expect(errors).toHaveLength(2);
    const siteUrlError = errors.find((e) => e.key === "BASCIK_SITE_URL");
    expect(siteUrlError).toBeDefined();
    expect(siteUrlError!.value).toBe("example.com");
    expect(siteUrlError!.message).toContain("absolute http or https URL");
  });

  it("accepts an absolute site URL", () => {
    expect(
      validateUserConfig({}, {}, { fs: allowAllFs, env: { BASCIK_SITE_URL: "https://example.com" } }),
    ).toHaveLength(0);
  });

  it("ignores an unset site URL", () => {
    expect(validateUserConfig({}, {}, { fs: allowAllFs, env: {} })).toHaveLength(0);
  });
});

describe("mode override layers", () => {
  it("validates named mode exports and dedupes errors shared across layers", () => {
    const errors = validateUserConfig(
      { http: { port: 70000 } },
      { build: { http: { port: 70000 } }, server: { http: { port: 70000 } } },
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.port");
  });

  it("validates a flat (legacy) override object as a config layer", () => {
    const errors = validateUserConfig(
      {},
      { scripts: { timeout: -1 } },
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.timeout");
  });
});

describe("aggregation", () => {
  it("reports every validation failure together", () => {
    const errors = validateUserConfig(
      {
        http: { port: 70000 },
        minify: { js: "esbuild" as any },
        scripts: { onBuildScriptErr: "error" } as any,
        pipeline: { exec: [{ script: "scripts/missing.ts" }] },
      },
      {},
      {
        fs: { existsSync: () => false, isDirectory: () => false, isReadableFile: () => false },
        env: {},
      },
    );
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.key).sort()).toEqual([
      "http.port",
      "minify.js",
      "pipeline.exec[0].script",
      "scripts.onBuildScriptErr",
    ]);
  });
});

describe("pure half performs no filesystem access", () => {
  it("reports no existence errors even for paths that do not exist", () => {
    // If the pure half touched the filesystem it would either throw (real fs
    // on these nonexistent paths is fine, but no "does not exist" error may
    // appear) — the fs half owns every existence/readability message.
    const errors = validateConfigShape(
      {
        directory: { pages: "definitely/not/here" },
        pipeline: {
          watchPaths: ["nope/"],
          exec: [{ script: "scripts/nope.ts" }],
        },
        assets: { inlineStyles: ["nope.css"] },
        http: { tls: { enabled: true, keyFile: "nope.pem" } },
      },
      { cwd: "/project" },
    );
    expect(errors.filter((e) => e.message.includes("does not exist"))).toHaveLength(0);
    expect(errors.filter((e) => e.message.includes("not readable"))).toHaveLength(0);
  });
});

describe("error report formatting", () => {
  it("groups errors by key with value and expectation, matching the report shape", () => {
    const report = formatConfigErrors([
      { key: "http.port", value: 70000, message: "expected an integer between 1 and 65535" },
      { key: "minify.js", value: "esbuild", message: "expected true, false, or a function" },
      {
        key: "scripts.onBuildScriptErr",
        value: undefined,
        message: 'did you mean "scripts.onBuildScriptError"?',
        unknownKey: true,
      },
      { key: "pipeline.exec[0].script", value: "scripts/gen-data.ts", message: "file does not exist" },
    ]);

    expect(report).toContain("Configuration errors in bascik.config.ts");
    expect(report).toContain("http.port");
    expect(report).toContain("70000");
    expect(report).toContain("expected an integer between 1 and 65535");
    expect(report).toContain('"esbuild"');
    expect(report).toContain("scripts.onBuildScriptErr");
    expect(report).toContain("unknown key");
    expect(report).toContain('did you mean "scripts.onBuildScriptError"?');
    expect(report).toContain("scripts/gen-data.ts");
    expect(report).toContain("4 configuration errors");
  });

  it("uses the singular form for one error", () => {
    const report = formatConfigErrors([
      { key: "http.port", value: 70000, message: "expected an integer between 1 and 65535" },
    ]);
    expect(report).toContain("1 configuration error");
    expect(report).not.toContain("1 configuration errors");
  });
});

describe("valid config", () => {
  it("produces zero errors for a fully valid config", () => {
    const errors = validateUserConfig(
      {
        directory: { pages: "src/pages", out: "dist" },
        scoping: { preserve: ["code"] },
        minify: { css: true, js: (code: string) => code },
        assets: { inlineStyles: ["src/css/styles.css"], exclude: ["**/*.map"] },
        pipeline: {
          watchPaths: ["content/"],
          exec: [{ script: "scripts/gen.ts", phase: "post" }],
          workers: 4,
        },
        scripts: { timeout: 30000, onBuildScriptError: "error" },
        onMinifyError: "warn",
        http: { port: 8080, hostname: "localhost", tls: { enabled: true, keyFile: "k.pem", certFile: "c.pem" } },
        logging: { level: "debug" },
        base: "/docs",
      },
      { build: { minify: { identifiers: true } } },
      { fs: allowAllFs, env: { BASCIK_SITE_URL: "https://example.com" } },
    );
    expect(errors).toHaveLength(0);
  });
});

describe("initBascikConfig integration", () => {
  it("throws the aggregated report when the config is invalid", () => {
    let thrown: Error | undefined;
    try {
      initBascikConfig(
        { http: { port: 70000 }, minify: { js: "esbuild" as any } },
        {},
        {},
        { fs: allowAllFs, env: {} },
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("Configuration errors in bascik.config.ts");
    expect(thrown!.message).toContain("http.port");
    expect(thrown!.message).toContain("70000");
    expect(thrown!.message).toContain("minify.js");
    expect(thrown!.message).toContain('"esbuild"');
    expect(thrown!.message).toContain("2 configuration errors");
  });

  it("normalizes base to a leading and trailing slash", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { base: "docs" },
      {},
      {},
      { fs: allowAllFs, env: {} },
    );
    expect(cfg.base).toBe("/docs/");
  });

  it("keeps a root base as-is", () => {
    const { BascikConfig: cfg } = initBascikConfig({ base: "/" }, {}, {}, { fs: allowAllFs, env: {} });
    expect(cfg.base).toBe("/");
  });

  it("returns a config with no errors for valid input", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { http: { port: 8080 } },
      {},
      {},
      { fs: allowAllFs, env: {} },
    );
    expect(cfg.http.port).toBe(8080);
  });
});
