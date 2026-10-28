import { parentPort, workerData } from "node:worker_threads";
import { transpilePage, type PageJob } from "./processing.ts";
import type { ComponentList, TranspilePageResult } from "./types.ts";
import { setChildWorkerCount } from "./script-runner.ts";
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
  { ok: true; result: PageWorkerResult | null } | { ok: false; error: string };

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
    port?.postMessage({ ok: false, error: errorMsg });
  }
};

interface CompileInputs {
  componentList: ComponentList;
  globalStylesHtml: string;
}

const isSettings = (
  message: string | PageJob | PageWorkerSettings,
): message is PageWorkerSettings =>
  typeof message === "object" && message !== null && "kind" in message;

/**
 * The worker's message listener. Page jobs are compiled; settings messages
 * (`page-worker-messages.ts`) update this worker's state and get no reply,
 * since the pool would take a reply for the result of the next job.
 *
 * `initial` is null when the pool was started before the component list was
 * loaded; the init message then supplies it. A job that arrives before it is
 * failed loudly instead of being compiled against an empty component list,
 * which would silently emit pages with every component tag left unexpanded.
 */
export const createPageWorkerListener = (
  port: PageWorkerPort,
  initial: CompileInputs | null,
) => {
  let inputs = initial;
  return (message: string | PageJob | PageWorkerSettings): void => {
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
  parentPort.on(
    "message",
    createPageWorkerListener(
      parentPort,
      data.componentList ? (data as CompileInputs) : null,
    ),
  );
  // This module is the worker's entry, so it finishes evaluating after its
  // whole import graph (top-level awaits included). Only now is it safe for
  // the pool to terminate this worker: Node can abort the process when a
  // worker is terminated mid-evaluation (`WorkerPool` `readySignal`). Posted
  // after the listener is registered, and never confused with a page result.
  parentPort.postMessage({ ready: true });
}
