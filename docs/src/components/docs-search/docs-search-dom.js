/* bascik-disable js-attribute-selector, js-document-class-query */
var btn = document.querySelector(".button");
var overlay = document.querySelector(".overlay");
var backdrop = document.querySelector(".backdrop");
var input = document.querySelector(".input");
var list = document.querySelector(".results");
var empty = document.querySelector(".empty");
var hint = document.querySelector(".hint");
var statusEl = document.getElementById("docs-search-status");
var lastFocused = null;
var preloaded = new Set();

function preload(href) {
  if (
    !href ||
    preloaded.has(href) ||
    href.startsWith("#") ||
    href.startsWith("http")
  )
    return;
  preloaded.add(href);
  var link = document.createElement("link");
  link.rel = "prefetch";
  link.setAttribute("href", href);
  document.head.appendChild(link);
}

// Portal to <body> so position:fixed escapes the nav's backdrop-filter stacking context
document.body.appendChild(overlay);
var index = null;

/**
 * Opens the search dialog. `deferIndex` leaves the index download to the caller, for /search, where the
 * dialog opens while the page is still loading.
 */
function open(deferIndex) {
  lastFocused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  overlay.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
  input.focus();
  if (!index && deferIndex !== true) loadIndex();
}

function close() {
  overlay.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
  input.value = "";
  list.innerHTML = "";
  empty.hidden = true;
  hint.hidden = false;
  if (statusEl) statusEl.textContent = "";
  if (lastFocused && typeof lastFocused.focus === "function") {
    lastFocused.focus();
  } else {
    btn.focus();
  }
  lastFocused = null;
}

var indexRequest = null;

/**
 * Downloads the index once. SEARCH_INDEX_URL carries a content hash, so the browser can keep it for a year. A page
 * opened before a deploy names a hashed file the deploy removed; it then reads the unhashed PUBLIC_SEARCH_INDEX_URL.
 */
function loadIndex() {
  if (!indexRequest) {
    indexRequest = fetch(SEARCH_INDEX_URL)
      .then(function (response) {
        return response.ok ? response : fetch(PUBLIC_SEARCH_INDEX_URL);
      })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        index = expandSearchIndex(data);
        if (input.value.trim()) runSearch(input.value);
      })
      .catch(function (e) {
        // Let the next open or hover try again.
        indexRequest = null;
        console.error("[docs-search] loadIndex error:", e);
      });
  }
  return indexRequest;
}

/** Starts the download when a visitor is about to search, so results are ready when the dialog opens. */
function warmIndex() {
  if (!index) loadIndex();
}

/**
 * One element with its attributes and children. A string child becomes a text node, so no index value is ever
 * parsed as HTML; null and "" children are skipped.
 */
function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs).forEach(function (name) {
    node.setAttribute(name, attrs[name]);
  });
  (children || []).forEach(function (child) {
    if (child !== null && child !== undefined && child !== "")
      node.append(child);
  });
  return node;
}

