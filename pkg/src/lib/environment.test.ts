import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SITE_URL_ENV_VAR,
  parseEnvFlags,
  loadEnvFiles,
  validateSiteUrl,
  resolveSiteUrl,
  bootEnvironment,
  getSiteUrl,
} from "./environment.ts";

// ─────────────────────────────────────────────────────────────────────────────
// environment.ts owns .env loading and BASCIK_SITE_URL resolution.
//
// Precedence (most specific and most ephemeral wins):
//   --site-url flag  >  real BASCIK_SITE_URL env var  >  .env file
//
// Tests use real temp directories for .env files and save/restore
// process.env around each test so nothing leaks between cases.
// ─────────────────────────────────────────────────────────────────────────────

let dirs: string[] = [];
let savedSiteUrl: string | undefined;

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "bascik-env-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  savedSiteUrl = process.env[SITE_URL_ENV_VAR];
});

afterEach(async () => {
  if (savedSiteUrl === undefined) {
    delete process.env[SITE_URL_ENV_VAR];
  } else {
    process.env[SITE_URL_ENV_VAR] = savedSiteUrl;
  }
  delete process.env.BASCIK_TEST_ENV_KEY_A;
  delete process.env.BASCIK_TEST_ENV_KEY_B;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("parseEnvFlags", () => {
  it("returns no values when the flags are absent", () => {
    expect(parseEnvFlags(["--build"])).toEqual({ siteUrl: undefined, envFiles: [] });
  });

  it("parses --site-url with a separate value", () => {
    expect(parseEnvFlags(["--build", "--site-url", "https://example.com"]).siteUrl)
      .toBe("https://example.com");
  });

  it("parses --site-url=<value>", () => {
    expect(parseEnvFlags(["--site-url=https://example.com"]).siteUrl)
      .toBe("https://example.com");
  });

  it("parses --env-file with a separate value", () => {
    expect(parseEnvFlags(["--env-file", ".env.staging"]).envFiles)
      .toEqual([".env.staging"]);
  });

  it("parses --env-file=<path>", () => {
    expect(parseEnvFlags(["--env-file=.env.staging"]).envFiles)
      .toEqual([".env.staging"]);
  });

  it("collects repeated --env-file flags in order", () => {
    expect(
      parseEnvFlags(["--env-file=.env.a", "--env-file", ".env.b"]).envFiles,
    ).toEqual([".env.a", ".env.b"]);
  });

  it("ignores unrelated flags and positional args", () => {
    expect(
      parseEnvFlags(["--build", "--log", "out.log", "--server"]),
    ).toEqual({ siteUrl: undefined, envFiles: [] });
  });
});

describe("loadEnvFiles", () => {
  it("is silent when the default ./.env does not exist", async () => {
    const dir = await makeDir();
    expect(() => loadEnvFiles([], dir)).not.toThrow();
    expect(loadEnvFiles([], dir)).toEqual([]);
  });

  it("loads the default ./.env when present", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".env"), "BASCIK_TEST_ENV_KEY_A=from-file\n", "utf8");
    const loaded = loadEnvFiles([], dir);
    expect(loaded).toEqual([join(dir, ".env")]);
    expect(process.env.BASCIK_TEST_ENV_KEY_A).toBe("from-file");
  });

  it("does not overwrite a real environment variable with a .env file value", async () => {
    const dir = await makeDir();
    process.env.BASCIK_TEST_ENV_KEY_A = "real-env";
    await writeFile(join(dir, ".env"), "BASCIK_TEST_ENV_KEY_A=from-file\n", "utf8");
    loadEnvFiles([], dir);
    expect(process.env.BASCIK_TEST_ENV_KEY_A).toBe("real-env");
  });

  it("throws when an explicitly passed env file does not exist", async () => {
    const dir = await makeDir();
    expect(() => loadEnvFiles([".env.missing"], dir)).toThrow(
      /--env-file .* does not exist/,
    );
  });

  it("later files override earlier files", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".env.a"), "BASCIK_TEST_ENV_KEY_A=a\n", "utf8");
    await writeFile(join(dir, ".env.b"), "BASCIK_TEST_ENV_KEY_A=b\n", "utf8");
    loadEnvFiles([".env.a", ".env.b"], dir);
    expect(process.env.BASCIK_TEST_ENV_KEY_A).toBe("b");
  });

  it("explicit files override the default ./.env", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".env"), "BASCIK_TEST_ENV_KEY_A=default\n", "utf8");
    await writeFile(join(dir, ".env.staging"), "BASCIK_TEST_ENV_KEY_A=staging\n", "utf8");
    loadEnvFiles([".env.staging"], dir);
    expect(process.env.BASCIK_TEST_ENV_KEY_A).toBe("staging");
  });

  it("a real env var survives even when multiple files set the key", async () => {
    const dir = await makeDir();
    process.env.BASCIK_TEST_ENV_KEY_A = "real-env";
    await writeFile(join(dir, ".env"), "BASCIK_TEST_ENV_KEY_A=default\n", "utf8");
    await writeFile(join(dir, ".env.a"), "BASCIK_TEST_ENV_KEY_A=a\n", "utf8");
    loadEnvFiles([".env.a"], dir);
    expect(process.env.BASCIK_TEST_ENV_KEY_A).toBe("real-env");
  });
});

