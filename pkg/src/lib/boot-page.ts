import { getLiveReloadScript } from "./live-reload.ts";

/**
 * boot-page.ts: In-memory dev-server boot page.
 *
 * Shown while the initial transpile/build is in progress. The page
 * connects to the live-reload endpoint and reloads automatically once
 * the build completes or when the user focuses the tab. The message is a
 * status message in the page's <main>, and the spinner stops for visitors
 * who ask for reduced motion.
 */

export const getBootPageHtml = (
  liveReloadUrl = "/bascik-live-reload?boot=1",
): Buffer =>
  Buffer.from(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Building site\u2026</title>
<style>
body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
font-family:system-ui,sans-serif;background:#0f0f0f;color:#ccc}
.box{text-align:center}
.spinner{width:36px;height:36px;border:3px solid #333;border-top-color:#888;
border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}}
p{margin:0;font-size:.875rem;opacity:.5}
</style>
</head>
<body>
<main class="box">
  <div class="spinner"></div>
  <p role="status">Building site\u2026</p>
</main>
${getLiveReloadScript(liveReloadUrl)}
</body>
</html>`);

export const BOOT_PAGE_HTML = getBootPageHtml();
