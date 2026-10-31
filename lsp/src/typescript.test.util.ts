/**
 * Fixtures for the TypeScript block tests: temporary projects on disk, and the TypeScript 6 the tests check with.
 * The repo itself builds with TypeScript 7, which has no language service, so the tests load the `typescript-6`
 * alias. The `.test.util` name keeps this out of the published package and out of Vitest's test files.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TypeScriptModule } from "./typescript-loader.js";

const require = createRequire(import.meta.url);

/** The `typescript-6` package folder (TypeScript 6, with the language service). */
export const TYPESCRIPT_6_DIR = path.dirname(
  require.resolve("typescript-6/package.json"),
);

/** The repo's own `typescript` package folder: TypeScript 7, which publishes no language service. */
export const TYPESCRIPT_7_DIR = path.dirname(
  require.resolve("typescript/package.json"),
);

export const typescript6 = require(TYPESCRIPT_6_DIR) as TypeScriptModule;

/** `@types/node`, linked into a fixture that should have Node's types. */
export const NODE_TYPES_DIR = path.dirname(
  require.resolve("@types/node/package.json"),
);

/** `pkg/src/lib/defineConfig.ts`: the source of the types `@bascik/bascik` publishes. */
export const BASCIK_TYPES_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../pkg/src/lib/defineConfig.ts",
);

/**
 * A tsconfig `paths` entry that points `@bascik/bascik` at its source, standing in for an installed package (the
 * workspace's own copy publishes types from a `dist/` that may not be built).
 */
export const BASCIK_TYPES_PATHS = {
  "@bascik/bascik": [BASCIK_TYPES_SOURCE],
  "@bascik/bascik/html": [
    path.join(path.dirname(BASCIK_TYPES_SOURCE), "..", "html.ts"),
  ],
};

export interface Fixture {
  root: string;
  file: (relative: string) => string;
  write: (relative: string, text: string) => string;
  link: (relative: string, target: string) => void;
  remove: () => void;
}

/** A temporary project with the given files. Real paths, so TypeScript's file names match the test's. */
export function createFixture(files: Record<string, string> = {}): Fixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "bascik-ts-")),
  );
  const file = (relative: string) => path.join(root, relative);
  const write = (relative: string, text: string) => {
    const target = file(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const link = (relative: string, target: string) => {
    const at = file(relative);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction");
  };
  for (const [relative, text] of Object.entries(files)) write(relative, text);
  return {
    root,
    file,
    write,
    link,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The offset of `needle` in `text` (plus `delta`), failing loudly when it is missing. */
export function offsetOf(text: string, needle: string, delta = 0): number {
  const index = text.indexOf(needle);
  if (index < 0)
    throw new Error(`${JSON.stringify(needle)} is not in the text`);
  return index + delta;
}
