import {
  formatExtensionConfigProblem,
  parseExtensionConfigFile,
  readConfigFile,
  type ExtensionConfigResult,
} from "./config-reader.js";

export interface BascikExtensionConfig {
  diagnostics?: {
    enabled?: boolean;
    unclosedComponents?: boolean;
    selfClosingComponents?: boolean;
    compatibilityRules?: boolean;
    serverScriptRules?: boolean;
    apiRouteRules?: boolean;
    disabledRules?: string[];
    /**
     * A project's own escaping functions, trusted like esc() by
     * server-script-unescaped-markup (for example ["escapeHtml"]).
     */
    escapeFunctions?: string[];
  };
}

/** Last text read per config path, so an unchanged file is parsed and reported once. */
const configCache = new Map<
  string,
  { raw: string; result: ExtensionConfigResult }
>();

/**
 * The project's extension config, `{}` when it has none or it cannot be read. A config that cannot be
 * read is reported on stderr (the Bascik output panel in the editor, the terminal for `--check`) with
 * its file and line, once per distinct content, then ignored, so a mistake never fails silently.
 */
export function loadExtensionConfig(
  projectRoot: string,
): BascikExtensionConfig {
  const found = readConfigFile(projectRoot);
  if (!found) return {};
  const cached = configCache.get(found.fullPath);
  if (cached && cached.raw === found.raw) return cached.result.config;
  const result = parseExtensionConfigFile(found.fullPath, found.raw);
  configCache.set(found.fullPath, { raw: found.raw, result });
  if (result.problem) {
    console.error(formatExtensionConfigProblem(result.problem));
  }
  return result.config;
}
