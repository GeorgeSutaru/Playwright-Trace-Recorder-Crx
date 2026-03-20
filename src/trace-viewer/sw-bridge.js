/**
 * sw-bridge.js
 *
 * Must be loaded as a plain <script> AFTER sw.bundle.js but BEFORE the
 * <script type="module"> that loads the Playwright Trace Viewer app.
 *
 * Responsibilities:
 *   1. Restore window.addEventListener (we temporarily hijacked it in
 *      sw-polyfill.js to capture sw.bundle.js's 'fetch' handler).
 *   2. Fake navigator.serviceWorker so the viewer thinks the SW is already
 *      activated and never blocks on a real SW registration.
 *   3. Monkey-patch window.fetch to route SW-handled requests (contexts?,
 *      /sha1/, /snapshot/, /snapshotInfo/, /closest-screenshot/, /file/)
 *      through the captured sw.bundle.js fetch handler.
 *   4. Forward window.postMessage events (progress updates from the fake SW
 *      client) to any serviceWorker.message listeners the viewer registers.
 */
(function () {
  'use strict';

  // ── 1. Restore addEventListener ─────────────────────────────────────────────
  window.addEventListener = window._origAdd;
  delete window._origAdd;

  var swHandler   = window.__swFetchHandler;
  var origFetch   = window.fetch.bind(window);
  var FAKE_SCOPE  = 'https://pw-trace-viewer-local/';

  // ── 2. Fake navigator.serviceWorker ────────────────────────────────────────
  var _msgListeners = [];
  var _fakeController = { state: 'activated' };

  var fakeServiceWorker = {
    // controller is non-null  → viewer doesn't wait for controllerchange
    controller: _fakeController,

    register: function (/*url*/) {
      return Promise.resolve({ scope: FAKE_SCOPE });
    },

    addEventListener: function (type, handler) {
      if (type === 'message') _msgListeners.push(handler);
    },
    removeEventListener: function (type, handler) {
      if (type === 'message')
        _msgListeners = _msgListeners.filter(function (h) { return h !== handler; });
    },
    // Also support direct property assignment  onmessage / oncontrollerchange
    onmessage:         null,
    oncontrollerchange: null
  };

  try {
    Object.defineProperty(navigator, 'serviceWorker', {
      value:        fakeServiceWorker,
      configurable: true,
      writable:     true
    });
  } catch (e) {
    // If defineProperty fails (some environments protect it), try direct assign
    navigator.serviceWorker = fakeServiceWorker;
  }

  // ── 3. Forward SW progress messages to serviceWorker.message listeners ─────
  window.addEventListener('message', function (e) {
    if (!e.data || e.source !== window) return;
    var msg = e.data;
    if (msg.method === 'progress' || msg.method === 'load') {
      var ev = new MessageEvent('message', { data: msg });
      _msgListeners.forEach(function (h) { try { h(ev); } catch (_) {} });
      if (typeof fakeServiceWorker.onmessage === 'function')
        try { fakeServiceWorker.onmessage(ev); } catch (_) {}
    }
  });

  // ── 4. Intercept fetch for SW-handled paths ─────────────────────────────────
  //
  // The viewer calls:
  //   fetch("contexts?trace=<blobUrl>")       → parsed into context entries
  //   fetch("/sha1/<hash>")                   → resource bytes
  //   fetch("/snapshot/<id>?...")             → rendered DOM snapshot
  //   fetch("/snapshotInfo/<id>?...")         → snapshot metadata
  //   fetch("/closest-screenshot/<id>?...")   → closest screenshot
  //   fetch("/file/?path=...")                → source file
  //   fetch("/ping")                          → health check
  //
  // We turn those relative URLs into https://pw-trace-viewer-local/<path>
  // so the SW's chrome-extension:// early-return guard is not triggered,
  // then hand them to the captured handler with a fake FetchEvent.

  var SW_PREFIXES = [
    '/contexts', '/sha1/', '/snapshot/', '/snapshotInfo/',
    '/closest-screenshot/', '/file/', '/ping', '/restartServiceWorker'
  ];

  function isSwPath(url) {
    var rel;
    try {
      // If it's already absolute (http/https/chrome-extension), extract pathname
      if (/^https?:/.test(url)) {
        var u = new URL(url);
        // Only intercept requests that target our fake scope
        if (!u.href.startsWith(FAKE_SCOPE)) return false;
        rel = u.pathname + u.search;
      } else if (/^chrome-extension:/.test(url)) {
        return false; // Let extension asset fetches through
      } else {
        rel = url; // relative path
      }
    } catch (_) {
      return false;
    }
    // contexts? is query-string-only (no leading slash in the viewer call)
    if (/^contexts\?/.test(rel)) return true;
    return SW_PREFIXES.some(function (p) { return rel.startsWith(p); });
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input
            : (input instanceof Request) ? input.url
            : String(input);

    if (!swHandler || !isSwPath(url)) {
      return origFetch(input, init);
    }

    // Build an absolute fake-https URL targeting the SW's scope
    var absUrl;
    if (/^https?:/.test(url)) {
      absUrl = url; // already absolute fake-https
    } else {
      var sep = url.startsWith('/') ? '' : '/';
      absUrl = FAKE_SCOPE.replace(/\/$/, '') + sep + url;
    }

    return new Promise(function (resolve, reject) {
      var request = new Request(absUrl, {
        method:  (init && init.method)  || 'GET',
        headers: (init && init.headers) || {}
      });

      var fakeEvent = {
        request:     request,
        clientId:    'local-client',
        respondWith: function (responseOrPromise) {
          Promise.resolve(responseOrPromise).then(resolve, reject);
        },
        waitUntil: function () {}
      };

      try {
        swHandler(fakeEvent);
      } catch (err) {
        reject(err);
      }
    });
  };
})();
