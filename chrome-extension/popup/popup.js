'use strict';

// ── Configuration ──────────────────────────────────────────────────────────────
const API_BASE = 'https://web-production-b9ae2.up.railway.app';

// chrome.storage.local keys
const TOKEN_KEY       = 'projectContextManager_token';
const TAB_IDS_KEY     = 'projectContextManager_openTabs_v1';
const BADGE_CACHE_KEY = 'projectContextManager_v1';

// ── Auth token ─────────────────────────────────────────────────────────────────

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

// ── API fetch wrapper ──────────────────────────────────────────────────────────

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

  if (res.status === 204) return null;

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail)
      ? err.detail.map(e => e.msg).join(', ')
      : (err.detail || `Request failed (${res.status})`);
    throw new Error(detail);
  }

  return res.json();
}

// ── Tab-tracking (stays local — tab IDs are not meaningful to the server) ──────

async function loadOpenTabs() {
  const result = await chrome.storage.local.get(TAB_IDS_KEY);
  return result[TAB_IDS_KEY] || {};
}

async function saveOpenTabs(openTabs) {
  await chrome.storage.local.set({ [TAB_IDS_KEY]: openTabs });
}

// ── Current lists cache ────────────────────────────────────────────────────────

let currentLists = [];

// ── Tab helper ─────────────────────────────────────────────────────────────────

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ── List operations ────────────────────────────────────────────────────────────

async function createList(name) {
  name = (name || '').trim() || 'Untitled List';
  await apiFetch('/lists', { method: 'POST', body: JSON.stringify({ name }) });
  await render();
}

async function deleteList(id) {
  await apiFetch(`/lists/${id}`, { method: 'DELETE' });
  const openTabs = await loadOpenTabs();
  if (openTabs[id]) { delete openTabs[id]; await saveOpenTabs(openTabs); }
  await render();
}

async function addUrlToList(listId, url) {
  const list = currentLists.find(l => l.id == listId);
  if (list && list.urls.some(u => u.url === url)) return 'duplicate';
  await apiFetch(`/lists/${listId}/urls`, { method: 'POST', body: JSON.stringify({ url }) });
  await render();
  return 'added';
}

