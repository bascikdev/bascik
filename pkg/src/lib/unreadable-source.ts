/**
 * What a scan does with a source it lists but cannot read: a folder under
 * a pages or components root, or a component file, stylesheet or script.
 * Kept apart from file-system.ts so styles.ts and javascript.ts can use it
 * without importing the config.
 */

import { relative, resolve } from "node:path";

let strictSourceReads: boolean | undefined;

/**
 * Whether an unreadable source fails the run (a build, `bascik --check`) or
 * is skipped with a warning (the dev server, where a file can be mid edit). Unset, it follows `BascikConfig.isBuild`, which config.ts mirrors into
 * `BASCIK_BUILD` for page workers too.
 */
export const setStrictSourceReads = (strict: boolean | undefined): void => {
  strictSourceReads = strict;
};

/** Whether a source that cannot be read fails the run (see setStrictSourceReads). */
export const isStrictSourceRead = (): boolean =>
  strictSourceReads ?? process.env.BASCIK_BUILD === "1";

const warnedUnreadableFiles = new Set<string>();

/** A listed source file that cannot be read; `file` is project-relative. */
export class UnreadableSourceError extends Error {
  readonly file: string;
  constructor(message: string, file: string, cause: unknown) {
    super(message, { cause });
    this.name = "UnreadableSourceError";
    this.file = file;
  }
}

/**
 * A component file, or its companion stylesheet or script, that is listed
 * but cannot be read. In a build or `bascik --check` this throws an error
 * naming the file; in the dev server it warns once per file, without a
 * stack, until `forgetUnreadableSourceFile` sees it read again. `ENOENT`
 * (deleted since its folder was listed) is skipped quietly. Returns
 * normally when the caller should go on without the file.
 */
export const reportUnreadableSourceFile = (
  kind: string,
  filePath: string,
  error: unknown,
): void => {
  // Already reported by the read that failed (a component's stylesheet).
  if (error instanceof UnreadableSourceError) throw error;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
  const display =
    relative(process.cwd(), resolve(filePath)).replace(/\\/g, "/") || filePath;
  const detail = `could not read ${kind} "${display}": ${error instanceof Error ? error.message : String(error)}.`;
  if (isStrictSourceRead())
    throw new UnreadableSourceError(
      `[bascik] error: ${detail} Make the file readable, or remove it.`,
      display,
      error,
    );
  const key = resolve(filePath);
  if (warnedUnreadableFiles.has(key)) return;
  warnedUnreadableFiles.add(key);
  console.warn(
    `[bascik] warning: ${detail} It is left out until it can be read.`,
  );
};

export const forgetUnreadableSourceFile = (filePath: string): void => {
  if (warnedUnreadableFiles.size > 0)
    warnedUnreadableFiles.delete(resolve(filePath));
};
