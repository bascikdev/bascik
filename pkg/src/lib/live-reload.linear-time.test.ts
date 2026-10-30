import { describe, it } from "vitest";
import {
  LIVE_RELOAD_SCRIPT_ATTR,
  getLiveReloadScript,
  stripLiveReloadScript,
} from "./live-reload.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("stripLiveReloadScript", () => {
  it(
    "stays linear on deeply nested look-alikes",
    () => {
      const nested = (depth: number) => {
        let html = getLiveReloadScript().trim();
        for (let i = 0; i < depth; i++)
          html = `<scr${html}ipt ${LIVE_RELOAD_SCRIPT_ATTR}>x${i}()</script>`;
        return html;
      };
      expectLinearTime(nested, 1000, stripLiveReloadScript);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
