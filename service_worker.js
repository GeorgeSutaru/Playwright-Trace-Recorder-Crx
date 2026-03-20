import './jszip.min.js';
import { generatePlaywrightTraceInBrowser } from './traceGeneratorExtension.js';

// Open the side panel automatically whenever the toolbar icon is clicked,
// mirroring the playwright-crx pattern.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let activeRecording = null;

// ── Port registry ─────────────────────────────────────────────────────────────
const panelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ventriloquist-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.postMessage({
    type: 'RECORDING_STATUS',
    recording: !!activeRecording,
    currentRecording: activeRecording ? { name: activeRecording.name } : null
  });
});

function broadcastToPanel(message) {
  for (const p of panelPorts) {
    try { p.postMessage(message); } catch (_) { panelPorts.delete(p); }
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Ventriloquist Standalone installed/updated');
});

console.log('Ventriloquist Standalone Service Worker running');

// Helper function to downscale screenshots to fit within max dimensions (Playwright style)
function inscribe(object, area) {
  const scale = Math.max(object.width / area.width, object.height / area.height);
  return {
    width: object.width / scale | 0,
    height: object.height / scale | 0
  };
}

// Function to start recording
async function startRecording(name, tabId) {
  if (activeRecording) {
    throw new Error('Already recording');
  }

  activeRecording = {
    name,
    events: [],
    startTime: Date.now(),
    debuggeeTabId: tabId || null,
    resources: [],
    lastDomSnapshot: null,
    url: null,
    viewport: null
  };
  console.log(`Recording started: ${name} (tabId=${tabId})`);

  if (tabId) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      console.log(`Debugger attached to tab ${tabId}`);
    } catch (e) {
      console.warn('Could not attach debugger:', e.message);
      activeRecording.debuggeeTabId = null;
    }
    // Enable CDP domains independently — a failed domain should not kill the session
    if (activeRecording.debuggeeTabId) {
      for (const domain of ['Network', 'Page', 'Runtime', 'Log']) {
        try {
          await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
        } catch (e) {
          console.warn(`Failed to enable ${domain} domain:`, e.message);
        }
      }
    }
  }

  if (activeRecording.debuggeeTabId) {
    const initialSnapshot = await captureDomSnapshot(activeRecording.debuggeeTabId);
    if (initialSnapshot) {
      activeRecording.lastDomSnapshot = initialSnapshot;
      activeRecording.url = initialSnapshot.url || null;
      activeRecording.viewport = initialSnapshot.viewport || null;
    }
  }

  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' });
    } catch (_) {
      // Content script unresponsive — stale context after extension reload.
      // Reset the injection guard so the re-injected script takes the full init
      // path (adds onMessage listener + calls GET_RECORDING_STATUS → gets
      // recording:true → starts capturing interactions).
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => { window._ventriloquistInjected = false; }
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });
      } catch (e) {
        console.warn('Could not re-inject content script:', e.message);
      }
    }
  }

  broadcastToPanel({
    type: 'RECORDING_STARTED',
    recording: true,
    currentRecording: { name }
  });
}

// Function to stop recording
async function stopRecording() {
  if (!activeRecording) {
    throw new Error('Not recording');
  }

  console.log(`Recording stopped: ${activeRecording.name}`);
  const recording = activeRecording;
  activeRecording = null;

  if (recording.debuggeeTabId) {
    try {
      await chrome.tabs.sendMessage(recording.debuggeeTabId, { type: 'RECORDING_STOPPED' });
    } catch (_) { /* tab may have navigated away */ }
  }

  if (recording.debuggeeTabId) {
    try {
      await chrome.debugger.detach({ tabId: recording.debuggeeTabId });
      console.log(`Debugger detached from tab ${recording.debuggeeTabId}`);
    } catch (e) {
      console.warn('Could not detach debugger:', e.message);
    }
  }

  broadcastToPanel({ type: 'RECORDING_STOPPED', recording: false });

  try {
    await saveTraceLocally(recording);
    broadcastToPanel({ type: 'TRACE_SAVED', name: recording.name });
  } catch (error) {
    console.error('Error saving recording:', error);
    broadcastToPanel({ type: 'TRACE_ERROR', error: error.message });
    throw error;
  }
}

// Function to handle recorded events
function handleRecordEvent(event) {
  if (!activeRecording) {
    console.warn('Received event while not recording');
    return;
  }
  activeRecording.events.push(event);
}

