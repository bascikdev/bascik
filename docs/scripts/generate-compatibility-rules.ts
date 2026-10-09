import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsFile = path.resolve(__dirname, '../content/compatibility.md');
const extensionRulesFile = path.resolve(__dirname, '../../extensions/vscode-bascik/src/compatibility-rules.json');
const lspRulesFile = path.resolve(__dirname, '../../lsp/src/compatibility-rules.json');
const pkgRulesFile = path.resolve(__dirname, '../../pkg/src/lib/compatibility-rules.json');

const text = await fs.readFile(docsFile, 'utf8');
const match = text.match(/<!--\s*bascik-compatibility-rules\s*(\[[\s\S]*?\])\s*-->/);

if (!match) {
  throw new Error('Missing bascik-compatibility-rules metadata block in docs/content/compatibility.md');
}

const rules = JSON.parse(match[1]);

for (const rule of rules) {
  if (!rule.id || !rule.kind || !rule.pattern || !rule.message || !rule.suggestion) {
    throw new Error(`Invalid compatibility rule: ${JSON.stringify(rule)}`);
  }

  if (rule.kind !== 'css' && rule.kind !== 'js') {
    throw new Error(`Unsupported compatibility rule kind for ${rule.id}: ${rule.kind}`);
  }

  try {
    new RegExp(rule.pattern, rule.flags ?? '');
  } catch (error) {
    throw new Error(`Invalid regex for ${rule.id}: ${rule.pattern} (${(error as Error).message})`);
  }
}

const formatted = `${JSON.stringify(rules, null, 2)}\n`;

await fs.mkdir(path.dirname(extensionRulesFile), { recursive: true });
await fs.writeFile(extensionRulesFile, formatted, 'utf8');

await fs.mkdir(path.dirname(lspRulesFile), { recursive: true });
await fs.writeFile(lspRulesFile, formatted, 'utf8');

await fs.mkdir(path.dirname(pkgRulesFile), { recursive: true });
await fs.writeFile(pkgRulesFile, formatted, 'utf8');

console.log(`Wrote ${rules.length} compatibility rules to extension, lsp, and pkg.`);
