'use strict';

const API_BASE = ''; // relative — works on any domain (tabrador.app, Railway, localhost)

// ── Auth token ────────────────────────────────────────────────────────────────

function getToken()   { return localStorage.getItem('pcm_token'); }
function setToken(t)  { localStorage.setItem('pcm_token', t); }
function clearToken() { localStorage.removeItem('pcm_token'); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    // fetch() itself threw — server unreachable or no internet
    throw new Error('Connection problem — please check your internet and try again.');
  }

  if (res.status === 401) {
    const hadToken = !!getToken();
    clearToken();
    if (hadToken) {
      // Show the session-expired message on the auth screen before navigating
      showAuthScreen();
      setAuthError('Your session expired — please log in again.');
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(hadToken
      ? 'Your session expired — please log in again.'
      : (err.detail || 'Incorrect email or password.'));
  }

  if (res.status === 429) {
    throw new Error('Too many attempts — please wait a moment and try again.');
  }

  if (res.status === 204) return null;

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail)
      ? err.detail.map(e => e.msg).join(', ')
      : (err.detail || 'Something went wrong — please try again. If the problem continues, contact hello@tabrador.app.');
    throw new Error(detail);
  }

  return res.json();
}

// ── Auth screen ───────────────────────────────────────────────────────────────

let authMode = 'login';

function showAuthScreen() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-email').focus();
}

function showApp(email) {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-email').textContent = email;
}

