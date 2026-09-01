// A global counter plus source collision checks keep generated tokens outside user input.
const SHIELD_TOKEN_PATTERN = /\x00BASCIK_SHIELD_(\d+)\x00/g;
let nextShieldToken = 0;

export const createContentShield = (source: string): {
  hide: (value: string) => string;
  restore: (value: string) => string;
} => {
  const values = new Map<string, string>();
  const ownedTokens = new Set<string>();

  const hide = (value: string): string => {
    let token: string;
    do {
      token = `\x00BASCIK_SHIELD_${nextShieldToken++}\x00`;
    } while (source.includes(token) || values.has(token));
    values.set(token, value);
    ownedTokens.add(token);
    return token;
  };

  const restore = (value: string): string => {
    let result = value;
    let replaced = true;
    while (replaced) {
      replaced = false;
      result = result.replace(SHIELD_TOKEN_PATTERN, (token) => {
        if (!ownedTokens.has(token)) return token;
        const preserved = values.get(token);
        if (preserved === undefined) return token;
        replaced = true;
        ownedTokens.delete(token);
        values.delete(token);
        return preserved;
      });
    }
    return result;
  };

  return { hide, restore };
};

export const shieldElementContents = (
  html: string,
  tags: string[],
): { html: string; restore: (value: string) => string } => {
  if (tags.length === 0) return { html, restore: (value) => value };
  const shield = createContentShield(html);
  let result = html;
  for (const tag of tags) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    result = result.replace(
      new RegExp(`(<${escapedTag}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${escapedTag}>)`, "gi"),
      (_match, open: string, inner: string, close: string) =>
        `${open}${shield.hide(inner)}${close}`,
    );
  }
  return { html: result, restore: shield.restore };
};

// Scanner masks discard content and preserve offsets; they are never restored.
export const maskElementContents = (html: string, tags: string[]): string => {
  let result = html;
  for (const tag of tags) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    result = result.replace(
      new RegExp(`(<${escapedTag}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${escapedTag}\\s*>)`, "gi"),
      (_match, open: string, inner: string, close: string) =>
        `${open}${" ".repeat(inner.length)}${close}`,
    );
  }
  return result;
};