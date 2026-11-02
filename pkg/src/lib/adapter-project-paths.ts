import { resolve } from "node:path";
import {
  formatConfigErrors,
  sourceFoldersFor,
  validateUserConfig,
} from "./config-validation.ts";
import { loadUserConfig, resolveConfigPath } from "./user-config-loader.ts";

/**
 * Resolve build-mode paths for post-build adapter installers without loading
 * the cwd-bound compiler singleton. All paths belong to the supplied project.
 */
export async function resolveAdapterProjectPaths(
  projectRoot: string,
  argv: string[] = [],
): Promise<{ distDir: string; sourceRoots: string[] }> {
  const root = resolve(projectRoot);
  const discovered = await resolveConfigPath(argv, root);
  const loaded = await loadUserConfig(discovered.path, {
    explicit: discovered.explicit,
  });
  const errors = validateUserConfig(
    loaded.config,
    { dev: loaded.dev, build: loaded.build, server: loaded.server },
    { cwd: root },
  );
  if (errors.length)
    throw new Error(formatConfigErrors(errors, discovered.path));

  const { out, sources } = sourceFoldersFor([loaded.config, loaded.build]);
  if (out === undefined)
    throw new Error("[bascik] directory.out must be a filesystem path.");
  return {
    distDir: resolve(root, out),
    sourceRoots: sources.map(([, path]) => resolve(root, path)),
  };
}
