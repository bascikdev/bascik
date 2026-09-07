import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile('content/doc.md', 'utf8');
const generated = JSON.parse(await readFile('dist/generated.json', 'utf8'));
const html = await readFile('dist/consumer.html', 'utf8');
if (!html.includes(generated.value)) throw new Error('post observed stale compiled page');
if (source.includes('FAIL_POST')) throw new Error('requested post failure');
await writeFile('dist/post.json', JSON.stringify({ value: generated.value }));
console.log(`[post] observed ${generated.value} in compiled page`);