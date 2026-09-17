import type ChokidarNS from "chokidar";

export type ChokidarModule = typeof ChokidarNS;

export async function loadChokidar(
  importModule: () => Promise<unknown> = () => import("chokidar")
): Promise<ChokidarModule> {
  try {
    const mod = (await importModule()) as any;
    return (mod.default ?? mod) as ChokidarModule;
  } catch (err: unknown) {
    const isNotFound =
      err &&
      typeof err === "object" &&
      "code" in err &&
      ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND" ||
        (err as { code?: string }).code === "MODULE_NOT_FOUND");

    if (isNotFound) {
      throw new Error(
        "[bascik] `bascik dev` requires chokidar for file watching, but it is not installed.\n" +
          "This usually happens if your package installation used `--omit=optional`.\n" +
          "Run `npm install chokidar` (or drop `--omit=optional`) and try again."
      );
    }
    throw err;
  }
}

