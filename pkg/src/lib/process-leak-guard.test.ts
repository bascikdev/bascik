import { describe, expect, it } from "vitest";
import {
  createProcessLeakGuard,
  descendantsOf,
  formatAbandonedReport,
  formatAge,
  formatLeakReport,
  LEAK_GUARD_ENV,
  parseElapsedSeconds,
  parsePsOutput,
  selectAbandonedProcesses,
  selectRunProcesses,
  type LeakGuardSystem,
  type ProcessRow,
} from "./process-leak-guard.test-helper.ts";

const ROOT = 100;
const MARKER = "100-abcdef";
const MARKED = `HOME=/home/me ${LEAK_GUARD_ENV}=${MARKER} PATH=/usr/bin`;

function row(
  pid: number,
  ppid: number,
  command: string,
  overrides: Partial<ProcessRow> = {},
): ProcessRow {
  return {
    pid,
    ppid,
    state: "S",
    ageSeconds: 5,
    started: `Sat Nov 14 10:00:${String(pid % 60).padStart(2, "0")} 2026`,
    command,
    ...overrides,
  };
}

/** The Vitest process, its shell, and an unrelated process. */
const BASE = [
  row(1, 0, "/sbin/launchd"),
  row(50, 1, "zsh"),
  row(ROOT, 50, "node vitest.mjs run"),
  row(900, 1, "node unrelated-server.js PATH=/usr/bin"),
];

/**
 * A fake operating system. Each call to `listProcesses` returns the next
 * table in `tables` (the last one repeats); `environment: false` strips the
 * environment the way a plain `ps` does. `sleep` advances the clock.
 */
