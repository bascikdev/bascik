/**
 * package-version.ts
 *
 * Reads the published @bascik/bascik version from pkg/package.json at build time so the docs never
 * carry a hand-edited copy. Release candidates and build metadata are dropped for display: while the
 * package is at `1.0.0-rc.6`, the site already presents the `1.0.0` release it is building toward.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reads the raw version string, or `undefined` when package.json is missing or malformed. */
export async function readPackageVersion(
  packageJsonPath: string = join(process.cwd(), '../pkg/package.json'),
): Promise<string | undefined> {
  try {
    const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** `1.0.0-rc.6` and `1.0.0+build.5` both become `1.0.0`. */
export function stableVersion(version: string): string {
  return version.replace(/[-+].*$/, '');
}

/** Reads the package version and strips any prerelease or build suffix. */
export async function readStableVersion(packageJsonPath?: string): Promise<string | undefined> {
  const version = await readPackageVersion(packageJsonPath);
  return version === undefined ? undefined : stableVersion(version);
}

/**
 * The hero version badge text (`v1.0.0`). Falls back to an empty string when the version is
 * unreadable, so the badge disappears instead of showing a wrong number.
 */
export async function versionBadge(packageJsonPath?: string): Promise<string> {
  const version = await readStableVersion(packageJsonPath);
  return version === undefined ? '' : `v${version}`;
}
