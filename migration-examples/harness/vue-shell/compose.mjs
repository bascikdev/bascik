// Assembles the pinned example's Options API files into single-file components the
// way the Vue docs site does. The files are copied into ./upstream by the harness
// from the gitignored cache; nothing from upstream is committed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

function indent(text) {
  return text.split('\n').map((line) => (line.trim() ? `  ${line}` : line)).join('\n');
}

async function read(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

await mkdir(join(root, 'src'), { recursive: true });
for (const name of ['App', 'Grid']) {
  const directory = join(root, 'upstream', name);
  const template = await read(join(directory, 'template.html'));
  const options = await read(join(directory, 'options.js'));
  const style = await read(join(directory, 'style.css'));
  if (template === undefined || options === undefined) {
    throw new Error(`Missing pinned example file in ${directory}`);
  }
  let sfc = `<script>\n${options}</script>\n\n<template>\n${indent(template)}</template>`;
  if (style !== undefined) sfc += `\n\n<style>\n${style}</style>`;
  await writeFile(join(root, 'src', `${name}.vue`), `${sfc}\n`);
}
