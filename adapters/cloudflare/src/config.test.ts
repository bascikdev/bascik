import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  parseJsonc,
  parseToml,
  discoverWranglerConfig,
  resolveWorkerName,
  generateWranglerConfig,
  WRANGLER_CONFIG_FILES,
} from "./config.ts";

/**
 * Invokes a throwing function and returns the thrown error message.
 * Asserts that the function actually throws.
 */
function errorMessageFrom(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Expected the function to throw, but it did not.");
}

describe("parseJsonc", () => {
  it("parses valid JSON without comments", () => {
    const json = `{"name": "my-worker", "compatibility_date": "2026-08-01"}`;
    const result = parseJsonc(json);
    expect(result).toEqual({
      name: "my-worker",
      compatibility_date: "2026-08-01",
    });
  });

  it("handles line comments (//) and block comments (/* */)", () => {
    const jsonc = `
    // Main config for worker
    {
      /* Worker name */
      "name": "commented-worker",
      // Date definition
      "compatibility_date": "2026-08-01" /* end of line block */
    }
    `;
    const result = parseJsonc(jsonc);
    expect(result).toEqual({
      name: "commented-worker",
      compatibility_date: "2026-08-01",
    });
  });

  it("handles trailing commas in objects and arrays", () => {
    const jsonc = `
    {
      "name": "trailing-comma-worker",
      "compatibility_flags": [
        "nodejs_compat",
        "custom_flag",
      ],
      "vars": {
        "API_URL": "https://api.example.com",
      },
    }
    `;
    const result = parseJsonc(jsonc);
    expect(result).toEqual({
      name: "trailing-comma-worker",
      compatibility_flags: ["nodejs_compat", "custom_flag"],
      vars: { API_URL: "https://api.example.com" },
    });
  });

  it("preserves URLs and slashes in string literals without treating them as comments", () => {
    const jsonc = `
    {
      "name": "url-test",
      "url": "https://example.com//path/*",
      "comment_like": "// not a comment /* still not */"
    }
    `;
    const result = parseJsonc(jsonc);
    expect(result).toEqual({
      name: "url-test",
      url: "https://example.com//path/*",
      comment_like: "// not a comment /* still not */",
    });
  });

  it("throws actionable errors for malformed JSONC syntax without disclosing secret contents", () => {
    const badJsonc = `{ "name": "bad", "unclosed": }`;
    expect(() => parseJsonc(badJsonc, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("throws actionable errors for malformed JSONC that can contain secret canaries without disclosing them", () => {
    const canary = "THIS_IS_A_SECRET_CANARY_12345_ABCD";
    // Use actual malformed JSONC syntax that causes throwing, with a canary embedded
    const badJsonc = `{ "name": "bad", "secret": "` + canary + `", unclosed }`;
    expect(() => parseJsonc(badJsonc, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
    // Verify the error message does NOT contain the canary value
    const msg = errorMessageFrom(() => parseJsonc(badJsonc, "wrangler.jsonc"));
    expect(msg).not.toContain(canary);
  });

  it("throws actionable error for unclosed block comments", () => {
    const unclosed = `{ "name": "bad" /* unclosed comment `;
    expect(() => parseJsonc(unclosed, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("rejects tokens joined across comments instead of silently merging them", () => {
    const joined = `{"value":1/* comment */2}`;
    expect(() => parseJsonc(joined, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("rejects partial values instead of returning partial results", () => {
    const partial = `{"value":1, "other": }`;
    expect(() => parseJsonc(partial, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("rejects non-object top-level values", () => {
    for (const bad of [`[1,2,3]`, `42`, `"hello"`, `null`, `true`]) {
      expect(() => parseJsonc(bad, "wrangler.jsonc")).toThrowError(
        /\[bascik\] Failed to parse wrangler\.jsonc/,
      );
    }
  });

  it("rejects empty or whitespace-only input", () => {
    for (const bad of [``, `   `, `\n\t `]) {
      expect(() => parseJsonc(bad, "wrangler.jsonc")).toThrowError(
        /\[bascik\] Failed to parse wrangler\.jsonc/,
      );
    }
  });

  it("rejects trailing content after the top-level object", () => {
    const trailing = `{"name": "x"} {"name": "y"}`;
    expect(() => parseJsonc(trailing, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("keeps comment-like text inside string literals", () => {
    const jsonc = `{"name": "worker", "note": "// not a comment /* still not */"}`;
    const result = parseJsonc(jsonc);
    expect(result.note).toBe("// not a comment /* still not */");
  });
});

describe("parseToml", () => {
  it("parses basic key-value pairs and comments", () => {
    const toml = `
    # Worker configuration
    name = "toml-worker"
    compatibility_date = "2026-08-01"
    main = "worker.js"
    workers_dev = true
    port = 8787
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "toml-worker",
      compatibility_date: "2026-08-01",
      main: "worker.js",
      workers_dev: true,
      port: 8787,
    });
  });

  it("parses section tables [vars]", () => {
    const toml = `
    name = "vars-worker"

    [vars]
    KEY = "value"
    SECRET_KEY = "dummy-secret"
    ENABLED = true
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "vars-worker",
      vars: {
        KEY: "value",
        SECRET_KEY: "dummy-secret",
        ENABLED: true,
      },
    });
  });

  it("handles inline comments in TOML", () => {
    const toml = `
    name = "inline-comment-worker" # name of worker
    compatibility_date = "2026-08-01" # compatibility date
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "inline-comment-worker",
      compatibility_date: "2026-08-01",
    });
  });

  it("parses inline arrays in TOML", () => {
    const toml = `
    name = "array-worker"
    compatibility_flags = ["nodejs_compat", "custom_flag"]
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "array-worker",
      compatibility_flags: ["nodejs_compat", "custom_flag"],
    });
  });

  it("parses multi-line arrays in TOML", () => {
    const toml = `
    name = "multiline-array-worker"
    compatibility_flags = [
      "nodejs_compat",
      "custom_flag",
    ]
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "multiline-array-worker",
      compatibility_flags: ["nodejs_compat", "custom_flag"],
    });
  });

  it("parses array of tables in TOML ([[migrations]])", () => {
    const toml = `
    name = "durable-objects-worker"

    [[migrations]]
    tag = "v1"
    new_classes = ["MyDurableObject"]

    [[migrations]]
    tag = "v2"
    deleted_classes = ["OldDurableObject"]
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "durable-objects-worker",
      migrations: [
        {
          tag: "v1",
          new_classes: ["MyDurableObject"],
        },
        {
          tag: "v2",
          deleted_classes: ["OldDurableObject"],
        },
      ],
    });
  });

  it("throws actionable errors for malformed TOML syntax", () => {
    const badToml = `invalid toml line without equals`;
    expect(() => parseToml(badToml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
  });

  it("throws actionable errors for malformed TOML that can contain secret canaries without disclosing them", () => {
    const canary = "THIS_IS_A_SECRET_CANARY_12345_ABCD";
    // Use truly malformed TOML syntax that causes throwing (unclosed array), with a canary embedded
    const badToml =
      `name = "bad-worker"\ncompatibility_flags = ["nodejs_compat", "` +
      canary +
      `"`;
    expect(() => parseToml(badToml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
    // Verify the error message does NOT contain the canary value
    const msg = errorMessageFrom(() => parseToml(badToml, "wrangler.toml"));
    expect(msg).not.toContain(canary);
  });

  it('parses quoted table names like [env."staging"]', () => {
    const toml = `
    name = "demo"
    [env."staging"]
    workers_dev = true
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "demo",
      env: { staging: { workers_dev: true } },
    });
  });

  it("decodes escaped characters in basic strings", () => {
    const toml = `name = "my\\u002dworker"`;
    const result = parseToml(toml);
    expect(result.name).toBe("my-worker");
  });

  it("parses dotted keys into nested objects", () => {
    const toml = `
    name = "dotted-worker"
    site.bucket = "bucket-name"
    site.prefix = "prefix"
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "dotted-worker",
      site: { bucket: "bucket-name", prefix: "prefix" },
    });
  });

  it("parses literal strings without escape processing", () => {
    const toml = `path = 'C:\\Users\\nodejs\\templates'`;
    const result = parseToml(toml);
    expect(result.path).toBe("C:\\Users\\nodejs\\templates");
  });

  it("parses inline tables", () => {
    const toml = `
    name = "inline-worker"
    point = { x = 1, y = 2 }
    `;
    const result = parseToml(toml);
    expect(result).toEqual({
      name: "inline-worker",
      point: { x: 1, y: 2 },
    });
  });

  it("parses arrays of tables with multiple entries", () => {
    const toml = `
    name = "multi-migrations"

    [[migrations]]
    tag = "v1"

    [[migrations]]
    tag = "v2"
    `;
    const result = parseToml(toml);
    expect(result.migrations).toEqual([{ tag: "v1" }, { tag: "v2" }]);
  });

  it("rejects duplicate keys", () => {
    const toml = `name = "a"\nname = "b"`;
    expect(() => parseToml(toml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
  });

  it("rejects duplicate table definitions", () => {
    const toml = `[vars]\na = 1\n[vars]\nb = 2`;
    expect(() => parseToml(toml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
  });

  it("rejects duplicate keys and tables without disclosing secret canaries in the error", () => {
    const canary = "THIS_IS_A_SECRET_CANARY_98765_WXYZ";
    const dupKeyToml = `name = "a"\nname = "` + canary + `"`;
    expect(() => parseToml(dupKeyToml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
    expect(
      errorMessageFrom(() => parseToml(dupKeyToml, "wrangler.toml")),
    ).not.toContain(canary);

    const dupTableToml = `[vars]\na = "` + canary + `"\n[vars]\nb = 2`;
    expect(() => parseToml(dupTableToml, "wrangler.toml")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
    expect(
      errorMessageFrom(() => parseToml(dupTableToml, "wrangler.toml")),
    ).not.toContain(canary);
  });

  it("rejects malformed values", () => {
    for (const bad of [`a = `, `[env."staging`, `x = "unterminated`]) {
      expect(() => parseToml(bad, "wrangler.toml")).toThrowError(
        /\[bascik\] Failed to parse wrangler\.toml/,
      );
    }
  });
});

describe("discoverWranglerConfig and resolveWorkerName", () => {
  let testDir: string;
  const envBackup = { ...process.env };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `bascik-cf-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    delete process.env.CLOUDFLARE_WORKER_NAME;
    delete process.env.WORKER_NAME;
    delete process.env.CF_PAGES_PROJECT_NAME;
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    await rm(testDir, { recursive: true, force: true });
  });

  it("matches Wrangler discovery precedence: wrangler.jsonc > wrangler.json > wrangler.toml", () => {
    expect(WRANGLER_CONFIG_FILES).toEqual([
      "wrangler.jsonc",
      "wrangler.json",
      "wrangler.toml",
    ]);
  });

  it("returns null when no configuration file is present", async () => {
    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered).toBeNull();
  });

  it("prefers wrangler.jsonc over wrangler.json and wrangler.toml", async () => {
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{"name": "from-jsonc"}`,
      "utf8",
    );
    await writeFile(
      join(testDir, "wrangler.json"),
      `{"name": "from-json"}`,
      "utf8",
    );
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "from-toml"`,
      "utf8",
    );

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.jsonc");
    expect(discovered?.values.name).toBe("from-jsonc");
  });

  it("prefers wrangler.json over wrangler.toml when wrangler.jsonc is absent", async () => {
    await writeFile(
      join(testDir, "wrangler.json"),
      `{"name": "from-json"}`,
      "utf8",
    );
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "from-toml"`,
      "utf8",
    );

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.json");
    expect(discovered?.values.name).toBe("from-json");
  });

  it("finds wrangler.toml when json/jsonc are absent", async () => {
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "from-toml"`,
      "utf8",
    );

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.toml");
    expect(discovered?.values.name).toBe("from-toml");
  });

  it("throws when the discovered configuration file is malformed rather than silently ignoring it", async () => {
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{ "name": "bad", `,
      "utf8",
    );
    await expect(discoverWranglerConfig(testDir)).rejects.toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("respects explicit environment variable overrides over config and package.json", async () => {
    process.env.CLOUDFLARE_WORKER_NAME = "env-override";
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{"name": "config-name"}`,
      "utf8",
    );
    await writeFile(
      join(testDir, "package.json"),
      `{"name": "pkg-name"}`,
      "utf8",
    );

    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("env-override");
    expect(resolved.source).toBe("env");
  });

  it("uses package.json name when no config file or env var exists", async () => {
    await writeFile(
      join(testDir, "package.json"),
      `{"name": "@my-scope/my-app"}`,
      "utf8",
    );

    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("my-app");
    expect(resolved.source).toBe("package");
  });

  it("falls back to 'bascik-site' when no env, config, or package name exists", async () => {
    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("bascik-site");
    expect(resolved.source).toBe("default");
  });

  it("extracts compatibility_date and compatibility_flags from discovered TOML configuration", async () => {
    await writeFile(
      join(testDir, "wrangler.toml"),
      `
      name = "toml-meta-worker"
      compatibility_date = "2026-09-01"
      compatibility_flags = ["custom_toml_flag", "nodejs_compat"]
      `,
      "utf8",
    );

    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("toml-meta-worker");
    expect(resolved.discoveredConfig?.values.compatibility_date).toBe(
      "2026-09-01",
    );
    expect(resolved.discoveredConfig?.values.compatibility_flags).toEqual([
      "custom_toml_flag",
      "nodejs_compat",
    ]);
  });

  it("discovers valid commented JSONC with trailing commas", async () => {
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{
        // comment
        "name": "commented-jsonc-worker",
        "compatibility_flags": ["nodejs_compat",],
      }`,
      "utf8",
    );

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.jsonc");
    expect(discovered?.values.name).toBe("commented-jsonc-worker");
  });

  it("discovers TOML names with decoded escapes", async () => {
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "my\\u002dworker"`,
      "utf8",
    );

    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("my-worker");
    expect(resolved.source).toBe("config");
  });

  it("reports malformed selected config instead of falling back to another file", async () => {
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{"value":1/* comment */2}`,
      "utf8",
    );
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "valid-toml"`,
      "utf8",
    );

    await expect(discoverWranglerConfig(testDir)).rejects.toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("reports malformed TOML instead of falling back to package.json", async () => {
    await writeFile(
      join(testDir, "wrangler.toml"),
      `name = "a"\nname = "b"`,
      "utf8",
    );
    await writeFile(
      join(testDir, "package.json"),
      `{"name": "pkg-name"}`,
      "utf8",
    );

    await expect(resolveWorkerName(testDir)).rejects.toThrowError(
      /\[bascik\] Failed to parse wrangler\.toml/,
    );
  });

  it("misuse: a malformed package.json names the file and its line and column, without echoing its contents", async () => {
    const canary = "tok_SECRET_canary_42";
    await writeFile(
      join(testDir, "package.json"),
      `{\n  "name": "app",\n  "token": ${canary}\n}`,
      "utf8",
    );
    let msg = "";
    try {
      await resolveWorkerName(testDir);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(
      /^\[bascik\] Failed to parse package\.json at line 3, column 12: /,
    );
    expect(msg).not.toContain(canary);
    expect(msg).not.toContain("token");
  });

  it("misuse: package.json with comments or a trailing comma is rejected as npm rejects it", async () => {
    for (const text of [`{ "name": "a", }`, `{ // c\n "name": "a" }`]) {
      await writeFile(join(testDir, "package.json"), text, "utf8");
      await expect(resolveWorkerName(testDir), text).rejects.toThrow(
        /\[bascik\] Failed to parse package\.json at line \d+, column \d+/,
      );
    }
  });

  it("misuse: a package.json that is not an object falls back to the default name", async () => {
    for (const text of ["null", "[]", `"app"`]) {
      await writeFile(join(testDir, "package.json"), text, "utf8");
      const resolved = await resolveWorkerName(testDir);
      expect(resolved.workerName, text).toBe("bascik-site");
    }
  });

  it("misuse: a wrangler config path that cannot be read (a directory) names the file", async () => {
    await mkdir(join(testDir, "wrangler.jsonc"));
    await expect(discoverWranglerConfig(testDir)).rejects.toThrow(
      /^\[bascik\] Failed to read wrangler\.jsonc: E/,
    );
  });

  it("does not disclose secrets in discovery failure messages", async () => {
    const canary = "super-secret-canary-9f3a";
    await writeFile(
      join(testDir, "wrangler.jsonc"),
      `{ "api_key": "` + canary + `", "broken": }`,
      "utf8",
    );

    let msg = "";
    try {
      await discoverWranglerConfig(testDir);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/\[bascik\] Failed to parse wrangler\.jsonc/);
    expect(msg).not.toContain(canary);
    expect(msg).not.toContain("api_key");
    expect(msg).not.toContain("broken");
  });
});

describe("generateWranglerConfig: the authored config carried into the generated one", () => {
  const projectRoot = join("/", "site");
  const outDir = join(projectRoot, "dist", ".bascik", "cloudflare");
  const base = {
    projectRoot,
    outDir,
    workerName: "my-worker",
    runWorkerFirst: ["/_routes.json", "/_worker.js"] as string[] | true,
  };
  const generate = (
    values: Record<string, unknown> | undefined,
    extra: Partial<Parameters<typeof generateWranglerConfig>[0]> = {},
  ) =>
    generateWranglerConfig({
      ...base,
      authored: values
        ? {
            filename: "wrangler.jsonc",
            filePath: join(projectRoot, "wrangler.jsonc"),
            values,
          }
        : null,
      ...extra,
    });

  it("without an authored config writes only what the adapter owns", () => {
    const { config, warnings } = generate(undefined);
    expect(config).toEqual({
      name: "my-worker",
      main: "worker.js",
      compatibility_date: "2026-08-01",
      compatibility_flags: ["nodejs_compat"],
      assets: {
        directory: "./public",
        binding: "ASSETS",
        not_found_handling: "404-page",
        run_worker_first: ["/_routes.json", "/_worker.js"],
      },
    });
    expect(warnings).toEqual([]);
  });

  it("carries every authored key the adapter does not own, verbatim", () => {
    const authored = {
      name: "ignored-here-name-comes-from-resolution",
      compatibility_date: "2026-09-01",
      preview_urls: true,
      previews: {},
      workers_dev: false,
      routes: [{ pattern: "example.com", custom_domain: true }],
      vars: { GREETING: "hi" },
      kv_namespaces: [{ binding: "KV", id: "abc" }],
      d1_databases: [{ binding: "DB", database_id: "x" }],
      r2_buckets: [{ binding: "R2", bucket_name: "b" }],
      observability: { enabled: true },
      limits: { cpu_ms: 100 },
      placement: { mode: "smart" },
      some_future_key: { nested: [1, 2] },
    };
    const { config, warnings } = generate(authored);
    expect(config.name).toBe("my-worker");
    expect(config.compatibility_date).toBe("2026-09-01");
    for (const key of [
      "preview_urls",
      "previews",
      "workers_dev",
      "routes",
      "vars",
      "kv_namespaces",
      "r2_buckets",
      "observability",
      "limits",
      "placement",
      "some_future_key",
    ])
      expect(config[key], key).toEqual(authored[key as keyof typeof authored]);
    // Carried over, plus the default migrations folder named from outDir.
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_id: "x",
        migrations_dir: "../../../migrations",
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("unions authored compatibility_flags with the adapter's", () => {
    const { config } = generate({
      compatibility_flags: ["custom", "nodejs_compat"],
    });
    expect(config.compatibility_flags).toEqual(["custom", "nodejs_compat"]);
  });

  it("merges authored assets keys; owned keys stay the adapter's, authored not_found_handling wins", () => {
    const { config, warnings } = generate({
      assets: {
        html_handling: "drop-trailing-slash",
        not_found_handling: "none",
        binding: "ASSETS",
      },
    });
    expect(config.assets).toEqual({
      directory: "./public",
      binding: "ASSETS",
      html_handling: "drop-trailing-slash",
      not_found_handling: "none",
      run_worker_first: ["/_routes.json", "/_worker.js"],
    });
    expect(warnings).toEqual([]);
  });

  it("run_worker_first: true when the Worker runs first; an authored list is unioned with the computed routes", () => {
    expect(
      (
        generate(
          { assets: { run_worker_first: ["/*"] } },
          { runWorkerFirst: true },
        ).config.assets as { run_worker_first: unknown }
      ).run_worker_first,
    ).toBe(true);
    expect(
      (
        generate({ assets: { run_worker_first: ["/admin/*", "/_worker.js"] } })
          .config.assets as { run_worker_first: unknown }
      ).run_worker_first,
    ).toEqual(["/_routes.json", "/_worker.js", "/admin/*"]);
  });

  it("misuse: an authored main is replaced by worker.js with a warning naming the file and key", () => {
    const { config, warnings } = generate({ main: "src/index.ts" });
    expect(config.main).toBe("worker.js");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[bascik\] wrangler\.jsonc: "main" is ignored/,
    );
  });

  it("misuse: an authored assets.directory is replaced with a warning", () => {
    const { config, warnings } = generate({ assets: { directory: "./out" } });
    expect((config.assets as { directory: string }).directory).toBe("./public");
    expect(warnings[0]).toMatch(
      /^\[bascik\] wrangler\.jsonc: "assets\.directory" is ignored/,
    );
  });

  it("misuse: an authored assets.binding other than ASSETS is a located error", () => {
    expect(() => generate({ assets: { binding: "STATIC" } })).toThrowError(
      /^\[bascik\] wrangler\.jsonc: "assets\.binding" must be "ASSETS"/,
    );
  });

  it("rebases path-valued keys from the project root to the output directory", () => {
    const { config, warnings } = generate({
      tsconfig: "tsconfig.worker.json",
      base_dir: "./src",
      build: { command: "make", watch_dir: ["src", "lib"] },
      d1_databases: [
        {
          binding: "DB",
          migrations_dir: "migrations",
          migrations_pattern: "migrations/*.sql",
        },
      ],
      wasm_modules: { W: "./a.wasm" },
      containers: [
        {
          image: "./docker/Dockerfile",
          image_build_context: "./docker",
          images: {
            worker: {
              dockerfile: "./jobs/Dockerfile",
              build_context: "./jobs",
            },
            pinned: { image: "registry.cloudflare.com/acct/x@sha256:abc" },
          },
        },
        { image: "registry.example/x:1" },
      ],
      previews: { d1_databases: [{ binding: "DB", migrations_dir: "./m" }] },
      absolute: "/abs/path",
    });
    expect(config.tsconfig).toBe("../../../tsconfig.worker.json");
    expect(config.base_dir).toBe("../../../src");
    expect(config.build).toEqual({
      command: "make",
      cwd: "../../..",
      watch_dir: ["../../../src", "../../../lib"],
    });
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        migrations_dir: "../../../migrations",
        migrations_pattern: "../../../migrations/*.sql",
      },
    ]);
    expect(config.wasm_modules).toEqual({ W: "../../../a.wasm" });
    expect(config.containers).toEqual([
      {
        image: "../../../docker/Dockerfile",
        image_build_context: "../../../docker",
        images: {
          worker: {
            dockerfile: "../../../jobs/Dockerfile",
            build_context: "../../../jobs",
          },
          pinned: { image: "registry.cloudflare.com/acct/x@sha256:abc" },
        },
      },
      { image: "registry.example/x:1" },
    ]);
    expect(config.previews).toEqual({
      d1_databases: [{ binding: "DB", migrations_dir: "../../../m" }],
    });
    expect(config.absolute).toBe("/abs/path");
    expect(warnings).toEqual([]);
  });

  it("names the default D1 migrations folder, which Wrangler resolves from the config's folder", () => {
    const { config, warnings } = generate({
      d1_databases: [{ binding: "DB", database_name: "db" }],
      previews: { d1_databases: [{ binding: "DB" }] },
      env: { staging: { d1_databases: [{ binding: "DB" }] } },
    });
    const rebasedDefault = {
      binding: "DB",
      migrations_dir: "../../../migrations",
    };
    expect(config.d1_databases).toEqual([
      { ...rebasedDefault, database_name: "db" },
    ]);
    expect(config.previews).toEqual({ d1_databases: [rebasedDefault] });
    expect(
      (config.env as { staging: { d1_databases: unknown } }).staging
        .d1_databases,
    ).toEqual([rebasedDefault]);
    expect(warnings).toEqual([]);
  });

  it("misuse: leaves migrations_pattern without migrations_dir for Wrangler to report", () => {
    const { config } = generate({
      d1_databases: [{ binding: "DB", migrations_pattern: "sql/*.sql" }],
    });
    expect(config.d1_databases).toEqual([
      { binding: "DB", migrations_pattern: "../../../sql/*.sql" },
    ]);
  });

  it("keeps an authored build.cwd (rebased) instead of adding one", () => {
    const { config } = generate({ build: { command: "make", cwd: "tools" } });
    expect(config.build).toEqual({ command: "make", cwd: "../../../tools" });
  });

  it("applies the same rules inside each env.<name>", () => {
    const { config, warnings } = generate({
      env: {
        staging: {
          main: "src/other.ts",
          vars: { A: "1" },
          compatibility_flags: ["staging_flag"],
          assets: { html_handling: "none" },
          tsconfig: "tsconfig.json",
        },
      },
    });
    const staging = (config.env as Record<string, Record<string, unknown>>)
      .staging;
    expect(staging.main).toBeUndefined();
    expect(staging.vars).toEqual({ A: "1" });
    expect(staging.compatibility_flags).toEqual([
      "staging_flag",
      "nodejs_compat",
    ]);
    expect(staging.assets).toEqual({
      directory: "./public",
      binding: "ASSETS",
      html_handling: "none",
      not_found_handling: "404-page",
      run_worker_first: ["/_routes.json", "/_worker.js"],
    });
    expect(staging.tsconfig).toBe("../../../tsconfig.json");
    expect(warnings).toEqual([
      expect.stringMatching(
        /^\[bascik\] wrangler\.jsonc: "env\.staging\.main" is ignored/,
      ),
    ]);
  });

  it("$schema: an authored relative path is rebased, a URL kept, and the default points at a resolvable schema or is left out", () => {
    expect(
      generate({ $schema: "node_modules/wrangler/config-schema.json" }).config
        .$schema,
    ).toBe("../../../node_modules/wrangler/config-schema.json");
    expect(
      generate({ $schema: "https://example.com/s.json" }).config.$schema,
    ).toBe("https://example.com/s.json");
    expect(generate(undefined).config.$schema).toBeUndefined();
    expect(
      generate(undefined, {
        schemaPath: join(
          projectRoot,
          "node_modules",
          "wrangler",
          "config-schema.json",
        ),
      }).config.$schema,
    ).toBe("../../../node_modules/wrangler/config-schema.json");
  });

  it("does not crash on unknown or oddly typed keys (wrangler validates them)", () => {
    const { config } = generate({
      compatibilty_date: "typo",
      assets: "public",
      env: "nope",
      build: null,
      d1_databases: "x",
    });
    expect(config.compatibilty_date).toBe("typo");
    expect(config.env).toBe("nope");
    expect(config.build).toBeNull();
    expect(config.d1_databases).toBe("x");
    expect((config.assets as { directory: string }).directory).toBe("./public");
  });

  it("reports TOML-authored files by their own filename", () => {
    const { warnings } = generateWranglerConfig({
      ...base,
      authored: {
        filename: "wrangler.toml",
        filePath: join(projectRoot, "wrangler.toml"),
        values: { main: "x.ts" },
      },
    });
    expect(warnings[0]).toMatch(/^\[bascik\] wrangler\.toml: "main"/);
  });
});
