'use strict';

// Runs on every tabrador.app page load.
// Copies pcm_token from the web app's localStorage into chrome.storage.local
// so the extension popup can auto-login without needing scripting injection.
const token = localStorage.getItem('pcm_token');
if (token) {
  chrome.storage.local.set({ projectContextManager_token: token });
}
