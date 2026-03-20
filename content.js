// Content script for User Interaction Recorder
// Guard: only run in the top-level frame, never inside iframes.
if (window !== window.top) {
  // Silently exit - do nothing in sub-frames.
  // (belt-and-suspenders; manifest also sets all_frames: false)
} else if (window._ventriloquistInjected) {
  // Already injected in this frame (e.g. due to a programmatic re-injection race).
  // Send current recording status instead of re-initialising.
  chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
} else {
  window._ventriloquistInjected = true;

let isRecording = false;
let isReplaying = false;

// Initialize content script
console.log('Ventriloquist content script loaded');

// Check initial recording status
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (response) => {
  if (response && response.recording) {
    startRecording();
  }
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'RECORDING_STARTED':
      startRecording();
      break;
    
    case 'RECORDING_STOPPED':
      stopRecording();
      break;
    
    case 'REPLAY_EVENTS':
      replayEvents(message.events, message.speed, message.loop);
      break;
  }
});

// Start recording user interactions
function startRecording() {
  if (isRecording) return;
  
  isRecording = true;
  // Recording indicator removed - it was appearing in traces and obscuring elements
  
  // Add event listeners for various user interactions
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('scroll', handleScroll, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  
  console.log('Recording started');
}

// Stop recording user interactions
function stopRecording() {
  if (!isRecording) return;
  
  isRecording = false;
  // hideRecordingIndicator() removed - indicator was removed
  
  // Remove event listeners
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeydown, true);
  document.removeEventListener('scroll', handleScroll, true);
  document.removeEventListener('input', handleInput, true);
  document.removeEventListener('change', handleChange, true);
  
  console.log('Recording stopped');
}

// Handle click events
function handleClick(event) {
  if (!isRecording || isReplaying) return;
  
  try {
    const selector = getElementSelector(event.target);
    const eventData = {
      type: 'click',
      selector: selector,
      x: event.clientX,
      y: event.clientY
    };
    
    sendEventToBackground(eventData);
  } catch (e) {
    console.warn('Failed to capture click event:', e);
  }
}

// Handle keydown events
function handleKeydown(event) {
  if (!isRecording || isReplaying) return;
  
  const selector = getElementSelector(event.target);
  const eventData = {
    type: 'keydown',
    selector: selector,
    key: event.key,
    keyCode: event.keyCode,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  };
  
  sendEventToBackground(eventData);
}

// Handle scroll events
function handleScroll(event) {
  if (!isRecording || isReplaying) return;
  
  // Throttle scroll events to avoid overhead
  if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
  this.scrollTimeout = setTimeout(() => {
    const eventData = {
      type: 'scroll',
      url: window.location.href,
      scrollX: window.scrollX,
      scrollY: window.scrollY
      // Snapshot omitted for scroll to save space
    };
    sendEventToBackground(eventData);
  }, 200);
}

// Handle input events
function handleInput(event) {
  if (!isRecording || isReplaying) return;
  
  try {
    const selector = getElementSelector(event.target);
    const eventData = {
      type: 'input',
      selector: selector,
      value: event.target.value
    };
    
    sendEventToBackground(eventData);
  } catch (e) {
    console.warn('Failed to capture input event:', e);
  }
}

// Handle change events
function handleChange(event) {
  if (!isRecording || isReplaying) return;
  
  try {
    const selector = getElementSelector(event.target);
    const eventData = {
      type: 'change',
      selector: selector,
      value: event.target.value
    };
    
    sendEventToBackground(eventData);
  } catch (e) {
    console.warn('Failed to capture change event:', e);
  }
}

// Generate CSS selector for an element
function getElementSelector(element) {
  if (!element) return '';
  
  // Try to use ID first
  if (element.id) {
    return `#${element.id}`;
  }
  
  // Try to use unique class combination
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/);
    if (classes.length > 0) {
      const classSelector = '.' + classes.map(cls => escapeCssSelector(cls)).join('.');
      if (document.querySelectorAll(classSelector).length === 1) {
        return classSelector;
      }
    }
  }
  
  // Use tag name with nth-child
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  
  if (parent) {
    const siblings = Array.from(parent.children).filter(child => 
      child.tagName.toLowerCase() === tagName
    );
    const index = siblings.indexOf(element) + 1;
    const parentSelector = getElementSelector(parent);
    return `${parentSelector} > ${tagName}:nth-child(${index})`;
  }
  
  return tagName;
}

// High-Fidelity: DOM Snapshotting via CDP now
function captureSnapshot() {
  return null;
}

// Escape special characters for CSS selector
function escapeCssSelector(selector) {
  // Escape characters that have special meaning in CSS selectors
  // This regex is more comprehensive for characters that might appear in class names
  return selector.replace(/([.#:;,\(\)\[\]{}*+?|^$!"'~`@%&])/g, '\\$1');
}

// Send event data to background script
function sendEventToBackground(eventData) {
  eventData.url = window.location.href; // Ensure URL is always present
  chrome.runtime.sendMessage({
    type: 'RECORD_EVENT',
    event: eventData
  }).catch(error => {
    console.error('Error sending event to background:', error);
  });
}

// Replay events
async function replayEvents(events, speed = 1, loop = false) {
  if (isReplaying) return;
  
  isReplaying = true;
  const delay = 1000 / speed; // Base delay between events
  
  do {
    for (const event of events) {
      try {
        await replayEvent(event);
      } catch (error) {
        console.error('Error replaying event:', error);
      }
    }
  } while (loop && isReplaying);
  
  isReplaying = false;
}

// Replay a single event
async function replayEvent(event) {
  switch (event.type) {
    case 'click':
      await replayClick(event);
      break;
    
    case 'keydown':
      await replayKeydown(event);
      break;
    
    case 'scroll':
      await replayScroll(event);
      break;
    
    case 'input':
    case 'change':
      await replayInput(event);
      break;
  }
}

// Replay click event
async function replayClick(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    try {
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.x,
        clientY: event.y
      });
      element.dispatchEvent(clickEvent);
    } catch (e) {
      console.warn('Failed to replay click event (untrusted event):', event.selector, e);
    }
    highlightElement(element);
  } else {
    console.warn('Element not found for click:', event.selector);
  }
}

// Replay keydown event
async function replayKeydown(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    element.focus();
    
    const keyEvent = new KeyboardEvent('keydown', {
      key: event.key,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      bubbles: true
    });
    
    try {
      element.dispatchEvent(keyEvent);
    } catch (e) {
      console.warn('Failed to replay keydown event (untrusted event):', event.selector, e);
    }
    highlightElement(element);
  } else {
    console.warn('Element not found for keydown:', event.selector);
  }
}

// Replay scroll event
async function replayScroll(event) {
  window.scrollTo(event.scrollX, event.scrollY);
}

// Replay input event
async function replayInput(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    element.focus();
    element.value = event.value;
    
    // Trigger input and change events
    try {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      console.warn('Failed to dispatch input event (untrusted event):', event.selector, e);
    }
    try {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('Failed to dispatch change event (untrusted event):', event.selector, e);
    }
    
    highlightElement(element);
  } else {
    console.warn('Element not found for input:', event.selector);
  }
}

// Highlight element during replay
function highlightElement(element) {
  element.style.outline = '3px solid #00ff00';
  element.style.outlineOffset = '2px';
  
  setTimeout(() => {
    element.style.outline = '';
    element.style.outlineOffset = '';
  }, 500);
}

} // end top-frame guard