// Handle messages from content scripts and panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.name, message.tabId).then(() => {
        sendResponse({ success: true, recording: true });
      }).catch(err => {
        console.error('Error starting recording:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'STOP_RECORDING':
      stopRecording().then(() => {
        sendResponse({ success: true, recording: false });
      }).catch(err => {
        console.error('Error stopping recording:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'GET_RECORDING_STATUS':
      sendResponse({
        recording: !!activeRecording,
        currentRecording: activeRecording ? { name: activeRecording.name } : null
      });
      return true;

    case 'RECORD_EVENT':
      handleRecordEventEnhanced(message.event);
      broadcastToPanel({
        type: 'EVENT_CAPTURED',
        eventType: message.event && message.event.type,
        selector: message.event && message.event.selector
      });
      break;

    case 'GET_LOCAL_TRACES':
      chrome.storage.local.get('local_traces').then(({ local_traces = [] }) => {
        sendResponse({ traces: local_traces });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;

    case 'GET_TRACE_ZIP': {
      const key = `trace_zip_${message.id}`;
      chrome.storage.local.get(key).then((result) => {
        sendResponse({ zipBase64: result[key] || null });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'DELETE_TRACE':
      chrome.storage.local.get('local_traces').then(async ({ local_traces = [] }) => {
        const updated = local_traces.filter(t => t.id !== message.id);
        await chrome.storage.local.remove(`trace_zip_${message.id}`);
        await chrome.storage.local.set({ local_traces: updated });
        sendResponse({ success: true });
        broadcastToPanel({ type: 'TRACES_UPDATED', traces: updated });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;

    case 'GET_ACTIVE_TAB':
      // Called by side-panel pages that lack chrome.devtools context.
      // lastFocusedWindow is more reliable than currentWindow from a SW.
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
        sendResponse({ tabId: tab ? tab.id : null });
      }).catch(() => sendResponse({ tabId: null }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// ── Helper: base64 encode a Uint8Array ───────────────────────────────────────
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Save trace to chrome.storage.local
async function saveTraceLocally(trace) {
  console.log('Generating trace ZIP in extension…');
  const traceInfo = await generatePlaywrightTraceInBrowser(trace);

  const zipBase64 = uint8ArrayToBase64(traceInfo.zipData);

  const { local_traces = [] } = await chrome.storage.local.get('local_traces');
  local_traces.unshift({
    id: traceInfo.id,
    name: traceInfo.name,
    url: traceInfo.url,
    timestamp: traceInfo.timestamp,
    eventCount: traceInfo.eventCount,
    size: traceInfo.size
  });

  // Keep at most 50 traces to avoid unbounded storage growth
  if (local_traces.length > 50) local_traces.splice(50);

  await chrome.storage.local.set({
    local_traces,
    [`trace_zip_${traceInfo.id}`]: zipBase64
  });

  console.log(`Trace "${trace.name}" saved locally (${traceInfo.size} bytes)`);

  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: 'Playwright Trace Recorder',
    message: `Trace "${trace.name}" saved. Click Download to get the file.`
  }).catch(() => {});

  return traceInfo;
}

async function captureDomSnapshot(tabId) {
  const EVAL_EXPR = `(function(){
    try{
      function sheetText(sh){
        try{var rl=sh.cssRules,out=[];for(var i=0;i<rl.length;i++)out.push(rl[i].cssText);return out.join('\\n');}catch(e){return null;}
      }
      function s(n,d){
        if(!n||d>80)return null;
        if(n.nodeType===3){
          var t=n.textContent;
          return t.length>5000?t.slice(0,5000)+'\u2026':t;
        }
        if(n.nodeType!==1)return null;
        if(n.tagName==='SCRIPT')return null;
        if(n.tagName==='NOSCRIPT')return null;
        if(n.tagName==='STYLE'){
          var css=n.sheet?sheetText(n.sheet):null;
          if(css===null)css=n.textContent||'';
          return ['STYLE',{},css];
        }
        if(n.tagName==='LINK'){
          var rel=(n.getAttribute&&n.getAttribute('rel')||'').toLowerCase().trim();
          if(rel==='stylesheet'&&n.sheet){
            var css=sheetText(n.sheet);
            if(css!==null)return ['STYLE',{'data-href':n.href||''},css];
          }
        }
        var a={},i,ch=[];
        for(i=0;i<n.attributes.length;i++){
          a[n.attributes[i].name]=n.attributes[i].value;
        }
        for(i=0;i<n.childNodes.length;i++){
          var c=s(n.childNodes[i],d+1);
          if(c!==null)ch.push(c);
        }
        var base=[n.tagName,a];
        return ch.length?base.concat(ch):base;
      }
      var dt=document.doctype;
      var tree=s(document.documentElement,0);
      if(!Array.isArray(tree))return null;
      var adopted=document.adoptedStyleSheets||[];
      for(var ai=0;ai<adopted.length;ai++){
        var css=sheetText(adopted[ai]);
        if(css)tree.push(['template',{'__playwright_style_sheet_':css}]);
      }
      return JSON.stringify({
        doctype:dt?dt.name:'html',
        html:tree,
        url:window.location.href,
        viewport:{width:window.innerWidth,height:window.innerHeight},
        scrollX:window.scrollX,
        scrollY:window.scrollY
      });
    }catch(e){return null;}
  })()`;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      { expression: EVAL_EXPR, returnByValue: true }
    );
    if (result && result.result && result.result.value) {
      const parsed = JSON.parse(result.result.value);
      if (parsed && Array.isArray(parsed.html) && typeof parsed.html[0] === 'string') {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to capture DOM snapshot:', e);
  }
  return null;
}

async function handleRecordEventEnhanced(event) {
  if (!activeRecording) return;

  const callId = `call@${Date.now()}@${Math.floor(Math.random() * 1000)}`;
  const timestamp = Date.now();
  const attachments = [];

  const beforeDomSnapshot = activeRecording.lastDomSnapshot || null;

  let actionDomSnapshot = null;
  if (activeRecording.debuggeeTabId) {
    actionDomSnapshot = await captureDomSnapshot(activeRecording.debuggeeTabId);
  }

  if (activeRecording.debuggeeTabId) {
    try {
      // Capture screenshot with Playwright-style sizing and quality
      const { data, width, height } = await chrome.debugger.sendCommand({ tabId: activeRecording.debuggeeTabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      
      // Downscale if needed to match Playwright's film strip sizing (max 800x600)
      const maxScreenshotSize = { width: 800, height: 600 };
      const scaledSize = inscribe({ width, height }, maxScreenshotSize);
      
      const sha1 = `screenshot-${timestamp}-${Math.floor(Math.random() * 1000)}.jpeg`;
      activeRecording.resources.push({ sha1, data });
      attachments.push({ 
        name: 'Action Screenshot', 
        contentType: 'image/jpeg', 
        sha1,
        width: scaledSize.width,
        height: scaledSize.height
      });
    } catch (e) {
      console.warn('Failed to capture screenshot:', e);
    }
  }

  activeRecording.events.push({
    type: 'before',
    callId,
    startTime: timestamp,
    method: event.type,
    class: 'Page',
    params: { selector: event.selector || '', value: event.value || '' },
    pageId: 'page1',
    timestamp,
    domSnapshots: { before: beforeDomSnapshot, action: actionDomSnapshot }
  });

  let afterDomSnapshot = null;
  if (activeRecording.debuggeeTabId) {
    await new Promise(resolve => setTimeout(resolve, 150));
    afterDomSnapshot = await captureDomSnapshot(activeRecording.debuggeeTabId);
    if (afterDomSnapshot) {
      activeRecording.lastDomSnapshot = afterDomSnapshot;
    }
  }

  activeRecording.events.push({
    type: 'after',
    callId,
    endTime: timestamp + 20,
    timestamp: timestamp + 20,
    attachments,
    domAfterSnapshot: afterDomSnapshot
  });

  if (!activeRecording.url && event.url) {
    activeRecording.url = event.url;
  }
}

// CDP Event Listener
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!activeRecording) return;

  const timestamp = Date.now();

  if (method === 'Runtime.consoleAPICalled') {
    activeRecording.events.push({
      type: 'console',
      messageType: params.type,
      text: params.args.map(a => a.value || a.description || '').join(' '),
      location: { url: '', lineNumber: 0, columnNumber: 0 },
      time: timestamp,
      pageId: 'page1'
    });
  } else if (method === 'Log.entryAdded') {
    activeRecording.events.push({
      type: 'console',
      messageType: params.entry.level,
      text: params.entry.text,
      time: timestamp,
      pageId: 'page1'
    });
  } else if (method.startsWith('Network.')) {
    activeRecording.events.push({ type: 'cdp-network', method, params, timestamp });

    if (method === 'Network.loadingFinished' && activeRecording.debuggeeTabId) {
      try {
        const bodyRes = await chrome.debugger.sendCommand(
          { tabId: activeRecording.debuggeeTabId },
          'Network.getResponseBody',
          { requestId: params.requestId }
        );
        activeRecording.events.push({
          type: 'cdp-network-body',
          requestId: params.requestId,
          body: bodyRes.body,
          base64Encoded: bodyRes.base64Encoded
        });
      } catch (_) { /* ignore */ }
    }
  }
});
