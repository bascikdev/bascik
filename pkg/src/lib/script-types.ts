import { getHtmlAttributeValue } from "./html-patterns.ts";

export const JAVASCRIPT_SCRIPT_TYPES = new Set([
  "text/javascript",
  "module",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

export const getScriptType = (openTag: string): string | undefined =>
  getHtmlAttributeValue(openTag, "type")?.trim().toLowerCase() || undefined;

export const isJavaScriptScript = (openTag: string): boolean => {
  const type = getScriptType(openTag);
  return type === undefined || JAVASCRIPT_SCRIPT_TYPES.has(type);
};
