/**
 * Open-ended generative UI, opt in.
 *
 * A model writes a whole small web page (HTML with inline `<style>` and
 * `<script>`) in a ```html-app fence. `sandboxFence()` turns the fence's text
 * into an `<iframe>` that runs it isolated from the chat page. The catalog
 * stays the default; this is for what no component can do: a simulation, a
 * custom visualization, a small game, a calculator.
 *
 * Isolation: `sandbox="allow-scripts"` without `allow-same-origin` gives the
 * frame an opaque origin (no cookies, no storage of the page, no access to the
 * page's DOM). No `allow-forms`, `allow-popups`, `allow-modals`, or top
 * navigation. A Content-Security-Policy in the frame with `default-src 'none'`
 * so it cannot fetch, load images from the network, or send data anywhere,
 * except scripts from origins the app lists.
 *
 * Talking to the chat: the frame's first script sends a one-time token with a
 * MessageChannel port, before any of the page's scripts run, and every later
 * message uses that port, so a page the frame navigates to cannot talk to
 * the chat. A suggestion is shown as a button in the chat page: only the
 * reader's click there puts it in the message box.
 *
 * The page can still send data out by navigating its own frame: no sandbox
 * flag and no CSP directive prevents that, so a prompt-injected page can put
 * what it was told into an address. The client runtime removes a frame that
 * leaves its page, but the request has gone by then, and an address that
 * answers 204 No Content loads nothing, so a page can repeat it without being
 * stopped. Other known limits: a page CSP is inherited by an srcdoc frame (a strict page CSP that
 * does not allow 'unsafe-inline' blocks the frame's scripts); and a listed
 * script origin receives whatever URL the page asks it for.
 */
import { esc } from "@bascik/bascik/html";
import type { FenceRenderer } from "./render.ts";

export interface SandboxFenceOptions {
  /** Origins the page may load scripts from, such as "https://cdn.jsdelivr.net". None by default. */
  scripts?: readonly string[];
  /** The frame's height in CSS pixels before the page reports its own (default 360). */
  height?: number;
  /** The frame's accessible name (default "Interactive page written by the assistant"). */
  title?: string;
  /** The longest page drawn, in characters (default 100_000); a longer one is shown as code. */
  maxLength?: number;
}

export const SANDBOX_LANGUAGE = "html-app";

/**
 * Validates a script origin. It must parse with `new URL()`, have protocol
 * `https:`, no username or password, and pathname "/" with no search or hash.
 * Returns the `url.origin`. Throws `TypeError` naming the bad entry otherwise.
 * This matters because the value goes into a CSP header value: a space or `;`
 * must never get through.
 */
function validateOrigin(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new TypeError(`Invalid script origin: "${entry}"`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`Invalid script origin: "${entry}"`);
  }
  return url.origin;
}

/**
 * What to tell a model about the fence: pass it to `fencePrompts` under
 * `SANDBOX_LANGUAGE`. It follows "A ```html-app fence is drawn, not shown as
 * code." and names the script origins the frame allows.
 */
export function sandboxPrompt(
  options?: Pick<SandboxFenceOptions, "scripts">,
): string {
  const origins = (options?.scripts ?? []).map(validateOrigin);
  const scriptLine = origins.length
    ? `Scripts may be loaded only from: ${origins.join(", ")}.`
    : "It cannot load scripts from anywhere: write all the code inline.";
  return [
    "Write one complete small web page in it, with inline style and script, only when no component fits: an interactive simulation, a custom chart, a small game, a calculator.",
    "It runs in a sandboxed frame with no network: no fetch, no images or fonts from the web (draw with inline SVG or a canvas), no links or navigation to other addresses, no forms, and no alert.",
    scriptLine,
    'To offer the reader a reply, call bascik.suggest("text"): the chat shows it as a button under the page, and pressing it puts the text in their message box.',
    "Keep it under 300 lines.",
  ].join(" ");
}

