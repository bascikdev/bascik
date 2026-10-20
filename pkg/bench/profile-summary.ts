import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface ProfileNode {
  id: number;
  name: string;
  url: string;
  line: number;
  column: number;
  children: number[];
  lines: { line: number; ticks: number }[];
}

interface FunctionTiming {
  name: string;
  url: string;
  line: number;
  column: number;
  selfMs: number;
  inclusiveMs: number;
  lines: { line: number; ticks: number }[];
}

const record = (value: unknown): Record<string, unknown> => {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected an object",
  );
  return value as Record<string, unknown>;
};

const integer = (value: unknown): number => {
  assert(
    typeof value === "number" && Number.isSafeInteger(value),
    "expected an integer",
  );
  return value;
};

export function summarizeCpuProfile(input: unknown): {
  totalMs: number;
  functions: FunctionTiming[];
} {
  const profile = record(input);
  assert(
    Array.isArray(profile.nodes) && profile.nodes.length > 0,
    "profile needs nodes",
  );
  assert(
    Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas),
    "profile needs samples and timeDeltas",
  );
  assert(
    profile.samples.length === profile.timeDeltas.length,
    "samples and timeDeltas must have equal lengths",
  );
  const nodes = new Map<number, ProfileNode>();
  for (const raw of profile.nodes as unknown[]) {
    const node = record(raw);
    const frame = record(node.callFrame);
    const id = integer(node.id);
    assert(!nodes.has(id), `duplicate node ${id}`);
    assert(
      typeof frame.functionName === "string" && typeof frame.url === "string",
      "invalid call frame",
    );
    assert(
      node.children === undefined || Array.isArray(node.children),
      "invalid children",
    );
    assert(
      node.positionTicks === undefined || Array.isArray(node.positionTicks),
      "invalid positionTicks",
    );
    nodes.set(id, {
      id,
      name: frame.functionName || "(anonymous)",
      url: frame.url,
      line: integer(frame.lineNumber) + 1,
      column: integer(frame.columnNumber) + 1,
      children: ((node.children ?? []) as unknown[]).map(integer),
      lines: ((node.positionTicks ?? []) as unknown[]).map((entry) => {
        const position = record(entry);
        return { line: integer(position.line), ticks: integer(position.ticks) };
      }),
    });
  }
  const parents = new Map<number, number>();
  for (const node of nodes.values())
    for (const child of node.children) {
      assert(nodes.has(child), `missing child ${child}`);
      assert(!parents.has(child), `multiple parents for node ${child}`);
      parents.set(child, node.id);
    }
  const checked = new Set<number>();
  for (const node of nodes.values()) {
    const path = new Set<number>();
    let cursor: number | undefined = node.id;
    while (cursor !== undefined && !checked.has(cursor)) {
      assert(!path.has(cursor), "cyclic profile graph");
      path.add(cursor);
      cursor = parents.get(cursor);
    }
    for (const id of path) checked.add(id);
  }
  const key = (node: ProfileNode) =>
    JSON.stringify([node.name, node.url, node.line, node.column]);
  const functions = new Map<string, FunctionTiming>();
  for (const node of nodes.values()) {
    const identity = key(node);
    let timing = functions.get(identity);
    if (!timing) {
      timing = {
        name: node.name,
        url: node.url,
        line: node.line,
        column: node.column,
        selfMs: 0,
        inclusiveMs: 0,
        lines: [],
      };
      functions.set(identity, timing);
    }
    for (const position of node.lines) {
      const existing = timing.lines.find(({ line }) => line === position.line);
      if (existing) existing.ticks += position.ticks;
      else timing.lines.push({ ...position });
    }
  }
  const self = new Map<number, number>();
  let totalMs = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const id = integer(profile.samples[index]);
    assert(nodes.has(id), `missing sampled node ${id}`);
    const delta: unknown = profile.timeDeltas[index];
    assert(
      typeof delta === "number" && Number.isFinite(delta),
      "invalid time delta",
    );
    const ms = Math.max(0, delta) / 1000;
    totalMs += ms;
    self.set(id, (self.get(id) ?? 0) + ms);
  }
  for (const [id, ms] of self) {
    functions.get(key(nodes.get(id)!))!.selfMs += ms;
    const seen = new Set<string>();
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      const identity = key(nodes.get(cursor)!);
      if (!seen.has(identity)) {
        functions.get(identity)!.inclusiveMs += ms;
        seen.add(identity);
      }
      cursor = parents.get(cursor);
    }
  }
  return { totalMs, functions: [...functions.values()] };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      filter: { type: "string", default: "" },
      limit: { type: "string", default: "30" },
    },
  });
  assert(
    positionals.length === 1,
    "usage: profile:summary <file.cpuprofile> [--filter text] [--limit 30]",
  );
  const limit = Number(values.limit);
  assert(
    Number.isInteger(limit) && limit > 0 && limit <= 500,
    "limit must be 1..500",
  );
  const summary = summarizeCpuProfile(
    JSON.parse(await readFile(positionals[0], "utf8")),
  );
  console.log(
    `Sampled time: ${summary.totalMs.toFixed(1)} ms (includes idle and GC)`,
  );
  for (const metric of ["selfMs", "inclusiveMs"] as const) {
    console.log(`\n${metric === "selfMs" ? "Self" : "Inclusive"} time`);
    for (const row of summary.functions
      .filter(({ name, url }) => `${name} ${url}`.includes(values.filter!))
      .sort((left, right) => right[metric] - left[metric])
      .slice(0, limit)) {
      const percent = summary.totalMs
        ? (row[metric] / summary.totalMs) * 100
        : 0;
      const lines = [...row.lines]
        .sort((left, right) => right.ticks - left.ticks)
        .slice(0, 3)
        .map(({ line, ticks }) => `${line}:${ticks}`)
        .join(", ");
      console.log(
        `${row[metric].toFixed(1)} ms ${percent.toFixed(1)}% ${row.name} ${row.url}:${row.line}:${row.column}${lines ? ` [line:ticks ${lines}]` : ""}`,
      );
    }
  }
}
