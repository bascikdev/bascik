var btn = document.querySelector('.dnav-search-btn');
var overlay = document.querySelector('.search-overlay');
var backdrop = document.querySelector('.search-backdrop');
var input = document.querySelector('.search-input');
var list = document.querySelector('.search-results');
var empty = document.querySelector('.search-empty');
var hint = document.querySelector('.search-hint');
var statusEl = document.getElementById('docs-search-status');
var lastFocused = null;
var preloaded = new Set();

function preload(href) {
  if (!href || preloaded.has(href) || href.startsWith('#') || href.startsWith('http')) return;
  preloaded.add(href);
  var link = document.createElement('link');
  link.rel = 'prefetch';
  link.setAttribute('href', href);
  document.head.appendChild(link);
}

// Portal to <body> so position:fixed escapes the nav's backdrop-filter stacking context
document.body.appendChild(overlay);
var index = null;

function open() {
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  input.focus();
  if (!index) loadIndex();
}

function close() {
  overlay.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  input.value = '';
  list.innerHTML = '';
  empty.hidden = true;
  hint.hidden = false;
  if (statusEl) statusEl.textContent = '';
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
  } else {
    btn.focus();
  }
  lastFocused = null;
}

async function loadIndex() {
  try {
    index = await (await fetch('/assets/search-index.json')).json();
    if (input.value.trim()) runSearch(input.value);
  } catch (e) {
    console.error('[docs-search] loadIndex error:', e);
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function runSearch(query) {
  if (!index) return;
  var q = query.toLowerCase().trim();
  list.innerHTML = '';
  empty.hidden = true;
  hint.hidden = !!q;
  if (!q) {
    if (statusEl) statusEl.textContent = '';
    return;
  }

  var toks = tokens(q);
  var top = buildResults(index, q, toks, 13);

  if (!top.length) {
    empty.hidden = false;
    if (statusEl) statusEl.textContent = 'No results found.';
    return;
  }

  if (statusEl) {
    statusEl.textContent = top.length + ' ' + (top.length === 1 ? 'result' : 'results') + ' found.';
  }

  list.innerHTML = top.map(function (e) {
    var label = e.heading
      ? esc(e.navLabel) + ' <span class="sr-sep">\u203a</span> ' + esc(e.heading)
      : esc(e.navLabel);
    var snip = snippet(e.text, q, toks);
    var snipHtml = snip ? '<span class="sr-text">' + esc(snip) + '</span>' : '';
    return '<li role="option"><a href="' + esc(e.path) + '" class="sr-link">'
      + '<span class="sr-section">' + esc(e.section || '') + '</span>'
      + '<span class="sr-label">' + label + '</span>'
      + snipHtml + '</a></li>';
  }).join('');

  var links = Array.from(list.querySelectorAll('a[href]'));
  links.forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href) return;

    a.addEventListener('mouseenter', function () {
      preload(href);
    });

    a.addEventListener('focus', function () {
      preload(href);
    });

    a.addEventListener('touchstart', function () {
      preload(href);
    }, { passive: true });
  });
}

list.addEventListener('focusin', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href');
  if (href) preload(href);
});

list.addEventListener('touchstart', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href');
  if (href) preload(href);
}, { passive: true });

btn.addEventListener('click', open);
backdrop.addEventListener('click', close);
input.addEventListener('input', function () { runSearch(input.value); });

document.addEventListener('keydown', function (e) {
  var isMod = e.metaKey || e.ctrlKey;
  if (isMod && e.key === 'k') { e.preventDefault(); overlay.hidden ? open() : close(); return; }
  if (e.key === 'Escape' && !overlay.hidden) { close(); return; }
  if (!overlay.hidden && e.key === 'Tab') {
    var focusables = Array.from(overlay.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return !el.hidden; });
    if (!focusables.length) { e.preventDefault(); input.focus(); return; }
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
  if (!overlay.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    var links = Array.from(list.querySelectorAll('a[href]'));
    if (!links.length) return;
    var cur = document.activeElement;
    var idx = links.indexOf(cur);
    if (e.key === 'ArrowDown') idx = (cur === input || idx < 0) ? 0 : Math.min(idx + 1, links.length - 1);
    else idx = idx > 0 ? idx - 1 : 0;
    links[idx].focus();
  }
});

// Adjust keyboard shortcut label for non-Mac
var kbd = document.querySelector('.search-btn-kbd');
if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  kbd.textContent = 'Ctrl+K';
}

// Auto-open on /search?q= (for SearchAction)
if (window.location.pathname === '/search') {
  var q = new URLSearchParams(window.location.search).get('q');
  if (q) { input.value = q; open(); hint.hidden = true; }
  else open();
}
