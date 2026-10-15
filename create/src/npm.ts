import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

type SpawnSyncFunction = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

export interface NpmInvocation {
  command: string;
  args: string[];
}

/**
 * The command that runs `npm <args>`. `args` must be fixed words such as `install`, never user input.
 *
 * On Windows `npm` is `npm.cmd`, and Node cannot start a `.cmd` file directly: `spawn("npm.cmd")` fails with
 * EINVAL. The documented way is to start `cmd.exe` and give it the script to run, which is what this does.
 * `/d` skips AutoRun commands, `/s` keeps the quoting of the rest of the line as written, `/c` runs it and exits.
 */
export const npmInvocation = (
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NpmInvocation =>
  platform === "win32"
    ? { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] }
    : { command: "npm", args };

export interface RunNpmResult {
  ok: boolean;
  /** Why it did not run, when the program could not be started at all. */
  error?: string;
}

/** Runs `npm <args>` in `cwd` with the terminal attached. Never throws: a missing npm is reported, not fatal. */
export const runNpm = (
  args: string[],
  cwd: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: SpawnSyncFunction;
  } = {},
): RunNpmResult => {
  const { command, args: commandArgs } = npmInvocation(args, options.platform, options.env);
  const result = (options.spawn ?? spawnSync)(command, commandArgs, { cwd, stdio: "inherit" });
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: result.status === 0 };
};
