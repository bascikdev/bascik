/**
 * Finds processes a test run started and left alive (vitest.leak-guard-setup.ts
 * is the global setup that fails the run on them).
 *
 * A leaked process is usually an orphan: its parent exited, the kernel
 * reparented it (PPID 1 or a subreaper), and nothing in the process table
 * links it to the run any more. The guard therefore identifies its own
 * processes three ways, and each one alone is enough:
 *
 * 1. **Marker.** The setup puts `BASCIK_TEST_LEAK_GUARD_RUN=<run id>` in
 *    `process.env` before any worker starts, so every child that inherits the
 *    environment carries it, and `ps e` prints the environment a process
 *    started with. This survives reparenting, detaching, and new sessions.
 * 2. **Descendants.** Anything whose parent chain still reaches the Vitest
 *    process.
 * 3. **Tracked.** A sample every few seconds remembers each descendant (PID
 *    and start time), so one that is orphaned later is still known. This
 *    covers children spawned with a replaced `env`, and macOS system binaries
 *    (`/bin/sh`, `/bin/sleep`), whose environment `ps` cannot read.
 *
 * A process that matches none of these is never reported or killed: the run
 * ID is random, and the PID and start time of a tracked process must both
 * match. What stays invisible is a child spawned with a replaced `env` (or a
 * macOS system binary) that is orphaned between two samples.
 *
 * A run whose Vitest process was killed never reaches its teardown, so the
 * next run also looks for marked processes whose run is gone: the run ID
 * starts with the PID of the run's Vitest process (`selectAbandonedProcesses`).
 *
 * `ps` is asked for the same columns on macOS and Linux (procps). Where `ps`
 * is missing or rejects the options (Windows, BusyBox) the guard reports that
 * it could not look and does not fail the run.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Environment variable that carries the run ID to every child process. */
export const LEAK_GUARD_ENV = "BASCIK_TEST_LEAK_GUARD_RUN";

/** One row of the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** `ps` state letters (`S`, `R+`, `Z`). */
  state: string;
  /** Seconds since the process started. */
  ageSeconds: number;
  /** Start time as `ps` prints it; with the PID it identifies one process. */
  started: string;
  /** Command line. From an environment scan, the environment follows it. */
  command: string;
}

/** A process the run left alive. */
export interface LeakedProcess {
  pid: number;
  ageSeconds: number;
  /** Command line without the environment. */
  command: string;
}

/** What the guard needs from the operating system; faked in unit tests. */
export interface LeakGuardSystem {
  /**
   * The process table, or `undefined` when it cannot be read. With
   * `environment` each command is followed by the process's environment. The
   * helper process that reads the table is not in the result.
   */
  listProcesses(environment: boolean): Promise<ProcessRow[] | undefined>;
  /** Kills one process; a process that is already gone is not an error. */
  kill(pid: number): void;
  /** Resolves after `milliseconds`. */
  sleep(milliseconds: number): Promise<void>;
  /** Milliseconds from a monotonic clock. */
  now(): number;
}

/** Options for {@link createProcessLeakGuard}. */
export interface LeakGuardOptions {
  /** PID of the process that owns the run (the Vitest main process). */
  rootPid: number;
  /** Run ID; random by default. */
  marker?: string;
  /** How long a process may take to exit after the last test. */
  graceMilliseconds?: number;
  /** Pause between two looks during the grace period. */
  pollMilliseconds?: number;
  /** Pause between two descendant samples during the run. */
  sampleMilliseconds?: number;
  system?: LeakGuardSystem;
}

/** Result of {@link ProcessLeakGuard.finish}. */
export interface LeakGuardResult {
  /** False when the process table could not be read. */
  checked: boolean;
  /** Processes that were still alive after the grace period; all were killed. */
  leaks: LeakedProcess[];
}

/** A guard for one test run. */
export interface ProcessLeakGuard {
  /** Run ID to put in `process.env[LEAK_GUARD_ENV]`. */
  readonly marker: string;
  /** Starts sampling the run's descendants on a timer. */
  start(): void;
  /** Takes one sample now: remembers every current descendant. */
  sample(): Promise<void>;
  /** Stops sampling, waits out the grace period, and kills what is left. */
  finish(): Promise<LeakGuardResult>;
  /**
   * Kills and returns what earlier runs left behind without reaching their
   * own teardown. Empty when there is nothing, or no process table to read.
   */
  sweepAbandoned(): Promise<LeakedProcess[]>;
}

const PS_COLUMNS = "pid=,ppid=,stat=,etime=,lstart=,command=";
/** pid, ppid, state, elapsed, five words of start time, command. */
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s(.*))?$/;
/** A loaded machine can take seconds to walk a large process table. */
const PS_TIMEOUT_MS = 15_000;