function runSearch(query) {
  if (!index) return;
  var q = query.toLowerCase().trim();
  list.innerHTML = "";
  empty.hidden = true;
  hint.hidden = !!q;
  if (!q) {
    if (statusEl) statusEl.textContent = "";
    return;
  }

  var toks = tokens(q);
  var top = buildResults(index, q, toks, 13);

  if (!top.length) {
    empty.hidden = false;
    if (statusEl) statusEl.textContent = "No results found.";
    return;
  }

  var sitelinks =
    top[0] && top[0].sitelinks ? buildSitelinks(index, top[0]) : [];
  var total = top.length + sitelinks.length;

  if (statusEl) {
    statusEl.textContent =
      total + " " + (total === 1 ? "result" : "results") + " found.";
  }

  function resultLink(e) {
    var separator = el("span", {}, ["\u203a"]);
    separator.className = "separator";
    var label = e.heading
      ? [e.navLabel, " ", separator, " ", e.heading]
      : [e.navLabel];
    var snip = snippet(e.text, q, toks);
    var section = el("span", { "data-testid": "search-result-section" }, [
      e.section || "",
    ]);
    section.className = "section";
    var title = el("span", { "data-testid": "search-result-label" }, label);
    title.className = "label";
    var text = snip
      ? el("span", { "data-testid": "search-result-text" }, [snip])
      : null;
    if (text) text.className = "snippet";
    var link = el("a", { href: e.path, "data-testid": "search-result-link" }, [
      section,
      title,
      text,
    ]);
    link.className = "result-link";
    return link;
  }

  // Home result with its popular pages nested under it, in the same result.
  function homeGroup(e) {
    var items = sitelinks.map(function (s) {
      var link = el("a", { href: s.path, "data-testid": "search-sitelink" }, [
        s.navLabel,
      ]);
      link.className = "sitelink";
      return el("li", { role: "option" }, [link]);
    });
    var nested = items.length
      ? el("ul", { role: "presentation" }, items)
      : null;
    if (nested) nested.className = "sitelinks";
    return el(
      "li",
      {
        role: "group",
        "aria-label": "Bascik home and popular pages",
        "data-testid": "search-home-result",
      },
      [el("div", { role: "option" }, [resultLink(e)]), nested],
    );
  }

  top.forEach(function (e, i) {
    list.append(
      i === 0 && e.sitelinks
        ? homeGroup(e)
        : el("li", { role: "option" }, [resultLink(e)]),
    );
  });

  var links = Array.from(list.querySelectorAll("a[href]"));
  links.forEach(function (a) {
    var href = a.getAttribute("href");
    if (!href) return;

    a.addEventListener("mouseenter", function () {
      preload(href);
    });

    a.addEventListener("focus", function () {
      preload(href);
    });

    a.addEventListener(
      "touchstart",
      function () {
        preload(href);
      },
      { passive: true },
    );
  });
}

list.addEventListener("focusin", function (e) {
  var a = e.target && e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  var href = a.getAttribute("href");
  if (href) preload(href);
});

list.addEventListener(
  "touchstart",
  function (e) {
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (href) preload(href);
  },
  { passive: true },
);

btn.addEventListener("click", open);
btn.addEventListener("pointerenter", warmIndex);
btn.addEventListener("focus", warmIndex);
backdrop.addEventListener("click", close);
input.addEventListener("input", function () {
  runSearch(input.value);
});

document.addEventListener("keydown", function (e) {
  var isMod = e.metaKey || e.ctrlKey;
  if (isMod && e.key === "k") {
    e.preventDefault();
    overlay.hidden ? open() : close();
    return;
  }
  if (e.key === "Escape" && !overlay.hidden) {
    close();
    return;
  }
  if (!overlay.hidden && e.key === "Tab") {
    var focusables = Array.from(
      overlay.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(function (el) {
      return !el.hidden;
    });
    if (!focusables.length) {
      e.preventDefault();
      input.focus();
      return;
    }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
      return;
    }
  }
  if (!overlay.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    var links = Array.from(list.querySelectorAll("a[href]"));
    if (!links.length) return;
    var cur = document.activeElement;
    var idx = links.indexOf(cur);
    if (e.key === "ArrowDown")
      idx = cur === input || idx < 0 ? 0 : Math.min(idx + 1, links.length - 1);
    else idx = idx > 0 ? idx - 1 : 0;
    links[idx].focus();
  }
});

// Adjust keyboard shortcut label for non-Mac
var kbd = document.querySelector(".button-shortcut");
if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  kbd.textContent = "Ctrl+K";
}

// Auto-open on /search?q= (for SearchAction). The index is about 1 MB, so it waits until the page has loaded
// instead of competing with the page's own resources.
if (window.location.pathname === "/search") {
  var q = new URLSearchParams(window.location.search).get("q");
  if (q) {
    input.value = q;
    open(true);
    hint.hidden = true;
  } else open(true);
  if (document.readyState === "complete") setTimeout(loadIndex, 0);
  else
    window.addEventListener("load", function () {
      setTimeout(loadIndex, 0);
    });
}
