/**
 * @module script-output-policy
 *
 * What a settled server or stream script becomes, on every host.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A script's call (or, for a script that yields, each pull) settles to a
 * value or a failure. This module turns that into the script's output:
 *
 * - a value prints by the shared rule (`serverScriptOutput`), has terminal
 *   color codes stripped unless `scripts.stripAnsi` is off, and receives its
 *   component's scoped names when the script lives in a component;
 * - a value that is not markup is refused: in development it is a failure
 *   under `scripts.onServerScriptError`; in production it never fails the
 *   page, the output is empty and one warning is logged per script;
 * - a failure throws under `"error"` (a 500 before the response commits, an
 *   empty slot after), is logged under `"warn"`, and is silent under
 *   `"ignore"`; a client that went away is never reported.
 *
 * The Node server, the Cloudflare Worker and the Netlify function all settle
 * through here, which is what makes them send the same bytes and word the
 * same mistake the same way. A host passes a `ScriptOutputPolicy` naming
 * only what differs: where a log goes, how a failure is described (Node maps
 * the stack to the authored file), which error class is thrown, and how
 * "once per script" is remembered.
 *
 * Portable: Web platform only. No `node:*` imports, no config, no globals of
 * a particular host. `serverless-contract.test.ts` bundles it with the rest
 * of the runtime.
 */
import { stripAnsiEscapeCodes } from "./ansi-escapes.ts";
import { applyOutputScope, decodeOutputScope } from "./output-scope.ts";
import {
  scriptChunkOutput,
  type ScriptChunkSource,
  type ScriptJobOutput,
} from "./request-execution.ts";
import {
  serverScriptOutput,
  serverScriptOutputErrorMessage,
} from "./server-script-output.ts";

/** `scripts.onServerScriptError`. */
export type ServerScriptErrorPolicy = "error" | "warn" | "ignore";

/**
 * One settled call or pull. An `InvokeResult` (the adapters) and the Node
 * registry's `ScriptExecutionResult` both fit, so a host passes what it has.
 */
export interface ScriptSettleResult {
  ok: boolean;
  /** Present when `ok`. */
  value?: unknown;
  /** Present when not `ok`. */
  error?: Error;
  /** The deadline fired before the script settled. */
  timedOut?: boolean;
  /** The upstream signal aborted before the script settled (not a timeout). */
  aborted?: boolean;
  /** The raw rejection, when the host kept it, for `isSilentFailure`. */
  thrown?: unknown;
}

/** What a host settles a script's output by. One per job. */
export interface ScriptOutputPolicy {
  /** `scripts.onServerScriptError` as this host has it. */
  onServerScriptError: ServerScriptErrorPolicy;
  /**
   * Whether a value that is not markup may fail the page. Development
   * (`false`): it is a failure under `onServerScriptError`, reported on every
   * request. Production (`true`): the output is empty and, unless the policy
   * is `"ignore"`, one warning is logged per script (`firstRefusal`).
   */
  production: boolean;
  /** The request's URL; its pathname names the route in every message. */
  requestUrl: string;
  /**
   * The script, for the message of a refused value: `stream script in
   * src/pages/orders.html:12`. Absent: "The script".
   */
  owner?: string;
  /** `scripts.stripAnsi`: only `false` keeps terminal color codes. */
  stripAnsi?: boolean;
  /**
   * The encoded output scope of a script written inside a component: its
   * output receives the component's class and element names. Absent for a
   * page's own script.
   */
  outputScope?: string;
  /** Where a warning goes: the host's own log. */
  warn: (message: string) => void;
  /**
   * Production only: whether this is the first refused value this script
   * has had since the host started. The host remembers (by job, by source
   * position); called at most once per refusal, and not at all under
   * `"ignore"`.
   */
  firstRefusal: () => boolean;
  /**
   * The body of a failure report, under the shared first line
   * `[bascik] server script error at "<pathname>":`. A host that can map the
   * stack to the authored file does it here; `result.timedOut` says the
   * deadline fired. Not called under `"ignore"`.
   */
  describeFailure: (error: Error, result: ScriptSettleResult) => string;
  /** The error thrown under `"error"`; a plain `Error` when absent. */
  createError?: (message: string) => Error;
  /**
   * A failure that is dropped without a report whatever the policy says: a
   * socket the client reset. A client abort is always dropped and needs no
   * rule here.
   */
  isSilentFailure?: (result: ScriptSettleResult) => boolean;
}

