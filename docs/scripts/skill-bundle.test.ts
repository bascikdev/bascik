import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  collectSkillFiles,
  createSkillArchive,
  createSkillsArchive,
  createTar,
  createWellKnownSkills,
  listSkillNames,
  readSkillDescription,
  readTar,
} from "./skill-bundle.ts";

const repoSkillsDir = path.resolve(import.meta.dirname, "../../skills");

describe("skill-bundle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bascik-skill-bundle-"));
    await mkdir(path.join(dir, "alpha-skill/scripts/lib"), { recursive: true });
    await mkdir(path.join(dir, "beta-skill/references"), { recursive: true });
    await mkdir(path.join(dir, "not-a-skill"), { recursive: true });
    await writeFile(
      path.join(dir, "alpha-skill/SKILL.md"),
      "---\nname: alpha-skill\ndescription: A.\n---\n# Alpha\n",
    );
    await writeFile(
      path.join(dir, "alpha-skill/scripts/run.mjs"),
      'console.log("$1 $& literal");\n',
    );
    await writeFile(
      path.join(dir, "alpha-skill/scripts/lib/util.mjs"),
      "export const x = 1;\n",
    );
    await writeFile(path.join(dir, "alpha-skill/.DS_Store"), "ignored");
    await writeFile(
      path.join(dir, "beta-skill/SKILL.md"),
      "---\nname: beta-skill\ndescription: B.\n---\n# Beta é\n",
    );
    await writeFile(
      path.join(dir, "beta-skill/references/notes.md"),
      "x".repeat(1300),
    );
    await writeFile(path.join(dir, "not-a-skill/notes.md"), "skip me");
    await writeFile(path.join(dir, "README.md"), "skip me too");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects only directories that contain a SKILL.md, skipping dotfiles, in sorted order", async () => {
    expect(await listSkillNames(dir)).toEqual(["alpha-skill", "beta-skill"]);
    const files = await collectSkillFiles(dir);
    expect(files.map((file) => file.path)).toEqual([
      "alpha-skill/SKILL.md",
      "alpha-skill/scripts/lib/util.mjs",
      "alpha-skill/scripts/run.mjs",
      "beta-skill/SKILL.md",
      "beta-skill/references/notes.md",
    ]);
  });

  it("round-trips through readTar and the system tar with identical bytes", async () => {
    const archive = await createSkillsArchive(dir);
    const files = await collectSkillFiles(dir);
    const read = readTar(gunzipSync(archive));
    expect([...read.keys()]).toEqual(files.map((file) => file.path));
    for (const file of files)
      expect(read.get(file.path)?.equals(file.data)).toBe(true);

    const out = path.join(dir, "extracted");
    await mkdir(out);
    const archivePath = path.join(dir, "skills.tar.gz");
    await writeFile(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "-C", out]);
    for (const file of files) {
      expect(
        (await readFile(path.join(out, file.path))).equals(file.data),
      ).toBe(true);
    }
  });

  it("is byte-for-byte reproducible", async () => {
    const [first, second] = [
      await createSkillsArchive(dir),
      await createSkillsArchive(dir),
    ];
    expect(first.equals(second)).toBe(true);
  });

  it("packs one skill with SKILL.md at the archive root for /.well-known/agent-skills/", async () => {
    const read = readTar(
      gunzipSync(await createSkillArchive(dir, "alpha-skill")),
    );
    expect([...read.keys()]).toEqual([
      "SKILL.md",
      "scripts/lib/util.mjs",
      "scripts/run.mjs",
    ]);
    expect(read.get("scripts/run.mjs")?.toString("utf8")).toBe(
      'console.log("$1 $& literal");\n',
    );
    await expect(createSkillArchive(dir, "not-a-skill")).rejects.toThrow(
      /not a skill/,
    );
    await expect(createSkillArchive(dir, "../alpha-skill")).rejects.toThrow(
      /not a skill/,
    );
  });

  it("builds a v0.2.0 agent-skills discovery index whose digests match the archives", async () => {
    const { index, artifacts } = await createWellKnownSkills(dir);
    expect(index.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    );
    expect(index.skills.map((skill) => skill.name)).toEqual([
      "alpha-skill",
      "beta-skill",
    ]);
    for (const entry of index.skills) {
      expect(entry).toEqual({
        name: entry.name,
        type: "archive",
        description: entry.name === "alpha-skill" ? "A." : "B.",
        url: `${entry.name}.tar.gz`,
        digest: `sha256:${createHash("sha256").update(artifacts.get(entry.url)!).digest("hex")}`,
      });
      expect(
        readTar(gunzipSync(artifacts.get(entry.url)!)).has("SKILL.md"),
      ).toBe(true);
    }
    expect([...artifacts.keys()]).toEqual([
      "alpha-skill.tar.gz",
      "beta-skill.tar.gz",
    ]);
  });

  it("reads the description from frontmatter and rejects a skill without one", async () => {
    expect(
      await readSkillDescription(path.join(dir, "beta-skill/SKILL.md")),
    ).toBe("B.");
    await writeFile(
      path.join(dir, "beta-skill/SKILL.md"),
      "---\nname: beta-skill\n---\n# Beta\n",
    );
    await expect(createWellKnownSkills(dir)).rejects.toThrow(
      /beta-skill.*description/,
    );
  });

  it("reads quoted and folded descriptions the way YAML does", async () => {
    const file = path.join(dir, "gamma.md");
    await writeFile(
      file,
      '---\nname: g\ndescription: "Quoted: with a colon."\n---\n',
    );
    expect(await readSkillDescription(file)).toBe("Quoted: with a colon.");
    await writeFile(
      file,
      "---\nname: g\ndescription: 'It''s single quoted.'\n---\n",
    );
    expect(await readSkillDescription(file)).toBe("It's single quoted.");
    await writeFile(
      file,
      "---\nname: g\ndescription: >-\n  Folded across\n  two lines.\nlicense: MIT\n---\n",
    );
    expect(await readSkillDescription(file)).toBe("Folded across two lines.");
  });

  it("publishes a discovery entry for every public skill in the repository", async () => {
    const { index } = await createWellKnownSkills(repoSkillsDir);
    expect(index.skills.map((skill) => skill.name)).toEqual(
      await listSkillNames(repoSkillsDir),
    );
    for (const entry of index.skills) {
      expect(entry.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.description.length).toBeLessThanOrEqual(1024);
    }
  });

  it("rejects archive paths that do not fit a ustar header", () => {
    expect(() =>
      createTar([
        { path: `${"a".repeat(101)}/SKILL.md`, data: Buffer.from("x") },
      ]),
    ).toThrow(/longer than 100 bytes/);
  });

  it("packs every public skill in the repository with valid frontmatter whose name matches its directory", async () => {
    const names = await listSkillNames(repoSkillsDir);
    expect(names).toContain("bascik");
    const read = readTar(gunzipSync(await createSkillsArchive(repoSkillsDir)));
    for (const name of names) {
      const skill = read.get(`${name}/SKILL.md`)?.toString("utf8") ?? "";
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
      expect(frontmatter, `${name} frontmatter`).toMatch(
        new RegExp(`^name: ${name}$`, "m"),
      );
      const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
      expect(description.length, `${name} description`).toBeGreaterThan(40);
      expect(description.length, `${name} description`).toBeLessThanOrEqual(
        1024,
      );
      expect(
        skill.split("\n").length,
        `${name} SKILL.md stays under 500 lines`,
      ).toBeLessThan(500);
    }
  });

  it("hides every contributor skill in .github/skills from `npx skills add` and none of the public ones", async () => {
    const contributorDir = path.resolve(
      import.meta.dirname,
      "../../.github/skills",
    );
    const contributor = await listSkillNames(contributorDir);
    expect(contributor.length).toBeGreaterThan(0);
    const frontmatterOf = async (file: string) =>
      /^---\n([\s\S]*?)\n---/.exec(await readFile(file, "utf8"))?.[1] ?? "";
    for (const name of contributor) {
      expect(
        await frontmatterOf(path.join(contributorDir, name, "SKILL.md")),
        name,
      ).toMatch(/^metadata:\n(?:[ \t]+[^\n]+\n)*?[ \t]+internal: true$/m);
    }
    for (const name of await listSkillNames(repoSkillsDir)) {
      expect(
        await frontmatterOf(path.join(repoSkillsDir, name, "SKILL.md")),
        name,
      ).not.toMatch(/internal: true/);
      expect(
        contributor,
        `${name} is defined in both skills/ and .github/skills/`,
      ).not.toContain(name);
    }
  });

  it("only links to files that exist inside the same skill", async () => {
    const files = await collectSkillFiles(repoSkillsDir);
    const paths = new Set(files.map((file) => file.path));
    const missing: string[] = [];
    for (const file of files.filter((f) => f.path.endsWith(".md"))) {
      const skill = file.path.split("/")[0];
      const base = path.posix.dirname(file.path);
      for (const match of file.data
        .toString("utf8")
        .matchAll(/\]\(((?:references|scripts)\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = path.posix.normalize(
          path.posix.join(
            file.path.endsWith("SKILL.md") ? skill : base,
            match[1],
          ),
        );
        if (!paths.has(target)) missing.push(`${file.path} -> ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
