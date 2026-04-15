/**
 * Browser-compatible Playwright trace generator for Chrome extension service workers.
 * Ports traceGenerator.js from Node.js to browser APIs:
 *  - crypto.subtle.digest('SHA-1') instead of Node crypto module
 *  - self.JSZip (loaded via importScripts) instead of require('jszip')
 *  - crypto.randomUUID() instead of uuid package
 *  - Returns Uint8Array instead of writing to disk
 */

async function sha1Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64ToUint8Array(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generates a Playwright-compatible trace zip in the browser (service worker).
 * @param {Object} tracePayload - Payload from the extension recording
 * @returns {Promise<{zipData: Uint8Array, id: string, name: string, url: string, timestamp: number, eventCount: number, size: number}>}
 */
async function generatePlaywrightTraceInBrowser(tracePayload) {
  const id = crypto.randomUUID();
  const zip = new self.JSZip();

  const traceTraceLines = [];
  const traceNetworkLines = [];

  const addedResources = new Set();
  const resourcesFolder = zip.folder('resources');

  const nowWall = Date.now();
  const baseTime = tracePayload.events.length > 0
    ? (tracePayload.events[0].timestamp || tracePayload.events[0].time || tracePayload.events[0].startTime || nowWall)
    : nowWall;
  const startTime = baseTime;

  const relTime = (absTime) => Math.max(0, absTime - baseTime);

  // 1. context-options event
  traceTraceLines.push(JSON.stringify({
    version: 6,
    type: 'context-options',
    origin: 'library',
    browserName: 'chromium',
    channel: '',
    options: {
      viewport: tracePayload.viewport || { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true
    },
    platform: navigator.platform || 'unknown',
    wallTime: startTime,
    monotonicTime: 0,
    sdkLanguage: 'javascript',
    testIdAttributeName: 'data-testid',
    internal: {}
  }));

  // 2. Base IDs
  const pageId = 'page@' + id.substring(0, 8);
  const mainFrameId = 'frame@' + id.substring(0, 8);

  // 3. metadata.json
  const metadata = {
    version: 6,
    startTime: 0,
    endTime: relTime(nowWall),
    wallTime: startTime,
    browserName: 'chromium',
    options: {
      viewport: tracePayload.viewport || { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      isMobile: false,
    },
    pages: [{
      pageId,
      url: tracePayload.url || '',
      title: tracePayload.name || 'Ventriloquist Trace'
    }]
  };
  zip.file('metadata.json', JSON.stringify(metadata, null, 2));

  // 4. event: pageCreated
  traceTraceLines.push(JSON.stringify({
    type: 'event',
    time: relTime(startTime),
    class: 'BrowserContext',
    method: 'newPage',
    params: { page: { guid: pageId } },
    pageId: pageId,
    internal: {}
  }));

  // 5. event: navigated
  if (tracePayload.url) {
    traceTraceLines.push(JSON.stringify({
      type: 'event',
      time: relTime(startTime),
      class: 'Frame',
      method: 'navigated',
      params: { url: tracePayload.url, name: '' },
      pageId: pageId,
      internal: {}
    }));
  }

  // Pre-process network events into requests map
  const networkRequests = new Map();
  for (const event of tracePayload.events) {
    if (event.type === 'cdp-network') {
      const reqId = event.params?.requestId;
      if (!reqId) continue;
      if (!networkRequests.has(reqId)) {
        networkRequests.set(reqId, {
          url: '', method: '', requestHeaders: [],
          status: 0, statusText: '', responseHeaders: [], mimeType: '',
          timestamp: event.timestamp
        });
      }
      const req = networkRequests.get(reqId);
      if (event.method === 'Network.requestWillBeSent') {
        req.url = event.params.request?.url || '';
        req.method = event.params.request?.method || 'GET';
        req.requestHeaders = Object.entries(event.params.request?.headers || {}).map(([n, v]) => ({ name: n, value: String(v) }));
        req.postData = event.params.request?.postData;
      } else if (event.method === 'Network.responseReceived') {
        req.status = event.params.response?.status || 0;
        req.statusText = event.params.response?.statusText || '';
        req.responseHeaders = Object.entries(event.params.response?.headers || {}).map(([n, v]) => ({ name: n, value: String(v) }));
        req.mimeType = event.params.response?.mimeType || '';
      }
    } else if (event.type === 'cdp-network-body') {
      const req = networkRequests.get(event.requestId);
      if (req && event.body) {
        req.body = event.body;
        req.base64Encoded = event.base64Encoded;
      }
    }
  }

  // Helper function to get file extension from MIME type (matches Ventriloquist implementation)
  function getResourceExtensionFromMime(mime) {
    if (!mime) return '';
    if (mime.includes('image/jpeg')) return '.jpeg';
    if (mime.includes('image/png')) return '.png';
    if (mime.includes('image/webp')) return '.webp';
    if (mime.includes('image/gif')) return '.gif';
    if (mime.includes('image/svg+xml')) return '.svg';
    if (mime.includes('video/mp4')) return '.mp4';
    if (mime.includes('audio/mpeg')) return '.mp3';
    if (mime.includes('font/woff2')) return '.woff2';
    if (mime.includes('font/woff')) return '.woff';
    if (mime.includes('font/ttf')) return '.ttf';
    if (mime.includes('css')) return '.css';
    if (mime.includes('javascript')) return '.js';
    if (mime.includes('json')) return '.json';
    if (mime.includes('html')) return '.html';
    return '';
  }

  // Generate resource-snapshot entries for trace.network
  for (const [, req] of networkRequests.entries()) {
    if (!req.url || !req.url.startsWith('http')) continue;

    let responseSha1 = undefined;
    if (req.body) {
      const bodyBuf = req.base64Encoded
        ? base64ToUint8Array(req.body)
        : new TextEncoder().encode(req.body);
      const pureSha1 = await sha1Hex(bodyBuf);
      
      // Get file extension from MIME type (matches Ventriloquist pattern)
      const ext = getResourceExtensionFromMime(req.mimeType);
      responseSha1 = pureSha1 + ext;
      
      if (!addedResources.has(responseSha1)) {
        addedResources.add(responseSha1);
        // Add extension to resource filename
        resourcesFolder.file(responseSha1, bodyBuf);
      }
    }

    traceNetworkLines.push(JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        pageref: pageId,
        startedDateTime: new Date(req.timestamp || startTime).toISOString(),
        time: relTime(req.timestamp || startTime),
        request: {
          url: req.url,
          method: req.method,
          headers: req.requestHeaders,
          postData: req.postData || undefined
        },
        response: {
          status: req.status,
          statusText: req.statusText,
          headers: req.responseHeaders,
          content: {
            mimeType: req.mimeType,
            size: req.body ? req.body.length : 0,
            _sha1: responseSha1
          }
        }
      },
      pageId: pageId
    }));
  }

  // Process resources first to get true SHA1 hashes
  const resourceSha1Map = new Map();
  const resourceBase64Map = new Map();

  if (tracePayload.resources && Array.isArray(tracePayload.resources)) {
    for (const res of tracePayload.resources) {
      // Skip JavaScript files - they are not needed in trace resources
      if (res.sha1 && res.data && !addedResources.has(res.sha1)) {
        // Check if this is a JavaScript resource by looking at the sha1 filename
        if (res.sha1.includes('.js') || res.sha1.startsWith('script-')) continue;
        
        let base64Data = res.data;
        if (base64Data.startsWith('data:')) {
          base64Data = base64Data.split(',')[1];
        }

        const bodyBuf = base64ToUint8Array(base64Data);
        const trueSha1 = await sha1Hex(bodyBuf);
        resourceSha1Map.set(res.sha1, trueSha1);
        resourceBase64Map.set(trueSha1, base64Data);

        if (!addedResources.has(trueSha1)) {
          addedResources.add(trueSha1);
          // Extract just the filename to avoid nested directories
          const fileName = trueSha1.split('/').pop() || trueSha1;
          console.log('[TraceGen] Storing resource from tracePayload.resources:', res.sha1, '->', fileName);
          resourcesFolder.file(fileName, bodyBuf);
        } else {
          console.log('[TraceGen] Resource already stored (tracePayload.resources):', res.sha1);
        }
      }
    }
  }

  /**
   * Emit a frame-snapshot trace event (Playwright trace format).
   * domSnap.html MUST be a NodeSnapshot tree (Array).
   */
  async function emitFrameSnapshot(snapshotName, domSnap, callId, snapTime) {
    if (!domSnap) return false;
    if (typeof domSnap.html === 'string') return false;
    if (!Array.isArray(domSnap.html)) return false;

    // Initialize resourceOverrides first (will be populated below)
    const resourceOverrides = [];

    // Build stylesheet resource map for href replacement
    const stylesheetResourceMap = new Map();
    
    // Process resourceOverrides from inline <style> elements
    if (Array.isArray(domSnap.resourceOverrides)) {
      for (const override of domSnap.resourceOverrides) {
        if (override.url && typeof override.content === 'string') {
          // Store sha1 reference for trace viewer to fetch CSS dynamically
          const buf = new TextEncoder().encode(override.content);
          const sha1 = await sha1Hex(buf);
          
          // Store CSS file with true SHA1 hash
          const cssPath = sha1 + '.css';
          if (!addedResources.has(sha1)) {
            addedResources.add(sha1);
            resourcesFolder.file(cssPath, buf);
          }
          
          resourceOverrides.push({ url: override.url, sha1: sha1 + ".css" });
          stylesheetResourceMap.set(override.url, 'resources/' + cssPath);
        } else if (override.url && typeof override.content === 'number') {
          resourceOverrides.push({ url: override.url, ref: override.content });
        }
      }
    }

    // Also process stylesheetResources from the extension
    if (Array.isArray(domSnap.stylesheetResources)) {
      for (const sheet of domSnap.stylesheetResources) {
        if (sheet.href && sheet.cssContent) {
          const buf = new TextEncoder().encode(sheet.cssContent);
          const sha1 = await sha1Hex(buf);
          
          // Store CSS file with true SHA1 hash
          const cssPath = sha1 + '.css';
          if (!addedResources.has(sha1)) {
            addedResources.add(sha1);
            resourcesFolder.file(cssPath, buf);
          }
          
          resourceOverrides.push({ url: sheet.href, sha1: sha1 + ".css" });
          stylesheetResourceMap.set(sheet.href, 'resources/' + cssPath);
        }
      }
    }

    // Clone and update HTML tree - only replace JS links to prevent execution
    function updateHtmlTree(node) {
      if (!Array.isArray(node) || node.length < 2) return node;
      
      const [tag, attrs, ...children] = node;
      
      // Only replace JavaScript-related links (modulepreload, script preload, etc.)
      if (tag === 'LINK' && attrs) {
        const rel = attrs.rel || '';
        const as = attrs.as || '';
        
        // Replace modulepreload and script preload links to prevent JS execution
        if (rel.includes('modulepreload') || (rel.includes('preload') && as === 'script')) {
          const href = attrs.href;
          if (href) {
            // Store original href and remove rel to prevent JS loading
            attrs['data-js-href'] = href;
            if (rel.includes('modulepreload')) {
              attrs.rel = rel.replace('modulepreload', '').trim();
            }
            if (rel.includes('preload') && as === 'script') {
              attrs.rel = rel.replace('preload', '').trim();
            }
          }
        }
      } else if (tag === 'STYLE' && attrs) {
        // Remove data-href from inline styles - trace viewer will fetch the CSS
        if (attrs['data-href']) {
          delete attrs['data-href'];
        }
      } else if (tag === 'SCRIPT' && attrs) {
        // Remove src attribute to prevent JS loading
        if (attrs.src) {
          attrs['data-src'] = attrs.src;
          delete attrs.src;
        }
      }
      
      // Recursively update children
      const updatedChildren = children.map(child => {
        if (Array.isArray(child)) return updateHtmlTree(child);
        return child;
      });
      
      return [tag, attrs, ...updatedChildren];
    }

    const updatedHtml = updateHtmlTree(domSnap.html || ['HTML', {}, ['HEAD'], ['BODY']]);

    const snapshotObj = {
      callId,
      snapshotName,
      pageId,
      frameId: mainFrameId,
      frameUrl: domSnap.url || tracePayload.url || '',
      doctype: domSnap.doctype || 'html',
      html: updatedHtml,
      viewport: domSnap.viewport || tracePayload.viewport || { width: 1280, height: 720 },
      timestamp: snapTime,
      wallTime: snapTime,
      collectionTime: 0,
      resourceOverrides,
      isMainFrame: true
    };

    traceTraceLines.push(JSON.stringify({
      type: 'frame-snapshot',
      snapshot: snapshotObj
    }));

    return true;
  }

  // Process user action events (before/after pairs)
  const beforeEventMap = new Map();
  let actionIndex = 0;

  for (const event of tracePayload.events) {
    if (!event.type) continue;
    if (event.type === 'cdp-network' || event.type === 'cdp-network-body') continue;

    const eventTime = event.timestamp || event.time || event.startTime || nowWall;

    if (event.type === 'before') {
      actionIndex++;
      const actionId = event.callId || `action-${actionIndex}`;
      beforeEventMap.set(actionId, event);

      const domBefore = event.domSnapshots?.before || null;
      const domAction = event.domSnapshots?.action || null;
      const beforeSnapshotName = `before@${actionId}`;
      const inputSnapshotName = `action@${actionId}`;

      if (domBefore && Array.isArray(domBefore.html)) {
        await emitFrameSnapshot(beforeSnapshotName, domBefore, actionId, relTime(eventTime));
      }

      traceTraceLines.push(JSON.stringify({
        type: 'before',
        callId: actionId,
        startTime: relTime(eventTime),
        apiName: `${event.class || 'Page'}.${event.method || 'click'}`,
        class: event.class || 'Page',
        method: event.method || 'click',
        params: event.params || {},
        pageId: pageId,
        wallTime: eventTime,
        beforeSnapshot: beforeSnapshotName,
        internal: {}
      }));

      if (domAction && Array.isArray(domAction.html)) {
        await emitFrameSnapshot(inputSnapshotName, domAction, actionId, relTime(eventTime));
      }
      traceTraceLines.push(JSON.stringify({
        type: 'input',
        callId: actionId,
        inputSnapshot: inputSnapshotName
      }));

    } else if (event.type === 'after') {
      const actionId = event.callId || `action-${actionIndex}`;
      const beforeEvent = beforeEventMap.get(actionId);
      const snapTime = relTime(event.endTime || eventTime);

      const domAfter = event.domAfterSnapshot || null;
      const afterSnapshotName = (domAfter && Array.isArray(domAfter.html))
        ? `after@${actionId}` : undefined;
      if (afterSnapshotName) {
        await emitFrameSnapshot(afterSnapshotName, domAfter, actionId, snapTime);
      }

      const hasDomSnapshots = (
        (beforeEvent?.domSnapshots?.before && Array.isArray(beforeEvent.domSnapshots.before.html)) ||
        (beforeEvent?.domSnapshots?.action && Array.isArray(beforeEvent.domSnapshots.action.html)) ||
        (domAfter && Array.isArray(domAfter.html))
      );

      const afterEvent = {
        type: 'after',
        callId: actionId,
        endTime: snapTime,
        wallTime: event.endTime || eventTime,
        afterSnapshot: afterSnapshotName,
        internal: {}
      };

      const attachments = [];
      if (event.attachments && Array.isArray(event.attachments)) {
        for (const att of event.attachments) {
          if (att.sha1) {
            const trueSha1 = resourceSha1Map.get(att.sha1) || att.sha1;

            traceTraceLines.push(JSON.stringify({
              type: 'screencast-frame',
              pageId: pageId,
              sha1: trueSha1,
              width: tracePayload.viewport?.width || 1280,
              height: tracePayload.viewport?.height || 720,
              timestamp: snapTime,
              frameSwapWallTime: event.endTime || eventTime
            }));

            if (!hasDomSnapshots) {
              const b64 = resourceBase64Map.get(trueSha1);
              if (b64) {
                const fallbackSnap = {
                  doctype: 'html',
                  html: ['HTML', {},
                    ['HEAD', {}],
                    ['BODY', { style: 'margin:0;overflow:hidden;background:#0f0f0f;display:flex;align-items:center;justify-content:center;height:100vh;' },
                      ['IMG', { src: `data:image/jpeg;base64,${b64}`, style: 'max-width:100%;max-height:100%;object-fit:contain;' }]
                    ]
                  ],
                  url: tracePayload.url || '',
                  viewport: tracePayload.viewport || { width: 1280, height: 720 }
                };
                const fbBefore = `before@${actionId}`;
                const fbAction = `action@${actionId}`;
                const fbAfter = `after@${actionId}`;
                await emitFrameSnapshot(fbBefore, fallbackSnap, actionId, snapTime);
                await emitFrameSnapshot(fbAction, fallbackSnap, actionId, snapTime);
                await emitFrameSnapshot(fbAfter, fallbackSnap, actionId, snapTime);
                afterEvent.afterSnapshot = fbAfter;
              }
            }

            attachments.push({
              name: att.name || 'screenshot',
              contentType: att.contentType || 'image/jpeg',
              sha1: trueSha1
            });
          }
        }
      }

      if (attachments.length > 0) {
        afterEvent.attachments = attachments;
      }

      traceTraceLines.push(JSON.stringify(afterEvent));

    } else if (event.type === 'console') {
      traceTraceLines.push(JSON.stringify({
        type: 'event',
        time: relTime(eventTime),
        class: 'Page',
        method: 'console',
        params: {
          type: event.messageType || 'log',
          text: event.text || '',
          location: event.location || { url: '', lineNumber: 0, columnNumber: 0 }
        },
        pageId: pageId,
        internal: {}
      }));
    }
  }

  zip.file('trace.trace', traceTraceLines.join('\n') + '\n');
  zip.file('trace.network', traceNetworkLines.join('\n') + '\n');

  const zipData = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  return {
    id,
    zipData,
    name: tracePayload.name,
    url: tracePayload.url,
    timestamp: nowWall,
    eventCount: tracePayload.events.length,
    size: zipData.length
  };
}

export { generatePlaywrightTraceInBrowser };
