// Playwright global setup: bascik --server compresses a static file on its first request, which takes several
// seconds for the 1 MB search index. Tests that open search would race that one-time cost against their
// timeouts, so it is paid here, once, before any test runs.
import type { FullConfig } from "@playwright/test";

export default async function warmServer(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const home = await (await fetch(baseURL)).text();
  const index = /"(\/assets\/search-index\.[0-9a-f]+\.json)"/.exec(home)?.[1];
  if (!index) return;
  for (const encoding of ["br", "gzip", "identity"])
    await (
      await fetch(new URL(index, baseURL), {
        headers: { "accept-encoding": encoding },
      })
    ).arrayBuffer();
}
