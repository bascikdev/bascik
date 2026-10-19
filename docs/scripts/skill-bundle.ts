/**
 * Collects the public agent skills from the repository's `skills/` directory and packs them into a
 * deterministic `.tar.gz`, so one `curl ... | tar -xz` installs every skill with its scripts and references.
 *
 * The archive layout is `<skill-name>/SKILL.md`, `<skill-name>/references/...`, `<skill-name>/scripts/...`,
 * ready to extract into `.agents/skills/`, `.claude/skills/`, or `.github/skills/`. Entries are sorted and use a
 * fixed timestamp, owner, and mode, so identical sources produce identical bytes.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

export interface SkillFile {
  /** Archive path with forward slashes, for example `bascik/scripts/verify.mjs`. */
  path: string;
  data: Buffer;
}

/** 2024-01-01T00:00:00Z. A fixed, plausible mtime keeps the archive reproducible without tar warnings. */
const FIXED_MTIME = 1704067200;
const BLOCK = 512;

/** Names of the skill directories (each has a SKILL.md) directly under `skillsDir`, sorted. */
export async function listSkillNames(skillsDir: string): Promise<string[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      if ((await stat(join(skillsDir, entry.name, "SKILL.md"))).isFile())
        names.push(entry.name);
    } catch {
      // Not a skill directory.
    }
  }
  return names.sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Every file of every skill, with archive-relative paths, sorted byte-wise. */
export async function collectSkillFiles(
  skillsDir: string,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const name of await listSkillNames(skillsDir)) {
    for (const full of await walk(join(skillsDir, name))) {
      files.push({
        path: relative(skillsDir, full).split(sep).join("/"),
        data: await readFile(full),
      });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(
  path: string,
  size: number,
  type: "0" | "5",
  mode: number,
): Buffer {
  const name = Buffer.from(path, "utf8");
  if (name.length > 100)
    throw new Error(
      `skill-bundle: archive path is longer than 100 bytes: ${path}`,
    );
  const block = Buffer.alloc(BLOCK, 0);
  name.copy(block, 0);
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii"); // uid
  block.write(octal(0, 8), 116, "ascii"); // gid
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(FIXED_MTIME, 12), 136, "ascii");
  block.write("        ", 148, "ascii"); // checksum placeholder (eight spaces)
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

/** A POSIX ustar archive containing the files and their parent directories. */
export function createTar(files: SkillFile[]): Buffer {
  const chunks: Buffer[] = [];
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = `${parts.slice(0, i).join("/")}/`;
      if (directories.has(dir)) continue;
      directories.add(dir);
      chunks.push(header(dir, 0, "5", 0o755));
    }
    const mode = file.path.endsWith(".mjs") ? 0o755 : 0o644;
    chunks.push(header(file.path, file.data.length, "0", mode), file.data);
    const remainder = file.data.length % BLOCK;
    if (remainder) chunks.push(Buffer.alloc(BLOCK - remainder, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

/** Read the regular files of a ustar archive (as produced by createTar). Used to verify published archives. */
export function readTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim();
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12) || "0", 8);
    const type = field(156, 1) || "0";
    offset += BLOCK;
    if (type === "0")
      files.set(
        prefix ? `${prefix}/${name}` : name,
        Buffer.from(archive.subarray(offset, offset + size)),
      );
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** The gzip-compressed tar archive of every skill. */
export async function createSkillsArchive(skillsDir: string): Promise<Buffer> {
  return gzipSync(createTar(await collectSkillFiles(skillsDir)), { level: 9 });
}

/** One skill as a gzip-compressed tar archive with `SKILL.md` at the archive root. */
export async function createSkillArchive(
  skillsDir: string,
  name: string,
): Promise<Buffer> {
  if (!(await listSkillNames(skillsDir)).includes(name)) {
    throw new Error(`skill-bundle: "${name}" is not a skill in ${skillsDir}`);
  }
  const prefix = `${name}/`;
  const files = (await collectSkillFiles(skillsDir))
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), data: file.data }));
  return gzipSync(createTar(files), { level: 9 });
}

/**
 * The `description` value from a SKILL.md frontmatter block. Handles the scalar forms YAML allows for a one-key
 * string: plain, double-quoted, single-quoted, and folded or literal block scalars (`>`, `>-`, `|`, `|-`).
 */
export async function readSkillDescription(
  skillMdPath: string,
): Promise<string> {
  const source = (await readFile(skillMdPath, "utf8")).replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)?.[1] ?? "";
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => /^description:/.test(line));
  if (start === -1) return "";
  const value = lines[start].slice("description:".length).trim();

  const block = /^([>|])[-+]?$/.exec(value);
  if (block) {
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      body.push(line.trim());
    }
    return (block[1] === ">" ? body.join(" ") : body.join("\n")).trim();
  }
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** The v0.2.0 Agent Skills discovery schema read by `npx skills add <site>`. */
export const DISCOVERY_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export interface WellKnownSkillEntry {
  name: string;
  type: "archive";
  description: string;
  /** Relative to the index, so it resolves under any deployment base. */
  url: string;
  digest: string;
}

export interface WellKnownSkills {
  index: { $schema: typeof DISCOVERY_SCHEMA; skills: WellKnownSkillEntry[] };
  /** Archive file name (relative to `/.well-known/agent-skills/`) to bytes. */
  artifacts: Map<string, Buffer>;
}

/**
 * The RFC 8615 discovery files for `/.well-known/agent-skills/`: `index.json` plus one archive per skill, each
 * pinned by the sha256 digest of the exact bytes served.
 */
export async function createWellKnownSkills(
  skillsDir: string,
): Promise<WellKnownSkills> {
  const skills: WellKnownSkillEntry[] = [];
  const artifacts = new Map<string, Buffer>();
  for (const name of await listSkillNames(skillsDir)) {
    const description = await readSkillDescription(
      join(skillsDir, name, "SKILL.md"),
    );
    if (!description)
      throw new Error(
        `skill-bundle: ${name}/SKILL.md has no frontmatter description`,
      );
    if (description.length > 1024)
      throw new Error(
        `skill-bundle: ${name} description is longer than 1024 characters`,
      );
    const archive = await createSkillArchive(skillsDir, name);
    const url = `${name}.tar.gz`;
    artifacts.set(url, archive);
    skills.push({
      name,
      type: "archive",
      description,
      url,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    });
  }
  return { index: { $schema: DISCOVERY_SCHEMA, skills }, artifacts };
}
