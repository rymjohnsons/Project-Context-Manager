'use strict';

// Passive: copy token into chrome.storage.local on every page load.
const _t = localStorage.getItem('pcm_token');
if (_t) {
  chrome.storage.local.set({ projectContextManager_token: _t });
}

// Active: respond when the popup asks for the current token.
// This handles the case where the page loaded before the user was logged in.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TABRADOR_GET_TOKEN') {
    sendResponse({ token: localStorage.getItem('pcm_token') });
    return true;
  }
});
