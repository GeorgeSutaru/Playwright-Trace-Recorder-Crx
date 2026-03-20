/**
 * trace-viewer-init.js
 *
 * Loaded by the patched trace viewer index.html to provide:
 *   1. Back-button navigation (returns to the trace list side panel)
 *   2. Auto-loading a trace from chrome.storage when ?traceId=<id> is present
 *
 * This is injected as an external script (not inline) to satisfy MV3 CSP.
 */
(function () {
  'use strict';

  // ── Back navigation ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('pw-back-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        window.location.href = chrome.runtime.getURL('panel.html');
      });
    }
  });

  // ── Auto-load trace from storage ───────────────────────────────────────────
  // When the side panel navigates to
  //   chrome-extension://<id>/src/trace-viewer/index.html?traceId=<traceId>
  // this script fetches the trace ZIP from the service worker, converts it to a
  // Blob, then sends it to the Playwright Trace Viewer via its postMessage API
  // once the viewer module has registered its 'message' listener.
  var params  = new URLSearchParams(location.search);
  var traceId = params.get('traceId');

  if (traceId) {
    window.addEventListener('load', function () {
      chrome.runtime.sendMessage(
        { type: 'GET_TRACE_ZIP', id: traceId },
        function (result) {
          if (!result || !result.zipBase64) return;

          var raw = atob(result.zipBase64);
          var arr = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          var blob = new Blob([arr], { type: 'application/zip' });

          // Give the viewer module a tick to finish mounting its 'message'
          // event listener before we send the trace blob.
          setTimeout(function () {
            window.postMessage({ method: 'load', params: { trace: blob } }, '*');
          }, 50);
        }
      );
    });
  }
})();