/** Parses `ps` elapsed time (`[[dd-]hh:]mm:ss`) into seconds; NaN when malformed. */
export function parseElapsedSeconds(elapsed: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(elapsed);
  if (!match) return Number.NaN;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (
    Number(days) * 86_400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** Parses `ps -o pid=,ppid=,stat=,etime=,lstart=,command=` output; skips lines it cannot read. */
export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const ageSeconds = parseElapsedSeconds(match[4]);
    if (Number.isNaN(ageSeconds)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      state: match[3],
      ageSeconds,
      started: match[5].replace(/\s+/g, " "),
      command: (match[6] ?? "").trim(),
    });
  }
  return rows;
}

/** PIDs whose parent chain reaches `rootPid` (not `rootPid` itself). */
export function descendantsOf(
  rows: readonly ProcessRow[],
  rootPid: number,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const found = new Set<number>();
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index++)
    for (const child of children.get(queue[index]) ?? [])
      if (child !== rootPid && !found.has(child)) {
        found.add(child);
        queue.push(child);
      }
  return found;
}

/** Whether a command line with its environment carries this run's marker. */
function carriesMarker(command: string, marker: string): boolean {
  const assignment = `${LEAK_GUARD_ENV}=${marker}`;
  let from = command.indexOf(assignment);
  while (from !== -1) {
    const next = command[from + assignment.length];
    if (next === undefined || /\s/.test(next)) return true;
    from = command.indexOf(assignment, from + 1);
  }
  return false;
}

/**
 * The live processes this run started: marked, descended from `rootPid`, or
 * tracked earlier with the same start time. Zombies, the root, and `ignore`
 * are left out. `rows` must come from an environment scan.
 */
export function selectRunProcesses(
  rows: readonly ProcessRow[],
  options: {
    rootPid: number;
    marker: string;
    tracked?: ReadonlyMap<number, string>;
    ignore?: ReadonlySet<number>;
  },
): ProcessRow[] {
  const descendants = descendantsOf(rows, options.rootPid);
  return rows.filter((row) => {
    if (row.pid === options.rootPid || options.ignore?.has(row.pid))
      return false;
    // Exited and waiting for its parent to collect it: nothing is running.
    if (row.state.includes("Z")) return false;
    return (
      descendants.has(row.pid) ||
      options.tracked?.get(row.pid) === row.started ||
      carriesMarker(row.command, options.marker)
    );
  });
}

/** A run ID as `createProcessLeakGuard` makes it: `<root PID>-<16 hex digits>`. */
const RUN_MARKER = new RegExp(
  `(?:^|\\s)${LEAK_GUARD_ENV}=((\\d+)-[0-9a-f]{16})(?=\\s|$)`,
);

/**
 * Live processes that carry the run ID of a run that is gone: its Vitest
 * process is not in the table, or a younger process has taken that PID (a
 * run's root is always older than what the run started). Their run was
 * killed before its teardown could look for them. `ownMarker` is the current
 * run, which is never abandoned. `rows` must come from an environment scan.
 */
export function selectAbandonedProcesses(
  rows: readonly ProcessRow[],
  ownMarker: string,
): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.filter((row) => {
    if (row.state.includes("Z")) return false;
    const match = RUN_MARKER.exec(row.command);
    if (!match || match[1] === ownMarker) return false;
    const root = byPid.get(Number(match[2]));
    // One second of slack: `ps` reports whole seconds.
    return !root || root.ageSeconds + 1 < row.ageSeconds;
  });
}

/** Formats seconds as `45s`, `3m 05s`, `2h 04m`, or `3d 01h`. */
export function formatAge(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
  return `${Math.floor(seconds / 86_400)}d ${pad(Math.floor((seconds % 86_400) / 3600))}h`;
}

/** The message the run fails with: one line per leaked process. */
export function formatLeakReport(leaks: readonly LeakedProcess[]): string {
  const count = leaks.length === 1 ? "1 process" : `${leaks.length} processes`;
  return [
    `Leak guard: this test run left ${count} running. Each was killed after this report.`,
    ...leaks.map(
      (leak) =>
        `  pid ${leak.pid}, age ${formatAge(leak.ageSeconds)}: ${leak.command || "(no command line)"}`,
    ),
    "A test that spawns a process must end it on every path, including a failed assertion (try/finally or afterEach), and wait for it to exit.",
  ].join("\n");
}

/** The warning for processes an earlier, killed run left behind. */
export function formatAbandonedReport(
  abandoned: readonly LeakedProcess[],
): string {
  const count =
    abandoned.length === 1 ? "1 process" : `${abandoned.length} processes`;
  return [
    `Leak guard: an earlier test run that was killed before it finished left ${count} running. Each was killed now; this run is not failed for them.`,
    ...abandoned.map(
      (leak) =>
        `  pid ${leak.pid}, age ${formatAge(leak.ageSeconds)}: ${leak.command || "(no command line)"}`,
    ),
  ].join("\n");
}

