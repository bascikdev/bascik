/**
 * live-reload.ts: Injected client-side live-reload script.
 *
 * Appended to HTML pages in dev mode. Connects to the SSE endpoint
 * and reloads the page on transpilation or hot asset updates.
 * Shuts down permanently on connection failure to keep the console clean.
 */

export const getLiveReloadScript = (url = "/bascik-live-reload") => `
<script>
  (function() {
    var wasConnected = false;
    var source;
    var retryCount = 0;
    var maxRetries = 5;
    var retryTimeout = null;
    var banner = null;

    function showBanner(message, showRefresh) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'bascik-live-reload-banner';
        banner.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;' +
          'background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:8px;' +
          'font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.4;' +
          'padding:10px 14px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);display:flex;' +
          'align-items:center;gap:12px;max-width:380px;';
        document.body.appendChild(banner);
      }
      var dotColor = showRefresh ? '#ef4444' : '#f59e0b';
      var html = '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor +
        ';flex-shrink:0;display:inline-block;"></span>' +
        '<span style="flex:1;">' + message + '</span>';
      if (showRefresh) {
        html += '<button onclick="location.reload()" style="background:#27272a;color:#fff;' +
          'border:1px solid #52525b;border-radius:4px;padding:4px 8px;font-size:12px;' +
          'cursor:pointer;font-weight:500;">Refresh</button>';
      }
      banner.innerHTML = html;
    }

    function removeBanner() {
      if (banner && banner.parentNode) {
        banner.parentNode.removeChild(banner);
        banner = null;
      }
    }

    function connect() {
      if (source) return;
      source = new EventSource("${url}");
      source.onmessage = function(e) {
        if (e.data === 'reload') {
          window.location.reload();
        } else if (e.data === 'connected') {
          retryCount = 0;
          removeBanner();
          if (wasConnected) {
            window.location.reload();
          }
          wasConnected = true;
        }
      };
      source.onerror = function() {
        source.close();
        source = null;
        if (retryCount < maxRetries) {
          var delay = Math.pow(2, retryCount) * 1000;
          retryCount++;
          showBanner('Live reload disconnected. Reconnecting (' + retryCount + '/' + maxRetries + ')...', false);
          if (retryTimeout) clearTimeout(retryTimeout);
          retryTimeout = setTimeout(connect, delay);
        } else {
          showBanner('Live reload disconnected. Dev server offline.', true);
        }
      };
    }
    function instantConnect() {
      retryCount = 0;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (!source) {
        connect();
      }
    }
    window.addEventListener('focus', instantConnect);
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') instantConnect();
    });
    window.addEventListener('beforeunload', function() {
      if (retryTimeout) clearTimeout(retryTimeout);
      if (source) source.close();
    });
    connect();
  })();
</script>
`;

export const LIVE_RELOAD_SCRIPT = getLiveReloadScript();
