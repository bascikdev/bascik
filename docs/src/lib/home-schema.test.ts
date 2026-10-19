import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeSchema } from "./home-schema.js";

/** Parses every JSON-LD block in the helper output. */
const parseBlocks = (html: string): Array<Record<string, unknown>> =>
  [
    ...html.matchAll(
      /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g,
    ),
  ].map((m) => JSON.parse(m[1]));

describe("homeSchema", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "home-schema-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads softwareVersion from package.json instead of hardcoding it", async () => {
    const packageJson = join(tempDir, "package.json");
    await writeFile(
      packageJson,
      JSON.stringify({ name: "@bascik/bascik", version: "9.8.7" }),
    );

    const [software] = parseBlocks(await homeSchema(packageJson));
    expect(software["@type"]).toBe("SoftwareApplication");
    expect(software.softwareVersion).toBe("9.8.7");
  });

  it("emits a SoftwareApplication and an Organization sharing the brand profiles", async () => {
    const packageJson = join(tempDir, "package.json");
    await writeFile(packageJson, JSON.stringify({ version: "1.0.0" }));

    const [software, organization] = parseBlocks(await homeSchema(packageJson));
    expect(organization["@type"]).toBe("Organization");
    expect(organization.sameAs).toEqual(software.sameAs);
    expect(software.sameAs).toContain("https://github.com/bascikdev/bascik");
  });

  it("omits softwareVersion rather than guessing when package.json is unreadable", async () => {
    const [software] = parseBlocks(
      await homeSchema(join(tempDir, "missing.json")),
    );
    expect(software).not.toHaveProperty("softwareVersion");
  });

  it("drops the release candidate suffix so the schema shows the launch version", async () => {
    const packageJson = join(tempDir, "package.json");
    await writeFile(packageJson, JSON.stringify({ version: "1.0.0-rc.6" }));

    const [software] = parseBlocks(await homeSchema(packageJson));
    expect(software.softwareVersion).toBe("1.0.0");
  });

  it("omits softwareVersion for a missing, empty, or non-string version", async () => {
    const packageJson = join(tempDir, "package.json");
    for (const body of ["{}", '{"version":""}', '{"version":1}', "not json"]) {
      await writeFile(packageJson, body);
      const [software] = parseBlocks(await homeSchema(packageJson));
      expect(software, body).not.toHaveProperty("softwareVersion");
    }
  });

  it("reads the real workspace package by default", async () => {
    const [software] = parseBlocks(await homeSchema());
    expect(software.softwareVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
