/**
 * Publishes the authored Copilot skill file to dist/assets/SKILL.md.
 *
 * Bascik's static asset copier deliberately denies Markdown so docs sources never leak into the output. The
 * skill download advertised at /assets/SKILL.md is the single intentional exception, so it is published by this
 * lifecycle producer rather than by weakening that deny-list. Only this one authored file is copied; the copy is
 * byte for byte and written only to the output directory.
 *
 * Run via pipeline.exec in bascik.config.ts (dev and build), or directly: node scripts/publish-agent-skill.ts
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(docsDir, 'src/pages/assets/SKILL.md');
const output = join(docsDir, 'dist/assets/SKILL.md');

const authored = await readFile(source);
if (authored.length === 0) throw new Error(`publish-agent-skill: ${source} is empty`);
await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
const published = await readFile(output);
if (!published.equals(authored)) throw new Error(`publish-agent-skill: ${output} does not match ${source}`);
