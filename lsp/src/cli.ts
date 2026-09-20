#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { buildSnapshot, findHtmlFiles } from './project.js';
import { createDiagnostics } from './analyzer.js';

interface CheckOptions {
  cwd: string;
  targetPath?: string;
}

function parseArgs(args: string[]): CheckOptions {
  let targetPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdio') {
      // Handled by main bin launcher
      continue;
    }
    if (!arg.startsWith('-')) {
      targetPath = arg;
    }
  }
  return {
    cwd: process.cwd(),
    targetPath,
  };
}

export async function runCliCheck(args: string[] = process.argv.slice(2)): Promise<number> {
  const { cwd, targetPath } = parseArgs(args);
  const targetRoot = targetPath ? path.resolve(cwd, targetPath) : cwd;

  // Locate closest bascik.config file or fallback to targetRoot
  let projectRoot = targetRoot;
  let curr = targetRoot;
  while (curr !== path.dirname(curr)) {
    if (
      fs.existsSync(path.join(curr, 'bascik.config.ts')) ||
      fs.existsSync(path.join(curr, 'bascik.config.js')) ||
      fs.existsSync(path.join(curr, 'bascik.config.mjs'))
    ) {
      projectRoot = curr;
      break;
    }
    curr = path.dirname(curr);
  }

  const stat = fs.existsSync(targetRoot) ? fs.statSync(targetRoot) : undefined;
  if (!stat) {
    console.error(`Error: Path does not exist: ${targetRoot}`);
    return 1;
  }

  let filesToCheck: string[] = [];
  if (stat.isFile()) {
    filesToCheck = [targetRoot];
  } else {
    // Recursively collect .html, .css, .js, .ts
    const stack = [targetRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (
          entry.isFile() &&
          /\.(html|css|js|ts)$/i.test(entry.name) &&
          !/\.(test|spec)\.[a-z0-9]+$/i.test(entry.name)
        ) {
          filesToCheck.push(full);
        }
      }
    }
  }

  const snapshot = await buildSnapshot(projectRoot);
  let errorCount = 0;
  let warningCount = 0;

  for (const filePath of filesToCheck) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const languageId =
      ext === 'html'
        ? 'html'
        : ext === 'css'
        ? 'css'
        : ext === 'ts'
        ? 'typescript'
        : 'javascript';

    const doc = TextDocument.create(`file://${filePath}`, languageId, 1, content);
    const diags = createDiagnostics(doc, filePath, snapshot);

    if (diags.length > 0) {
      const rel = path.relative(cwd, filePath);
      for (const d of diags) {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const isError = d.severity === DiagnosticSeverity.Error;
        const prefix = isError ? '\x1b[31merror\x1b[0m' : '\x1b[33mwarning\x1b[0m';
        if (isError) errorCount++;
        else warningCount++;

        const codeStr = d.code ? ` \x1b[90m(${d.code})\x1b[0m` : '';
        console.log(`${rel}:${line}:${col} - ${prefix}:${codeStr} ${d.message}`);
      }
    }
  }

  if (errorCount > 0 || warningCount > 0) {
    console.log(`\nFound ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}.`);
  } else {
    console.log(`\x1b[32m✔ No Bascik diagnostics found in ${filesToCheck.length} file${filesToCheck.length === 1 ? '' : 's'}.\x1b[0m`);
  }

  return errorCount > 0 ? 1 : 0;
}
