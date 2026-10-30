import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import config, { build } from "../bascik.config.ts";
import {
  DISCOVERY_SCHEMA,
  collectSkillFiles,
  listSkillNames,
  readTar,
} from "./skill-bundle.ts";

const docsDir = path.resolve(import.meta.dirname, "..");
const skillsDir = path.resolve(docsDir, "../skills");
const authored = path.join(skillsDir, "bascik/SKILL.md");
const published = path.join(docsDir, "dist/assets/SKILL.md");
const archive = path.join(docsDir, "dist/assets/skills.tar.gz");

describe("publish-agent-skill", () => {
  it("is wired into both the effective default and build exec arrays without watching its output", () => {
    for (const [label, effective] of [
      ["default", config],
      ["build", build],
    ] as const) {
      const producer = effective.pipeline?.exec?.find(
        (entry) => entry.script === "scripts/publish-agent-skill.ts",
      );
      expect(producer, `${label} config publishes the skill`).toBeDefined();
      expect(producer).not.toHaveProperty("outputs");
      for (const output of [
        "dist/assets/SKILL.md",
        "dist/assets/skills.tar.gz",
        "dist/assets/",
        "dist/",
      ]) {
        expect(effective.pipeline?.watchPaths ?? []).not.toContain(output);
      }
    }
    const dev = config.pipeline?.exec?.find(
      (entry) => entry.script === "scripts/publish-agent-skill.ts",
    );
    expect(dev?.watch).toEqual(["../skills/"]);
  });

  it("publishes the core skill to dist/assets/SKILL.md byte for byte", async () => {
    await fs.rm(published, { force: true });
    await import("./publish-agent-skill.js");
    const [source, output] = await Promise.all([
      fs.readFile(authored),
      fs.readFile(published),
    ]);
    expect(output.length).toBeGreaterThan(0);
    expect(output.equals(source)).toBe(true);
  });

  it("publishes every skill file to dist/assets/skills.tar.gz byte for byte", async () => {
    await import("./publish-agent-skill.js");
    const files = readTar(gunzipSync(await fs.readFile(archive)));
    const sources = await collectSkillFiles(skillsDir);
    expect(sources.length).toBeGreaterThan(10);
    expect([...files.keys()]).toEqual(sources.map((file) => file.path));
    for (const source of sources)
      expect(files.get(source.path)?.equals(source.data), source.path).toBe(
        true,
      );
    expect(files.has("bascik/scripts/verify.mjs")).toBe(true);
    // The opt-in skill new projects leave out still ships in the tarball.
    expect(files.has("bascik-refactor/SKILL.md")).toBe(true);
    expect(files.has("bascik-refactor/scripts/compare-route.mjs")).toBe(true);
  });

  it("publishes an RFC 8615 /.well-known/agent-skills/ index whose archives match their digests", async () => {
    // The module runs once per test file (ESM cache), so this reads what that run published.
    await import("./publish-agent-skill.js");
    const wellKnown = path.join(docsDir, "dist/.well-known/agent-skills");
    const index = JSON.parse(
      await fs.readFile(path.join(wellKnown, "index.json"), "utf8"),
    );
    expect(index.$schema).toBe(DISCOVERY_SCHEMA);
    expect(index.skills.map((skill: { name: string }) => skill.name)).toContain(
      "bascik-refactor",
    );
    expect(index.skills.map((skill: { name: string }) => skill.name)).toEqual(
      await listSkillNames(skillsDir),
    );
    for (const entry of index.skills) {
      const archive = await fs.readFile(path.join(wellKnown, entry.url));
      expect(entry.digest).toBe(
        `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      );
      const files = readTar(gunzipSync(archive));
      expect(
        files
          .get("SKILL.md")
          ?.equals(
            await fs.readFile(path.join(skillsDir, entry.name, "SKILL.md")),
          ),
      ).toBe(true);
    }
    expect((await fs.readdir(wellKnown)).sort()).toEqual(
      [
        "index.json",
        ...index.skills.map((entry: { url: string }) => entry.url),
      ].sort(),
    );
  });

  it("does not publish ordinary Markdown sources into the output directory", async () => {
    await import("./publish-agent-skill.js");
    const assets = await fs.readdir(path.join(docsDir, "dist/assets"));
    expect(assets.filter((name) => name.toLowerCase().endsWith(".md"))).toEqual(
      ["SKILL.md"],
    );
    await expect(
      fs.stat(path.join(docsDir, "dist/content/getting-started.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(docsDir, "dist/getting-started.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
