// Test fixture: a build-script helper with a hand-written escaper and plain
// template markup, which the language server reports in the editor.
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export const frothList = (names: string[]): string =>
  names.map((name) => `<li>${name}</li>`).join("");
