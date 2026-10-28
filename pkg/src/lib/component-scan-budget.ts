/**
 * @module component-scan-budget
 *
 * The request-time scanning budget (prompt 157 security audit, item G).
 *
 * The expansion loop is linear in its input except where it must read
 * again text it has read before: when an instance is spliced where the mask
 * cannot be patched in place (a usage cut mid-tag, or a template or usage
 * that leaves a comment, tag or raw-text element open), it re-masks the
 * whole text and its next search re-reads the attribute state from the
 * start; a usage with no closing tag has its close looked for to the end;
 * and a usage with one is read to its close and its slot copied, so each
 * level of nested usages reads everything inside it again. Once per nested
 * instance, that is quadratic: up to 1000 instances times the output's
 * length, about 40 s for a 1 MB output a visitor's text shaped (3 s for
 * 1000 nested usages around 1 MB of slot text, 13 s at 4 MiB). Every such
 * read is charged here, by its characters.
 *
 * A request renderer runs each script output's expansion inside
 * `withScanBudget(SCAN_BUDGET.perOutputChar * output.length +
 * SCAN_BUDGET.base, ...)`; the loop charges its rescans with `chargeScan` and
 * stops with a `ScanBudgetExceededError` once the budget is spent, which the
 * renderer reports as a located `RequestRenderError`. The build never sets a
 * budget, so nothing changes there.
 *
 * Module state is safe: the loop is synchronous, so one budget is active
 * from `withScanBudget`'s entry to its return, with no other request's work
 * interleaved. Internal: neither runtime entry re-exports this module.
 *
 * This module must stay portable: no `node:*` imports, no `process`, no
 * `Buffer`, no config module.
 */

/**
 * The budget for one script output, in characters read again: this many
 * per character of the output as the script returned it, plus `base`. A
 * page whose usages are written whole spends about its length once per
 * level of nesting (the request-render-scan-budget tests measure the docs
 * demos, the catalog fixture, the e2e pages and 1000 small cards); a
 * hostile shape spends the output's length per nested instance. `base` is
 * work that takes a fraction of a second at any size (32 Mi characters,
 * about 0.1 to 0.2 s), so a small page is never refused for doing cheap
 * work quadratically: say a few hundred unclosed usages inside a wrapper,
 * which the instance limit already bounds.
 */
export const SCAN_BUDGET = {
  perOutputChar: 16,
  base: 32 * 1024 * 1024,
} as const;

/** The loop spent the active budget. Caught and located by the renderer. */
export class ScanBudgetExceededError extends Error {
  readonly tag: string;
  readonly budget: number;

  constructor(tag: string, budget: number) {
    super(
      `component expansion rescanned more than ${budget} characters (at ${tag})`,
    );
    this.name = "ScanBudgetExceededError";
    this.tag = tag;
    this.budget = budget;
  }
}

interface ActiveBudget {
  budget: number;
  spent: number;
}

let active: ActiveBudget | null = null;

/** Run `expand` (synchronous) with a budget of `budget` characters read again. */
export const withScanBudget = <T>(budget: number, expand: () => T): T => {
  const previous = active;
  const current: ActiveBudget = { budget, spent: 0 };
  active = current;
  try {
    return expand();
  } finally {
    active = previous;
    __scanBudgetStatsForTests.lastSpent = current.spent;
  }
};

/** Charge `chars` characters read again to the active budget, if any. */
export const chargeScan = (chars: number): void => {
  if (active !== null && chars > 0) active.spent += chars;
};

/**
 * Throw a `ScanBudgetExceededError` naming `tag` when the active budget is
 * spent. The loop calls this before each search, outside its per-instance
 * error handling, so the failure is the output's, not one instance's.
 */
export const checkScanBudget = (tag: string): void => {
  if (active !== null && active.spent > active.budget)
    throw new ScanBudgetExceededError(tag, active.budget);
};

/** Test-only: what the last `withScanBudget` run spent. */
export const __scanBudgetStatsForTests = { lastSpent: 0 };