function runPs(environment: boolean): Promise<ProcessRow[] | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // LC_ALL keeps the start time at five words in every locale.
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
    delete env[LEAK_GUARD_ENV];
    try {
      const child = execFile(
        "ps",
        [environment ? "axeww" : "axww", "-o", PS_COLUMNS],
        {
          encoding: "utf8",
          env,
          maxBuffer: 256 * 1024 * 1024,
          timeout: PS_TIMEOUT_MS,
        },
        (error, stdout) => {
          if (error) return resolve(undefined);
          // `ps` lists itself, as a child of this process.
          const rows = parsePsOutput(stdout).filter(
            (row) => row.pid !== child.pid,
          );
          // Options this `ps` does not know print nothing usable.
          resolve(rows.length > 0 ? rows : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

const realSystem: LeakGuardSystem = {
  listProcesses: runPs,
  kill(pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  },
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => performance.now(),
};

/** Creates the guard for one run. It does nothing until `start` or `finish`. */
export function createProcessLeakGuard(
  options: LeakGuardOptions,
): ProcessLeakGuard {
  const system = options.system ?? realSystem;
  const marker =
    options.marker ?? `${options.rootPid}-${randomBytes(8).toString("hex")}`;
  const graceMilliseconds = options.graceMilliseconds ?? 2000;
  const pollMilliseconds = options.pollMilliseconds ?? 200;
  const sampleMilliseconds = options.sampleMilliseconds ?? 2000;
  /** Descendants seen during the run: PID to start time. */
  const tracked = new Map<number, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampling: Promise<void> | undefined;
  let stopped = false;

  async function sample(): Promise<void> {
    const rows = await system.listProcesses(false);
    if (!rows) return;
    const descendants = descendantsOf(rows, options.rootPid);
    for (const row of rows)
      if (descendants.has(row.pid)) tracked.set(row.pid, row.started);
  }

  // One sample at a time, the next one a full pause after the last finished,
  // so a slow `ps` never stacks up.
  function schedule(): void {
    timer = setTimeout(() => {
      sampling = sample().then(() => {
        sampling = undefined;
        if (!stopped) schedule();
      });
    }, sampleMilliseconds);
    // The guard must never keep the run alive.
    (timer as { unref?: () => void }).unref?.();
  }

  const identity = (row: ProcessRow) => `${row.pid} ${row.started}`;

  /** Reports `rows` with command lines from a plain scan, and kills them. */
  async function reportAndKill(rows: ProcessRow[]): Promise<LeakedProcess[]> {
    const plain = new Map<string, string>();
    for (const row of (await system.listProcesses(false)) ?? [])
      plain.set(identity(row), row.command);
    const leaks = rows
      .map((row) => ({
        pid: row.pid,
        ageSeconds: row.ageSeconds,
        // Never the environment scan's text: it would print the
        // environment, secrets included, into the log.
        command: plain.get(identity(row)) ?? "",
      }))
      .sort((a, b) => a.pid - b.pid);
    // Killed after the report is built, so one leak does not hold a port or
    // a lock when the next run starts.
    for (const leak of leaks) system.kill(leak.pid);
    return leaks;
  }

  return {
    marker,
    sample,
    async sweepAbandoned() {
      const rows = await system.listProcesses(true);
      const abandoned = rows ? selectAbandonedProcesses(rows, marker) : [];
      return abandoned.length > 0 ? reportAndKill(abandoned) : [];
    },
    start() {
      if (timer === undefined && !stopped) schedule();
    },
    async finish() {
      stopped = true;
      clearTimeout(timer);
      await sampling;

      const look = async (): Promise<ProcessRow[] | undefined> => {
        const rows = await system.listProcesses(true);
        return (
          rows &&
          selectRunProcesses(rows, {
            rootPid: options.rootPid,
            marker,
            tracked,
          })
        );
      };

      let alive = await look();
      if (!alive) return { checked: false, leaks: [] };
      // Workers and children that were told to stop get time to exit. Only a
      // process alive at every look is a leak.
      const deadline = system.now() + graceMilliseconds;
      while (alive.length > 0 && system.now() < deadline) {
        await system.sleep(pollMilliseconds);
        const next = await look();
        if (!next) return { checked: false, leaks: [] };
        const before: ReadonlySet<string> = new Set(alive.map(identity));
        alive = next.filter((row) => before.has(identity(row)));
      }
      if (alive.length === 0) return { checked: true, leaks: [] };

      return { checked: true, leaks: await reportAndKill(alive) };
    },
  };
}