function setAuthMode(mode) {
  authMode = mode;
  const isLoginOrRegister = mode === 'login' || mode === 'register';
  const isLogin           = mode === 'login';

  document.getElementById('auth-tabs').classList.toggle('hidden', !isLoginOrRegister);
  document.getElementById('auth-form-wrap').classList.toggle('hidden', !isLoginOrRegister);
  document.getElementById('forgot-link-row').classList.toggle('hidden', !isLogin);
  document.getElementById('forgot-section').classList.toggle('hidden', mode !== 'forgot');
  document.getElementById('reset-section').classList.toggle('hidden', mode !== 'reset');

  if (isLoginOrRegister) {
    document.getElementById('tab-login').classList.toggle('active', isLogin);
    document.getElementById('tab-register').classList.toggle('active', !isLogin);
    document.getElementById('auth-submit').textContent = isLogin ? 'Log In' : 'Create Account';
    document.getElementById('auth-password').autocomplete = isLogin ? 'current-password' : 'new-password';
  }
  setAuthError('');
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function _validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function _showEmailExistsError() {
  const el = document.getElementById('auth-error');
  el.innerHTML =
    'An account with that email already exists. ' +
    '<button class="auth-back-link" style="display:inline;padding:0;font-weight:600;color:#1E3A8A;" ' +
    'id="_err-login-link">Log in instead →</button>';
  el.classList.remove('hidden');
  document.getElementById('_err-login-link')
    ?.addEventListener('click', () => setAuthMode('login'));
}

async function submitAuth() {
  const email        = document.getElementById('auth-email').value.trim();
  const password     = document.getElementById('auth-password').value;
  const isNewAccount = authMode === 'register';

  // ── Frontend validation ──────────────────────────────────────────────────
  if (!email || !password) {
    setAuthError('Please enter your email and password.');
    return;
  }
  if (!_validEmail(email)) {
    setAuthError('Please enter a valid email address (e.g. name@example.com).');
    return;
  }
  if (isNewAccount && password.length < 8) {
    setAuthError('Password must be at least 8 characters.');
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  setAuthError('');

  try {
    if (isNewAccount) {
      await apiFetch('/users/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    }
    const { access_token } = await apiFetch('/users/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    setToken(access_token);
    const user = await apiFetch('/users/me');
    currentUser = user; // BILLING: store for trial banner checks
    // ONBOARDING: new accounts go to role question before the app
    if (isNewAccount) {
      document.getElementById('user-email').textContent = user.email;
      showOnboarding();
    } else {
      showApp(user.email);
      showTrialBanner();
      await render();
      await loadSharedWorkspaces();
      showDashboard();
      checkShareLink();
    }
  } catch (e) {
    // "Already exists" gets a friendly inline link rather than a raw error
    if (isNewAccount && e.message.toLowerCase().includes('already exists')) {
      _showEmailExistsError();
    } else {
      setAuthError(e.message);
    }
  } finally {
    btn.disabled = false;
    // Restore button text directly — do NOT call setAuthMode() here because
    // setAuthMode always calls setAuthError('') which wipes the error message.
    btn.textContent = isNewAccount ? 'Create Account' : 'Log In';
  }
}

function logout() {
  clearToken();
  currentLists = [];
  selectedListId = null;
  showAuthScreen();
}

// ── Onboarding ────────────────────────────────────────────────────────────────
// ONBOARDING: shown once after first account creation

function showOnboarding() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('onboarding-overlay').classList.remove('hidden');
}

async function completeOnboarding(workType) {
  if (workType) {
    try {
      await apiFetch('/users/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({ work_type: workType }),
      });
    } catch { /* non-fatal — onboarding is optional */ }
  }
  document.getElementById('onboarding-overlay').classList.add('hidden');
  const email = document.getElementById('user-email').textContent;
  showApp(email);
  await render();
  await loadSharedWorkspaces();
  showDashboard();
  checkShareLink();
}

// ── Workspace templates ────────────────────────────────────────────────────────
// TEMPLATE: starter workspaces pre-loaded with placeholder resources

const WORKSPACE_TEMPLATES = {
  consultant: {
    // TERMINOLOGY: "workspace" was "list"; "resources" were "URLs"
    name: 'Consultant Starter Pack',
    resources: [
      { url: 'https://salesforce.com',  notes: 'CRM — replace with your CRM' },
      { url: 'https://notion.so',       notes: 'Project tracker — replace with your tracker' },
      { url: 'https://mail.google.com', notes: 'Client email' },
      { url: 'https://freshbooks.com',  notes: 'Invoicing — replace with your invoicing tool' },
    ],
  },
  it: {
    name: 'IT Tech Daily Briefing',
    resources: [
      { url: 'https://jira.atlassian.com',       notes: 'Ticket system — replace with your system' },
      { url: 'https://grafana.com',              notes: 'Monitoring dashboard — replace with your dashboard' },
      { url: 'https://confluence.atlassian.com', notes: 'Documentation wiki — replace with your wiki' },
    ],
  },
  pm: {
    name: 'Project Manager Toolkit',
    resources: [
      { url: 'https://jira.atlassian.com',           notes: 'Project board — replace with your board' },
      { url: 'https://docs.google.com/spreadsheets', notes: 'Spreadsheet tracker — replace with your tracker' },
      { url: 'https://slack.com',                    notes: 'Team communication — replace with your tool' },
      { url: 'https://calendar.google.com',          notes: 'Meeting notes & calendar' },
    ],
  },
  agency: {
    name: 'Agency Client Workspace',
    resources: [
      { url: 'https://monday.com',          notes: 'Project management — replace with your tool' },
      { url: 'https://figma.com',           notes: 'Design tool — replace with your design tool' },
      { url: 'https://notion.so',           notes: 'Client portal — replace with your portal link' },
      { url: 'https://analytics.google.com', notes: 'Reporting dashboard — replace with your dashboard' },
    ],
  },
};

function openTemplateModal() {
  document.getElementById('new-list-form').classList.add('hidden');
  document.getElementById('new-list-name').value = '';
  document.getElementById('template-modal').classList.remove('hidden');
}

function closeTemplateModal() {
  document.getElementById('template-modal').classList.add('hidden');
}

async function createFromTemplate(templateKey) {
  const tmpl = WORKSPACE_TEMPLATES[templateKey];
  if (!tmpl) return;
  closeTemplateModal();
  try {
    // TERMINOLOGY: creates a "workspace" (was "list") with "resources" (was "URLs")
    const list = await apiFetch('/lists', { method: 'POST', body: JSON.stringify({ name: tmpl.name }) });
    for (const r of tmpl.resources) {
      const urlObj = await apiFetch(`/lists/${list.id}/urls`, {
        method: 'POST', body: JSON.stringify({ url: r.url }),
      });
      if (r.notes && urlObj && urlObj.id) {
        await apiFetch(`/lists/${list.id}/urls/${urlObj.id}/notes`, {
          method: 'PATCH', body: JSON.stringify({ notes: r.notes }),
        });
      }
    }
    if (list && list.id) selectedListId = list.id;
    await render();
    showErrorToast(''); // clear any previous
  } catch (e) {
    if (e.message && e.message.includes('free tier limit')) {
      openUpgradeModal();
    } else {
      showErrorToast(e.message);
    }
  }
}

// ── Forgot / reset password ───────────────────────────────────────────────────

async function submitForgot() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) return;
  const btn = document.getElementById('forgot-submit');
  btn.disabled = true; btn.textContent = 'Please wait…';
  try {
    await apiFetch('/users/forgot-password', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    document.getElementById('forgot-form').classList.add('hidden');
    document.getElementById('forgot-success').classList.remove('hidden');
  } catch (e) {
    setAuthError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Send Reset Link';
  }
}

async function submitReset() {
  const token    = document.getElementById('reset-token').value.trim();
  const password = document.getElementById('reset-password').value;
  const confirm  = document.getElementById('reset-password-confirm').value;
  if (!token)    { setAuthError('Reset link is missing its token — please use the link from your email.'); return; }
  if (!password) { setAuthError('Please enter a new password.'); return; }
  if (password !== confirm) { setAuthError('Passwords do not match.'); return; }
  const btn = document.getElementById('reset-submit');
  btn.disabled = true; btn.textContent = 'Please wait…';
  try {
    await apiFetch('/users/reset-password', {
      method: 'POST', body: JSON.stringify({ token, new_password: password }),
    });
    setAuthMode('login');
    setAuthError('');
    document.getElementById('auth-error').textContent = 'Password updated — please log in.';
    document.getElementById('auth-error').classList.remove('hidden');
    document.getElementById('auth-error').style.background = 'rgba(5,150,105,0.08)';
    document.getElementById('auth-error').style.borderColor = '#6ee7b7';
    document.getElementById('auth-error').style.color = '#047857';
  } catch (e) {
    setAuthError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Set New Password';
  }
}

// ── App state ─────────────────────────────────────────────────────────────────

let currentUser       = null; // BILLING: populated from /users/me on boot
let currentLists      = [];
let selectedListId    = null;
let currentView       = 'dashboard'; // 'dashboard' | 'workspace'
let sharedWorkspaces  = []; // workspaces shared with current user (summary from /shared-with-me)
let sharedListDetails = []; // full List data for shared workspaces (fetched on click)
let archivedLists     = []; // owner's archived workspaces (fetched alongside currentLists)
let sharedOutData     = []; // workspaces I've shared with others (for Shared Out view)
let currentShares     = []; // shares for the currently selected workspace (owner view)
const trackedWindows        = {};
const openedLists           = new Set(
  JSON.parse(localStorage.getItem('pcm_opened_lists') || '[]').map(String)
);
const dismissedLargeWarning = new Set();
const activeWorkspaceIds    = new Set(
  JSON.parse(localStorage.getItem('pcm_active_workspaces') || '[]').map(String)
);

function _saveOpenedLists()      { localStorage.setItem('pcm_opened_lists',      JSON.stringify([...openedLists])); }
function _saveActiveWorkspaces() { localStorage.setItem('pcm_active_workspaces', JSON.stringify([...activeWorkspaceIds])); }

// ── List operations ───────────────────────────────────────────────────────────

async function createList(name) {
  // TERMINOLOGY: "Untitled Workspace" was "Untitled List"
  name = (name || '').trim() || 'Untitled Workspace';
  try {
    const newList = await apiFetch('/lists', { method: 'POST', body: JSON.stringify({ name }) });
    if (newList && newList.id) selectedListId = newList.id;
    await render();
  } catch (e) {
    if (e.message && e.message.includes('free tier limit')) {
      openUpgradeModal();
    } else {
      showErrorToast(e.message || 'Could not create workspace.');
    }
  }
}

async function deleteList(id) {
  await apiFetch(`/lists/${id}`, { method: 'DELETE' });
  openedLists.delete(String(id));
  delete trackedWindows[id];
  if (selectedListId == id) selectedListId = null;
  await render();
}

async function archiveList(id) {
  const updated = await apiFetch(`/lists/${id}/archive`, { method: 'POST' });
  const idx = currentLists.findIndex(l => l.id == id);
  if (idx !== -1) {
    const [list] = currentLists.splice(idx, 1);
    archivedLists.push({ ...list, ...updated });
  }
  renderSidebar();
  renderDetail();
}

async function unarchiveList(id) {
  const updated = await apiFetch(`/lists/${id}/unarchive`, { method: 'POST' });
  const idx = archivedLists.findIndex(l => l.id == id);
  if (idx !== -1) {
    const [list] = archivedLists.splice(idx, 1);
    currentLists.push({ ...list, ...updated });
  }
  renderSidebar();
  renderDetail();
}

async function renameList(id, newName) {
  newName = (newName || '').trim();
  if (!newName) return;
  try {
    await apiFetch(`/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    const nameEl = document.querySelector(`.nav-item[data-id="${id}"] .nav-item-name`);
    if (nameEl) nameEl.textContent = newName;
  } catch (e) {
    showErrorToast(e.message);
  }
}

// ── URL operations ────────────────────────────────────────────────────────────

function normaliseUrl(raw) {
  raw = raw.trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  return raw;
}

async function addUrl(listId, inputEl) {
  const url    = normaliseUrl(inputEl.value);
  const errEl  = document.getElementById('detail-add-error');

  if (!url) {
    errEl.textContent = 'Please enter a URL.';
    errEl.classList.remove('hidden');
    inputEl.focus();
    return;
  }
  // normaliseUrl already prepends https:// if no scheme — no further format check needed
  errEl.classList.add('hidden');

  try {
    await apiFetch(`/lists/${listId}/urls`, { method: 'POST', body: JSON.stringify({ url }) });
    inputEl.value = '';
    await render();
  } catch (e) {
    showErrorToast(e.message);
  }
}

async function removeUrl(listId, urlId) {
  try {
    await apiFetch(`/lists/${listId}/urls/${urlId}`, { method: 'DELETE' });
    await render();
  } catch (e) {
    showErrorToast(e.message);
  }
}

// ── Star / Unstar ─────────────────────────────────────────────────────────────

async function toggleStar() {
  const list = currentLists.find(l => l.id == selectedListId) || sharedListDetails.find(l => l.id == selectedListId);
  if (!list) return;
  try {
    await apiFetch(`/lists/${selectedListId}/star`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: !list.starred }),
    });
    await render();
  } catch (e) {
    showErrorToast(e.message);
  }
}

// ── Workspace sharing (email invite) ─────────────────────────────────────────

async function loadSharedWorkspaces() {
  try {
    sharedWorkspaces = await apiFetch('/lists/shared-with-me');
  } catch { sharedWorkspaces = []; }
  renderSidebar();
}

function renderSharesList() {
  const el = document.getElementById('invite-shares-list');
  el.innerHTML = '';
  currentShares.forEach(share => {
    const row = document.createElement('div');
    row.className = 'invite-share-row';
    const statusCls  = share.status === 'pending' ? 'invite-badge--pending' : 'invite-badge--claimed';
    const statusText = share.status === 'pending' ? 'Pending' : 'Active';
    row.innerHTML = `
      <span class="invite-share-email">${esc(share.recipient_email)}</span>
      <select class="share-perm-select" data-share-id="${share.id}" title="Permission">
        <option value="edit" ${share.permission === 'edit' ? 'selected' : ''}>Can edit</option>
        <option value="view" ${share.permission === 'view' ? 'selected' : ''}>View only</option>
      </select>
      <span class="invite-badge ${statusCls}">${statusText}</span>`;
    el.appendChild(row);
  });
}

async function updateSharePermission(shareId, permission) {
  if (!selectedListId) return;
  try {
    const updated = await apiFetch(`/lists/${selectedListId}/shares/${shareId}`, {
      method: 'PATCH', body: JSON.stringify({ permission }),
    });
    const idx = currentShares.findIndex(s => s.id === shareId);
    if (idx !== -1) currentShares[idx] = updated;
  } catch (e) { showErrorToast(e.message); renderSharesList(); } // revert on error
}

async function loadShares(listId) {
  try {
    currentShares = await apiFetch(`/lists/${listId}/shares`);
  } catch { currentShares = []; }
  renderSharesList();
}

async function submitInvite() {
  const email      = document.getElementById('invite-email').value.trim();
  const permission = document.getElementById('invite-permission').value;
  if (!email || !selectedListId) return;
  const btn = document.getElementById('invite-submit-btn');
  btn.disabled = true; btn.textContent = 'Inviting…';
  try {
    const share = await apiFetch(`/lists/${selectedListId}/share`, {
      method: 'POST', body: JSON.stringify({ email, permission }),
    });
    document.getElementById('invite-email').value = '';
    currentShares = [...currentShares, share];
    renderSharesList();
  } catch (e) { showErrorToast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Invite'; }
}

function openInvitePanel() {
  document.getElementById('invite-panel').classList.remove('hidden');
  document.getElementById('invite-email').focus();
  if (selectedListId) loadShares(selectedListId);
}

function closeInvitePanel() {
  document.getElementById('invite-panel').classList.add('hidden');
  document.getElementById('invite-email').value = '';
  currentShares = [];
  document.getElementById('invite-shares-list').innerHTML = '';
}

// ── Skeleton / loading helpers ────────────────────────────────────────────────

function showSidebarSkeleton() {
  const widths = ['72%', '58%', '80%', '63%'];
  document.getElementById('sidebar-lists').innerHTML = widths.map(w =>
    `<div class="nav-item nav-item--skeleton">
       <div class="skeleton" style="height:11px;border-radius:3px;width:${w};"></div>
     </div>`
  ).join('');
}

function _showDetailSkeleton() {
  _hideAllViews();
  document.getElementById('list-detail').classList.remove('hidden');
  document.getElementById('detail-url-table-header').classList.add('hidden');
  document.getElementById('large-workspace-warning').classList.add('hidden');
  document.getElementById('detail-list-name').value = '';
  document.getElementById('detail-url-count').textContent = '';
  document.getElementById('detail-url-list').innerHTML = [0,1,2,3].map(() =>
    `<li class="skeleton" style="height:52px;border-radius:8px;flex-shrink:0;"></li>`
  ).join('');
}

// ── Billing / trial banner ────────────────────────────────────────────────────

function _isPro(user) {
  if (!user) return false;
  if (user.comped)         return true;
  if (user.plan === 'pro') return true;
  if (user.trial_ends_at) {
    return new Date(user.trial_ends_at) > new Date();
  }
  return false;
}

function showTrialBanner() {
  const bannerEl  = document.getElementById('trial-banner');
  const textEl    = document.getElementById('trial-banner-text');
  const upgradeEl = document.getElementById('trial-upgrade-btn');
  const user      = currentUser;

  const sidebarUpgradeBtn = document.getElementById('sidebar-upgrade-btn');
  if (sidebarUpgradeBtn) sidebarUpgradeBtn.classList.toggle('hidden', !user || user.plan === 'pro' || user.comped);

  if (!user || _isPro(user)) {
    bannerEl.classList.add('hidden');
    return;
  }

  bannerEl.classList.remove('hidden');

  if (user.trial_ends_at) {
    const daysLeft = Math.ceil((new Date(user.trial_ends_at) - new Date()) / 864e5);
    if (daysLeft > 0) {
      textEl.innerHTML =
        `<strong>Free trial:</strong> ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining. ` +
        `Upgrade to Pro to keep full access.`;
      upgradeEl.classList.remove('hidden');
      return;
    }
  }

  // Trial expired, free tier
  textEl.innerHTML =
    `<strong>Trial ended.</strong> You're on the free tier — up to 3 workspaces. ` +
    `Upgrade to Pro for unlimited access.`;
  upgradeEl.classList.remove('hidden');
}

async function _doCheckout(btn) {
  const origText = btn ? btn.textContent : 'Upgrade to Pro';
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
  try {
    const { url } = await apiFetch('/billing/create-checkout-session', { method: 'POST' });
    window.location.href = url;
  } catch (e) {
    showErrorToast(e.message || 'Could not start checkout — please try again.');
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function startUpgrade() {
  _doCheckout(document.getElementById('trial-upgrade-btn'));
}

function openUpgradeModal() {
  document.getElementById('upgrade-modal').classList.remove('hidden');
}

function closeUpgradeModal() {
  document.getElementById('upgrade-modal').classList.add('hidden');
}

// ── Shared Out view ──────────────────────────────────────────────────────────

function showSharedOut() {
  currentView    = 'shared-out';
  selectedListId = null;
  document.getElementById('shared-out-view').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('welcome-state').classList.add('hidden');
  document.getElementById('list-detail').classList.add('hidden');
  document.querySelectorAll('.nav-item--active').forEach(el => el.classList.remove('nav-item--active'));
  document.getElementById('sidebar-shared-out').classList.add('nav-item--active');
  loadSharedOut();
}

async function loadSharedOut() {
  try {
    sharedOutData = await apiFetch('/lists/shared-out');
  } catch { sharedOutData = []; }
  renderSharedOut();
}

function renderSharedOut() {
  const container = document.getElementById('shared-out-list');
  container.innerHTML = '';
  if (sharedOutData.length === 0) {
    container.innerHTML = '<p class="dash-empty-hint">You haven\'t shared any workspaces yet. Open a workspace and use the Invite button to share it with a teammate.</p>';
    return;
  }
  sharedOutData.forEach(ws => {
    const card = document.createElement('div');
    card.className = 'shared-out-card';
    const rows = ws.shares.map(share => {
      const statusCls = share.status === 'pending' ? 'shared-out-badge--pending' : 'shared-out-badge--active';
      const statusTxt = share.status === 'pending' ? 'Pending' : 'Active';
      return `
        <div class="shared-out-recipient-row">
          <span class="shared-out-email" title="${esc(share.recipient_email)}">${esc(share.recipient_email)}</span>
          <select class="shared-out-perm-select" data-share-id="${share.id}" data-ws-id="${ws.id}">
            <option value="edit" ${share.permission === 'edit' ? 'selected' : ''}>Can edit</option>
            <option value="view" ${share.permission === 'view' ? 'selected' : ''}>View only</option>
          </select>
          <span class="shared-out-badge ${statusCls}">${statusTxt}</span>
          <button class="btn-revoke" data-share-id="${share.id}" data-ws-id="${ws.id}">Revoke</button>
        </div>`;
    }).join('');
    card.innerHTML = `
      <div class="shared-out-card-header">
        <span class="shared-out-ws-name" data-ws-id="${ws.id}">${esc(ws.name)}</span>
        <span class="shared-out-ws-count">${ws.shares.length} recipient${ws.shares.length !== 1 ? 's' : ''}</span>
      </div>
      <div>${rows}</div>`;
    container.appendChild(card);
  });
}

// ── Account Settings ─────────────────────────────────────────────────────────

const _WORK_TYPE_LABELS = {
  independent_consultant: 'Independent consultant',
  agency_firm:            'Agency or firm',
  internal_pm:            'Internal project manager',
  it_technical:           'IT or technical team',
  other:                  'Other',
};

function showAccountSettings() {
  currentView    = 'account-settings';
  selectedListId = null;
  document.querySelectorAll('.nav-item--active').forEach(el => el.classList.remove('nav-item--active'));
  document.getElementById('sidebar-account-settings').classList.add('nav-item--active');
  renderDetail();
  loadAccountSettings();
}

async function loadAccountSettings() {
  try {
    const user = await apiFetch('/users/me');
    document.getElementById('settings-email').textContent      = user.email;
    document.getElementById('settings-work-type').textContent  = _WORK_TYPE_LABELS[user.work_type] || user.work_type || 'Not set';
    const d = new Date(user.created_at);
    document.getElementById('settings-created-at').textContent =
      d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const isPayingPro = user.plan === 'pro' || user.comped;
    const subEl = document.getElementById('settings-subscription-content');
    if (isPayingPro) {
      const label = user.comped ? 'Tabrador Pro (Comped)' : 'Tabrador Pro';
      subEl.innerHTML = `
        <div class="settings-row">
          <span class="settings-label">Plan</span>
          <span class="settings-value settings-pro-badge">✓ ${esc(label)}</span>
        </div>`;
    } else {
      const inTrial = user.trial_ends_at && new Date(user.trial_ends_at) > new Date();
      const planLabel = inTrial ? 'Free trial' : 'Free tier';
      subEl.innerHTML = `
        <div class="settings-row">
          <span class="settings-label">Plan</span>
          <span class="settings-value">${esc(planLabel)} · up to 3 workspaces</span>
        </div>
        <p class="settings-upgrade-desc">Upgrade to Tabrador Pro for unlimited workspaces and email sharing with teammates.</p>
        <button class="btn-primary" id="settings-upgrade-btn">Upgrade to Pro</button>`;
      document.getElementById('settings-upgrade-btn').addEventListener('click', function() { _doCheckout(this); });
    }
  } catch { /* silent */ }
}

async function savePassword() {
  const current = document.getElementById('settings-current-pw').value;
  const next    = document.getElementById('settings-new-pw').value;
  const confirm = document.getElementById('settings-confirm-pw').value;
  const btn     = document.getElementById('settings-pw-btn');

  _setSettingsMsg('', '');
  if (!current || !next)  { _setSettingsMsg('Enter your current and new password.', 'error'); return; }
  if (next !== confirm)   { _setSettingsMsg('New passwords do not match.', 'error'); return; }
  if (next.length < 8)    { _setSettingsMsg('New password must be at least 8 characters.', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/users/me/password', {
      method: 'PATCH', body: JSON.stringify({ current_password: current, new_password: next }),
    });
    _setSettingsMsg('Password updated successfully.', 'success');
    document.getElementById('settings-current-pw').value = '';
    document.getElementById('settings-new-pw').value     = '';
    document.getElementById('settings-confirm-pw').value = '';
  } catch (e) {
    _setSettingsMsg(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Password';
  }
}

function _setSettingsMsg(msg, type) {
  const el = document.getElementById('settings-pw-msg');
  el.textContent = msg;
  el.className   = msg ? `settings-inline-msg settings-inline-msg--${type}` : 'settings-inline-msg hidden';
}

async function deleteAccount() {
  const input = document.getElementById('settings-delete-input').value.trim();
  if (input !== 'DELETE') { showErrorToast('Type DELETE in capitals to confirm.'); return; }
  const btn = document.getElementById('settings-delete-confirm-btn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await apiFetch('/users/me', { method: 'DELETE' });
    clearToken();
    currentLists   = [];
    selectedListId = null;
    currentView    = 'dashboard';
    showAuthScreen();
  } catch (e) {
    showErrorToast(e.message);
    btn.disabled = false; btn.textContent = 'Confirm Delete';
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function formatTimeSaved(totalSeconds) {
  if (!totalSeconds) return '0 minutes';
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`;
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0 && hours > 0) return `${days} day${days !== 1 ? 's' : ''} ${hours} hr${hours !== 1 ? 's' : ''}`;
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  if (hours > 0 && minutes > 0)
    return `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

async function loadDashboard() {
  const skeletonEl = document.getElementById('dashboard-skeleton');
  const emptyEl    = document.getElementById('dashboard-empty');
  const contentEl  = document.getElementById('dashboard-content');

  skeletonEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  contentEl.classList.add('hidden');

  try {
    const data = await apiFetch('/users/dashboard');

    if (data.total_workspaces === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    contentEl.classList.remove('hidden');

    const limitBannerEl = document.getElementById('limit-banner');
    if (!_isPro(currentUser) && data.total_workspaces >= 3) {
      limitBannerEl.classList.remove('hidden');
    } else {
      limitBannerEl.classList.add('hidden');
    }

    document.getElementById('dash-time-saved').textContent       = formatTimeSaved(data.time_saved_seconds);
    document.getElementById('dash-time-saved-month').textContent = formatTimeSaved(data.time_saved_month_seconds);
    document.getElementById('dash-time-saved-all').textContent   = formatTimeSaved(data.all_users_time_saved_seconds);
    document.getElementById('dash-num-shared-by').textContent   = data.shared_by_me;
    document.getElementById('dash-num-shared-with').textContent = data.shared_with_me;
    document.getElementById('dash-num-total').textContent       = data.total_workspaces;

    const recentEl = document.getElementById('dash-recent');
    recentEl.innerHTML = '';
    if (data.recent_workspaces.length === 0) {
      recentEl.innerHTML = '<p class="dash-empty-hint">Open a workspace with Start Working to see it here.</p>';
    } else {
      data.recent_workspaces.forEach(ws => {
        const card = document.createElement('div');
        card.className = 'dash-recent-card';

        // Name row (with optional TEAM badge for shared workspaces)
        const nameEl = document.createElement('div');
        nameEl.className = 'dash-recent-name';
        const nameText = document.createElement('span');
        nameText.className = 'dash-recent-name-text';
        nameText.textContent = ws.name;
        nameEl.appendChild(nameText);
        if (ws.is_shared) {
          const badge = document.createElement('span');
          badge.className = 'dash-recent-team-badge';
          badge.textContent = 'Team';
          nameEl.appendChild(badge);
        }
        card.appendChild(nameEl);

        // Meta row
        const metaParts = [`${ws.url_count} resource${ws.url_count !== 1 ? 's' : ''}`];
        if (ws.last_opened) metaParts.push(formatDate(ws.last_opened));
        if (ws.is_shared && ws.shared_by_email) metaParts.push(`from ${ws.shared_by_email.split('@')[0]}`);
        const metaEl = document.createElement('div');
        metaEl.className = 'dash-recent-meta';
        metaEl.textContent = metaParts.join(' · ');
        card.appendChild(metaEl);

        card.addEventListener('click', () => selectList(ws.id));
        recentEl.appendChild(card);
      });
    }
  } catch {
    contentEl.classList.remove('hidden'); // show content area even on error
  } finally {
    skeletonEl.classList.add('hidden');
  }
}

function showDashboard() {
  currentView    = 'dashboard';
  selectedListId = null;
  _hideAllViews();
  document.getElementById('dashboard').classList.remove('hidden');
  document.querySelectorAll('.nav-item--active').forEach(el => el.classList.remove('nav-item--active'));
  document.getElementById('sidebar-home').classList.add('nav-item--active');
  loadDashboard();
}

// ── Start Working / Wrap Up (was Open All / Close All) ───────────────────────
// TIME_TRACKING: when time tracking is added here, use these conventions:
//   "Time logged"    → "Billable hours"
//   "Work session"   → "Client session"
//   "Export"         → "Invoice ready export"

async function openAll() {
  const list = currentLists.find(l => l.id == selectedListId) || sharedListDetails.find(l => l.id == selectedListId);
  if (!list || list.urls.length === 0) return;

  openedLists.add(String(selectedListId));
  activeWorkspaceIds.add(String(selectedListId));
  _saveOpenedLists();
  _saveActiveWorkspaces();
  updateOpenCloseButtons();
  updateActiveIndicators();

  const urls     = list.urls;
  const total    = urls.length;
  const closeBtn = document.getElementById('close-all-btn');

  // Fire-and-forget: record last_opened timestamps for all URLs
  urls.forEach(u => {
    apiFetch(`/lists/${selectedListId}/urls/${u.id}/open`, { method: 'POST' }).catch(() => {});
  });

  trackedWindows[selectedListId] = [];

  for (let i = 0; i < total; i += 10) {
    const batch = urls.slice(i, i + 10);

    batch.forEach(u => {
      const w = safeOpen(u.url, '_blank');
      if (w) trackedWindows[selectedListId].push(w);
    });

    const opened = Math.min(i + 10, total);
    if (total > 10 && opened < total) closeBtn.textContent = `Opening… ${opened} of ${total}`;

    if (i + 10 < total) await new Promise(r => setTimeout(r, 1500));
  }

  if (total > 10) closeBtn.textContent = 'Wrap Up';

  // Return focus to the first tab so the user lands there, not the last one opened.
  if (trackedWindows[selectedListId]?.[0]) trackedWindows[selectedListId][0].focus();

  // Detect popup blocking — if the browser silently refused tabs, warn the user
  const opened = (trackedWindows[selectedListId] || []).length;
  if (opened === 0 && total > 0) {
    showErrorToast(
      'No tabs opened — your browser may be blocking popups. ' +
      'Allow popups for tabrador.app in your browser settings and try again.'
    );
  } else if (opened < total) {
    showErrorToast(
      `${total - opened} tab${total - opened !== 1 ? 's' : ''} couldn\'t be opened — ` +
      'your browser may be blocking some popups. Check your browser settings.'
    );
  }
}

async function toggleUrlStar(listId, urlId, currentStarred) {
  const newStarred = !currentStarred;
  try {
    await apiFetch(`/lists/${listId}/urls/${urlId}/star`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: newStarred }),
    });
    // Optimistic local update — no full re-render needed.
    const list = currentLists.find(l => l.id == listId);
    if (list) { const u = list.urls.find(u => u.id == urlId); if (u) u.starred = newStarred; }
    const btn = document.querySelector(`.url-star[data-list="${listId}"][data-url="${urlId}"]`);
    if (btn) {
      btn.classList.toggle('starred', newStarred);
      btn.textContent     = newStarred ? '★' : '☆';
      btn.title           = newStarred ? 'Unstar' : 'Star';
      btn.dataset.starred = String(newStarred);
    }
  } catch (e) { showErrorToast(e.message); }
}

async function saveNotes(listId, urlId, notes) {
  try {
    await apiFetch(`/lists/${listId}/urls/${urlId}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: notes || null }),
    });
  } catch (e) {
    showErrorToast(e.message);
  }
}

function closeAll() {
  (trackedWindows[selectedListId] || []).forEach(w => { if (w && !w.closed) w.close(); });
  delete trackedWindows[selectedListId];
  openedLists.delete(String(selectedListId));
  activeWorkspaceIds.delete(String(selectedListId));
  _saveOpenedLists();
  _saveActiveWorkspaces();
  updateOpenCloseButtons();
  updateActiveIndicators();
}

function updateOpenCloseButtons() {
  const isOpen = openedLists.has(String(selectedListId));
  document.getElementById('open-all-btn').classList.toggle('hidden', isOpen);
  document.getElementById('close-all-btn').classList.toggle('hidden', !isOpen);
}

function updateActiveIndicators() {
  document.querySelectorAll('.nav-item--working').forEach(el => el.classList.remove('nav-item--working'));
  activeWorkspaceIds.forEach(id => {
    const el = document.querySelector(`.nav-item[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add('nav-item--working');
  });
  const badge = document.getElementById('detail-active-badge');
  if (badge) {
    badge.classList.toggle('hidden', !activeWorkspaceIds.has(String(selectedListId)));
  }
}

// ── Sharing ───────────────────────────────────────────────────────────────────

function encodeList(list) {
  const payload = JSON.stringify({ name: list.name, urls: list.urls.map(u => u.url) });
  return btoa(unescape(encodeURIComponent(payload)));
}

function decodeShareToken(raw) {
  raw = raw.trim();
  const idx = raw.indexOf('#share=');
  if (idx !== -1) raw = raw.slice(idx + '#share='.length);
  if (raw.startsWith('share=')) raw = raw.slice(6);
  return JSON.parse(decodeURIComponent(escape(atob(raw))));
}


let pendingImport = null;

function checkShareLink() {
  if (!location.hash.startsWith('#share=')) return;
  try {
    const token = location.hash.slice('#share='.length);
    pendingImport = decodeShareToken(token);
    const { name, urls } = pendingImport;
    document.getElementById('import-banner-title').textContent = `Shared list: "${name}"`;
    document.getElementById('import-banner-desc').textContent =
      `${urls.length} URL${urls.length !== 1 ? 's' : ''} — click "Add to My Lists" to save it.`;
    document.getElementById('import-banner').classList.remove('hidden');
  } catch { /* malformed token — ignore */ }
}

async function importSharedList() {
  if (!pendingImport) return;
  const { name, urls } = pendingImport;
  try {
    const list = await apiFetch('/lists', { method: 'POST', body: JSON.stringify({ name }) });
    for (const url of urls) {
      await apiFetch(`/lists/${list.id}/urls`, { method: 'POST', body: JSON.stringify({ url }) });
    }
    pendingImport = null;
    dismissImportBanner();
    if (list && list.id) selectedListId = list.id;
    await render();
  } catch (e) {
    showErrorToast(e.message);
  }
}

function dismissImportBanner() {
  document.getElementById('import-banner').classList.add('hidden');
  history.replaceState(null, '', location.pathname + location.search);
}

// ── Snapshot modal ────────────────────────────────────────────────────────────

function openSnapshotModal() {
  document.getElementById('snapshot-modal').classList.remove('hidden');
}

function closeSnapshotModal() {
  document.getElementById('snapshot-modal').classList.add('hidden');
}

// ── Transfer modal (move / copy resource to another workspace) ─────────────────

let _transferMode   = null;  // 'move' | 'copy'
let _transferListId = null;
let _transferUrlId  = null;

function openTransferModal(mode, listId, urlId) {
  _transferMode   = mode;
  _transferListId = listId;
  _transferUrlId  = urlId;

  document.getElementById('transfer-modal-title').textContent =
    mode === 'move' ? 'Move to workspace' : 'Copy to workspace';
  const confirmBtn = document.getElementById('transfer-confirm-btn');
  confirmBtn.textContent = mode === 'move' ? 'Move' : 'Copy';
  confirmBtn.disabled = false;

  const select = document.getElementById('transfer-workspace-select');
  select.innerHTML = '';
  currentLists
    .filter(l => l.id != listId)
    .forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      select.appendChild(opt);
    });

  if (select.options.length === 0) {
    showErrorToast('No other workspaces to transfer to — create one first.');
    return;
  }

  document.getElementById('transfer-modal').classList.remove('hidden');
  select.focus();
}

function closeTransferModal() {
  document.getElementById('transfer-modal').classList.add('hidden');
  _transferMode = _transferListId = _transferUrlId = null;
}

async function confirmTransfer() {
  const destId = document.getElementById('transfer-workspace-select').value;
  if (!destId) return;

  const btn = document.getElementById('transfer-confirm-btn');
  btn.disabled = true;
  btn.textContent = _transferMode === 'move' ? 'Moving…' : 'Copying…';

  try {
    await apiFetch(`/lists/${_transferListId}/urls/${_transferUrlId}/${_transferMode}`, {
      method: 'POST',
      body: JSON.stringify({ dest_list_id: parseInt(destId, 10) }),
    });
    closeTransferModal();
    await render();
    renderDetail();
  } catch (e) {
    showErrorToast(e.message);
    btn.disabled = false;
    btn.textContent = _transferMode === 'move' ? 'Move' : 'Copy';
  }
}

async function importSnapshot() {
  // TERMINOLOGY: "Snapshot" used as fallback workspace name
  const name = document.getElementById('snapshot-list-name').value.trim() || 'Captured Session';
  const raw  = document.getElementById('snapshot-urls').value;
  const urls = raw.split('\n').map(s => normaliseUrl(s)).filter(Boolean);

  if (urls.length === 0) { closeSnapshotModal(); return; }

  try {
    const list = await apiFetch('/lists', { method: 'POST', body: JSON.stringify({ name }) });
    for (const url of urls) {
      await apiFetch(`/lists/${list.id}/urls`, { method: 'POST', body: JSON.stringify({ url }) });
    }
    closeSnapshotModal();
    if (list && list.id) selectedListId = list.id;
    await render();
  } catch (e) {
    showErrorToast(e.message);
  }
}

// ── Error toast ───────────────────────────────────────────────────────────────

function showErrorToast(msg) {
  const toast = document.createElement('div');
  toast.className   = 'error-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Display helpers ───────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const d    = new Date(iso);
  const now  = new Date();
  const tod  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest = new Date(tod - 86400000);
  const day  = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day.getTime() === tod.getTime())  return 'Today';
  if (day.getTime() === yest.getTime()) return 'Yesterday';
  const n = d.getDate();
  const suffix = [,'st','nd','rd'][n % 10 > 3 || ~~(n % 100 / 10) === 1 ? 0 : n % 10] || 'th';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label  = `${months[d.getMonth()]} ${n}${suffix}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

function displayUrl(raw) {
  try {
    const u    = new URL(raw);
    const full = u.hostname + u.pathname + u.search + u.hash;
    return full.length > 80 ? full.slice(0, 80) + '…' : full;
  } catch {
    return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeOpen(url, ...args) {
  try {
    const scheme = new URL(url).protocol;
    if (scheme !== 'http:' && scheme !== 'https:') {
      console.warn('Blocked unsafe URL scheme:', scheme);
      return null;
    }
  } catch {
    console.warn('Blocked malformed URL:', url);
    return null;
  }
  return window.open(url, ...args);
}


// ── Rendering ─────────────────────────────────────────────────────────────────

function buildNavItem(list) {
  const item = document.createElement('div');
  const isWorking = activeWorkspaceIds.has(String(list.id));
  item.className  = 'nav-item'
    + (list.id == selectedListId ? ' nav-item--active' : '')
    + (isWorking ? ' nav-item--working' : '');
  item.dataset.id = list.id;
  item.innerHTML  = `
    <span class="nav-item-name">${esc(list.name)}</span>
    ${list.starred ? '<span class="nav-item-star">★</span>' : ''}
    <span class="nav-item-count">${list.urls.length}</span>
  `;
  item.addEventListener('click', () => selectList(list.id));
  return item;
}

function renderSidebar() {
  const myListsContainer   = document.getElementById('sidebar-lists');
  const teamContainer      = document.getElementById('sidebar-team-workspaces');
  const starredContainer   = document.getElementById('sidebar-starred-lists');
  const archivedContainer  = document.getElementById('sidebar-archived-lists');
  myListsContainer.innerHTML  = '';
  teamContainer.innerHTML     = '';
  starredContainer.innerHTML  = '';
  archivedContainer.innerHTML = '';

  if (currentLists.length === 0) {
    const p = document.createElement('p');
    p.className = 'nav-empty-hint';
    p.innerHTML = 'No workspaces yet&nbsp;&mdash; click&nbsp;<strong style="color:#C5D8F0;">+</strong>&nbsp;above to create one.';
    myListsContainer.appendChild(p);
  } else {
    currentLists.forEach(list => myListsContainer.appendChild(buildNavItem(list)));
  }

  // SHARING: Team Workspaces section — workspaces shared with current user
  if (sharedWorkspaces.length === 0) {
    const p = document.createElement('p');
    p.className   = 'nav-coming-soon';
    p.textContent = 'Nothing shared with you yet.';
    teamContainer.appendChild(p);
  } else {
    sharedWorkspaces.forEach(ws => {
      const item = document.createElement('div');
      item.className  = 'nav-item' + (ws.id == selectedListId ? ' nav-item--active' : '');
      item.dataset.id = ws.id;
      item.innerHTML  = `
        <span class="nav-item-name">${esc(ws.name)}</span>
        <span class="nav-item-count">${ws.url_count}</span>`;
      item.addEventListener('click', () => selectList(ws.id));
      teamContainer.appendChild(item);
    });
  }

  const starred = currentLists.filter(l => l.starred);
  if (starred.length === 0) {
    const p = document.createElement('p');
    p.className   = 'nav-coming-soon';
    p.textContent = 'Star a workspace to pin it here.';
    starredContainer.appendChild(p);
  } else {
    starred.forEach(list => starredContainer.appendChild(buildNavItem(list)));
  }

  if (archivedLists.length === 0) {
    const p = document.createElement('p');
    p.className   = 'nav-coming-soon';
    p.textContent = 'No archived workspaces.';
    archivedContainer.appendChild(p);
  } else {
    archivedLists.forEach(list => archivedContainer.appendChild(buildNavItem(list)));
  }
}

// All top-level content panels — renderDetail always clears then shows only the right one
const _ALL_VIEWS = [
  'dashboard', 'shared-out-view', 'my-workspaces-view',
  'shared-with-me-view', 'account-settings-view', 'welcome-state', 'list-detail',
];
function _hideAllViews() {
  _ALL_VIEWS.forEach(id => document.getElementById(id).classList.add('hidden'));
}

function renderMyWorkspaces() {
  const grid = document.getElementById('my-workspaces-grid');
  grid.innerHTML = '';
  if (currentLists.length === 0) {
    grid.innerHTML = '<p class="dash-empty-hint">No workspaces yet — click + next to My Workspaces in the sidebar to create one.</p>';
    return;
  }
  currentLists.forEach(list => {
    const card = document.createElement('div');
    card.className = 'workspace-grid-card';
    card.innerHTML = `
      <div class="workspace-grid-card-name">${esc(list.name)}</div>
      <div class="workspace-grid-card-meta">${list.urls.length} resource${list.urls.length !== 1 ? 's' : ''}${list.starred ? ' · ★' : ''}</div>`;
    card.addEventListener('click', () => selectList(list.id));
    grid.appendChild(card);
  });
}

function showMyWorkspaces() {
  currentView    = 'my-workspaces';
  selectedListId = null;
  document.querySelectorAll('.nav-item--active').forEach(el => el.classList.remove('nav-item--active'));
  renderDetail();
}

function renderSharedWithMe() {
  const grid = document.getElementById('shared-with-me-grid');
  grid.innerHTML = '';
  if (sharedWorkspaces.length === 0) {
    grid.innerHTML = '<p class="dash-empty-hint">No shared workspaces yet. When a teammate shares a workspace with you, it will appear here.</p>';
    return;
  }
  sharedWorkspaces.forEach(ws => {
    const card = document.createElement('div');
    card.className = 'workspace-grid-card';
    card.innerHTML = `
      <div class="workspace-grid-card-name">${esc(ws.name)}</div>
      <div class="workspace-grid-card-meta">${ws.url_count} resource${ws.url_count !== 1 ? 's' : ''} · from ${esc(ws.shared_by_email.split('@')[0])}</div>`;
    card.addEventListener('click', () => selectList(ws.id));
    grid.appendChild(card);
  });
}

function showSharedWithMe() {
  currentView    = 'shared-with-me';
  selectedListId = null;
  document.querySelectorAll('.nav-item--active').forEach(el => el.classList.remove('nav-item--active'));
  renderDetail();
}

function renderDetail() {
  _hideAllViews();

  if (currentView === 'dashboard') {
    document.getElementById('dashboard').classList.remove('hidden');
    return;
  }
  if (currentView === 'shared-out') {
    document.getElementById('shared-out-view').classList.remove('hidden');
    return;
  }
  if (currentView === 'my-workspaces') {
    document.getElementById('my-workspaces-view').classList.remove('hidden');
    renderMyWorkspaces();
    return;
  }
  if (currentView === 'shared-with-me') {
    document.getElementById('shared-with-me-view').classList.remove('hidden');
    renderSharedWithMe();
    return;
  }
  if (currentView === 'account-settings') {
    document.getElementById('account-settings-view').classList.remove('hidden');
    return;
  }

  // workspace view
  if (!selectedListId) {
    document.getElementById('welcome-state').classList.remove('hidden');
    return;
  }

  const list = currentLists.find(l => l.id == selectedListId)
    || archivedLists.find(l => l.id == selectedListId)
    || sharedListDetails.find(l => l.id == selectedListId);
  if (!list) {
    selectedListId = null;
    document.getElementById('welcome-state').classList.remove('hidden');
    return;
  }

  const isArchived = !!list.archived;
  document.getElementById('archive-list-btn').textContent =
    isArchived ? 'Unarchive Workspace' : 'Archive Workspace';
  document.getElementById('detail-archived-badge').classList.toggle('hidden', !isArchived);

  const welcomeEl = document.getElementById('welcome-state');
  const detailEl  = document.getElementById('list-detail');
  detailEl.classList.remove('hidden');

  closeInvitePanel(); // reset invite state when switching workspaces

  document.getElementById('detail-list-name').value  = list.name;
  // TERMINOLOGY: "resource(s)" was "URL(s)"
  document.getElementById('detail-url-count').textContent =
    `${list.urls.length} resource${list.urls.length !== 1 ? 's' : ''}`;

  const starBtn = document.getElementById('star-btn');
  starBtn.textContent = list.starred ? '★ Starred' : '☆ Star';
  starBtn.classList.toggle('starred', list.starred);

  updateOpenCloseButtons();
  updateActiveIndicators();

  const warningEl = document.getElementById('large-workspace-warning');
  if (list.urls.length > 30 && !dismissedLargeWarning.has(selectedListId)) {
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }

  const tableHeader = document.getElementById('detail-url-table-header');
  const urlList     = document.getElementById('detail-url-list');
  urlList.innerHTML = '';

  if (list.urls.length === 0) {
    tableHeader.classList.add('hidden');
    urlList.innerHTML = `
      <li class="detail-empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24"
             fill="none" stroke="#C5D8F0" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"
             style="margin-bottom:0.5rem;">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <strong>This workspace is empty</strong>
        <p>Add your first resource to get started.<br>Paste a URL in the field below and press Enter.</p>
      </li>`;
  } else {
    tableHeader.classList.remove('hidden');
    list.urls.forEach(u => {
      const li        = document.createElement('li');
      li.className    = 'detail-url-item';
      const linkText  = u.title ? esc(u.title) : esc(displayUrl(u.url));
      const addedBy   = u.added_by_email
        ? esc(u.added_by_email.split('@')[0])
        : '—';
      const addedByFull = u.added_by_email ? esc(u.added_by_email) : '';
      const lastOpened  = u.last_opened ? formatDate(u.last_opened) : '—';
      const starred     = u.starred || false;

      li.innerHTML = `
        <div class="url-row">
          <div class="url-col-title">
            <a href="${esc(u.url)}" target="_blank" rel="noopener"
               class="detail-url-link" title="${esc(u.url)}"
               data-list="${list.id}" data-url="${u.id}">${linkText}</a>
          </div>
          <div class="url-col-addedby" title="${addedByFull}">${addedBy}</div>
          <div class="url-col-lastopened">${lastOpened}</div>
          <div class="url-col-actions">
            <button class="url-action-btn url-open"
                    data-href="${esc(u.url)}" data-list="${list.id}" data-url="${u.id}"
                    title="Open in new tab">↗</button>
            <button class="url-action-btn url-move"
                    data-list="${list.id}" data-url="${u.id}"
                    title="Move to another workspace">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
                <path d="M1 8h7"/><path d="M5.5 5l2.5 3-2.5 3"/>
                <rect x="9.5" y="3.5" width="5" height="9" rx="1"/>
              </svg>
            </button>
            <button class="url-action-btn url-copy"
                    data-list="${list.id}" data-url="${u.id}"
                    title="Copy to another workspace">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
                <rect x="5" y="5" width="9" height="9" rx="1"/>
                <path d="M4 11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/>
              </svg>
            </button>
            <button class="url-action-btn url-star ${starred ? 'starred' : ''}"
                    data-list="${list.id}" data-url="${u.id}" data-starred="${starred}"
                    title="${starred ? 'Unstar' : 'Star'}">${starred ? '★' : '☆'}</button>
            <button class="url-action-btn url-remove remove-url"
                    data-list="${list.id}" data-url="${u.id}"
                    title="Remove">×</button>
          </div>
        </div>
        <div class="url-notes-row">
          <input type="text" class="url-notes-input"
                 placeholder="Resource notes…"
                 value="${esc(u.notes || '')}"
                 data-list="${list.id}" data-url="${u.id}" />
        </div>
      `;
      urlList.appendChild(li);
    });
  }
}

async function selectList(id) {
  selectedListId = id;
  currentView    = 'workspace';
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('shared-out-view').classList.add('hidden');

  // If this workspace isn't in currentLists (i.e. it's shared with us, not owned),
  // fetch the full data and cache it so renderDetail can find it.
  if (!currentLists.find(l => l.id == id)) {
    _showDetailSkeleton(); // show skeleton rows while the fetch completes
    try {
      const full = await apiFetch(`/lists/${id}`);
      const idx  = sharedListDetails.findIndex(l => l.id == id);
      if (idx >= 0) sharedListDetails[idx] = full;
      else sharedListDetails.push(full);
    } catch (e) {
      showErrorToast(e.message);
      return;
    }
  }

  renderSidebar();
  renderDetail();
}

let _firstRender = true;

async function render() {
  try {
    [currentLists, archivedLists] = await Promise.all([
      apiFetch('/lists'),
      apiFetch('/lists/archived').catch(() => []),
    ]);
    _firstRender = false;
  } catch (e) {
    _firstRender = false;
    if (currentView === 'workspace' && selectedListId) {
      showErrorToast(e.message || 'Couldn\'t load your workspaces — please refresh.');
    }
    return;
  }
  // If a shared (non-owned) workspace is currently open, refresh its cached data
  if (selectedListId && !currentLists.find(l => l.id == selectedListId) || sharedListDetails.find(l => l.id == selectedListId)) {
    const idx = sharedListDetails.findIndex(l => l.id == selectedListId);
    if (idx >= 0) {
      try {
        sharedListDetails[idx] = await apiFetch(`/lists/${selectedListId}`);
      } catch { /* non-fatal */ }
    }
  }
  renderSidebar();
  renderDetail();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('tab-login').addEventListener('click',    () => setAuthMode('login'));
document.getElementById('tab-register').addEventListener('click', () => setAuthMode('register'));
document.getElementById('auth-submit').addEventListener('click',  submitAuth);
document.getElementById('logout-btn').addEventListener('click',   logout);

document.getElementById('forgot-link').addEventListener('click', () => setAuthMode('forgot'));
document.getElementById('forgot-back-link').addEventListener('click', () => {
  // Reset the forgot-password form to its initial state when navigating away
  document.getElementById('forgot-form').classList.remove('hidden');
  document.getElementById('forgot-success').classList.add('hidden');
  document.getElementById('forgot-email').value = '';
  setAuthMode('login');
});
document.getElementById('reset-back-link').addEventListener('click',  () => setAuthMode('login'));
document.getElementById('forgot-submit').addEventListener('click', submitForgot);
document.getElementById('reset-submit').addEventListener('click', submitReset);
document.getElementById('forgot-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('forgot-submit').click();
});
document.getElementById('reset-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('reset-password-confirm').focus();
});
document.getElementById('reset-password-confirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('reset-submit').click();
});

document.getElementById('auth-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-password').focus();
});
document.getElementById('auth-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAuth();
});

document.getElementById('new-list-btn').addEventListener('click', () => {
  const form = document.getElementById('new-list-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById('new-list-name').focus();
});

document.getElementById('cancel-new-list-btn').addEventListener('click', () => {
  document.getElementById('new-list-form').classList.add('hidden');
  document.getElementById('new-list-name').value = '';
});

document.getElementById('create-list-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-list-name');
  if (!input.value.trim()) return;
  const name = input.value.trim();
  const btn  = document.getElementById('create-list-btn');
  btn.disabled = true; btn.textContent = '…';
  input.value = '';
  document.getElementById('new-list-form').classList.add('hidden');
  await createList(name);
  btn.disabled = false; btn.textContent = 'Create';
});

document.getElementById('new-list-name').addEventListener('keydown', e => {
  if (e.key === 'Enter')  document.getElementById('create-list-btn').click();
  if (e.key === 'Escape') document.getElementById('cancel-new-list-btn').click();
});

document.getElementById('open-all-btn').addEventListener('click', openAll);
document.getElementById('close-all-btn').addEventListener('click', closeAll);
document.getElementById('dismiss-large-warning').addEventListener('click', () => {
  dismissedLargeWarning.add(selectedListId);
  document.getElementById('large-workspace-warning').classList.add('hidden');
});
document.getElementById('star-btn').addEventListener('click', toggleStar);
document.getElementById('invite-btn').addEventListener('click', openInvitePanel);
document.getElementById('invite-close-btn').addEventListener('click', closeInvitePanel);
document.getElementById('invite-submit-btn').addEventListener('click', submitInvite);
document.getElementById('invite-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitInvite();
  if (e.key === 'Escape') closeInvitePanel();
});
document.getElementById('invite-shares-list').addEventListener('change', e => {
  const sel = e.target.closest('.share-perm-select');
  if (sel) updateSharePermission(parseInt(sel.dataset.shareId), sel.value);
});

// Overflow menu toggle
document.getElementById('detail-overflow-btn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('detail-overflow-menu').classList.toggle('hidden');
});
document.addEventListener('click', () => {
  document.getElementById('detail-overflow-menu').classList.add('hidden');
});

// Archive / Unarchive
document.getElementById('archive-list-btn').addEventListener('click', async () => {
  if (!selectedListId) return;
  document.getElementById('detail-overflow-menu').classList.add('hidden');
  const isArchived = archivedLists.some(l => l.id == selectedListId);
  const btn = document.getElementById('archive-list-btn');
  btn.disabled = true;
  try {
    if (isArchived) await unarchiveList(selectedListId);
    else            await archiveList(selectedListId);
  } catch (e) { showErrorToast(e.message); }
  btn.disabled = false;
});

// Delete — open confirmation modal
document.getElementById('delete-list-btn').addEventListener('click', () => {
  if (!selectedListId) return;
  const list = currentLists.find(l => l.id == selectedListId)
    || archivedLists.find(l => l.id == selectedListId);
  const name = list ? list.name : 'this workspace';
  document.getElementById('delete-confirm-body').textContent =
    `Are you sure you want to delete "${name}"? This cannot be undone.`;
  document.getElementById('delete-confirm-modal').classList.remove('hidden');
});

function closeDeleteConfirmModal() {
  document.getElementById('delete-confirm-modal').classList.add('hidden');
}

document.getElementById('delete-confirm-cancel').addEventListener('click', closeDeleteConfirmModal);
document.getElementById('delete-confirm-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeleteConfirmModal();
});

document.getElementById('delete-confirm-ok').addEventListener('click', async () => {
  if (!selectedListId) return;
  const btn = document.getElementById('delete-confirm-ok');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await deleteList(selectedListId);
    closeDeleteConfirmModal();
  } catch (e) {
    showErrorToast(e.message);
    btn.disabled = false; btn.textContent = 'Delete';
  }
});

document.getElementById('detail-list-name').addEventListener('change', async e => {
  if (selectedListId) await renameList(selectedListId, e.target.value);
});
document.getElementById('detail-list-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') e.target.blur();
});
document.getElementById('detail-edit-btn').addEventListener('click', () => {
  const input = document.getElementById('detail-list-name');
  input.focus();
  input.select();
});

document.getElementById('detail-add-btn').addEventListener('click', async () => {
  if (!selectedListId) return;
  const btn = document.getElementById('detail-add-btn');
  btn.disabled = true; btn.textContent = '…';
  await addUrl(selectedListId, document.getElementById('detail-add-url'));
  btn.disabled = false; btn.textContent = 'Add Resource';
});
document.getElementById('detail-add-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('detail-add-btn').click();
});

document.getElementById('detail-url-list').addEventListener('click', async e => {
  const removeBtn = e.target.closest('.url-remove');
  if (removeBtn) { await removeUrl(removeBtn.dataset.list, removeBtn.dataset.url); return; }

  const openBtn = e.target.closest('.url-open');
  if (openBtn) {
    safeOpen(openBtn.dataset.href, '_blank', 'noopener');
    apiFetch(`/lists/${openBtn.dataset.list}/urls/${openBtn.dataset.url}/open`, { method: 'POST' })
      .then(() => render()).catch(() => {});
    return;
  }

  const moveBtn = e.target.closest('.url-move');
  if (moveBtn) { openTransferModal('move', moveBtn.dataset.list, moveBtn.dataset.url); return; }

  const copyBtn = e.target.closest('.url-copy');
  if (copyBtn) { openTransferModal('copy', copyBtn.dataset.list, copyBtn.dataset.url); return; }

  const starBtn = e.target.closest('.url-star');
  if (starBtn) {
    await toggleUrlStar(starBtn.dataset.list, starBtn.dataset.url, starBtn.dataset.starred === 'true');
    return;
  }

  const link = e.target.closest('a.detail-url-link');
  if (link) {
    apiFetch(`/lists/${link.dataset.list}/urls/${link.dataset.url}/open`, { method: 'POST' })
      .then(() => render()).catch(() => {});
  }
});

document.getElementById('detail-url-list').addEventListener('blur', async e => {
  const input = e.target.closest('.url-notes-input');
  if (input) await saveNotes(input.dataset.list, input.dataset.url, input.value.trim());
}, true);

document.getElementById('snapshot-btn').addEventListener('click', openSnapshotModal);
document.getElementById('modal-cancel').addEventListener('click', closeSnapshotModal);
document.getElementById('snapshot-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSnapshotModal();
});
document.getElementById('snapshot-modal').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSnapshotModal();
});

document.getElementById('transfer-cancel-btn').addEventListener('click', closeTransferModal);
document.getElementById('transfer-confirm-btn').addEventListener('click', confirmTransfer);
document.getElementById('transfer-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeTransferModal();
});
document.getElementById('transfer-modal').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTransferModal();
});

document.getElementById('banner-import-btn').addEventListener('click',  importSharedList);
document.getElementById('banner-dismiss-btn').addEventListener('click', dismissImportBanner);

// ONBOARDING: role selection buttons
document.querySelectorAll('.onboarding-option').forEach(btn => {
  btn.addEventListener('click', () => completeOnboarding(btn.dataset.type));
});
document.getElementById('onboarding-skip').addEventListener('click', () => completeOnboarding(null));

// ACCOUNT SETTINGS
document.getElementById('sidebar-account-settings').addEventListener('click', showAccountSettings);
document.getElementById('settings-pw-btn').addEventListener('click', savePassword);
document.getElementById('settings-confirm-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') savePassword();
});
document.getElementById('settings-delete-btn').addEventListener('click', () => {
  document.getElementById('settings-delete-btn').classList.add('hidden');
  document.getElementById('settings-delete-confirm').classList.remove('hidden');
  document.getElementById('settings-delete-input').focus();
});
document.getElementById('settings-delete-cancel-btn').addEventListener('click', () => {
  document.getElementById('settings-delete-confirm').classList.add('hidden');
  document.getElementById('settings-delete-btn').classList.remove('hidden');
  document.getElementById('settings-delete-input').value = '';
});
document.getElementById('settings-delete-confirm-btn').addEventListener('click', deleteAccount);
document.getElementById('settings-delete-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') deleteAccount();
});

// DASHBOARD: sidebar home link + metric tiles + empty-state create button
document.getElementById('sidebar-home').addEventListener('click', showDashboard);
document.getElementById('dashboard-create-btn').addEventListener('click', () => {
  // Open the new-workspace form in the sidebar
  const form = document.getElementById('new-list-form');
  form.classList.remove('hidden');
  document.getElementById('new-list-name').focus();
});
document.getElementById('sidebar-shared-out').addEventListener('click', showSharedOut);
document.getElementById('dash-tile-shared-by').addEventListener('click', showSharedOut);
document.getElementById('dash-tile-shared-with').addEventListener('click', showSharedWithMe);
document.getElementById('dash-tile-total').addEventListener('click', showMyWorkspaces);

// SHARED OUT: permission change and revoke
document.getElementById('shared-out-list').addEventListener('change', async e => {
  const sel = e.target.closest('.shared-out-perm-select');
  if (!sel) return;
  const shareId = parseInt(sel.dataset.shareId);
  const wsId    = parseInt(sel.dataset.wsId);
  try {
    await apiFetch(`/lists/${wsId}/shares/${shareId}`, {
      method: 'PATCH', body: JSON.stringify({ permission: sel.value }),
    });
    const ws = sharedOutData.find(w => w.id == wsId);
    if (ws) { const s = ws.shares.find(s => s.id == shareId); if (s) s.permission = sel.value; }
  } catch (e) { showErrorToast(e.message); loadSharedOut(); }
});

document.getElementById('shared-out-list').addEventListener('click', async e => {
  const revokeBtn = e.target.closest('.btn-revoke');
  if (revokeBtn) {
    const shareId = parseInt(revokeBtn.dataset.shareId);
    const wsId    = parseInt(revokeBtn.dataset.wsId);
    revokeBtn.disabled = true; revokeBtn.textContent = '…';
    try {
      await apiFetch(`/lists/${wsId}/shares/${shareId}`, { method: 'DELETE' });
      const ws = sharedOutData.find(w => w.id == wsId);
      if (ws) {
        ws.shares = ws.shares.filter(s => s.id !== shareId);
        if (ws.shares.length === 0) sharedOutData = sharedOutData.filter(w => w.id !== wsId);
      }
      renderSharedOut();
      await loadSharedWorkspaces(); // refresh Team Workspaces sidebar for recipient
    } catch (e) { showErrorToast(e.message); loadSharedOut(); }
    return;
  }
  const wsName = e.target.closest('.shared-out-ws-name');
  if (wsName) selectList(parseInt(wsName.dataset.wsId));
});

// BILLING: upgrade button in trial banner
document.getElementById('trial-upgrade-btn').addEventListener('click', startUpgrade);

// Upgrade modal
document.getElementById('upgrade-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('upgrade-modal')) closeUpgradeModal();
});
document.getElementById('upgrade-modal-cancel').addEventListener('click', closeUpgradeModal);
document.getElementById('upgrade-modal-ok').addEventListener('click', function() { _doCheckout(this); });

// Limit banner upgrade button
document.getElementById('limit-upgrade-btn').addEventListener('click', function() { _doCheckout(this); });

// Sidebar upgrade button
document.getElementById('sidebar-upgrade-btn').addEventListener('click', function() { _doCheckout(this); });

// TEMPLATE: template picker
document.getElementById('template-btn').addEventListener('click', openTemplateModal);
document.getElementById('template-cancel').addEventListener('click', closeTemplateModal);
document.getElementById('template-modal').addEventListener('click', e => {
  const card = e.target.closest('.template-card');
  if (card) createFromTemplate(card.dataset.template);
  if (e.target === e.currentTarget) closeTemplateModal();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  const bootEl = document.getElementById('boot-loader');

  const params     = new URLSearchParams(location.search);
  const resetToken = params.get('token') || params.get('reset_token');
  if (resetToken) {
    document.getElementById('reset-token').value = resetToken;
    showAuthScreen();
    setAuthMode('reset');
    history.replaceState(null, '', location.pathname);
    bootEl.classList.add('hidden');
    return;
  }

  const token = getToken();
  if (!token) {
    showAuthScreen();
    bootEl.classList.add('hidden');
    return;
  }

  try {
    const user = await apiFetch('/users/me');
    currentUser = user;             // BILLING: store for trial banner checks
    showApp(user.email);
    showSidebarSkeleton();          // show skeleton items in sidebar
    showTrialBanner();              // show trial/upgrade banner if applicable
    bootEl.classList.add('hidden'); // user now sees app with skeleton
    await render();                 // lists load → skeleton replaced with real items
    await loadSharedWorkspaces();
    showDashboard();                // triggers loadDashboard() which shows its own skeleton
    checkShareLink();
  } catch {
    // apiFetch clears the token on 401 — if it's gone now, the session expired.
    // Any other failure (network, server) shows a different message.
    const wasAuthFailure = !getToken();
    showAuthScreen();
    setAuthError(
      wasAuthFailure
        ? 'Your session expired — please log in again.'
        : 'Connection error — please check your internet and try again.'
    );
    bootEl.classList.add('hidden');
  }
}

boot();