describe("validateSiteUrl", () => {
  it("accepts absolute http and https URLs", () => {
    expect(validateSiteUrl("https://example.com")).toBe("https://example.com");
    expect(validateSiteUrl("http://localhost:4200")).toBe("http://localhost:4200");
  });

  it("rejects a URL with no scheme, naming the value", () => {
    expect(() => validateSiteUrl("example.com")).toThrow(/"example\.com"/);
    expect(() => validateSiteUrl("example.com")).toThrow(/absolute http or https URL/);
  });

  it("rejects non-http schemes", () => {
    expect(() => validateSiteUrl("ftp://example.com")).toThrow(
      /absolute http or https URL/,
    );
  });
});

describe("resolveSiteUrl", () => {
  it("returns undefined when no source provides a value", () => {
    expect(resolveSiteUrl([], {})).toBeUndefined();
  });

  it("treats an empty BASCIK_SITE_URL as unset", () => {
    expect(resolveSiteUrl([], { BASCIK_SITE_URL: "" })).toBeUndefined();
  });

  it("uses BASCIK_SITE_URL from the environment", () => {
    expect(resolveSiteUrl([], { BASCIK_SITE_URL: "https://example.com" }))
      .toBe("https://example.com");
  });

  it("--site-url beats the environment variable", () => {
    expect(
      resolveSiteUrl(
        ["--site-url", "https://flag.example.com"],
        { BASCIK_SITE_URL: "https://env.example.com" },
      ),
    ).toBe("https://flag.example.com");
  });

  it("rejects an invalid value from the flag", () => {
    expect(() => resolveSiteUrl(["--site-url=example.com"], {})).toThrow(
      /"example\.com"/,
    );
  });

  it("rejects an invalid value from the environment", () => {
    expect(() => resolveSiteUrl([], { BASCIK_SITE_URL: "example.com" })).toThrow(
      /"example\.com"/,
    );
  });
});

describe("bootEnvironment", () => {
  it("a .env file supplies BASCIK_SITE_URL when nothing else does", async () => {
    const dir = await makeDir();
    delete process.env[SITE_URL_ENV_VAR];
    await writeFile(join(dir, ".env"), "BASCIK_SITE_URL=https://file.example.com\n", "utf8");
    bootEnvironment([], dir);
    expect(process.env[SITE_URL_ENV_VAR]).toBe("https://file.example.com");
  });

  it("a real env var beats the .env file", async () => {
    const dir = await makeDir();
    process.env[SITE_URL_ENV_VAR] = "https://real.example.com";
    await writeFile(join(dir, ".env"), "BASCIK_SITE_URL=https://file.example.com\n", "utf8");
    bootEnvironment([], dir);
    expect(process.env[SITE_URL_ENV_VAR]).toBe("https://real.example.com");
  });

  it("--site-url beats both the real env var and the .env file", async () => {
    const dir = await makeDir();
    process.env[SITE_URL_ENV_VAR] = "https://real.example.com";
    await writeFile(join(dir, ".env"), "BASCIK_SITE_URL=https://file.example.com\n", "utf8");
    bootEnvironment(["--site-url", "https://flag.example.com"], dir);
    expect(process.env[SITE_URL_ENV_VAR]).toBe("https://flag.example.com");
  });

  it("a missing explicit --env-file errors during boot", async () => {
    const dir = await makeDir();
    expect(() => bootEnvironment(["--env-file=.env.missing"], dir)).toThrow(
      /--env-file .* does not exist/,
    );
  });

  it("writes --port, --host, and --log-level into the environment so workers inherit them", async () => {
    const dir = await makeDir();
    const saved = {
      port: process.env.BASCIK_SERVER_PORT,
      host: process.env.BASCIK_SERVER_HOST,
      level: process.env.BASCIK_LOG_LEVEL,
    };
    delete process.env.BASCIK_SERVER_PORT;
    delete process.env.BASCIK_SERVER_HOST;
    delete process.env.BASCIK_LOG_LEVEL;
    try {
      bootEnvironment(
        ["--build", "--port", "4321", "--host=0.0.0.0", "--log-level", "debug"],
        dir,
      );
      expect(process.env.BASCIK_SERVER_PORT).toBe("4321");
      expect(process.env.BASCIK_SERVER_HOST).toBe("0.0.0.0");
      expect(process.env.BASCIK_LOG_LEVEL).toBe("debug");
    } finally {
      for (const [key, value] of Object.entries({
        BASCIK_SERVER_PORT: saved.port,
        BASCIK_SERVER_HOST: saved.host,
        BASCIK_LOG_LEVEL: saved.level,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("getSiteUrl", () => {
  it("returns undefined when BASCIK_SITE_URL is unset", () => {
    delete process.env[SITE_URL_ENV_VAR];
    expect(getSiteUrl()).toBeUndefined();
  });

  it("returns the validated value when set", () => {
    process.env[SITE_URL_ENV_VAR] = "https://example.com";
    expect(getSiteUrl()).toBe("https://example.com");
  });

  it("throws on an invalid value, naming what was received", () => {
    process.env[SITE_URL_ENV_VAR] = "example.com";
    expect(() => getSiteUrl()).toThrow(/"example\.com"/);
  });
});