/** `sandboxPrompt()` with no options. */
export const SANDBOX_PROMPT = sandboxPrompt();

/**
 * The frame's document: a policy that allows no network, a small base style,
 * the `bascik` bridge (`suggest`, and the page's height for the chat to size
 * the frame), then the model's page as the body. A page that writes its own
 * `<html>` or `<head>` still gets this head first, so the policy applies.
 */
export function sandboxDocument(
  source: string,
  scripts?: readonly string[],
  token: string = newToken(),
): string {
  const origins = (scripts ?? []).map(validateOrigin);
  // It is written into a script and an attribute: nothing but a plain token.
  if (!/^[\w-]{16,64}$/.test(token)) {
    throw new TypeError("A sandbox token is 16 to 64 letters, digits, - or _.");
  }
  const csp =
    `default-src 'none'; script-src 'unsafe-inline'` +
    (origins.length ? ` ${origins.join(" ")}` : "") +
    `; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'`;
  const base =
    ":root{color-scheme:light dark}body{margin:0;padding:12px;font:15px/1.5 system-ui,sans-serif}";
  // The bridge is the first script of the frame, so it runs before any of
  // the page's. It sends the token once, with a MessageChannel port, and
  // removes its own element; later messages go only through the port, which
  // page script cannot reach, and a page the frame navigates to never has it.
  // The chat pings the port every few seconds and removes a frame that does
  // not answer, and the bridge says "leaving" when its document goes away.
  const bridge =
    "(()=>{" +
    `const channel=new MessageChannel(),port=channel.port1,send=port.postMessage.bind(port);` +
    `parent.postMessage({bascikSandbox:"ready",token:${JSON.stringify(token)}},"*",[channel.port2]);` +
    'port.onmessage=(e)=>{if(e.data==="ping")send("pong")};' +
    'let lastHeight=0;const reportHeight=()=>{const h=Math.ceil(document.documentElement.scrollHeight);if(h!==lastHeight){lastHeight=h;send({bascikSandbox:"height",height:h})}};' +
    'const suggest=(text)=>send({bascikSandbox:"suggest",text:String(text).slice(0,200)});' +
    'Object.defineProperty(window,"bascik",{value:Object.freeze({suggest}),enumerable:true});' +
    'addEventListener("load",reportHeight);' +
    // Leaving this document, by navigation or otherwise: the chat stops the frame.
    'addEventListener("pagehide",()=>send("leaving"));' +
    'document.addEventListener("DOMContentLoaded",()=>new ResizeObserver(reportHeight).observe(document.documentElement));' +
    "document.currentScript.remove();" +
    "})();";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style><script>${bridge}</script></head><body>` +
    source +
    `</body></html>`
  );
}

/** A fresh token for one frame: 24 hex digits, from Web Crypto. */
const newToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * A renderer for ```html-app fences. Returns an `<iframe>` that runs the
 * source in an isolated frame.
 */
export function sandboxFence(options: SandboxFenceOptions = {}): FenceRenderer {
  const {
    scripts = [],
    height = 360,
    title = "Interactive page written by the assistant",
    maxLength = 100_000,
  } = options;

  const origins = scripts.map(validateOrigin);

  if (!Number.isFinite(height) || height < 60 || height > 2000) {
    throw new TypeError(`Invalid height: ${height}`);
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new TypeError(`Invalid maxLength: ${maxLength}`);
  }

  const escapedTitle = esc(title);

  return (source: string): string | null => {
    if (!source.trim() || source.length > maxLength) {
      return null;
    }
    const token = newToken();
    const doc = sandboxDocument(source, origins, token);
    const escapedDoc = esc(doc);
    return `<iframe class="genui-sandbox" data-genui-sandbox="${token}" sandbox="allow-scripts" referrerpolicy="no-referrer" width="100%" height="${height}" title="${escapedTitle}" srcdoc="${escapedDoc}"></iframe>`;
  };
}
