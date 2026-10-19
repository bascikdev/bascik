/**
 * Publishes the agent skills from the repository's `skills/` directory into the docs output:
 *
 * - `dist/assets/skills.tar.gz`: every public skill with its references and scripts, for
 *   `curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills`.
 * - `dist/assets/SKILL.md`: the core `bascik` skill as a single file, byte for byte, so the long-standing
 *   `/assets/SKILL.md` download keeps working. It tells agents how to install the full set.
 * - `dist/.well-known/agent-skills/index.json` plus one `<name>.tar.gz` per skill: the RFC 8615 discovery
 *   index (Agent Skills discovery schema 0.2.0) that makes `npx skills add https://bascik.dev` work.
 *
 * Bascik's static asset copier deliberately denies Markdown so docs sources never leak into the output. These
 * downloads are the intentional exception, so this lifecycle producer publishes them rather than weakening that
 * deny-list. Outputs are written only to the output directory, never to sources.
 *
 * Run via pipeline.exec in bascik.config.ts (dev and build), or directly: node scripts/publish-agent-skill.ts
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSkillsArchive,
  createWellKnownSkills,
  listSkillNames,
} from "./skill-bundle.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = resolve(docsDir, "../skills");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");
const coreSource = join(skillsDir, "bascik/SKILL.md");
const coreOutput = join(outDir, "assets/SKILL.md");
const archiveOutput = join(outDir, "assets/skills.tar.gz");

if (!(await listSkillNames(skillsDir)).includes("bascik")) {
  throw new Error(`publish-agent-skill: ${coreSource} is missing`);
}

const authored = await readFile(coreSource);
if (authored.length === 0)
  throw new Error(`publish-agent-skill: ${coreSource} is empty`);
await mkdir(dirname(coreOutput), { recursive: true });
await copyFile(coreSource, coreOutput);
const published = await readFile(coreOutput);
if (!published.equals(authored))
  throw new Error(
    `publish-agent-skill: ${coreOutput} does not match ${coreSource}`,
  );

await writeFile(archiveOutput, await createSkillsArchive(skillsDir));

const wellKnownDir = join(outDir, ".well-known/agent-skills");
const { index, artifacts } = await createWellKnownSkills(skillsDir);
await rm(wellKnownDir, { recursive: true, force: true });
await mkdir(wellKnownDir, { recursive: true });
for (const [file, bytes] of artifacts)
  await writeFile(join(wellKnownDir, file), bytes);
await writeFile(
  join(wellKnownDir, "index.json"),
  `${JSON.stringify(index, null, 2)}\n`,
);
