// Dependency-free ${path.to.value} interpolation helper.
// Escapes each value with esc() from @bascik/bascik/html; missing keys render as empty strings.
import { esc } from "@bascik/bascik/html";

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
    return value == null ? "" : esc(String(value));
  });