function fakeSystem(tables: (ProcessRow[] | undefined)[]) {
  let clock = 0;
  let index = 0;
  const calls: boolean[] = [];
  const killed: number[] = [];
  const slept: number[] = [];
  const system: LeakGuardSystem = {
    async listProcesses(environment) {
      calls.push(environment);
      const table = tables[Math.min(index, tables.length - 1)];
      // Only looks for leaks (environment scans) move to the next table, so
      // the plain scan for the report sees the same processes.
      if (environment) index++;
      return table?.map((entry) =>
        environment
          ? entry
          : { ...entry, command: entry.command.split(" HOME=")[0] },
      );
    },
    kill(pid) {
      killed.push(pid);
    },
    async sleep(milliseconds) {
      slept.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
  };
  return { system, calls, killed, slept };
}

describe("parseElapsedSeconds", () => {
  it.each([
    ["00:00", 0],
    ["01:05", 65],
    ["59:59", 3599],
    ["02:03:04", 7384],
    ["3-01:00:00", 262_800],
    ["120:00", 7200],
  ])("reads %s as %i seconds", (elapsed, seconds) => {
    expect(parseElapsedSeconds(elapsed)).toBe(seconds);
  });

  it.each(["", "5", "1:2:3:4", "ab:cd", "-01:00"])("rejects %j", (elapsed) => {
    expect(parseElapsedSeconds(elapsed)).toBeNaN();
  });
});

describe("parsePsOutput", () => {
  it("reads macOS rows, including a single-digit day and a command with spaces", () => {
    const output = [
      "27584     1 SN         00:03 Sat Nov 14 22:18:33 2026 sleep 61",
      "  812   800 S+     01:02:03 Wed Nov  4 09:00:00 2026 /usr/local/bin/node /tmp/my project/server.ts --port 8080 HOME=/Users/me",
      "",
    ].join("\n");
    expect(parsePsOutput(output)).toEqual([
      {
        pid: 27584,
        ppid: 1,
        state: "SN",
        ageSeconds: 3,
        started: "Sat Nov 14 22:18:33 2026",
        command: "sleep 61",
      },
      {
        pid: 812,
        ppid: 800,
        state: "S+",
        ageSeconds: 3723,
        started: "Wed Nov 4 09:00:00 2026",
        command:
          "/usr/local/bin/node /tmp/my project/server.ts --port 8080 HOME=/Users/me",
      },
    ]);
  });

  it("reads Linux procps rows, and a zombie with no command", () => {
    const output = [
      "      8       1 S          00:00 Sun Nov 15 05:19:42 2026 sleep 30 NODE_VERSION=22.22.0",
      "     12       8 Z     2-00:00:01 Sun Nov 15 05:19:42 2026 [node] <defunct>",
      "     13       8 Z          00:00 Sun Nov 15 05:19:42 2026",
    ].join("\n");
    expect(
      parsePsOutput(output).map((entry) => [
        entry.pid,
        entry.state,
        entry.ageSeconds,
        entry.command,
      ]),
    ).toEqual([
      [8, "S", 0, "sleep 30 NODE_VERSION=22.22.0"],
      [12, "Z", 172_801, "[node] <defunct>"],
      [13, "Z", 0, ""],
    ]);
  });

  it("skips headers, error text, and rows with a malformed elapsed time", () => {
    const output = [
      "  PID  PPID STAT     ELAPSED STARTED COMMAND",
      "ps: illegal option -- e",
      "usage: ps [-AaCcEefhjlMmrSTvwXx]",
      "12 1 S bogus Sat Nov 14 22:18:33 2026 node",
      "",
    ].join("\n");
    expect(parsePsOutput(output)).toEqual([]);
  });
});

describe("descendantsOf", () => {
  it("follows the parent chain to any depth and leaves out the root", () => {
    const rows = [
      ...BASE,
      row(101, ROOT, "worker"),
      row(102, 101, "bascik --build"),
      row(103, 102, "exec script"),
    ];
    expect([...descendantsOf(rows, ROOT)].sort()).toEqual([101, 102, 103]);
  });

  it("ends on a parent cycle in a table read while processes changed", () => {
    const rows = [row(ROOT, 201, "root"), row(201, ROOT, "child")];
    expect([...descendantsOf(rows, ROOT)]).toEqual([201]);
  });
});

describe("selectRunProcesses", () => {
  it("finds a reparented orphan by its marker", () => {
    const rows = [...BASE, row(300, 1, `node long.ts ${MARKED}`)];
    const found = selectRunProcesses(rows, { rootPid: ROOT, marker: MARKER });
    expect(found.map((entry) => entry.pid)).toEqual([300]);
  });

  it("finds a descendant whose environment was replaced", () => {
    const rows = [
      ...BASE,
      row(101, ROOT, `worker ${MARKED}`),
      row(102, 101, "node child.js NODE_OPTIONS=--max-old-space-size=256"),
    ];
    const found = selectRunProcesses(rows, { rootPid: ROOT, marker: MARKER });
    expect(found.map((entry) => entry.pid)).toEqual([101, 102]);
  });

  it("finds a tracked orphan with no marker, only when the start time matches", () => {
    const orphan = row(400, 1, "/bin/sleep 600");
    const rows = [...BASE, orphan];
    expect(
      selectRunProcesses(rows, {
        rootPid: ROOT,
        marker: MARKER,
        tracked: new Map([[400, orphan.started]]),
      }).map((entry) => entry.pid),
    ).toEqual([400]);
    // The tracked process exited and another one got its PID.
    expect(
      selectRunProcesses(rows, {
        rootPid: ROOT,
        marker: MARKER,
        tracked: new Map([[400, "Sat Nov 14 09:00:00 2026"]]),
      }),
    ).toEqual([]);
  });

  it("never selects a process the run did not start", () => {
    const rows = [
      ...BASE,
      // Another run's marker, one that only starts like this run's, and none.
      row(500, 1, `node other.js ${LEAK_GUARD_ENV}=200-ffffff`),
      row(501, 1, `node other.js ${LEAK_GUARD_ENV}=${MARKER}99`),
      row(502, 1, `node other.js ${LEAK_GUARD_ENV}=`),
      // A sibling of the run under the same shell.
      row(503, 50, "node another-vitest.mjs run"),
    ];
    expect(selectRunProcesses(rows, { rootPid: ROOT, marker: MARKER })).toEqual(
      [],
    );
  });

  it("matches the marker at the end of the line", () => {
    const rows = [
      ...BASE,
      row(300, 1, `node x.js ${LEAK_GUARD_ENV}=${MARKER}`),
    ];
    expect(
      selectRunProcesses(rows, { rootPid: ROOT, marker: MARKER }),
    ).toHaveLength(1);
  });

  it("leaves out zombies, the root, and ignored PIDs", () => {
    const rows = [
      ...BASE.filter((entry) => entry.pid !== ROOT),
      // A nested run: the root carries its own marker.
      row(ROOT, 50, `node vitest.mjs run ${MARKED}`),
      row(101, ROOT, "", { state: "Z" }),
      row(102, ROOT, `[node] <defunct> ${MARKED}`, { state: "Zs" }),
      row(103, ROOT, `ps axeww ${MARKED}`),
    ];
    expect(
      selectRunProcesses(rows, {
        rootPid: ROOT,
        marker: MARKER,
        ignore: new Set([103]),
      }),
    ).toEqual([]);
  });
});

describe("selectAbandonedProcesses", () => {
  // The run of a Vitest process with PID 700 that is no longer running.
  const GONE = `${LEAK_GUARD_ENV}=700-0123456789abcdef`;
  const OWN = "100-fedcba9876543210";

  it("finds a marked process whose run's Vitest process is gone", () => {
    const rows = [
      ...BASE,
      row(300, 1, `node server.js HOME=/home/me ${GONE} PATH=/usr/bin`),
      row(301, 300, `node child.js ${GONE}`),
    ];
    expect(
      selectAbandonedProcesses(rows, OWN).map((entry) => entry.pid),
    ).toEqual([300, 301]);
  });

  it("leaves a run that is still going alone, this one included", () => {
    const rows = [
      ...BASE,
      row(700, 50, "node vitest.mjs run", { ageSeconds: 90 }),
      row(300, 1, `node server.js ${GONE}`, { ageSeconds: 60 }),
      // Started in the same second as its run, as `ps` rounds it.
      row(302, 700, `node worker.js ${GONE}`, { ageSeconds: 91 }),
      row(303, 1, `node mine.js ${LEAK_GUARD_ENV}=${OWN}`),
    ];
    expect(selectAbandonedProcesses(rows, OWN)).toEqual([]);
  });

  it("is not fooled by another process that got the dead run's PID", () => {
    const rows = [
      ...BASE,
      // Younger than the process that names it as its run.
      row(700, 1, "some other program", { ageSeconds: 10 }),
      row(300, 1, `node server.js ${GONE}`, { ageSeconds: 3600 }),
    ];
    expect(
      selectAbandonedProcesses(rows, OWN).map((entry) => entry.pid),
    ).toEqual([300]);
  });

  it("ignores zombies, unmarked processes, and values that are not a run ID", () => {
    const rows = [
      ...BASE,
      row(300, 1, `[node] <defunct> ${GONE}`, { state: "Z" }),
      row(301, 1, `node a.js ${LEAK_GUARD_ENV}=700-0123456789abcdef-other`),
      row(302, 1, `node b.js ${LEAK_GUARD_ENV}=hello`),
      row(303, 1, `node c.js X${GONE}`),
      row(304, 1, `node d.js ${LEAK_GUARD_ENV}=`),
    ];
    expect(selectAbandonedProcesses(rows, OWN)).toEqual([]);
  });
});

describe("formatAge and formatLeakReport", () => {
  it.each([
    [0, "0s"],
    [59, "59s"],
    [185, "3m 05s"],
    [7440, "2h 04m"],
    [262_800, "3d 01h"],
  ])("formats %i seconds as %s", (seconds, text) => {
    expect(formatAge(seconds)).toBe(text);
  });

  it("names every process with its PID, age, and command line", () => {
    const report = formatLeakReport([
      { pid: 300, ageSeconds: 185, command: "node long.ts" },
      { pid: 301, ageSeconds: 4, command: "" },
    ]);
    expect(report.split("\n")).toEqual([
      "Leak guard: this test run left 2 processes running. Each was killed after this report.",
      "  pid 300, age 3m 05s: node long.ts",
      "  pid 301, age 4s: (no command line)",
      expect.stringContaining("try/finally"),
    ]);
    expect(
      formatLeakReport([{ pid: 1, ageSeconds: 1, command: "x" }]),
    ).toContain("left 1 process running");
  });
});

describe("formatAbandonedReport", () => {
  it("names every process and says the run is not failed for them", () => {
    expect(
      formatAbandonedReport([
        { pid: 300, ageSeconds: 262_800, command: "node long.ts" },
      ]).split("\n"),
    ).toEqual([
      "Leak guard: an earlier test run that was killed before it finished left 1 process running. Each was killed now; this run is not failed for them.",
      "  pid 300, age 3d 01h: node long.ts",
    ]);
    expect(
      formatAbandonedReport([
        { pid: 300, ageSeconds: 1, command: "" },
        { pid: 301, ageSeconds: 1, command: "x" },
      ]),
    ).toContain("left 2 processes running");
  });
});

describe("createProcessLeakGuard", () => {
  const options = { rootPid: ROOT, marker: MARKER };

  describe("sweepAbandoned", () => {
    const abandoned = row(
      300,
      1,
      `node server.js HOME=/home/me ${LEAK_GUARD_ENV}=700-0123456789abcdef`,
      { ageSeconds: 262_800 },
    );

    it("kills and reports what a killed run left, without its environment", async () => {
      const mine = row(301, 1, `node mine.js ${MARKED}`);
      const fake = fakeSystem([[...BASE, abandoned, mine]]);
      const swept = await createProcessLeakGuard({
        ...options,
        system: fake.system,
      }).sweepAbandoned();
      expect(swept).toEqual([
        { pid: 300, ageSeconds: 262_800, command: "node server.js" },
      ]);
      expect(fake.killed).toEqual([300]);
    });

    it("does one scan and kills nothing when nothing was left", async () => {
      const fake = fakeSystem([BASE]);
      const swept = await createProcessLeakGuard({
        ...options,
        system: fake.system,
      }).sweepAbandoned();
      expect(swept).toEqual([]);
      expect(fake.calls).toEqual([true]);
      expect(fake.killed).toEqual([]);
    });

    it("finds nothing when the process table cannot be read", async () => {
      const fake = fakeSystem([undefined]);
      const swept = await createProcessLeakGuard({
        ...options,
        system: fake.system,
      }).sweepAbandoned();
      expect(swept).toEqual([]);
      expect(fake.killed).toEqual([]);
    });
  });

  it("makes a different run ID for every run of the same process", () => {
    const first = createProcessLeakGuard({ rootPid: ROOT }).marker;
    const second = createProcessLeakGuard({ rootPid: ROOT }).marker;
    expect(first).toMatch(/^100-[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
  });

  it("reports nothing, and does not wait, when the run left nothing", async () => {
    const fake = fakeSystem([BASE]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    expect(result).toEqual({ checked: true, leaks: [] });
    expect(fake.slept).toEqual([]);
    expect(fake.killed).toEqual([]);
    expect(fake.calls).toEqual([true]);
  });

  it("gives a process that is still exiting the grace period", async () => {
    const exiting = row(300, 1, `node server.js ${MARKED}`);
    const fake = fakeSystem([[...BASE, exiting], [...BASE, exiting], BASE]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    expect(result).toEqual({ checked: true, leaks: [] });
    expect(fake.slept).toEqual([200, 200]);
    expect(fake.killed).toEqual([]);
  });

  it("reports and kills what outlives the grace period, without printing its environment", async () => {
    const orphan = row(300, 1, `node long.ts ${MARKED}`, { ageSeconds: 42 });
    const child = row(102, 101, `node bascik --build ${MARKED}`);
    const fake = fakeSystem([
      [...BASE, row(101, ROOT, `worker ${MARKED}`), child, orphan],
      // The worker exits during the grace period; its child is reparented.
      [...BASE, { ...child, ppid: 1 }, orphan],
    ]);
    const result = await createProcessLeakGuard({
      ...options,
      graceMilliseconds: 1000,
      pollMilliseconds: 250,
      system: fake.system,
    }).finish();
    expect(result).toEqual({
      checked: true,
      leaks: [
        { pid: 102, ageSeconds: 5, command: "node bascik --build" },
        { pid: 300, ageSeconds: 42, command: "node long.ts" },
      ],
    });
    expect(fake.slept).toEqual([250, 250, 250, 250]);
    expect(fake.killed).toEqual([102, 300]);
    expect(JSON.stringify(result)).not.toContain("HOME=");
  });

  it("does not report a process that started during the grace period", async () => {
    const late = row(301, 1, `node late.js ${MARKED}`);
    const early = row(300, 1, `node early.js ${MARKED}`);
    const fake = fakeSystem([
      [...BASE, early],
      [...BASE, late],
    ]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    // `early` exited; `late` was not there at the first look, so it has not
    // been alive for the whole grace period.
    expect(result.leaks).toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it("does not take a reused PID for the process it saw before", async () => {
    const first = row(300, 1, `node a.js ${MARKED}`);
    const reused = { ...first, started: "Sat Nov 14 11:11:11 2026" };
    const fake = fakeSystem([
      [...BASE, first],
      [...BASE, reused],
    ]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    expect(result.leaks).toEqual([]);
  });

  it("says it could not check when the process table cannot be read", async () => {
    const fake = fakeSystem([undefined]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    expect(result).toEqual({ checked: false, leaks: [] });
    expect(fake.killed).toEqual([]);
  });

  it("kills nothing when the process table stops being readable during the grace period", async () => {
    const orphan = row(300, 1, `node long.ts ${MARKED}`);
    const fake = fakeSystem([[...BASE, orphan], undefined]);
    const result = await createProcessLeakGuard({
      ...options,
      system: fake.system,
    }).finish();
    expect(result).toEqual({ checked: false, leaks: [] });
    expect(fake.killed).toEqual([]);
  });

  it("reports a leak with no command line when it is gone from the plain scan", async () => {
    const orphan = row(300, 1, `node long.ts ${MARKED}`);
    let environmentScans = 0;
    const fake = fakeSystem([[...BASE, orphan]]);
    const system: LeakGuardSystem = {
      ...fake.system,
      async listProcesses(environment) {
        if (environment) environmentScans++;
        return environment ? [...BASE, orphan] : undefined;
      },
    };
    const result = await createProcessLeakGuard({
      ...options,
      graceMilliseconds: 0,
      system,
    }).finish();
    expect(environmentScans).toBe(1);
    expect(result.leaks).toEqual([{ pid: 300, ageSeconds: 5, command: "" }]);
  });

  it("remembers a sampled descendant after it is orphaned with no marker", async () => {
    const attached = row(102, 101, "/bin/sh -c server");
    const tables = [
      [...BASE, row(101, ROOT, "worker"), attached],
      [...BASE, { ...attached, ppid: 1 }],
    ];
    let table = tables[0];
    const fake = fakeSystem([]);
    const system: LeakGuardSystem = {
      ...fake.system,
      listProcesses: async () => table,
    };
    const guard = createProcessLeakGuard({ ...options, system });
    await guard.sample();
    table = tables[1];
    const result = await guard.finish();
    expect(result.leaks.map((leak) => leak.pid)).toEqual([102]);
    expect(fake.killed).toEqual([102]);
  });

  it("samples on a timer after start, and stops at finish", async () => {
    const attached = row(102, 101, "/bin/sh -c server");
    let table = [...BASE, row(101, ROOT, "worker"), attached];
    let plainScans = 0;
    const fake = fakeSystem([]);
    const system: LeakGuardSystem = {
      ...fake.system,
      async listProcesses(environment) {
        if (!environment) plainScans++;
        return table;
      },
    };
    const guard = createProcessLeakGuard({
      ...options,
      sampleMilliseconds: 1,
      graceMilliseconds: 0,
      system,
    });
    guard.start();
    guard.start();
    await expect.poll(() => plainScans).toBeGreaterThanOrEqual(2);
    table = [...BASE, { ...attached, ppid: 1 }];
    const result = await guard.finish();
    expect(result.leaks.map((leak) => leak.pid)).toEqual([102]);
    const scansAtFinish = plainScans;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plainScans).toBe(scansAtFinish);
    // Starting again after the end does nothing.
    guard.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plainScans).toBe(scansAtFinish);
  });
});
