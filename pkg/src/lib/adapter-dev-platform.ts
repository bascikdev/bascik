import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

/** Resolve the user's installed CLI, never download one during development. */
export const resolvePlatformCli = async (
  projectRoot: string,
  packageName: string,
  binary: string,
): Promise<string> => {
  let manifestPath: string;
  try {
    manifestPath = createRequire(join(projectRoot, "package.json")).resolve(
      `${packageName}/package.json`,
    );
  } catch (cause) {
    throw new Error(
      `[bascik] Install ${packageName} in this project to use adapter dev mode.`,
      { cause },
    );
  }
  const manifest: { bin?: string | Record<string, string> } = JSON.parse(
    await readFile(manifestPath, "utf8"),
  );
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binary];
  if (!bin) throw new Error(`[bascik] ${packageName} has no "${binary}" CLI.`);
  return resolve(dirname(manifestPath), bin);
};

/** Reserve a currently unused loopback port for a child runtime. */
export const availableDevPort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("[bascik] Could not allocate a local runtime port."));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
