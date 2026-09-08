import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

export function profileJournal(directory: string | undefined) {
  let sequence = 0;
  return (event: string, details: object = {}) => {
    if (!directory) return;
    appendFileSync(join(directory, `events-${process.pid}-${threadId}.jsonl`), JSON.stringify({
      ...details, event, pid: process.pid, threadId, sequence: sequence++, at: Date.now(), monotonicNs: String(process.hrtime.bigint()),
    }) + "\n", { mode: 0o600 });
  };
}