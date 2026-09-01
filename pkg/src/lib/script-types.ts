export const JAVASCRIPT_SCRIPT_TYPES = new Set([
  "text/javascript",
  "module",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

export const getScriptType = (openTag: string): string | undefined =>
  openTag.match(/\btype\s*=\s*["']?([^"'>\s]+)["']?/i)?.[1].toLowerCase();

export const isJavaScriptScript = (openTag: string): boolean => {
  const type = getScriptType(openTag);
  return type === undefined || JAVASCRIPT_SCRIPT_TYPES.has(type);
};