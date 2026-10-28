// Identical capture settings for production and the Bascik target. Dependency-free; Node.js 22.18+.
// The functions take a Playwright page or browser from the caller; nothing here imports Playwright.

/**
 * Browser context options for one matrix case: the exact viewport, device scale factor 1, reduced motion and the
 * light color scheme, so two captures differ only by the site. A case may override colorScheme, reducedMotion,
 * hasTouch and isMobile to test those conditions.
 */
export function contextOptions(matrixCase) {
  const options = {
    viewport: { width: matrixCase.width, height: matrixCase.height },
    deviceScaleFactor: 1,
    reducedMotion: matrixCase.reducedMotion ?? "reduce",
    colorScheme: matrixCase.colorScheme ?? "light",
  };
  for (const key of ["hasTouch", "isMobile"])
    if (matrixCase[key] !== undefined) options[key] = matrixCase[key];
  return options;
}

/**
 * Waits until the page is stable enough to measure: fonts ready, eager images complete, finite animations
 * finished, scrolled to the top. Each wait is capped so a lazy image or a looping animation cannot hang the run.
 */
export async function settle(page, { timeout = 10_000 } = {}) {
  await page.evaluate(async (limit) => {
    const capped = (promise) =>
      Promise.race([promise, new Promise((r) => setTimeout(r, limit))]);
    await capped(document.fonts.ready);
    await capped(
      Promise.all(
        [...document.images]
          .filter((img) => !img.complete && img.loading !== "lazy")
          .map(
            (img) =>
              new Promise((r) => {
                img.addEventListener("load", r, { once: true });
                img.addEventListener("error", r, { once: true });
              }),
          ),
      ),
    );
    await capped(
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    window.scrollTo(0, 0);
  }, timeout);
}

/**
 * Joins a route onto an origin: ("https://www.example.com", "/pricing") -> "https://www.example.com/pricing".
 * A path on the origin is a base path and is kept: ("http://localhost:8080/docs", "/pricing") ->
 * "http://localhost:8080/docs/pricing".
 */
export function routeUrl(origin, route) {
  const base = new URL(origin.endsWith("/") ? origin : `${origin}/`);
  return new URL(String(route).replace(/^\/+/, ""), base).href;
}

/** Opens `url` in a fresh context for `matrixCase` and settles it. The caller closes the returned context. */
export async function openPage(browser, url, matrixCase) {
  const context = await browser.newContext(contextOptions(matrixCase));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });
  await settle(page);
  return { context, page };
}
