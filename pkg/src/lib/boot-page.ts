/**
 * boot-page.ts: In-memory dev-server boot page.
 *
 * Shown while the initial transpile/build is in progress. The page
 * connects to the live-reload endpoint and reloads automatically once
 * the build completes or when the user focuses the tab.
 */

export const BOOT_PAGE_HTML = Buffer.from(`<!DOCTYPE html>
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
p{margin:0;font-size:.875rem;opacity:.5}
</style>
</head>
<body>
<div class="box">
  <div class="spinner"></div>
  <p>Building site\u2026</p>
</div>
<script>
(function(){
  var es;
  var retryCount = 0;
  var maxRetries = 5;
  var retryTimeout = null;

  function connect() {
    if (es) return;
    es = new EventSource('/bascik-live-reload?boot=1');
    es.onmessage = function(e){ if (e.data === 'reload') location.reload() };
    es.onerror = function(){
      es.close();
      es = null;
      if (retryCount < maxRetries) {
        var delay = Math.pow(2, retryCount) * 1000;
        retryCount++;
        if (retryTimeout) clearTimeout(retryTimeout);
        retryTimeout = setTimeout(connect, delay);
      } else {
        var p = document.querySelector('p');
        if (p) p.textContent = 'Connection to dev server lost. Refresh page.';
      }
    };
  }
  function instantConnect() {
    retryCount = 0;
    if (retryTimeout) clearTimeout(retryTimeout);
    if (!es) connect();
  }
  window.addEventListener('focus', instantConnect);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') instantConnect();
  });
  connect();
})();
</script>
</body>
</html>`);
