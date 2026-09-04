import { parentPort, workerData } from "node:worker_threads";
import { transpilePage, type PageJob } from "./processing.ts";
import type { ComponentList, TranspilePageResult } from "./types.ts";

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
  | { ok: false; error: string };

export interface PageWorkerPort {
  postMessage(message: PageWorkerMessage, transferList?: readonly ArrayBuffer[]): void;
}

const utf8 = new TextEncoder();

/**
 * Encode `distHtml` into a Uint8Array that owns its entire ArrayBuffer.
 * `TextEncoder.encode` always allocates a fresh backing store (never a view
 * into Node's shared Buffer pool), which is what makes the buffer safe to
 * hand over in a transfer list.
 */
export const toPageWorkerResult = (result: TranspilePageResult): PageWorkerResult => {
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
    const preCleanedHtml = typeof input === "string" ? undefined : input.preCleanedHtml;

    const result = await transpilePage(
      pagePath,
      componentList,
      globalStylesHtml,
      route,
      preCleanedHtml,
    );
    if (!result) {
      port?.postMessage({ ok: true, result: null });
      return;
    }
    const workerResult = toPageWorkerResult(result);
    port?.postMessage({ ok: true, result: workerResult }, [workerResult.distHtmlBytes.buffer as ArrayBuffer]);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    port?.postMessage({ ok: false, error: errorMsg });
  }
};

if (parentPort && workerData) {
  const data = workerData as { componentList: ComponentList; globalStylesHtml: string };
  parentPort.on("message", (input: string | PageJob) => {
    handlePageWorkerMessage(parentPort, data, input);
  });
}

