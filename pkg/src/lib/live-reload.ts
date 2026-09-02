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
    var source = null;
    var retryCount = 0;
    var maxRetries = 5;
    var retryTimeout = null;
    var banner = null;
    var errorOverlay = null;

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showErrorOverlay(errData) {
      if (!errorOverlay) {
        errorOverlay = document.createElement('div');
        errorOverlay.id = 'bascik-build-error-overlay';
        errorOverlay.setAttribute('data-testid', 'bascik-build-error-overlay');
        errorOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
          'background:rgba(0,0,0,0.85);color:#f43f5e;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
          'padding:24px;overflow:auto;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;';
        document.body.appendChild(errorOverlay);
      }
      var header = '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3f3f46;padding-bottom:12px;">' +
        '<span style="font-weight:bold;font-size:16px;color:#f43f5e;">Bascik Build Error</span>' +
        '<button data-testid="bascik-error-dismiss" style="background:#27272a;color:#e4e4e7;border:1px solid #3f3f46;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;" onclick="this.closest(\\'#bascik-build-error-overlay\\').remove()">Dismiss</button>' +
        '</div>';
      var loc = errData.file ? '<div style="color:#a1a1aa;font-size:13px;">File: <span style="color:#e4e4e7;">' + escapeHtml(errData.file) + (errData.line ? ':' + errData.line : '') + '</span></div>' : '';
      var body = '<pre style="background:#18181b;color:#e4e4e7;padding:16px;border-radius:6px;border:1px solid #27272a;overflow-x:auto;white-space:pre-wrap;font-size:13px;line-height:1.5;margin:0;">' + escapeHtml(errData.message || errData) + '</pre>';
      errorOverlay.innerHTML = header + loc + body;
    }

    function removeErrorOverlay() {
      if (errorOverlay && errorOverlay.parentNode) {
        errorOverlay.parentNode.removeChild(errorOverlay);
        errorOverlay = null;
      }
    }

    function showBanner(message, isOffline) {
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
      var dotColor = isOffline ? '#ef4444' : '#f59e0b';
      banner.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor +
        ';flex-shrink:0;display:inline-block;"></span>' +
        '<span style="flex:1;">' + message + '</span>';
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
          removeErrorOverlay();
          window.location.reload();
        } else if (e.data === 'connected') {
          retryCount = 0;
          removeBanner();
          if (wasConnected) {
            removeErrorOverlay();
            window.location.reload();
          }
          wasConnected = true;
        }
      };
      source.addEventListener('build-error', function(e) {
        try {
          var errData = JSON.parse(e.data);
          showErrorOverlay(errData);
        } catch (_) {
          showErrorOverlay({ message: e.data });
        }
      });
      source.onerror = function() {
        if (source) {
          source.close();
          source = null;
        }
        if (retryCount < maxRetries) {
          var delay = 1000;
          retryCount++;
          showBanner('Live reload disconnected. Reconnecting (' + retryCount + '/' + maxRetries + ')...', false);
          if (retryTimeout) clearTimeout(retryTimeout);
          retryTimeout = setTimeout(connect, delay);
        } else {
          showBanner('Dev server offline. Will reconnect automatically when server restarts.', true);
        }
      };
    }

    function instantConnect() {
      if (source && source.readyState !== EventSource.CLOSED) return;
      retryCount = 0;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
      if (source) {
        source.close();
        source = null;
      }
      connect();
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
