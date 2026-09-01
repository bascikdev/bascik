import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read the installed package version from package.json.
export const readVersion = async (baseDir?: string): Promise<string> => {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "../package.json"),
    join(here, "../../package.json"),
    join(here, "package.json"),
  ]) {
    try {
      const raw = await readFile(candidate, "utf8");
      const version = (JSON.parse(raw) as { version?: string }).version;
      if (version) return version;
    } catch {
      // Try the next candidate path.
    }
  }
  return "unknown";
};
