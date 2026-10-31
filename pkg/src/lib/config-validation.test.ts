import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";

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
  collectConfigWarnings,
  formatConfigErrors,
  normalizeBasePath,
} from "./config-validation.ts";
import { initBascikConfig } from "./config.ts";
import { defineConfig } from "./defineConfig.ts";

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
    const errors = validateConfigShape({
      scripts: { onBuildScriptErr: "error" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.onBuildScriptErr");
    expect(errors[0].message).toContain(
      'did you mean "scripts.onBuildScriptError"',
    );
  });

  it("tells a user who still has logging.pinServerUrl where the setting went", () => {
    const errors = validateConfigShape({ logging: { pinServerUrl: false } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("logging.pinServerUrl");
    expect(errors[0].unknownKey).toBe(true);
    expect(errors[0].message).toContain("--no-pin");
    expect(errors[0].message).toContain("BASCIK_PIN_SERVER_URL=0");
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
    const errors = validateConfigShape({
      http: { hostname: "https://example.com" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.hostname");
    expect(errors[0].value).toBe("https://example.com");
  });

  it("rejects a path as hostname", () => {
    expect(
      validateConfigShape({ http: { hostname: "/tmp/host" } }),
    ).toHaveLength(1);
  });

  it("accepts plain hostnames", () => {
    expect(
      validateConfigShape({ http: { hostname: "localhost" } }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({ http: { hostname: "example.com" } }),
    ).toHaveLength(0);
    expect(validateConfigShape({ http: { hostname: "0.0.0.0" } })).toHaveLength(
      0,
    );
  });
});

describe("scripts.timeout", () => {
  it("rejects zero and negative timeouts", () => {
    expect(validateConfigShape({ scripts: { timeout: 0 } })[0].key).toBe(
      "scripts.timeout",
    );
    expect(validateConfigShape({ scripts: { timeout: -5 } })).toHaveLength(1);
  });

  it("rejects a non-number timeout", () => {
    const errors = validateConfigShape({ scripts: { timeout: "30" as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe("30");
  });

  it("accepts a positive timeout", () => {
    expect(validateConfigShape({ scripts: { timeout: 30000 } })).toHaveLength(
      0,
    );
  });
});

describe("http.timeouts", () => {
  it("accepts every documented key as a positive whole number", () => {
    expect(
      validateConfigShape({
        http: {
          timeouts: { request: 30000, headers: 10000, keepAlive: 5000 },
        },
      }),
    ).toHaveLength(0);
  });

  it.each(["request", "headers", "keepAlive"] as const)(
    "rejects a fractional %s, which Node's server would throw on at start",
    (key) => {
      const errors = validateConfigShape({
        http: { timeouts: { [key]: 1500.5 } },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe(`http.timeouts.${key}`);
      expect(errors[0].message).toContain("whole number");
    },
  );

  it.each([0, -1, Number.NaN, "5000"])("rejects %s for a timeout", (value) => {
    const errors = validateConfigShape({
      http: { timeouts: { keepAlive: value as any } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.keepAlive");
  });

  it("suggests the right key for a typo", () => {
    const errors = validateConfigShape({
      http: { timeouts: { keepalive: 5000 } as any },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.keepalive");
    expect(errors[0].message).toContain(
      'did you mean "http.timeouts.keepAlive"',
    );
  });

  it("rejects headers longer than request, naming both values", () => {
    const errors = validateUserConfig(
      { http: { timeouts: { request: 5000, headers: 8000 } } },
      {},
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.headers");
    expect(errors[0].value).toBe(8000);
    expect(errors[0].message).toContain("http.timeouts.request (5000)");
  });

  it("compares a raised headers timeout against the default request timeout", () => {
    const errors = validateUserConfig(
      { http: { timeouts: { headers: 45000 } } },
      {},
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.headers");
    expect(errors[0].message).toContain("30000, the default");
  });

  it("lowers the default headers timeout to a request set below it, instead of failing", () => {
    // Only request is set; the 10 s headers default must not reject it.
    expect(
      validateUserConfig(
        { http: { timeouts: { request: 5000 } } },
        {},
        { fs: allowAllFs, env: {} },
      ),
    ).toHaveLength(0);
    expect(
      validateUserConfig(
        {},
        { server: { http: { timeouts: { request: 2000 } } } },
        { fs: allowAllFs, env: {} },
      ),
    ).toHaveLength(0);
    const { BascikConfig } = initBascikConfig(
      { http: { timeouts: { request: 5000 } } },
      {},
      { isProdServer: true },
      { fs: allowAllFs, env: {} },
    );
    expect(BascikConfig.http.timeouts).toMatchObject({
      request: 5000,
      headers: 5000,
    });
  });

  it("skips the default export's own pair when every server mode overrides it", () => {
    // dev and --server both raise request; build starts no server.
    expect(
      validateUserConfig(
        { http: { timeouts: { headers: 40000 } } },
        {
          dev: { http: { timeouts: { request: 60000 } } },
          server: { http: { timeouts: { request: 60000 } } },
        },
        { fs: allowAllFs, env: {} },
      ),
    ).toHaveLength(0);
    // A mode export that leaves request alone still runs the default pair.
    const errors = validateUserConfig(
      { http: { timeouts: { headers: 40000 } } },
      { dev: { http: { timeouts: { request: 60000 } } } },
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.headers");
    expect(errors[0].message).toContain("30000, the default");
  });

  it("checks the merged values of each mode export, not each layer alone", () => {
    // request from the default export, headers from the server export: fine.
    expect(
      validateUserConfig(
        { http: { timeouts: { request: 60000 } } },
        { server: { http: { timeouts: { headers: 45000 } } } },
        { fs: allowAllFs, env: {} },
      ),
    ).toHaveLength(0);
    // The dev export lowers request under the default export's headers.
    const errors = validateUserConfig(
      { http: { timeouts: { headers: 20000, request: 60000 } } },
      { dev: { http: { timeouts: { request: 15000 } } } },
      { fs: allowAllFs, env: {} },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.timeouts.headers");
    expect(errors[0].message).toContain("(15000)");
  });

  it("initBascikConfig fills the documented defaults and keeps a partial object's others", () => {
    const { BascikConfig: defaults } = initBascikConfig(
      {},
      {},
      {},
      { fs: allowAllFs, env: {} },
    );
    expect(defaults.http.timeouts).toMatchObject({
      request: 30000,
      headers: 10000,
      keepAlive: 5000,
    });
    const { BascikConfig: partial } = initBascikConfig(
      { http: { timeouts: { keepAlive: 2000 } } },
      {},
      { isProdServer: true },
      { fs: allowAllFs, env: {} },
    );
    expect(partial.http.timeouts).toMatchObject({
      request: 30000,
      headers: 10000,
      keepAlive: 2000,
    });
  });
});

// F093: a wrong-typed body limit used to reach api-runtime, where
// `"1mb" > 0` and `"1mb" <= 0` are both false, so no limit applied.
describe("http.maxBodySize, http.apiTimeout and http.httpCache", () => {
  const httpErrors = (http: Record<string, unknown>) =>
    validateConfigShape({ http }, { cwd: "/project" });

  it.each(["1mb", "1048576", -1, 1.5, Number.NaN, Infinity, null, true])(
    "rejects maxBodySize %s",
    (value) => {
      const errors = httpErrors({ maxBodySize: value });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe("http.maxBodySize");
      expect(errors[0].value).toBe(value);
      expect(errors[0].message).toContain("whole number of bytes");
    },
  );

  it("accepts a byte count, and 0 for no limit", () => {
    expect(httpErrors({ maxBodySize: 1048576 })).toEqual([]);
    expect(httpErrors({ maxBodySize: 0 })).toEqual([]);
  });

  it.each(["10s", -5, Number.NaN, Infinity, 2 ** 31, null, false])(
    "rejects apiTimeout %s",
    (value) => {
      const errors = httpErrors({ apiTimeout: value });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe("http.apiTimeout");
      expect(errors[0].message).toContain("milliseconds");
    },
  );

  it("accepts an apiTimeout in milliseconds, and 0 for no timeout", () => {
    expect(httpErrors({ apiTimeout: 10000 })).toEqual([]);
    expect(httpErrors({ apiTimeout: 0 })).toEqual([]);
    expect(httpErrors({ apiTimeout: 2 ** 31 - 1 })).toEqual([]);
  });

  it.each(["false", 0, 1, null])("rejects httpCache %s", (value) => {
    const errors = httpErrors({ httpCache: value });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("http.httpCache");
    expect(errors[0].message).toBe("expected true or false");
  });

  it("reports a wrong type in a mode export too", () => {
    const errors = validateUserConfig(
      {},
      { server: { http: { maxBodySize: "1mb" } } },
      { fs: allowAllFs, cwd: "/project", env: {} },
    );
    expect(errors.map((error) => error.key)).toContain("http.maxBodySize");
  });
});

// F094: these keys used to accept any value. A string "false" is truthy, so
// `generate: { sitemap: "false" }` still generated the sitemap.
describe("value types of boolean, cache and exec settings", () => {
  const shape = (raw: unknown) => validateConfigShape(raw, { cwd: "/project" });

  it.each([
    ["generate", "sitemap"],
    ["generate", "robots"],
    ["generate", "sitemapLastmod"],
    ["generate", "cspHashes"],
    ["generate", "manifest"],
    ["scoping", "scriptBlocks"],
    ["scoping", "inheritAttributes"],
    ["scoping", "deduplicateCss"],
    ["logging", "requests"],
    ["logging", "copies"],
    ["logging", "deletes"],
    ["logging", "transpiles"],
  ])("rejects a non-boolean %s.%s", (section, key) => {
    for (const value of ["false", 0, null, {}]) {
      const errors = shape({ [section]: { [key]: value } });
      expect(errors, String(value)).toHaveLength(1);
      expect(errors[0].key).toBe(`${section}.${key}`);
      expect(errors[0].value).toBe(value);
      expect(errors[0].message).toBe("expected true or false");
    }
    expect(shape({ [section]: { [key]: false } })).toEqual([]);
    expect(shape({ [section]: { [key]: true } })).toEqual([]);
  });

  it.each(["class", "id", "name"])(
    "rejects a non-boolean scoping.attributes.%s",
    (key) => {
      const errors = shape({ scoping: { attributes: { [key]: "yes" } } });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe(`scoping.attributes.${key}`);
    },
  );

  it.each([
    "directory",
    "components",
    "scoping",
    "assets",
    "generate",
    "pipeline",
    "scripts",
    "http",
    "logging",
  ])("rejects a %s section that is not an object", (section) => {
    for (const value of [false, "x", null, []]) {
      const errors = shape({ [section]: value });
      expect(errors, JSON.stringify(value)).toHaveLength(1);
      expect(errors[0].key).toBe(section);
      expect(errors[0].message).toBe("expected an object");
    }
  });

  it.each([
    ["scoping.attributes", { scoping: { attributes: true } }],
    ["http.tls", { http: { tls: "on" } }],
  ])("rejects a %s that is not an object", (key, raw) => {
    const errors = shape(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe(key);
  });

  it("rejects a scripts.cache that is neither a boolean nor an object", () => {
    for (const value of ["off", 0, null, ["a"]]) {
      const errors = shape({ scripts: { cache: value } });
      expect(errors, JSON.stringify(value)).toHaveLength(1);
      expect(errors[0].key).toBe("scripts.cache");
      expect(errors[0].message).toContain("true, false, or an object");
    }
  });

  it("checks the fields of an object scripts.cache", () => {
    const errors = shape({
      scripts: {
        cache: {
          enabled: "no",
          include: "src/**",
          exclude: [""],
          environment: ["API_KEY", 7],
        },
      },
    });
    expect(errors.map((error) => error.key)).toEqual([
      "scripts.cache.enabled",
      "scripts.cache.include",
      "scripts.cache.exclude[0]",
      "scripts.cache.environment[1]",
    ]);
    expect(
      shape({
        scripts: {
          cache: {
            enabled: false,
            include: ["src/**"],
            exclude: [],
            environment: ["API_KEY"],
          },
        },
      }),
    ).toEqual([]);
    expect(shape({ scripts: { cache: false } })).toEqual([]);
  });

  it("checks the optional fields of an exec entry", () => {
    const errors = shape({
      pipeline: {
        exec: [
          {
            script: "scripts/a.ts",
            watch: 7,
            cwd: "",
            env: { A: 1 },
            args: "--full",
            timeout: "60s",
          },
          { script: "scripts/b.ts", watch: ["content/", ""], env: "A=1" },
          { script: "scripts/c.ts", args: ["--full", 2], timeout: -1 },
        ],
      },
    });
    expect(errors.map((error) => error.key)).toEqual([
      "pipeline.exec[0].watch",
      "pipeline.exec[0].cwd",
      'pipeline.exec[0].env["A"]',
      "pipeline.exec[0].args",
      "pipeline.exec[0].timeout",
      "pipeline.exec[1].watch[1]",
      "pipeline.exec[1].env",
      "pipeline.exec[2].args[1]",
      "pipeline.exec[2].timeout",
    ]);
  });

  it("accepts every documented exec entry field", () => {
    expect(
      shape({
        pipeline: {
          exec: [
            {
              script: "scripts/a.ts",
              phase: "parallel",
              cwd: ".",
              args: ["--full"],
              env: { CUSTOM: "1" },
              timeout: 60000,
              watch: ["content/"],
            },
            { script: "scripts/b.ts", watch: "content/**/*.md", timeout: 0 },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("initBascikConfig refuses a string boolean instead of treating it as true", () => {
    expect(() =>
      initBascikConfig(
        { generate: { sitemap: "false" as unknown as boolean } },
        {},
        { isBuild: true },
        { fs: allowAllFs, env: {} },
      ),
    ).toThrow(/generate\.sitemap[\s\S]*expected true or false/);
  });
});

describe("http.cacheControl", () => {
  it("types and accepts a string or a per-extension map (yarn pkg:typecheck)", () => {
    const one = defineConfig({
      http: { cacheControl: "public, max-age=600" },
    });
    const map = defineConfig({
      http: {
        cacheControl: {
          ".css": "public, max-age=31536000, immutable",
          woff2: "public, max-age=31536000, immutable",
        },
      },
    });
    expect(validateConfigShape(one)).toHaveLength(0);
    expect(validateConfigShape(map)).toHaveLength(0);
    // @ts-expect-error a max-age number is not a Cache-Control value
    defineConfig({ http: { cacheControl: 3600 } });
    // @ts-expect-error each extension maps to a Cache-Control string
    defineConfig({ http: { cacheControl: { ".css": 3600 } } });
  });

  it.each([3600, true, ["public"]])(
    "rejects %j, naming both accepted shapes",
    (value) => {
      const errors = validateConfigShape({
        http: { cacheControl: value as any },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe("http.cacheControl");
      expect(errors[0].message).toContain("per-extension");
    },
  );

  it("locates a non-string value in the map at its extension", () => {
    const errors = validateConfigShape({
      http: {
        cacheControl: { ".css": "public, max-age=60", ".png": 86400 } as any,
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe('http.cacheControl[".png"]');
    expect(errors[0].value).toBe(86400);
  });

  it("rejects a key that is not a file extension, which would never match", () => {
    const errors = validateConfigShape({
      http: {
        cacheControl: {
          "*.css": "public, max-age=60",
          "assets/logo.png": "no-cache",
        },
      },
    });
    expect(errors.map((e) => e.key)).toEqual([
      'http.cacheControl["*.css"]',
      'http.cacheControl["assets/logo.png"]',
    ]);
    expect(errors[0].message).toContain('".css"');
  });
});

describe("scripts.typescript", () => {
  it("is a known key that accepts true, false, or a function", () => {
    expect(validateConfigShape({ scripts: { typescript: true } })).toHaveLength(
      0,
    );
    expect(
      validateConfigShape({ scripts: { typescript: false } }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({
        scripts: { typescript: async (code: string) => code },
      }),
    ).toHaveLength(0);
  });

  it("rejects a string or object value", () => {
    const errors = validateConfigShape({
      scripts: { typescript: "esbuild" as any },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.typescript");
    expect(errors[0].message).toMatch(/true, false, or a function/);
    expect(
      validateConfigShape({ scripts: { typescript: {} as any } }),
    ).toHaveLength(1);
  });
});

describe("scripts.importRoot", () => {
  const missingFs = {
    existsSync: () => false,
    isDirectory: () => false,
    isReadableFile: () => false,
  };

  it("is a known key", () => {
    expect(
      validateConfigShape({ scripts: { importRoot: "src" } }),
    ).toHaveLength(0);
  });

  it("rejects a non-string value", () => {
    const errors = validateConfigShape({ scripts: { importRoot: 42 as any } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.importRoot");
    expect(errors[0].value).toBe(42);
  });

  it("rejects an empty string", () => {
    const errors = validateConfigShape({ scripts: { importRoot: "" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.importRoot");
  });

  it("accepts an import root outside the project root (monorepo shared scripts)", () => {
    // Pinned on purpose: unlike directory.out, the import root is read-only and
    // legitimately points at a sibling folder in a monorepo. Never add an escape check.
    expect(
      validateConfigShape(
        { scripts: { importRoot: "../shared/scripts" } },
        { cwd: "/project" },
      ),
    ).toHaveLength(0);
    expect(
      validateConfigPaths(
        { scripts: { importRoot: "../shared/scripts" } },
        { fs: allowAllFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
  });

  it("does not error when the import root directory is missing", () => {
    expect(
      validateConfigPaths(
        { scripts: { importRoot: "helpers" } },
        { fs: missingFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
    expect(
      validateUserConfig(
        { scripts: { importRoot: "helpers" } },
        {},
        { fs: missingFs, cwd: "/project", env: {} },
      ),
    ).toHaveLength(0);
  });

  it("warns (not errors) when the import root directory is missing", () => {
    const warnings = collectConfigWarnings(
      { scripts: { importRoot: "helpers" } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].key).toBe("scripts.importRoot");
    expect(warnings[0].value).toBe("helpers");
    expect(warnings[0].message).toContain("does not exist");
  });

  it("does not warn when the import root exists or was not set", () => {
    expect(
      collectConfigWarnings(
        { scripts: { importRoot: "src" } },
        { fs: allowAllFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
    expect(
      collectConfigWarnings({}, { fs: missingFs, cwd: "/project" }),
    ).toHaveLength(0);
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
    expect(
      validateConfigShape({ minify: { css: "lightningcss" as any } }),
    ).toHaveLength(1);
  });

  it("accepts booleans and functions", () => {
    expect(
      validateConfigShape({ minify: { css: true, js: (c: string) => c } }),
    ).toHaveLength(0);
    expect(validateConfigShape({ minify: true })).toHaveLength(0);
  });

  it("rejects a non-boolean non-object minify", () => {
    expect(validateConfigShape({ minify: "yes" as any })).toHaveLength(1);
  });
});

describe("error action enums", () => {
  it("rejects a typo in scripts.onBuildScriptError", () => {
    const errors = validateConfigShape({
      scripts: { onBuildScriptError: "erorr" as any },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scripts.onBuildScriptError");
    expect(errors[0].value).toBe("erorr");
    expect(errors[0].message).toContain('"warn", "error", or "ignore"');
  });

  it("rejects invalid onRoutesScriptError and onServerScriptError", () => {
    expect(
      validateConfigShape({ scripts: { onRoutesScriptError: "halt" as any } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ scripts: { onServerScriptError: "halt" as any } }),
    ).toHaveLength(1);
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
    expect(validateConfigShape({ pipeline: { workers: true } })).toHaveLength(
      0,
    );
    expect(validateConfigShape({ pipeline: { workers: 4 } })).toHaveLength(0);
  });
});

describe("pipeline.onExecError", () => {
  it("accepts warn and error", () => {
    expect(
      validateConfigShape({ pipeline: { onExecError: "warn" } }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({ pipeline: { onExecError: "error" } }),
    ).toHaveLength(0);
  });

  it("rejects ignore and typos, naming the allowed values", () => {
    for (const value of ["ignore", "erorr", true]) {
      const errors = validateConfigShape({
        pipeline: { onExecError: value as any },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe("pipeline.onExecError");
      expect(errors[0].message).toContain('"warn" or "error"');
    }
  });
});

describe("pipeline.exec phase", () => {
  it("rejects an unknown exec phase, folded into the validation pass", () => {
    const errors = validateConfigShape({
      pipeline: {
        exec: [{ script: "scripts/a.js", phase: "invalid-phase" as any }],
      },
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
    const errors = validateConfigShape({
      directory: { public: "static" },
    } as any);
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.public");
    expect(errors[0].unknownKey).toBe(true);
  });

  it("does not check directory paths the user did not set", () => {
    expect(
      validateConfigPaths({}, { fs: missingFs, cwd: "/project" }),
    ).toHaveLength(0);
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

describe("directory.components shape (string | string[])", () => {
  it("accepts a single string", () => {
    expect(
      validateConfigShape(
        { directory: { components: "src/components" } },
        { cwd: "/project" },
      ),
    ).toHaveLength(0);
  });

  it("accepts an array of strings, including paths outside the project", () => {
    expect(
      validateConfigShape(
        {
          directory: {
            components: ["../../shared/components", "src/components"],
          },
        },
        { cwd: "/project" },
      ),
    ).toHaveLength(0);
  });

  it("rejects an empty array", () => {
    const errors = validateConfigShape(
      { directory: { components: [] } },
      { cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.components");
    expect(errors[0].message).toMatch(/non-empty/);
  });

  it("rejects an array containing a non-string element", () => {
    const errors = validateConfigShape(
      { directory: { components: ["src/components", 42] } } as any,
      { cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.components[1]");
    expect(errors[0].value).toBe(42);
  });

  it("rejects an array containing an empty string element", () => {
    const errors = validateConfigShape(
      { directory: { components: ["src/components", ""] } },
      { cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.components[1]");
  });

  it("still rejects a non-string, non-array value", () => {
    const errors = validateConfigShape(
      { directory: { components: 7 } } as any,
      { cwd: "/project" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("directory.components");
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
      validateConfigShape(
        { directory: { out: "/project/dist" } },
        { cwd: "/project" },
      ),
    ).toHaveLength(0);
    expect(
      validateConfigShape(
        { directory: { out: "../shared/dist" } },
        { cwd: "/project" },
      ),
    ).toHaveLength(1);
  });
});

// F092 / F047: the output directory is emptied at the start of every build
// and dev session, so an out that holds (or is) a source folder deletes it.
describe("directory.out overlap with source folders", () => {
  const overlapErrors = (userConfig: unknown, modeOverrides: unknown = {}) =>
    validateUserConfig(userConfig, modeOverrides, {
      fs: allowAllFs,
      cwd: "/project",
      env: {},
    }).filter((error) => error.key === "directory.out");

  it("rejects an out that contains the default source folders", () => {
    const errors = overlapErrors({ directory: { out: "src" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe("src");
    expect(errors[0].message).toContain('directory.pages "src/pages"');
    expect(errors[0].message).toContain(
      'directory.components "src/components"',
    );
    expect(errors[0].message).toContain('directory.api "src/api"');
    expect(errors[0].message).toContain('scripts.importRoot "src"');
    expect(errors[0].message).toContain("emptied at the start of every build");
  });

  it("rejects an out equal to the pages folder", () => {
    const errors = overlapErrors({
      directory: { pages: "site", out: "site" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('directory.pages "site"');
  });

  it("rejects an out that contains a pages folder set alone (out left at its default)", () => {
    const errors = overlapErrors({ directory: { pages: "dist/pages" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe("dist");
    expect(errors[0].message).toContain('directory.pages "dist/pages"');
  });

  it("rejects an out that contains one of several component roots", () => {
    const errors = overlapErrors({
      directory: {
        components: ["src/components", "build/shared"],
        out: "build",
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('directory.components "build/shared"');
  });

  it("rejects an out inside the pages folder: built pages would be read back as source", () => {
    const errors = overlapErrors({ directory: { out: "src/pages/dist" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'is inside directory.pages "src/pages"',
    );
  });

  it("rejects an out set only in a mode export", () => {
    const errors = overlapErrors({}, { build: { directory: { out: "src" } } });
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe("src");
  });

  it("rejects an absolute out that resolves to a source folder", () => {
    const errors = overlapErrors({ directory: { out: "/project/src/" } });
    expect(errors).toHaveLength(1);
  });

  it("rejects an out that is the project root", () => {
    for (const out of [".", "./", "/project"]) {
      const errors = validateConfigShape(
        { directory: { out } },
        { cwd: "/project" },
      );
      expect(errors, out).toHaveLength(1);
      expect(errors[0].key).toBe("directory.out");
      expect(errors[0].message).toContain("is the project root");
    }
  });

  it("accepts the default layout and separate output folders", () => {
    expect(overlapErrors({})).toEqual([]);
    expect(overlapErrors({ directory: { out: "dist" } })).toEqual([]);
    expect(overlapErrors({ directory: { out: "build/site" } })).toEqual([]);
    // Inside the import root but outside every source folder: nothing is
    // deleted and nothing is read back.
    expect(overlapErrors({ directory: { out: "src/dist" } })).toEqual([]);
    // A sibling whose name starts with the source folder's name.
    expect(overlapErrors({ directory: { out: "src/pages-dist" } })).toEqual([]);
    expect(
      overlapErrors({
        directory: {
          pages: "pages",
          components: "components",
          api: "api",
          out: "src",
        },
        scripts: { importRoot: "lib" },
      }),
    ).toEqual([]);
  });

  it("leaves wrong-typed directory values to their own type errors", () => {
    const errors = validateUserConfig(
      { directory: { out: 7, pages: ["src"] } },
      {},
      { fs: allowAllFs, cwd: "/project", env: {} },
    );
    expect(errors.map((error) => error.message)).not.toContain(
      expect.stringContaining("emptied"),
    );
  });

  it("initBascikConfig refuses the config before anything is deleted", () => {
    expect(() =>
      initBascikConfig(
        { directory: { out: "src" } },
        {},
        { isBuild: true },
        { fs: allowAllFs, cwd: process.cwd(), env: {} },
      ),
    ).toThrow(/directory\.out[\s\S]*emptied at the start of every build/);
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

  it("checks a glob watchPaths entry by the folder before its first wildcard", () => {
    // Resolved the way the validator resolves them, so the test holds on Windows too.
    const existing = new Set([
      resolve("/project", "content"),
      resolve("/project", "data"),
    ]);
    const fs = {
      ...missingFs,
      existsSync: (path: string) => existing.has(path),
    };
    expect(
      validateConfigPaths(
        {
          pipeline: {
            watchPaths: ["content/**/*.md", "data/*.json", "missing/**/*.md"],
          },
        },
        { fs, cwd: "/project" },
      ).map((error) => error.value),
    ).toEqual(["missing/**/*.md"]);
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
    const tls = {
      enabled: true,
      keyFile: "certs/key.pem",
      certFile: "certs/cert.pem",
    };
    const errors = validateConfigPaths(
      { http: { tls } },
      { fs: missingFs, cwd: "/project" },
    );
    expect(errors).toHaveLength(2);
    expect(errors[0].key).toBe("http.tls.keyFile");
    expect(errors[1].key).toBe("http.tls.certFile");
    expect(errors[0].message).toContain("not readable");

    const disabled = { enabled: false, keyFile: "certs/key.pem" };
    expect(
      validateConfigPaths(
        { http: { tls: disabled } },
        { fs: missingFs, cwd: "/project" },
      ),
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
    expect(invalidErrors.some((e) => e.key === "http.rateLimit.window")).toBe(
      true,
    );
    expect(invalidErrors.some((e) => e.key === "http.rateLimit.max")).toBe(
      true,
    );

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
          pipeline: {
            watchPaths: ["content/"],
            exec: [{ script: "scripts/gen.ts" }],
          },
          assets: { inlineStyles: ["src/css/styles.css"] },
          http: { tls: { enabled: true, keyFile: "k.pem", certFile: "c.pem" } },
        },
        { fs: allowAllFs, cwd: "/project" },
      ),
    ).toHaveLength(0);
  });
});

describe("asset configuration", () => {
  it("accepts a boolean assets.symlink setting and rejects other values", () => {
    expect(validateConfigShape({ assets: { symlink: true } })).toEqual([]);
    expect(
      validateConfigShape({ assets: { symlink: "true" } as any }),
    ).toContainEqual(
      expect.objectContaining({
        key: "assets.symlink",
        message: expect.stringContaining("boolean"),
      }),
    );
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

describe("components.external", () => {
  it("accepts exact tag names and wildcard patterns", () => {
    expect(
      validateConfigShape({
        components: { external: ["heading-anchors", "vendor-*", "*-widget"] },
      }),
    ).toHaveLength(0);
    expect(validateConfigShape({ components: { external: [] } })).toHaveLength(
      0,
    );
  });

  it("rejects a non-array value, naming the key", () => {
    const errors = validateConfigShape({
      components: { external: "heading-anchors" as any },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("components.external");
    expect(errors[0].message).toContain("array");
  });

  it("rejects malformed entries with the entry index in the key", () => {
    const errors = validateConfigShape({
      components: { external: ["heading-anchors", "div span", 42 as any, ""] },
    });
    expect(errors.map((e) => e.key)).toEqual([
      "components.external[1]",
      "components.external[2]",
      "components.external[3]",
    ]);
    expect(errors[0].message).toContain("tag name or wildcard");
  });

  it("suggests the right key for a near miss", () => {
    const errors = validateConfigShape({
      components: { extrnal: ["heading-anchors"] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("components.extrnal");
    expect(errors[0].message).toContain('did you mean "components.external"');
  });
});

describe("scoping.preserve and assets.exclude", () => {
  it("rejects a malformed preserve entry", () => {
    const errors = validateConfigShape({
      scoping: { preserve: ["code", "div span"] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scoping.preserve[1]");
    expect(errors[0].value).toBe("div span");
    expect(errors[0].message).toContain("tag name");
  });

  it("accepts plausible tag names including custom elements", () => {
    expect(
      validateConfigShape({
        scoping: { preserve: ["code", "pre", "my-element"] },
      }),
    ).toHaveLength(0);
  });

  it("accepts wildcard patterns in preserve entries", () => {
    expect(
      validateConfigShape({ scoping: { preserve: ["vendor-*"] } }),
    ).toHaveLength(0);
    expect(
      validateConfigShape({ scoping: { preserve: ["*-widget"] } }),
    ).toHaveLength(0);
    expect(validateConfigShape({ scoping: { preserve: ["*"] } })).toHaveLength(
      0,
    );
    expect(
      validateConfigShape({ scoping: { preserve: ["code", "vendor-*"] } }),
    ).toHaveLength(0);
  });

  it("still rejects malformed preserve entries alongside wildcards", () => {
    expect(
      validateConfigShape({ scoping: { preserve: ["div span"] } }),
    ).toHaveLength(1);
    expect(validateConfigShape({ scoping: { preserve: [""] } })).toHaveLength(
      1,
    );
    expect(
      validateConfigShape({ scoping: { preserve: ["ven dor"] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ scoping: { preserve: ["a".repeat(51)] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ scoping: { preserve: [42 as any] } }),
    ).toHaveLength(1);
  });

  it("holds an entry without * to the plausible tag name rule", () => {
    const errors = validateConfigShape({
      scoping: { preserve: ["vendor-*", "1bad"] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("scoping.preserve[1]");
    expect(errors[0].value).toBe("1bad");
  });

  it("rejects wildcard entries with characters outside [a-zA-Z0-9-*]", () => {
    expect(
      validateConfigShape({ scoping: { preserve: ["vendor_*"] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ scoping: { preserve: ["vendor-?"] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ scoping: { preserve: ["vendor-[ab]"] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({
        scoping: { preserve: [`vendor-${"*".repeat(60)}`] },
      }),
    ).toHaveLength(1);
  });

  it("rejects invalid exclude glob entries", () => {
    expect(validateConfigShape({ assets: { exclude: [""] } })).toHaveLength(1);
    expect(
      validateConfigShape({ assets: { exclude: [42 as any] } }),
    ).toHaveLength(1);
    expect(
      validateConfigShape({ assets: { exclude: ["dist/**", "unbalanced["] } }),
    ).toHaveLength(1);
  });

  it("accepts valid exclude globs", () => {
    expect(
      validateConfigShape({
        assets: { exclude: ["dist/**", "**/*.map", "assets/[0-9].png"] },
      }),
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
      validateUserConfig(
        {},
        {},
        { fs: allowAllFs, env: { BASCIK_SITE_URL: "https://example.com" } },
      ),
    ).toHaveLength(0);
  });

  it("ignores an unset site URL", () => {
    expect(
      validateUserConfig({}, {}, { fs: allowAllFs, env: {} }),
    ).toHaveLength(0);
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
        fs: {
          existsSync: () => false,
          isDirectory: () => false,
          isReadableFile: () => false,
        },
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
    expect(
      errors.filter((e) => e.message.includes("does not exist")),
    ).toHaveLength(0);
    expect(
      errors.filter((e) => e.message.includes("not readable")),
    ).toHaveLength(0);
  });
});

describe("error report formatting", () => {
  it("groups errors by key with value and expectation, matching the report shape", () => {
    const report = formatConfigErrors([
      {
        key: "http.port",
        value: 70000,
        message: "expected an integer between 1 and 65535",
      },
      {
        key: "minify.js",
        value: "esbuild",
        message: "expected true, false, or a function",
      },
      {
        key: "scripts.onBuildScriptErr",
        value: undefined,
        message: 'did you mean "scripts.onBuildScriptError"?',
        unknownKey: true,
      },
      {
        key: "pipeline.exec[0].script",
        value: "scripts/gen-data.ts",
        message: "file does not exist",
      },
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
      {
        key: "http.port",
        value: 70000,
        message: "expected an integer between 1 and 65535",
      },
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
        http: {
          port: 8080,
          hostname: "localhost",
          tls: { enabled: true, keyFile: "k.pem", certFile: "c.pem" },
        },
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
    expect(thrown!.message).toContain(
      "Configuration errors in bascik.config.ts",
    );
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
    const { BascikConfig: cfg } = initBascikConfig(
      { base: "/" },
      {},
      {},
      { fs: allowAllFs, env: {} },
    );
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
