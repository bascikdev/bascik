#!/usr/bin/env node
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { BascikLanguageServer } from './server.js';
import { runCliCheck } from './cli.js';

const args = process.argv.slice(2);
if (args.includes('--check') || args.includes('check')) {
  const exitCode = await runCliCheck(args.filter((a) => a !== '--check' && a !== 'check'));
  process.exit(exitCode);
} else {
  const connection = createConnection(ProposedFeatures.all);
  const server = new BascikLanguageServer(connection);
  server.listen();
}

