// Dependency-free ${path.to.value} interpolation helper.
// Escapes HTML by default; missing keys render as empty strings.
export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const interpolate = (template, data) =>
  template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = path
      .trim()
      .split('.')
      .reduce((obj, key) => (obj == null ? undefined : obj[key]), data);
    return value == null ? '' : escapeHtml(value);
  });
