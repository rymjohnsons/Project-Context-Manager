// popup.js — all logic for the extension popup
//
// WHAT CHANGED FROM PHASE 2:
//   Phase 2 used chrome.storage.local to store list data locally.
//   Phase 3 stores lists on the FastAPI backend (http://localhost:8000).
//   This file replaces all loadData()/saveData() calls with fetch() calls
//   to the API, and adds a login screen that stores a JWT token locally.
//
// WHAT STAYS THE SAME:
//   • chrome.storage.local still holds the JWT token and tracked tab IDs
//     (those are browser-session data that don't belong in the database)
//   • chrome.tabs.create() for popup-blocker-free Open All
//   • Share token encoding/decoding (format unchanged — tokens work between
//     the extension and the web app in both directions)
//   • The service worker is UNCHANGED: after every render(), this file
//     writes the freshly-fetched lists into chrome.storage.local so the
//     service worker can check badge status without needing an API token

'use strict';

// =============================================================================
// CONFIGURATION
// Change API_BASE when you deploy to a real server.
// =============================================================================
const API_BASE = 'http://localhost:8000';

// chrome.storage.local keys
const TOKEN_KEY    = 'projectContextManager_token';     // JWT string
const TAB_IDS_KEY  = 'projectContextManager_openTabs_v1'; // { [listId]: number[] }
const BADGE_CACHE_KEY = 'projectContextManager_v1';    // { lists: [...] } read by service-worker.js

// =============================================================================
// AUTH — token stored in chrome.storage.local
//
// We store only the JWT here, not the list data. The actual lists live in the
// SQLite database on the backend. chrome.storage.local (not window.localStorage)
// because extension storage is scoped to the extension, not a web page origin.
// =============================================================================

// Module-level cache so we don't await storage on every API call.
let _token = null;

async function loadToken() {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  _token = result[TOKEN_KEY] || null;
}

async function setToken(t) {
  _token = t;
  await chrome.storage.local.set({ [TOKEN_KEY]: t });
}

async function clearToken() {
  _token = null;
  await chrome.storage.local.remove(TOKEN_KEY);
}

// =============================================================================
// API FETCH WRAPPER
//
// Every request to the backend goes through apiFetch(). It:
//   1. Adds the Authorization: Bearer <token> header automatically
//   2. Treats 204 No Content as a success with no body (used by DELETE)
//   3. On 401, clears the token and redirects to the login screen
//   4. Extracts readable error messages from FastAPI's { detail: ... } format
// =============================================================================

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    await clearToken();
    showLoginScreen();
    throw new Error('Session expired — please log in again.');
  }

  if (res.status === 204) return null; // DELETE success

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Pydantic validation errors come as an array; pick all messages.
    const detail = Array.isArray(err.detail)
      ? err.detail.map(e => e.msg).join(', ')
      : (err.detail || `Request failed (${res.status})`);
    throw new Error(detail);
  }

  return res.json();
}

// =============================================================================
// TAB-TRACKING HELPERS — stays in chrome.storage.local
//
// Tab IDs are ephemeral (Chrome resets them on restart) and meaningless to the
// server, so we keep them locally. Shape: { [listId]: number[] }
// =============================================================================

async function loadOpenTabs() {
  const result = await chrome.storage.local.get(TAB_IDS_KEY);
  return result[TAB_IDS_KEY] || {};
}

async function saveOpenTabs(openTabs) {
  await chrome.storage.local.set({ [TAB_IDS_KEY]: openTabs });
}

// =============================================================================
// CURRENT LISTS CACHE
//
// Populated by render() after every GET /lists. Read-only operations like
// openAll(), shareExport(), and duplicate-checking use this so they don't need
// an extra round-trip for data that was just fetched.
// =============================================================================

let currentLists = [];

// =============================================================================
// TAB HELPER
// =============================================================================

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// =============================================================================
// LIST OPERATIONS — all backed by the API now
// =============================================================================

