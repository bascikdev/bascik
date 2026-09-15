import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  parseJsonc,
  parseToml,
  discoverWranglerConfig,
  resolveWorkerName,
  WRANGLER_CONFIG_FILES,
} from "./config.ts";

describe("parseJsonc", () => {
  it("parses valid JSON without comments", () => {
    const json = `{"name": "my-worker", "compatibility_date": "2026-08-01"}`;
    const result = parseJsonc(json);
    expect(result).toEqual({ name: "my-worker", compatibility_date: "2026-08-01" });
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
    expect(result).toEqual({ name: "commented-worker", compatibility_date: "2026-08-01" });
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

  it("throws actionable error for unclosed block comments", () => {
    const unclosed = `{ "name": "bad" /* unclosed comment `;
    expect(() => parseJsonc(unclosed, "wrangler.jsonc")).toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc: unclosed block comment\./,
    );
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
      /\[bascik\] Failed to parse wrangler\.toml at line 1: invalid syntax\./,
    );
  });
});

describe("discoverWranglerConfig and resolveWorkerName", () => {
  let testDir: string;
  const envBackup = { ...process.env };

  beforeEach(async () => {
    testDir = join(tmpdir(), `bascik-cf-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    expect(WRANGLER_CONFIG_FILES).toEqual(["wrangler.jsonc", "wrangler.json", "wrangler.toml"]);
  });

  it("returns null when no configuration file is present", async () => {
    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered).toBeNull();
  });

  it("prefers wrangler.jsonc over wrangler.json and wrangler.toml", async () => {
    await writeFile(join(testDir, "wrangler.jsonc"), `{"name": "from-jsonc"}`, "utf8");
    await writeFile(join(testDir, "wrangler.json"), `{"name": "from-json"}`, "utf8");
    await writeFile(join(testDir, "wrangler.toml"), `name = "from-toml"`, "utf8");

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.jsonc");
    expect(discovered?.values.name).toBe("from-jsonc");
  });

  it("prefers wrangler.json over wrangler.toml when wrangler.jsonc is absent", async () => {
    await writeFile(join(testDir, "wrangler.json"), `{"name": "from-json"}`, "utf8");
    await writeFile(join(testDir, "wrangler.toml"), `name = "from-toml"`, "utf8");

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.json");
    expect(discovered?.values.name).toBe("from-json");
  });

  it("finds wrangler.toml when json/jsonc are absent", async () => {
    await writeFile(join(testDir, "wrangler.toml"), `name = "from-toml"`, "utf8");

    const discovered = await discoverWranglerConfig(testDir);
    expect(discovered?.filename).toBe("wrangler.toml");
    expect(discovered?.values.name).toBe("from-toml");
  });

  it("throws when the discovered configuration file is malformed rather than silently ignoring it", async () => {
    await writeFile(join(testDir, "wrangler.jsonc"), `{ "name": "bad", `, "utf8");
    await expect(discoverWranglerConfig(testDir)).rejects.toThrowError(
      /\[bascik\] Failed to parse wrangler\.jsonc/,
    );
  });

  it("respects explicit environment variable overrides over config and package.json", async () => {
    process.env.CLOUDFLARE_WORKER_NAME = "env-override";
    await writeFile(join(testDir, "wrangler.jsonc"), `{"name": "config-name"}`, "utf8");
    await writeFile(join(testDir, "package.json"), `{"name": "pkg-name"}`, "utf8");

    const resolved = await resolveWorkerName(testDir);
    expect(resolved.workerName).toBe("env-override");
    expect(resolved.source).toBe("env");
  });

  it("uses package.json name when no config file or env var exists", async () => {
    await writeFile(join(testDir, "package.json"), `{"name": "@my-scope/my-app"}`, "utf8");

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
    expect(resolved.discoveredConfig?.values.compatibility_date).toBe("2026-09-01");
    expect(resolved.discoveredConfig?.values.compatibility_flags).toEqual([
      "custom_toml_flag",
      "nodejs_compat",
    ]);
  });
});
