#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { buildSnapshot, isInsideComponentRoots, type ProjectSnapshot } from './project.js';
import { createDiagnostics, applyAutoFixes } from './analyzer.js';

interface CheckOptions {
  cwd: string;
  targetPath?: string;
  projectPath?: string;
  fix?: boolean;
}

const CONFIG_FILES = ['bascik.config.ts', 'bascik.config.js', 'bascik.config.mjs'];

function parseArgs(args: string[]): CheckOptions {
  let targetPath: string | undefined;
  let projectPath: string | undefined;
  let fix = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdio' || arg === '--check' || arg === '--lint') {
      // Handled by main bin launcher
      continue;
    }
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--project') {
      projectPath = args[++i];
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectPath = arg.slice('--project='.length);
      continue;
    }
    if (!arg.startsWith('-')) {
      targetPath = arg;
    }
  }
  return {
    cwd: process.cwd(),
    targetPath,
    projectPath,
    fix,
  };
}

/** The nearest directory at or above `start` that holds a Bascik config file. */
function findConfigRoot(start: string): string | undefined {
  let curr = start;
  while (true) {
    if (CONFIG_FILES.some((file) => fs.existsSync(path.join(curr, file)))) return curr;
    const parent = path.dirname(curr);
    if (parent === curr) return undefined;
    curr = parent;
  }
}

export async function runCliCheck(args: string[] = process.argv.slice(2)): Promise<number> {
  const { cwd, targetPath, projectPath, fix } = parseArgs(args);
  const targetRoot = targetPath ? path.resolve(cwd, targetPath) : cwd;

  const stat = fs.existsSync(targetRoot) ? fs.statSync(targetRoot) : undefined;
  if (!stat) {
    console.error(`Error: Path does not exist: ${targetRoot}`);
    return 1;
  }

  // Project whose config decides component roots and the import root:
  //   1. --project <dir>, for checking a folder that lives outside the project (a monorepo's shared components)
  //   2. the project in the working directory, when the target is one of its component roots
  //   3. the nearest config at or above the target, else the target itself
  let projectRoot: string;
  let snapshot: ProjectSnapshot | undefined;
  if (projectPath !== undefined) {
    projectRoot = path.resolve(cwd, projectPath);
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      console.error(`Error: Project directory does not exist: ${projectRoot}`);
      return 1;
    }
  } else {
    const cwdProject = findConfigRoot(cwd);
    if (cwdProject) {
      const cwdSnapshot = await buildSnapshot(cwdProject);
      if (isInsideComponentRoots(targetRoot.replace(/\\/g, '/'), cwdSnapshot.componentRoots)) {
        snapshot = cwdSnapshot;
      }
    }
    projectRoot = snapshot?.projectRoot ?? findConfigRoot(targetRoot) ?? targetRoot;
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

  snapshot ??= await buildSnapshot(projectRoot);
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

    let doc = TextDocument.create(`file://${filePath}`, languageId, 1, content);
    if (fix && languageId === 'html') {
      const fixed = applyAutoFixes(doc, snapshot, filePath);
      if (fixed.fixedCount > 0) {
        fs.writeFileSync(filePath, fixed.text, 'utf8');
        content = fixed.text;
        doc = TextDocument.create(`file://${filePath}`, languageId, 2, content);
      }
    }
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
        // LSP 3.18 allows a MarkupContent message; print its text, not [object Object].
        const message = typeof d.message === 'string' ? d.message : d.message.value;
        console.log(`${rel}:${line}:${col} - ${prefix}:${codeStr} ${message}`);
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
