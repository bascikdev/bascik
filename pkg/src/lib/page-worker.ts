import { parentPort, workerData } from "node:worker_threads";
import { transpilePage } from "./processing.ts";
import type { ComponentList } from "./types.ts";

export const handlePageWorkerMessage = async (
  port: { postMessage: (msg: any) => void } | null,
  data: { componentList: ComponentList; globalStylesHtml: string } | null,
  pagePath: string
): Promise<void> => {
  try {
    const { componentList, globalStylesHtml } = data ?? {
      componentList: {},
      globalStylesHtml: "",
    };
    const result = await transpilePage(pagePath, componentList, globalStylesHtml);
    port?.postMessage({ ok: true, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    port?.postMessage({ ok: false, error: errorMsg });
  }
};

if (parentPort && workerData) {
  const data = workerData as { componentList: ComponentList; globalStylesHtml: string };
  parentPort.on("message", (pagePath: string) => {
    handlePageWorkerMessage(parentPort, data, pagePath);
  });
}

