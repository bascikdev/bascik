import { parentPort, workerData } from "node:worker_threads";
import { transpilePage, type PageJob } from "./processing.ts";
import type { ComponentList, TranspilePageResult } from "./types.ts";
import { setChildWorkerCount } from "./script-runner.ts";
import { stopSharedCheckerGracefully } from "./typescript.ts";
import { mem } from "./mem.ts";
import {
  toPageWorkerFailure,
  type PageWorkerFailure,
} from "./page-worker-errors.ts";
import {
  CHILD_WORKER_COUNT_MESSAGE,
  PAGE_WORKER_INIT_MESSAGE,
  type PageWorkerSettings,
} from "./page-worker-messages.ts";

/**
 * What a page worker posts back for one page (prompt 86). The rendered HTML
 * travels as UTF-8 bytes whose ArrayBuffer is placed in the `postMessage`
 * transfer list, so ownership moves to the main thread with no structured
 * clone copy. Everything else is small metadata and is cloned as usual.
 */
export type PageWorkerResult = Omit<TranspilePageResult, "distHtml"> & {
  distHtmlBytes: Uint8Array;
};

export type PageWorkerMessage =
  | { ok: true; result: PageWorkerResult | null }
  | { ok: false; error: string; detail?: PageWorkerFailure };

export interface PageWorkerPort {
  postMessage(
    message: PageWorkerMessage,
    transferList?: readonly ArrayBuffer[],
  ): void;
}

const utf8 = new TextEncoder();

/**
 * Encode `distHtml` into a Uint8Array that owns its entire ArrayBuffer.
 * `TextEncoder.encode` always allocates a fresh backing store (never a view
 * into Node's shared Buffer pool), which is what makes the buffer safe to
 * hand over in a transfer list.
 */
export const toPageWorkerResult = (
  result: TranspilePageResult,
): PageWorkerResult => {
  const { distHtml, ...rest } = result;
  return { ...rest, distHtmlBytes: utf8.encode(distHtml) };
};

