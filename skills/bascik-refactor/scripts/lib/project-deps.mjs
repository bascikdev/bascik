// Load Playwright and sharp from the reader's own project. Dependency-free; Node.js 22.18+.
//
// The bascik-refactor scripts never install anything and never ship these packages: each skill is its own archive with no
// node_modules. They resolve the packages from the project the scripts run in, the same way the project's own code
// would, and say exactly which install command to run when one is missing.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

function projectRequire(cwd) {
  return createRequire(join(resolve(cwd), "package.json"));
}

function tryRequire(req, id) {
  try {
    return { module: req(id) };
  } catch (error) {
    if (
      error?.code === "MODULE_NOT_FOUND" ||
      error?.code === "ERR_MODULE_NOT_FOUND"
    )
      return { missing: true };
    throw error;
  }
}

/** The project's `playwright` package, or `@playwright/test` (which exports the same browsers). */
export async function loadPlaywright({ cwd = process.cwd() } = {}) {
  const req = projectRequire(cwd);
  for (const id of ["playwright", "@playwright/test"]) {
    const found = tryRequire(req, id);
    if (found.module?.chromium) return found.module;
  }
  throw new Error(
    `Playwright is not installed in ${resolve(cwd)}. Install it as a dev dependency of your project:\n` +
      "  npm install -D playwright\n" +
      "  npx playwright install chromium",
  );
}

/** The project's `sharp` image library. */
export async function loadSharp({ cwd = process.cwd() } = {}) {
  const found = tryRequire(projectRequire(cwd), "sharp");
  const sharp = found.module?.default ?? found.module;
  if (typeof sharp === "function") return sharp;
  throw new Error(
    `sharp is not installed in ${resolve(cwd)}. Install it as a dev dependency of your project:\n` +
      "  npm install -D sharp",
  );
}
