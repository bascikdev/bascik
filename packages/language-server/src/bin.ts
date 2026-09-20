#!/usr/bin/env node
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { BascikLanguageServer } from './server.js';

const connection = createConnection(ProposedFeatures.all);
const server = new BascikLanguageServer(connection);
server.listen();