async function createList(name) {
  name = (name || '').trim() || 'Untitled List';
  await apiFetch('/lists', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await render();
}

async function deleteList(id) {
  await apiFetch(`/lists/${id}`, { method: 'DELETE' });

  // Clean up any tracked tab IDs for this list so stale entries don't accumulate.
  const openTabs = await loadOpenTabs();
  if (openTabs[id]) { delete openTabs[id]; await saveOpenTabs(openTabs); }

  await render();
}

// Returns 'added' | 'duplicate' so the caller can show the right toast.
// Duplicate check is client-side using the cached list data.
async function addUrlToList(listId, url) {
  const list = currentLists.find(l => l.id == listId);
  if (list && list.urls.some(u => u.url === url)) return 'duplicate';

  await apiFetch(`/lists/${listId}/urls`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  await render();
  return 'added';
}

async function renameList(id, newName) {
  newName = (newName || '').trim();
  if (!newName) return;
  try {
    await apiFetch(`/lists/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: newName }),
    });
    // Don't call render() — that would steal focus from the input the user
    // may still be editing. Just update the dropdowns so the name shows there.
    syncDropdowns();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function removeUrl(listId, urlId) {
  try {
    await apiFetch(`/lists/${listId}/urls/${urlId}`, { method: 'DELETE' });
    await render();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// =============================================================================
// OPEN ALL — uses chrome.tabs.create() so the popup blocker never applies
// =============================================================================

async function openAll(listId) {
  const list = currentLists.find(l => l.id == listId);
  if (!list || list.urls.length === 0) return;

  const tabIds = [];
  for (const entry of list.urls) {
    // active: false keeps focus on the popup while tabs load in the background
    const tab = await chrome.tabs.create({ url: entry.url, active: false });
    tabIds.push(tab.id);
  }

  // Store the IDs so Close All knows exactly which tabs to close later.
  const openTabs = await loadOpenTabs();
  openTabs[listId] = tabIds;
  await saveOpenTabs(openTabs);

  await render();
  showToast(`Opened ${list.urls.length} tab${list.urls.length !== 1 ? 's' : ''}`, 'success');
}

// =============================================================================
// CLOSE ALL
// =============================================================================

async function closeAll(listId) {
  const openTabs  = await loadOpenTabs();
  const storedIds = openTabs[listId] || [];

  if (storedIds.length > 0) {
    // Cross-reference against tabs that are actually still open — gracefully
    // handles tabs the user already closed manually.
    const currentTabs = await chrome.tabs.query({});
    const currentIds  = new Set(currentTabs.map(t => t.id));
    const toClose     = storedIds.filter(id => currentIds.has(id));
    if (toClose.length > 0) await chrome.tabs.remove(toClose);
  }

  delete openTabs[listId];
  await saveOpenTabs(openTabs);
  await render();
  showToast('Tabs closed.', 'success');
}

// =============================================================================
// SNAPSHOT OPEN TABS
//
// This is the feature the web app can't do — chrome.tabs.query() can read every
// open tab's full URL, which a normal webpage is never allowed to access.
// Creates a new list on the server, then adds each URL to it.
// =============================================================================

async function snapshotTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const urls = tabs
    .filter(t => t.url
      && !t.url.startsWith('chrome://')
      && !t.url.startsWith('chrome-extension://')
      && !t.url.startsWith('about:'))
    .map(t => t.url);

  if (urls.length === 0) {
    showToast('No capturable tabs in this window.', 'warn');
    return;
  }

  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    // Create the list first, then add URLs to it one by one.
    const list  = await apiFetch('/lists', {
      method: 'POST',
      body: JSON.stringify({ name: `Snapshot — ${today}` }),
    });
    for (const url of urls) {
      await apiFetch(`/lists/${list.id}/urls`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
    }
    await render();
    showToast(`Captured ${urls.length} tab${urls.length !== 1 ? 's' : ''}!`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// =============================================================================
// SHARE TOKEN ENCODE / DECODE
//
// Format is IDENTICAL to the web app (same Base64 / JSON shape). A token from
// this extension can be imported by the web app and vice versa.
// =============================================================================

function encodeList(list) {
  const payload = { name: list.name, urls: list.urls.map(u => u.url) };
  const bytes   = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decodeToken(raw) {
  raw = raw.trim();
  const hashIdx = raw.indexOf('#share=');
  if (hashIdx !== -1) raw = raw.slice(hashIdx + '#share='.length);
  if (raw.startsWith('share=')) raw = raw.slice(6);
  const binary = atob(raw);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)); // { name, urls: string[] }
}

// =============================================================================
// DISPLAY HELPERS
// =============================================================================

function displayUrl(raw) {
  try {
    const u    = new URL(raw);
    const full = u.hostname + u.pathname + u.search + u.hash;
    return full.length > 46 ? full.slice(0, 46) + '…' : full;
  } catch {
    return raw.length > 46 ? raw.slice(0, 46) + '…' : raw;
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// RENDER
//
// Fetches the current lists from GET /lists, updates currentLists, rebuilds
// the popup DOM, and writes the badge cache to chrome.storage.local so the
// service worker can check badge status without needing its own API token.
// =============================================================================

async function render() {
  try {
    currentLists = await apiFetch('/lists');
  } catch {
    // apiFetch already handled 401 by calling showLoginScreen().
    // Any other error (server offline etc.): leave the UI as-is.
    return;
  }

  // Write the badge cache so service-worker.js can read it without API access.
  // Shape matches what the service worker expects: { lists: [ { urls: [...] } ] }
  await chrome.storage.local.set({ [BADGE_CACHE_KEY]: { lists: currentLists } });

  const tab        = await getCurrentTab();
  const currentUrl = (tab && tab.url) ? tab.url : '';

  // ── Tab bar ──
  const tabUrlEl   = document.getElementById('current-tab-url');
  const tabBadgeEl = document.getElementById('current-tab-badge');

  if (currentUrl && !currentUrl.startsWith('chrome://') && !currentUrl.startsWith('chrome-extension://')) {
    tabUrlEl.textContent = displayUrl(currentUrl);
    tabUrlEl.title       = currentUrl;
    const matchingList = currentLists.find(l => l.urls.some(u => u.url === currentUrl));
    if (matchingList) {
      tabBadgeEl.textContent = `✓ In "${matchingList.name}"`;
      tabBadgeEl.classList.remove('hidden');
    } else {
      tabBadgeEl.classList.add('hidden');
    }
  } else {
    tabUrlEl.textContent = currentUrl.startsWith('chrome://') ? 'Chrome system page' : 'No page active';
    tabBadgeEl.classList.add('hidden');
  }

  // ── Quick-add dropdown ──
  const listSelect   = document.getElementById('list-select');
  const prevSelected = listSelect.value;
  listSelect.innerHTML = '<option value="">— select a list —</option>';
  currentLists.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id; opt.textContent = l.name;
    listSelect.appendChild(opt);
  });
  if (prevSelected) listSelect.value = prevSelected;

  // ── List cards ──
  const container = document.getElementById('lists-container');
  const openTabs  = await loadOpenTabs();
  container.innerHTML = '';

  if (currentLists.length === 0) {
    container.innerHTML = '<p class="empty-state">No lists yet — create one above.</p>';
  } else {
    currentLists.forEach(list => container.appendChild(buildCard(list, currentUrl, openTabs)));
  }

  // ── Export dropdown ──
  const exportSelect = document.getElementById('export-list-select');
  if (exportSelect) {
    const prevExport = exportSelect.value;
    exportSelect.innerHTML = '<option value="">— select a list —</option>';
    currentLists.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id; opt.textContent = l.name;
      exportSelect.appendChild(opt);
    });
    if (prevExport) exportSelect.value = prevExport;
  }
}

function buildCard(list, currentUrl, openTabs) {
  const isActive       = list.urls.some(u => u.url === currentUrl);
  const hasTrackedTabs = (openTabs[list.id] || []).length > 0;

  const card = document.createElement('div');
  card.className = 'list-card' + (isActive ? ' list-card--active' : '');

  const urlItems = list.urls.map(u => `
    <li class="url-item">
      <span class="url-label" title="${esc(u.url)}">${esc(displayUrl(u.url))}</span>
      <button class="remove-url-btn"
              data-list="${list.id}"
              data-url="${u.id}"
              title="Remove">×</button>
    </li>
  `).join('');

  card.innerHTML = `
    <div class="list-header">
      <input class="list-name-input"
             type="text"
             value="${esc(list.name)}"
             data-list="${list.id}"
             title="Click to rename" />
      <span class="url-count">${list.urls.length}</span>
      <button class="btn-open open-all-btn"
              data-list="${list.id}"
              title="Open all URLs in new tabs">Open All</button>
      ${hasTrackedTabs ? `<button class="btn-close close-all-btn"
              data-list="${list.id}"
              title="Close the tabs opened by this list">Close All</button>` : ''}
      <button class="btn-delete delete-list-btn"
              data-list="${list.id}"
              title="Delete list">✕</button>
    </div>
    ${list.urls.length > 0
      ? `<ul class="url-list">${urlItems}</ul>`
      : '<p class="no-urls">No URLs yet — use Add Tab above.</p>'
    }
  `;

  return card;
}

// ── Dropdown sync ──────────────────────────────────────────────────────────────
// Called after rename so the <select> elements update without a full re-render
// (which would steal keyboard focus from the name input mid-edit).

function syncDropdowns() {
  for (const selectId of ['list-select', 'export-list-select']) {
    const sel = document.getElementById(selectId);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— select a list —</option>';
    currentLists.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id; opt.textContent = l.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }
}

// =============================================================================
// TOAST NOTIFICATIONS
// =============================================================================

let toastTimer = null;

function showToast(message, type = 'success') {
  const el = document.getElementById('status-toast');
  el.textContent = message;
  el.className   = `status-toast status-toast--${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// =============================================================================
// LOGIN / LOGOUT UI
// =============================================================================

function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('main-ui').classList.add('hidden');
  // Focus the email input so the user can start typing immediately.
  document.getElementById('login-email').focus();
}

function showMainUI(email) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-ui').classList.remove('hidden');
  document.getElementById('user-email-label').textContent = email;
}

function setLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function login() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    setLoginError('Please enter your email and password.');
    return;
  }

  const btn = document.getElementById('login-btn');
  btn.disabled    = true;
  btn.textContent = 'Logging in…';
  setLoginError('');

  try {
    const { access_token } = await apiFetch('/users/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    await setToken(access_token);

    const user = await apiFetch('/users/me');
    showMainUI(user.email);
    await render();
  } catch (e) {
    setLoginError(e.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Log In';
  }
}

async function logout() {
  await clearToken();
  currentLists = [];
  // Clear the badge cache so the service worker stops showing the badge.
  await chrome.storage.local.remove(BADGE_CACHE_KEY);
  showLoginScreen();
}

// =============================================================================
// EVENT WIRING
// All listeners are attached here — no inline onclick in HTML (CSP forbids it).
// =============================================================================

// ── Login screen ──
document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('login-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-password').focus();
});
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

// ── Logout ──
document.getElementById('logout-btn').addEventListener('click', logout);

// ── Add current tab to the selected list ──
document.getElementById('add-btn').addEventListener('click', async () => {
  const listId = document.getElementById('list-select').value;
  if (!listId) { showToast('Pick a list first.', 'error'); return; }

  const tab = await getCurrentTab();
  if (!tab || !tab.url || tab.url.startsWith('chrome://')) {
    showToast('No valid page to add.', 'error');
    return;
  }

  const result = await addUrlToList(listId, tab.url);
  showToast(result === 'duplicate' ? 'Already in this list.' : 'Added!',
            result === 'duplicate' ? 'warn' : 'success');
});

// ── New list form toggle ──
document.getElementById('new-list-btn').addEventListener('click', () => {
  const form = document.getElementById('new-list-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById('new-list-name').focus();
});

document.getElementById('cancel-new-list-btn').addEventListener('click', () => {
  document.getElementById('new-list-form').classList.add('hidden');
});

document.getElementById('create-list-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-list-name');
  if (!input.value.trim()) return;
  await createList(input.value);
  input.value = '';
  document.getElementById('new-list-form').classList.add('hidden');
  showToast('List created!', 'success');
});

document.getElementById('new-list-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('create-list-btn').click();
});

