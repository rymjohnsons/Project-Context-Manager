// service-worker.js
//
// This script runs in the background at all times — even when the popup is
// closed. Chrome automatically starts it when a relevant event fires and may
// suspend it between events to save memory. That's fine; we don't hold any
// state here, everything is read fresh from chrome.storage.local each time.
//
// Sole responsibility: watch which tab is active and paint a green ✓ badge
// on the extension icon when the current page is already in one of your lists.

'use strict';

const STORAGE_KEY = 'projectContextManager_v1';

// ── Badge helpers ──────────────────────────────────────────────────────────────

function showFoundBadge() {
  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#059669' }); // emerald green
}

function clearBadge() {
  // An empty string removes the badge entirely.
  chrome.action.setBadgeText({ text: '' });
}

// ── Core check ─────────────────────────────────────────────────────────────────
// Given a tab URL, load the saved lists and see if that URL is in any of them.

async function checkTabUrl(url) {
  // Skip internal Chrome pages — they can never be in a user list.
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    clearBadge();
    return;
  }

  // chrome.storage.local.get returns an object keyed by what we asked for.
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const data   = result[STORAGE_KEY] || { lists: [] };

  // .some() short-circuits as soon as it finds a match, which is efficient.
  const found = data.lists.some(list =>
    list.urls.some(entry => entry.url === url)
  );

  found ? showFoundBadge() : clearBadge();
}

// ── Tab event listeners ────────────────────────────────────────────────────────
// These three events cover every situation where the "current page" changes.

// 1. User clicks a different tab.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    checkTabUrl(tab.url);
  } catch {
    // Tab was closed between the event firing and us reading it. Safe to ignore.
    clearBadge();
  }
});

// 2. A tab navigates to a new URL (catches forward/back, link clicks, etc.).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // status === 'complete' means the page has finished loading.
  // tab.active ensures we only care about the tab the user is looking at.
  if (changeInfo.status === 'complete' && tab.active) {
    checkTabUrl(tab.url);
  }
});

// 3. The user adds or removes a URL via the popup — re-check immediately so
//    the badge updates without needing a tab switch.
chrome.storage.onChanged.addListener(async (changes, area) => {
  // Only react to changes in our key in local storage.
  if (area !== 'local' || !changes[STORAGE_KEY]) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) checkTabUrl(tab.url);
});
