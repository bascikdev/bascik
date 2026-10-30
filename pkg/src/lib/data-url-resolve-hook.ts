/**
 * @module data-url-resolve-hook
 *
 * An inline server or stream script runs as a `data:` URL module (its text
 * is its identity), and Node cannot resolve a bare specifier such as
 * `@bascik/bascik/html` or `marked` from a `data:` parent ("base scheme is
 * not hierarchical"). This resolve hook gives those imports the project as
 * their parent, so they resolve through the site's node_modules exactly as a
 * `src=` module or a build script's would (the package's `import` and
 * `default` export conditions, subpath exports, workspaces).
 *
 * Only bare specifiers from a `data:` parent are touched; every other
 * resolution passes through unchanged. Installed once per process, in
 * development and production alike.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

let installed = false;

/** Whether `specifier` names a package (not a relative path, an absolute path or a URL). */
const isBare = (specifier: string): boolean =>
  !/^(?:\.{0,2}\/|[a-zA-Z][a-zA-Z0-9+.-]*:|#)/.test(specifier);

/** Resolve bare imports of `data:` modules from `projectRoot`. Idempotent. */
export const installDataUrlResolveHook = (projectRoot: string): void => {
  if (installed) return;
  installed = true;
  const parentURL = pathToFileURL(`${projectRoot.replace(/[\\/]$/, "")}/`).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith("data:") && isBare(specifier))
        return next(specifier, { ...context, parentURL });
      return next(specifier, context);
    },
  });
};