// ── Snapshot ──
document.getElementById('snapshot-btn').addEventListener('click', snapshotTabs);

// ── List container — rename, open/close/delete, remove URL ──
document.getElementById('lists-container').addEventListener('change', async e => {
  if (e.target.classList.contains('list-name-input')) {
    await renameList(e.target.dataset.list, e.target.value);
  }
});

document.getElementById('lists-container').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('list-name-input')) {
    e.target.blur(); // triggers the change event above
  }
});

document.getElementById('lists-container').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.classList.contains('open-all-btn')) {
    await openAll(btn.dataset.list);
  } else if (btn.classList.contains('close-all-btn')) {
    await closeAll(btn.dataset.list);
  } else if (btn.classList.contains('delete-list-btn')) {
    await deleteList(btn.dataset.list);
    showToast('List deleted.', 'success');
  } else if (btn.classList.contains('remove-url-btn')) {
    await removeUrl(btn.dataset.list, btn.dataset.url);
  }
});

// ── Import panel ──
document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-panel').classList.toggle('hidden');
  document.getElementById('export-panel').classList.add('hidden');
});

document.getElementById('import-cancel-btn').addEventListener('click', () => {
  document.getElementById('import-panel').classList.add('hidden');
});

document.getElementById('import-confirm-btn').addEventListener('click', async () => {
  const raw = document.getElementById('import-text').value.trim();
  if (!raw) return;
  try {
    const { name, urls } = decodeToken(raw);
    // Create the list first, then POST each URL to it.
    const list = await apiFetch('/lists', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    for (const url of urls) {
      await apiFetch(`/lists/${list.id}/urls`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
    }
    document.getElementById('import-text').value = '';
    document.getElementById('import-panel').classList.add('hidden');
    await render();
    showToast(`Imported "${name}"!`, 'success');
  } catch {
    showToast('Invalid token — check the pasted text.', 'error');
  }
});

// ── Export panel — reads from currentLists cache, no API call needed ──
document.getElementById('export-btn').addEventListener('click', () => {
  document.getElementById('export-panel').classList.toggle('hidden');
  document.getElementById('import-panel').classList.add('hidden');
  document.getElementById('export-text').value = '';
});

document.getElementById('export-list-select').addEventListener('change', e => {
  const listId = e.target.value;
  if (!listId) { document.getElementById('export-text').value = ''; return; }
  const list = currentLists.find(l => l.id == listId);
  if (list) document.getElementById('export-text').value = encodeList(list);
});

document.getElementById('copy-export-btn').addEventListener('click', () => {
  const token = document.getElementById('export-text').value;
  if (!token) { showToast('Select a list first.', 'warn'); return; }
  navigator.clipboard.writeText(token).then(() => showToast('Token copied!', 'success'));
});

document.getElementById('export-close-btn').addEventListener('click', () => {
  document.getElementById('export-panel').classList.add('hidden');
});

// =============================================================================
// BOOT
//
// On popup open: load the cached token, verify it with the server, then render.
// If there's no token or it's invalid, show the login screen instead.
// =============================================================================

async function boot() {
  await loadToken(); // populate _token from chrome.storage.local

  if (!_token) {
    showLoginScreen();
    return;
  }

  try {
    // GET /users/me validates the token and returns the user's email.
    const user = await apiFetch('/users/me');
    showMainUI(user.email);
    await render();
  } catch {
    // apiFetch already called showLoginScreen() on a 401.
    // Any other error (server offline): show the login screen anyway.
    showLoginScreen();
  }
}

boot();
