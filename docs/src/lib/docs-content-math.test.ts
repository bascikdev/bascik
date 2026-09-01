import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function getAllMdFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllMdFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

interface MathOccurrence {
  file: string;
  line: number;
  match: string;
  lineContent: string;
}

function findMathOccurrences(content: string, filePath: string, contentDir: string): MathOccurrence[] {
  const lines = content.split(/\r?\n/);
  const occurrences: MathOccurrence[] = [];
  let inFencedCode = false;
  let fenceChars = '';
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trimStart();

    // Check for fenced code block start/end
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch && !inHtmlComment) {
      const fence = fenceMatch[1];
      if (!inFencedCode) {
        inFencedCode = true;
        fenceChars = fence[0]; // '`' or '~'
        continue;
      } else if (fence[0] === fenceChars && fence.length >= 3) {
        inFencedCode = false;
        fenceChars = '';
        continue;
      }
    }

    if (inFencedCode) {
      continue;
    }

    // Handle HTML comments across multiple lines
    let line = rawLine;
    if (inHtmlComment) {
      const closeIdx = line.indexOf('-->');
      if (closeIdx === -1) {
        continue;
      }
      line = line.slice(closeIdx + 3);
      inHtmlComment = false;
    }

    // Strip any full comments within the line
    line = line.replace(/<!--[\s\S]*?-->/g, '');

    // Check if an unclosed HTML comment starts on this line
    const openIdx = line.indexOf('<!--');
    if (openIdx !== -1) {
      line = line.slice(0, openIdx);
      inHtmlComment = true;
    }

    // Strip inline code spans: handles `code`, ``code``, etc.
    line = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, '');

    // Look for $...$ math syntax
    const mathRegex = /\$([^$\n]+)\$/g;
    let match: RegExpExecArray | null;
    while ((match = mathRegex.exec(line)) !== null) {
      occurrences.push({
        file: relative(contentDir, filePath),
        line: i + 1,
        match: match[0],
        lineContent: rawLine.trim(),
      });
    }
  }

  return occurrences;
}

describe('docs content math rendering guard', () => {
  it('should not contain raw $...$ math syntax in docs/content markdown files', async () => {
    const contentDir = join(__dirname, '../../../docs/content');
    const mdFiles = await getAllMdFiles(contentDir);

    expect(mdFiles.length).toBeGreaterThan(0);

    const allOccurrences: MathOccurrence[] = [];

    for (const filePath of mdFiles) {
      const content = await readFile(filePath, 'utf8');
      const occurrences = findMathOccurrences(content, filePath, contentDir);
      allOccurrences.push(...occurrences);
    }

    const failureReport = allOccurrences
      .map(o => `  ${o.file}:${o.line} -> "${o.match}" in "${o.lineContent}"`)
      .join('\n');

    expect(
      allOccurrences,
      `Found ${allOccurrences.length} literal math expressions in docs/content:\n${failureReport}`
    ).toEqual([]);
  });
});
