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
/**
 * Room for each thread's own count in a version. A thread id is never reused
 * within a process, so `threadId * THREAD_VERSION_SPAN + count` stays unique
 * across the main thread (id 0, versions 1, 2, ...) and every page worker of
 * every pool, which each count from 1 (F055: a fresh pool for each dev
 * rebuild re-stamped a changed page with the version it had before). Digits
 * only, and below 2^53 for two million threads.
 */
const THREAD_VERSION_SPAN = 2 ** 32;
/**
 * A version for a page being compiled now, unique in this process. `thread`
 * is the compiling thread's `threadId` from `node:worker_threads` (passed in,
 * so this module needs no Node import).
 */
export const nextLiveReloadVersion = (thread = 0): string =>
  String(thread * THREAD_VERSION_SPAN + ++lastPageVersion);

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
    var offlineRetryDelay = 5000;
    var retryTimeout = null;
    var banner = null;
    var bannerDot = null;
    var bannerText = null;
    var errorOverlay = null;
    var errorDetails = null;
    var lastGeneration = 0;
    var pageVersion = (document.currentScript &&
      document.currentScript.getAttribute('${LIVE_RELOAD_VERSION_ATTR}')) || '';

    // The overlay is a native modal <dialog> with the alertdialog role: showModal() puts it in the top layer
    // above any dialog or popover the page has open, moves focus to Dismiss, makes the page behind it inert,
    // closes it on Escape, and returns focus to where it was when it closes. Its parts are built with
    // createElement and textContent, so an error message is always shown as text.
    function showErrorOverlay(errData) {
      // Escape closes the dialog at once but removes it only in the close event's later task.
      if (errorOverlay && !errorOverlay.open) closeErrorOverlay();
      if (!errorOverlay) {
        errorOverlay = document.createElement('dialog');
        errorOverlay.id = 'bascik-build-error-overlay';
        errorOverlay.setAttribute('data-testid', 'bascik-build-error-overlay');
        errorOverlay.setAttribute('role', 'alertdialog');
        errorOverlay.setAttribute('aria-modal', 'true');
        errorOverlay.setAttribute('aria-labelledby', 'bascik-build-error-title');
        errorOverlay.setAttribute('aria-describedby', 'bascik-build-error-details');
        errorOverlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;' +
          'margin:0;border:0;z-index:2147483647;' +
          'background:rgba(0,0,0,0.85);color:#f43f5e;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
          'padding:24px;overflow:auto;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;';
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3f3f46;padding-bottom:12px;';
        var title = document.createElement('span');
        title.id = 'bascik-build-error-title';
        title.style.cssText = 'font-weight:bold;font-size:16px;color:#f43f5e;';
        title.textContent = 'Bascik Build Error';
        var dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.setAttribute('data-testid', 'bascik-error-dismiss');
        dismiss.style.cssText = 'background:#27272a;color:#e4e4e7;border:1px solid #3f3f46;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', function() { closeErrorOverlay(); });
        header.appendChild(title);
        header.appendChild(dismiss);
        errorDetails = document.createElement('div');
        errorDetails.id = 'bascik-build-error-details';
        errorDetails.setAttribute('aria-live', 'polite');
        errorDetails.style.cssText = 'display:flex;flex-direction:column;gap:16px;';
        errorOverlay.appendChild(header);
        errorOverlay.appendChild(errorDetails);
        // Escape, Dismiss, and a reload all end in close; the overlay then leaves the page, so the next error
        // builds a new one instead of filling in a detached element.
        var overlay = errorOverlay;
        overlay.addEventListener('close', function() {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (errorOverlay === overlay) {
            errorOverlay = null;
            errorDetails = null;
          }
        });
        document.body.appendChild(errorOverlay);
        if (typeof errorOverlay.showModal === 'function') errorOverlay.showModal();
        else errorOverlay.setAttribute('open', '');
        dismiss.focus();
      }
      errorDetails.textContent = '';
      if (errData && errData.file) {
        var loc = document.createElement('div');
        loc.style.cssText = 'color:#a1a1aa;font-size:13px;';
        loc.textContent = 'File: ';
        var where = document.createElement('span');
        where.style.cssText = 'color:#e4e4e7;';
        where.textContent = errData.file + (errData.line ? ':' + errData.line : '');
        loc.appendChild(where);
        errorDetails.appendChild(loc);
      }
      var body = document.createElement('pre');
      body.style.cssText = 'background:#18181b;color:#e4e4e7;padding:16px;border-radius:6px;border:1px solid #27272a;overflow-x:auto;white-space:pre-wrap;font-size:13px;line-height:1.5;margin:0;';
      body.textContent = String((errData && errData.message) || errData || '');
      errorDetails.appendChild(body);
    }

    function closeErrorOverlay() {
      if (!errorOverlay) return;
      var overlay = errorOverlay;
      if (typeof overlay.close === 'function' && overlay.open) overlay.close();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (errorOverlay === overlay) {
        errorOverlay = null;
        errorDetails = null;
      }
    }

    // A polite status region: screen readers announce each new message without moving focus. The element and
    // its message span stay while the text changes, because a live region added together with its text is
    // often not announced.
    function showBanner(message, isOffline) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'bascik-live-reload-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.setAttribute('aria-atomic', 'true');
        banner.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;' +
          'background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:8px;' +
          'font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.4;' +
          'padding:10px 14px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);display:flex;' +
          'align-items:center;gap:12px;max-width:380px;';
        bannerDot = document.createElement('span');
        bannerDot.setAttribute('aria-hidden', 'true');
        bannerText = document.createElement('span');
        bannerText.style.cssText = 'flex:1;';
        banner.appendChild(bannerDot);
        banner.appendChild(bannerText);
        document.body.appendChild(banner);
      }
      var dotColor = isOffline ? '#ef4444' : '#f59e0b';
      bannerDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + dotColor +
        ';flex-shrink:0;display:inline-block;';
      bannerText.textContent = message;
    }

    function removeBanner() {
      if (banner && banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
      banner = null;
      bannerDot = null;
      bannerText = null;
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
            closeErrorOverlay();
            window.location.reload();
          }
        } else if (msg === 'connected' || msg.indexOf('connected ') === 0) {
          retryCount = 0;
          removeBanner();
          var storedVersion = msg.split(' ')[1] || '';
          if (wasConnected || (pageVersion && storedVersion && storedVersion !== pageVersion)) {
            closeErrorOverlay();
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
          // Keep probing slowly so a tab that stays focused and visible still
          // reconnects when the server comes back, as the banner promises.
          showBanner('Dev server offline. Will reconnect automatically when server restarts.', true);
          if (retryTimeout) clearTimeout(retryTimeout);
          retryTimeout = setTimeout(connect, offlineRetryDelay);
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
