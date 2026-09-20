import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";

const BUILD_STATE_FILE = "build-state.json";
const BUILD_STATE_FORMAT = 1;

type BuildMode = "development" | "build";

interface BuildState {
  format: number;
  mode: BuildMode;
  version: string;
}

const statePath = (): string => join(resolve(BascikConfig.directory.out), ".bascik", BUILD_STATE_FILE);

export const writeBuildState = async (mode: BuildMode, version: string): Promise<void> => {
  const path = statePath();
  await mkdir(resolve(path, ".."), { recursive: true });
  const state: BuildState = { format: BUILD_STATE_FORMAT, mode, version };
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
};

export const assertProductionBuildState = async (purpose: "server" | "targeted-build"): Promise<void> => {
  let state: BuildState;
  try {
    state = JSON.parse(await readFile(statePath(), "utf8")) as BuildState;
  } catch {
    throw new Error(
      purpose === "server"
        ? "[bascik] --server requires a completed production build in dist/. Run `bascik --build` first."
        : "[bascik] targeted builds require an existing completed production build. Run `bascik --build` first.",
    );
  }
  if (state.format !== BUILD_STATE_FORMAT || state.mode !== "build") {
    throw new Error(
      purpose === "server"
        ? "[bascik] --server requires a completed production build in dist/. Run `bascik --build` first."
        : "[bascik] targeted builds require an existing completed production build. Run `bascik --build` first.",
    );
  }
};
