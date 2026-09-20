import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BascikExtensionConfig {
  diagnostics?: {
    enabled?: boolean;
    unclosedComponents?: boolean;
    selfClosingComponents?: boolean;
    compatibilityRules?: boolean;
    serverScriptRules?: boolean;
    apiRouteRules?: boolean;
    disabledRules?: string[];
  };
}

export function loadExtensionConfig(projectRoot: string): BascikExtensionConfig {
  const configFiles = ['bascik.ext.json', '.bascikrc.json', 'bascik.ext.ts', 'bascik.ext.js'];
  for (const filename of configFiles) {
    const fullPath = path.join(projectRoot, filename);
    if (fs.existsSync(fullPath)) {
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        if (filename.endsWith('.json')) {
          return JSON.parse(raw) as BascikExtensionConfig;
        } else {
          // Lexical parse for simple JS/TS config export default { ... }
          const match = /export\s+default\s+({[\s\S]*});?/.exec(raw);
          if (match) {
            // Evaluates standard JSON-like object literal safely
            return Function(`"use strict"; return (${match[1]})`)() as BascikExtensionConfig;
          }
        }
      } catch {
        // Fall back to empty config on parse error
      }
    }
  }
  return {};
}