async function renameList(id, newName) {
  newName = (newName || '').trim();
  if (!newName) return;
  try {
    await apiFetch(`/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    syncDropdown();
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

// ── Open All ───────────────────────────────────────────────────────────────────

async function openAll(listId) {
  const list = currentLists.find(l => l.id == listId);
  if (!list || list.urls.length === 0) return;

  const tabIds = [];
  for (const entry of list.urls) {
    const tab = await chrome.tabs.create({ url: entry.url, active: false });
    tabIds.push(tab.id);
  }

  const openTabs = await loadOpenTabs();
  openTabs[listId] = tabIds;
  await saveOpenTabs(openTabs);

  await render();
  showToast(`Opened ${list.urls.length} tab${list.urls.length !== 1 ? 's' : ''}`, 'success');
}

// ── Close All ──────────────────────────────────────────────────────────────────

async function closeAll(listId) {
  const openTabs  = await loadOpenTabs();
  const storedIds = openTabs[listId] || [];

  if (storedIds.length > 0) {
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

// ── Snapshot open tabs ─────────────────────────────────────────────────────────

async function snapshotTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const urls = tabs
    .filter(t => t.url
      && !t.url.startsWith('chrome://')
      && !t.url.startsWith('chrome-extension://')
      && !t.url.startsWith('about:'))
    .map(t => t.url);

  if (urls.length === 0) { showToast('No capturable tabs in this window.', 'warn'); return; }

  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const list  = await apiFetch('/lists', {
      method: 'POST',
      body: JSON.stringify({ name: `Snapshot — ${today}` }),
    });
    for (const url of urls) {
      await apiFetch(`/lists/${list.id}/urls`, { method: 'POST', body: JSON.stringify({ url }) });
    }
    await render();
    showToast(`Captured ${urls.length} tab${urls.length !== 1 ? 's' : ''}!`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Display helpers ────────────────────────────────────────────────────────────

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

// ── Render ─────────────────────────────────────────────────────────────────────

async function render() {
  try {
    currentLists = await apiFetch('/lists');
  } catch {
    return;
  }

  // Write badge cache so the service worker can check without its own API token.
  await chrome.storage.local.set({ [BADGE_CACHE_KEY]: { lists: currentLists } });

  const tab        = await getCurrentTab();
  const currentUrl = (tab && tab.url) ? tab.url : '';

  // Tab bar
  const tabUrlEl   = document.getElementById('current-tab-url');
  const tabBadgeEl = document.getElementById('current-tab-badge');

  if (currentUrl && !currentUrl.startsWith('chrome://') && !currentUrl.startsWith('chrome-extension://')) {
    tabUrlEl.textContent = displayUrl(currentUrl);
    tabUrlEl.title       = currentUrl;
    const match = currentLists.find(l => l.urls.some(u => u.url === currentUrl));
    if (match) {
      tabBadgeEl.textContent = `✓ In "${match.name}"`;
      tabBadgeEl.classList.remove('hidden');
    } else {
      tabBadgeEl.classList.add('hidden');
    }
  } else {
    tabUrlEl.textContent = currentUrl.startsWith('chrome://') ? 'Chrome system page' : 'No page active';
    tabBadgeEl.classList.add('hidden');
  }

  // Quick-add dropdown
  const listSelect   = document.getElementById('list-select');
  const prevSelected = listSelect.value;
  listSelect.innerHTML = '<option value="">— select a list —</option>';
  currentLists.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id; opt.textContent = l.name;
    listSelect.appendChild(opt);
  });
  if (prevSelected) listSelect.value = prevSelected;

  // List cards
  const container = document.getElementById('lists-container');
  const openTabs  = await loadOpenTabs();
  container.innerHTML = '';

  if (currentLists.length === 0) {
    container.innerHTML = '<p class="empty-state">No lists yet — create one above.</p>';
  } else {
    currentLists.forEach(list => container.appendChild(buildCard(list, currentUrl, openTabs)));
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
      <button class="remove-url-btn" data-list="${list.id}" data-url="${u.id}" title="Remove">×</button>
    </li>
  `).join('');

  card.innerHTML = `
    <div class="list-header">
      <input class="list-name-input" type="text" value="${esc(list.name)}"
             data-list="${list.id}" title="Click to rename" />
      <span class="url-count">${list.urls.length}</span>
      <button class="btn-open open-all-btn" data-list="${list.id}">Open All</button>
      ${hasTrackedTabs ? `<button class="btn-close close-all-btn" data-list="${list.id}">Close All</button>` : ''}
      <button class="btn-delete delete-list-btn" data-list="${list.id}" title="Delete list">✕</button>
    </div>
    ${list.urls.length > 0
      ? `<ul class="url-list">${urlItems}</ul>`
      : '<p class="no-urls">No URLs yet — use Add Tab above.</p>'
    }
  `;

  return card;
}

// Updates only the quick-add dropdown after a rename (avoids stealing focus).
function syncDropdown() {
  const sel  = document.getElementById('list-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select a list —</option>';
  currentLists.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id; opt.textContent = l.name;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

// ── Toast ──────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = 'success') {
  const el = document.getElementById('status-toast');
  el.textContent = message;
  el.className   = `status-toast status-toast--${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ── Login / Logout ─────────────────────────────────────────────────────────────

function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('main-ui').classList.add('hidden');
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

  if (!email || !password) { setLoginError('Please enter your email and password.'); return; }

  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Logging in…';
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
    btn.disabled = false; btn.textContent = 'Log In';
  }
}

async function logout() {
  await clearToken();
  currentLists = [];
  await chrome.storage.local.remove(BADGE_CACHE_KEY);
  showLoginScreen();
}

// ── Event wiring ───────────────────────────────────────────────────────────────

document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('login-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-password').focus();
});
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.getElementById('add-btn').addEventListener('click', async () => {
  const listId = document.getElementById('list-select').value;
  if (!listId) { showToast('Pick a list first.', 'error'); return; }
  const tab = await getCurrentTab();
  if (!tab || !tab.url || tab.url.startsWith('chrome://')) {
    showToast('No valid page to add.', 'error'); return;
  }
  const result = await addUrlToList(listId, tab.url);
  showToast(result === 'duplicate' ? 'Already in this list.' : 'Added!',
            result === 'duplicate' ? 'warn' : 'success');
});

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

document.getElementById('snapshot-btn').addEventListener('click', snapshotTabs);

document.getElementById('lists-container').addEventListener('change', async e => {
  if (e.target.classList.contains('list-name-input')) {
    await renameList(e.target.dataset.list, e.target.value);
  }
});

document.getElementById('lists-container').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('list-name-input')) e.target.blur();
});

document.getElementById('lists-container').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.classList.contains('open-all-btn'))      await openAll(btn.dataset.list);
  else if (btn.classList.contains('close-all-btn')) await closeAll(btn.dataset.list);
  else if (btn.classList.contains('delete-list-btn')) {
    await deleteList(btn.dataset.list);
    showToast('List deleted.', 'success');
  } else if (btn.classList.contains('remove-url-btn')) {
    await removeUrl(btn.dataset.list, btn.dataset.url);
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

async function boot() {
  await loadToken();
  if (!_token) { showLoginScreen(); return; }
  try {
    const user = await apiFetch('/users/me');
    showMainUI(user.email);
    await render();
  } catch {
    showLoginScreen();
  }
}

boot();
