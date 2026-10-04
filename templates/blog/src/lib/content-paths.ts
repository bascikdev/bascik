import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// Resolving files that Markdown refers to. All paths are checked against content/ so a
// link or image cannot read outside the folder.

export const isExternal = (value: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);

export const toPosix = (path: string): string => path.split(sep).join('/');

/**
 * Resolve a target written in `file` (a path relative to content/) to an absolute path under
 * content/. A target starting with `/` is relative to content/. Returns null when the file does
 * not exist and throws when the target leaves content/.
 */
export function resolveContentPath(target: string, file: string, root: string): string | null {
  const base = resolve(root);
  const candidate = target.startsWith('/') ? join(base, target) : resolve(base, dirname(file), target);
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw new Error(`content/${file}: "${target}" points outside content/`);
  }
  return existsSync(candidate) ? candidate : null;
}

/** Path relative to content/, with forward slashes. */
export const relativeToContent = (absolutePath: string, root: string): string =>
  toPosix(absolutePath.slice(resolve(root).length + 1));
