/**
 * sw-polyfill.js
 *
 * Must be loaded as a plain <script> BEFORE sw.bundle.js.
 *
 * sw.bundle.js was written for a Service Worker context.  When loaded in a
 * regular extension page (chrome-extension://) we need to:
 *   1. Override self.addEventListener so that 'install', 'activate', and 'fetch'
 *      registrations are captured rather than forwarded to window events.
 *   2. Provide the SW globals that sw.bundle.js reads at evaluation time:
 *        self.registration.scope   — used to derive the path prefix
 *        self.clients              — used for progress postMessage to the client
 *        self.skipWaiting          — called in the 'install' handler
 */
(function () {
  'use strict';

  // ── 1. Intercept self.addEventListener ──────────────────────────────────────
  // In a page context self === window.  Keep the original so we can restore it.
  var _origAdd = window.addEventListener.bind(window);
  window._origAdd = _origAdd;
  window.__swFetchHandler = null;

  window.addEventListener = function (type, handler, opts) {
    if (type === 'fetch') {
      // Capture the single fetch event handler registered by sw.bundle.js.
      window.__swFetchHandler = handler;
      return;
    }
    if (type === 'install' || type === 'activate') {
      // SW lifecycle events — ignore; they never fire in a page context.
      return;
    }
    return _origAdd(type, handler, opts);
  };

  // ── 2. Fake SW registration globals ────────────────────────────────────────
  //
  // sw.bundle.js reads `self.registration.scope` at module evaluation time to
  // compute the path prefix it should handle.  We use a fake https:// origin so
  // the SW's own chrome-extension:// early-return guard is never triggered.
  var FAKE_SCOPE = 'https://pw-trace-viewer-local/';

  if (!window.registration) {
    window.registration = {
      scope:       FAKE_SCOPE,
      skipWaiting: function () { return Promise.resolve(); }
    };
  }

  // self.clients — the SW calls clients.get(clientId) to obtain the page's
  // "client" so it can postMessage progress events back to it.
  window.clients = {
    get: function (/*id*/) {
      // Return a fake client whose postMessage forwards to the page window.
      return Promise.resolve({
        id:          'local-client',
        url:         FAKE_SCOPE,
        postMessage: function (msg) { window.postMessage(msg, '*'); }
      });
    },
    matchAll: function () { return Promise.resolve([]); },
    claim:    function () { return Promise.resolve(); }
  };

  window.skipWaiting = function () { return Promise.resolve(); };
})();