export const handlePageWorkerMessage = async (
  port: PageWorkerPort | null,
  data: { componentList: ComponentList; globalStylesHtml: string } | null,
  input: string | PageJob,
): Promise<void> => {
  const failedPagePath = typeof input === "string" ? input : input.pagePath;
  // Only what this compile records may travel back with a failure.
  mem.clearFailedDependencies(failedPagePath);
  try {
    const { componentList, globalStylesHtml } = data ?? {
      componentList: {},
      globalStylesHtml: "",
    };
    const pagePath = typeof input === "string" ? input : input.pagePath;
    const route = typeof input === "string" ? null : (input.route ?? null);
    const preCleanedHtml =
      typeof input === "string" ? undefined : input.preCleanedHtml;

    const result = await transpilePage(
      pagePath,
      componentList,
      globalStylesHtml,
      route,
      preCleanedHtml,
      // Disk publication is owned by the main thread (prompt 100). The worker
      // computes and transfers the bytes; it never writes or records artifacts
      // into its own process-local collectors.
      {
        deferDiskWrite: true,
        onceResolvedHtml:
          typeof input === "string" ? undefined : input.onceResolvedHtml,
      },
    );
    if (!result) {
      port?.postMessage({ ok: true, result: null });
      return;
    }
    const workerResult = toPageWorkerResult(result);
    port?.postMessage({ ok: true, result: workerResult }, [
      workerResult.distHtmlBytes.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // The class and fields of an error do not survive the thread boundary,
    // so the location, stage and missing helpers go as data (F053, F054).
    const failedDependencies = mem.failedDependenciesOf(failedPagePath);
    const detail = toPageWorkerFailure(error, failedDependencies);
    const hasDetail =
      detail.stage !== undefined ||
      detail.location !== undefined ||
      detail.failedDependencies !== undefined;
    port?.postMessage(
      hasDetail
        ? { ok: false, error: errorMsg, detail }
        : { ok: false, error: errorMsg },
    );
  }
};

interface CompileInputs {
  componentList: ComponentList;
  globalStylesHtml: string;
}

/** What `WorkerPool` posts to a `stopSignal` worker to end it. */
interface StopMessage {
  stop: true;
}

type PageWorkerInput = string | PageJob | PageWorkerSettings | StopMessage;

const isStop = (message: PageWorkerInput): message is StopMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { stop?: unknown }).stop === true;

const isSettings = (
  message: string | PageJob | PageWorkerSettings,
): message is PageWorkerSettings =>
  typeof message === "object" && message !== null && "kind" in message;

/**
 * How long an ending page worker waits for its event loop to drain before
 * it exits itself. Shorter than the pool's `STOP_GRACE_MS`, so a worker kept
 * alive by something a build script left open (a timer, a socket) still
 * ends from inside, not by the pool's external terminate.
 */
export const PAGE_WORKER_SELF_EXIT_MS = 1_000;

/**
 * End this worker from inside, on the pool's stop message (`WorkerPool`
 * `stopSignal`): stop its nested syntax checker the same way (its exit would
 * otherwise terminate it), then close the port, which lets the event loop
 * drain so the thread ends on its own with code 0. An unref'd timer exits
 * it if something else still holds the loop open; it never holds it itself.
 * Ending between tasks, not wherever an external `worker.terminate()`
 * lands, keeps the thread from being stopped while V8 is allocating code,
 * which can abort the whole process on Node 24 ("Check failed:
 * jit_page.has_value()").
 */
export const endPageWorker = async (
  port: { close(): void },
  {
    stopChecker = () => stopSharedCheckerGracefully(),
    exit = (code: number) => process.exit(code),
  }: {
    stopChecker?: () => Promise<void>;
    exit?: (code: number) => void;
  } = {},
): Promise<void> => {
  try {
    await stopChecker();
  } catch {
    // The checker is stopped with the thread regardless.
  }
  port.close();
  setTimeout(() => exit(0), PAGE_WORKER_SELF_EXIT_MS).unref();
};

/**
 * The worker's message listener. Page jobs are compiled; settings messages
 * (`page-worker-messages.ts`) update this worker's state and get no reply,
 * since the pool would take a reply for the result of the next job. The
 * pool's stop message calls `onStop` (`endPageWorker` in the worker) once.
 *
 * `initial` is null when the pool was started before the component list was
 * loaded; the init message then supplies it. A job that arrives before it is
 * failed loudly instead of being compiled against an empty component list,
 * which would silently emit pages with every component tag left unexpanded.
 */
export const createPageWorkerListener = (
  port: PageWorkerPort,
  initial: CompileInputs | null,
  onStop: () => void = () => {},
) => {
  let inputs = initial;
  let stopping = false;
  return (message: PageWorkerInput): void => {
    // On its way out: the pool sends nothing after the stop message and
    // waits for the exit, so anything that still arrives is dropped.
    if (stopping) return;
    if (isStop(message)) {
      stopping = true;
      onStop();
      return;
    }
    if (isSettings(message)) {
      if (message.kind === PAGE_WORKER_INIT_MESSAGE) {
        inputs = {
          componentList: message.componentList,
          globalStylesHtml: message.globalStylesHtml,
        };
      } else if (message.kind === CHILD_WORKER_COUNT_MESSAGE) {
        setChildWorkerCount(message.workerCount);
      }
      return;
    }
    if (!inputs) {
      port.postMessage({
        ok: false,
        error:
          "Page worker received a page before its component list (no init message was configured on the pool)",
      });
      return;
    }
    void handlePageWorkerMessage(port, inputs, message);
  };
};

if (parentPort && workerData) {
  const data = workerData as Partial<CompileInputs>;
  const port = parentPort;
  port.on(
    "message",
    createPageWorkerListener(
      port,
      data.componentList ? (data as CompileInputs) : null,
      () => void endPageWorker(port),
    ),
  );
  // This module is the worker's entry, so it finishes evaluating after its
  // whole import graph (top-level awaits included). Only now is it safe for
  // the pool to terminate this worker: Node can abort the process when a
  // worker is terminated mid-evaluation (`WorkerPool` `readySignal`). Posted
  // after the listener is registered, and never confused with a page result.
  port.postMessage({ ready: true });
}
