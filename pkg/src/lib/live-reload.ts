/**
 * live-reload.ts: Injected client-side live-reload script.
 *
 * Appended to HTML pages in dev mode. Connects to the SSE endpoint
 * and reloads the page on transpilation or hot asset updates.
 * Shuts down permanently on connection failure to keep the console clean.
 *
 * The open tag carries `data-bascik-live-reload` so this injected script can
 * be identified by its tag alone. Production startup (`server-prod.ts`) and
 * E2E harnesses rely on that attribute; never identify the script by
 * scanning page content for the SSE path, which ordinary pages may mention.
 */

import {
  readStartTagAttributes,
  removeHtmlRanges,
  scanHtml,
  type HtmlRange,
} from "./html-scanner.ts";

/** Attribute that marks the injected dev live-reload `<script>` tag. */
export const LIVE_RELOAD_SCRIPT_ATTR = "data-bascik-live-reload";

/**
 * Remove every live-reload script element from `html`, leaving everything
 * else exactly as the browser parses it.
 *
 * Elements are found by the spec-following scan in html-scanner.ts, with the
 * attribute read from the tokenized start tag, so only a real `<script>`
 * element whose own start tag carries `data-bascik-live-reload` is removed.
 * Look-alike text, such as `<scr<script data-bascik-live-reload>` (one odd
 * start tag that runs nothing) or the attribute name inside another
 * attribute's value, is not a live-reload script and is kept. Text on either
 * side of a removed element never joins into new markup, so stripping can
 * never create a script, live-reload or otherwise. If malformed SVG or MathML
 * stops the scan, scripts after that point stay; a leftover dev client finds
 * no live-reload endpoint and shuts itself down.
 */
export const stripLiveReloadScript = (html: string): string => {
  if (!html.includes(LIVE_RELOAD_SCRIPT_ATTR)) return html;
  const removals: HtmlRange[] = [];
  scanHtml(html, {
    script(script) {
      const attributes = readStartTagAttributes(html, script.start);
      if (
        attributes.some(
          (attribute) => attribute.name === LIVE_RELOAD_SCRIPT_ATTR,
        )
      )
        removals.push(script);
    },
  });
  return removeHtmlRanges(html, removals).html;
};

/**
 * The attribute that carries a compiled page's version on its live-reload
 * script. A page can load its old version and miss the reload for the new
 * one: the rebuild finishes, and its reload goes out, before the page's own
 * connection opens. So the server sends the stored page's version when a
 * page connects (`connected <version>`), and a page whose version differs
 * reloads.
 */
export const LIVE_RELOAD_VERSION_ATTR = "data-bascik-live-reload-version";

let lastPageVersion = 0;
/** A version for a page being compiled now, unique in this process. */
export const nextLiveReloadVersion = (): string => String(++lastPageVersion);

/**
 * The version on the last live-reload script in a stored page, quoted or
 * left unquoted by the minifier, or null when it has none.
 */
export const liveReloadVersionOf = (html: string): string | null => {
  const at = html.lastIndexOf(`${LIVE_RELOAD_VERSION_ATTR}=`);
  if (at === -1) return null;
  let i = at + LIVE_RELOAD_VERSION_ATTR.length + 1;
  if (html[i] === '"' || html[i] === "'") i++;
  let end = i;
  while (end < html.length && html[end] >= "0" && html[end] <= "9") end++;
  return end > i ? html.slice(i, end) : null;
};

export const getLiveReloadScript = (
  url = "/bascik-live-reload",
  version?: string,
) => `
<script ${LIVE_RELOAD_SCRIPT_ATTR}${version ? ` ${LIVE_RELOAD_VERSION_ATTR}="${version}"` : ""}>
  (function() {
    var wasConnected = false;
    var source = null;
    var retryCount = 0;
    var maxRetries = 5;
    var retryTimeout = null;
    var banner = null;
    var errorOverlay = null;
    var lastGeneration = 0;
    var pageVersion = (document.currentScript &&
      document.currentScript.getAttribute('${LIVE_RELOAD_VERSION_ATTR}')) || '';

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
        var msg = e.data || '';
        if (msg.indexOf('reload') === 0) {
          var parts = msg.split(' ');
          var gen = parts.length > 1 ? parseInt(parts[1], 10) : 0;
          if (!gen || gen > lastGeneration) {
            if (gen) lastGeneration = gen;
            removeErrorOverlay();
            window.location.reload();
          }
        } else if (msg === 'connected' || msg.indexOf('connected ') === 0) {
          retryCount = 0;
          removeBanner();
          var storedVersion = msg.split(' ')[1] || '';
          if (wasConnected || (pageVersion && storedVersion && storedVersion !== pageVersion)) {
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
