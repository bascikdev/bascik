import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILLS_DIR } from "./scaffold.js";

const sourceDir = resolve(import.meta.dirname, "../../skills");

/**
 * Skills published with the rest (`npx skills add bascikdev/bascik`, the bascik.dev index and tarball) but left
 * out of new projects: readers install them on purpose with `--skill <name>`.
 */
const OPT_IN_SKILLS = ["bascik-refactor"];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replace(/\\/g, "/"),
    )
    .sort();
}

describe("agent skills asset synchronization", () => {
  it("create/assets/skills is a byte-identical copy of the repo-root skills/ directory minus the opt-in skills", async () => {
    expect(resolve(SKILLS_DIR)).toBe(
      resolve(import.meta.dirname, "../assets/skills"),
    );
    const [allSourceFiles, bundledFiles] = await Promise.all([
      listFiles(sourceDir),
      listFiles(SKILLS_DIR),
    ]);
    const sourceFiles = allSourceFiles.filter(
      (file) => !OPT_IN_SKILLS.includes(file.split("/")[0]),
    );
    expect(sourceFiles).toContain("bascik/SKILL.md");
    expect(
      bundledFiles,
      "run `yarn create:prepack` to refresh create/assets/skills",
    ).toEqual(sourceFiles);
    for (const file of sourceFiles) {
      const [source, bundled] = await Promise.all([
        readFile(join(sourceDir, file)),
        readFile(join(SKILLS_DIR, file)),
      ]);
      expect(
        bundled.equals(source),
        `${file} differs; run \`yarn create:prepack\``,
      ).toBe(true);
    }
  });

  it("never bundles an opt-in skill, while skills/ still publishes it", async () => {
    const bundled = await readdir(SKILLS_DIR);
    for (const name of OPT_IN_SKILLS) {
      expect(
        (await readdir(join(sourceDir, name))).includes("SKILL.md"),
        `skills/${name}/SKILL.md`,
      ).toBe(true);
      expect(
        bundled,
        `${name} is opt-in: create/package.json prepare and prepack must leave it out`,
      ).not.toContain(name);
    }
  });

  it("prepare and prepack both remove every opt-in skill from assets/skills", async () => {
    const { scripts } = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of ["prepare", "prepack"])
      for (const name of OPT_IN_SKILLS)
        expect(scripts[script], `${script} excludes ${name}`).toContain(
          `rm -rf assets/skills/${name}`,
        );
  });

  // Request-time component rendering: the scripts skill carries the rule that
  // a server or stream script may return component tags, the limits that come
  // with it, and every reason `bascik --check` prints for a component left
  // unexpanded, so an agent working from the bundled copy knows them too.
  it("the bundled bascik-scripts skill carries the component-tags rule and every unsupported reason", async () => {
    const skill = await readFile(
      join(SKILLS_DIR, "bascik-scripts/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(
      /Server and stream scripts may return component tags/,
    );
    expect(skill).toMatch(/sanitize HTML from a CMS or an API/i);
    expect(skill).toContain("components.external");
    for (const reason of [
      "attr-binding-to-scoped-attribute",
      "instance-scoped-server-script",
      "build-script-reads-page-context",
      "attr-src-on-directive-script",
      "scoping-template-unavailable",
    ])
      expect(skill).toContain(reason);
    // url(#id) alone does not make a component unsupported: only with its
    // own server or stream script.
    expect(skill).not.toContain(
      "names its scoped ids or field names, or the stylesheet uses `url(#id)`)",
    );
    expect(skill).toMatch(/a `url\(#id\)` component with no script renders/);
  });
});
