import { parentPort, workerData } from "node:worker_threads";
import { transpilePage, type PageJob } from "./processing.ts";
import type { ComponentList } from "./types.ts";

export const handlePageWorkerMessage = async (
  port: { postMessage: (msg: any) => void } | null,
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
    port?.postMessage({ ok: true, result });
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

