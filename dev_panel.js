// Devtools page script — registers the Ventriloquist panel.
// This file runs in the devtools_page context (not visible to the user).
// The actual panel UI lives in panel.html / panel.js.
chrome.devtools.panels.create(
  'Ventriloquist',
  '../icons/icon48.png',
  'panel.html',
  (panel) => {
    console.log('Ventriloquist panel registered');
  }
);
