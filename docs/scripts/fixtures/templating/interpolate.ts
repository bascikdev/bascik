// Dependency-free ${path.to.value} interpolation helper.
// Escapes HTML by default; missing keys render as empty strings.
export const escape = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const interpolate = (
  template: string,
  data: Record<string, unknown>,
): string =>
  template.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
    const value = path
      .trim()
      .split(".")
      .reduce<unknown>(
        (obj, key) =>
          obj == null ? undefined : (obj as Record<string, unknown>)[key],
        data,
      );
    return value == null ? "" : escape(value);
  });