const fail = (policy: ScriptOutputPolicy, message: string): never => {
  throw policy.createError ? policy.createError(message) : new Error(message);
};

/**
 * The output of one settled call (`yielded` false) or one pull from a script
 * that yields (`yielded` true): the printed markup, or `""`. Throws under
 * `"error"` for a failure, and in development for a value that is not
 * markup. `result` is not changed.
 */
export const settleScriptOutput = (
  result: ScriptSettleResult,
  yielded: boolean,
  policy: ScriptOutputPolicy,
): string => {
  let settled = result;
  if (result.ok) {
    // An array is joined with no separator, the way `html` inserts one; an
    // object, a Response, an unawaited Promise in an array, a function or a
    // symbol is refused instead of printing "[object ...]". A throw from the
    // author's own toString is the script failing: it follows the failure
    // policy below like any other throw.
    let printed: ReturnType<typeof serverScriptOutput> | undefined;
    try {
      printed = serverScriptOutput(result.value);
    } catch (thrown) {
      settled = {
        ok: false,
        error: thrown instanceof Error ? thrown : new Error(String(thrown)),
      };
    }
    if (printed?.error) {
      if (!policy.production) {
        if (policy.onServerScriptError === "ignore") return "";
        const message = serverScriptOutputErrorMessage(
          printed.error,
          policy.requestUrl,
          policy.owner,
          { yielded },
        );
        if (policy.onServerScriptError === "error") fail(policy, message);
        policy.warn(message);
        return "";
      }
      // Production never fails the page for this: an empty output and one
      // warning per script.
      if (policy.onServerScriptError !== "ignore" && policy.firstRefusal())
        policy.warn(
          serverScriptOutputErrorMessage(
            printed.error,
            policy.requestUrl,
            policy.owner,
            { production: true, yielded },
          ),
        );
      return "";
    }
    if (printed) {
      // Color codes go first, so one inside a tag cannot hide its class.
      const text =
        policy.stripAnsi === false
          ? printed.text
          : stripAnsiEscapeCodes(printed.text);
      const scope = decodeOutputScope(policy.outputScope);
      return scope ? applyOutputScope(text, scope) : text;
    }
  }

  if (policy.isSilentFailure?.(settled)) return "";
  // The client went away before the script settled: nothing is delivered,
  // so there is nothing to report, even when the script answered the abort
  // with a value inside its listener.
  if (settled.aborted && !settled.timedOut) return "";
  if (policy.onServerScriptError === "ignore") return "";
  const error = settled.error ?? new Error("Server script failed");
  const message =
    `[bascik] server script error at "${new URL(policy.requestUrl).pathname}":\n` +
    policy.describeFailure(error, settled);
  if (policy.onServerScriptError === "error") fail(policy, message);
  policy.warn(message);
  return "";
};

/**
 * A job's output from its invocation: the settled string of a script that
 * returned, or, for a script that yields (`invoked.source`, from
 * `invokeLoadedWithDeadline` with `chunks: true`), an iterable whose every
 * value and every failed pull is settled by the same policy. Under `"error"`
 * a failure throws: from this call, or from the iterable's `next()`.
 */
export const scriptJobOutput = (
  invoked: ScriptSettleResult & { source?: ScriptChunkSource },
  policy: ScriptOutputPolicy,
): ScriptJobOutput =>
  invoked.ok && invoked.source
    ? scriptChunkOutput(
        invoked.source,
        (value) => settleScriptOutput({ ok: true, value }, true, policy),
        (failed) => settleScriptOutput(failed, true, policy),
      )
    : settleScriptOutput(invoked, false, policy);
