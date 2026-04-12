let items = [];
let claims = [];
let matches = [];
let API_BASE = '';
let CSRF_TOKEN = '';
let ADMIN_API_KEY = '';
const API_BASE_STORAGE_KEY = 'founduApiBase';
const ADMIN_KEY_STORAGE_KEY = 'founduAdminApiKey';
const ADMIN_KEY_COOKIE_NAME = 'foundu_admin_api_key';
const ADMIN_KEY_COOKIE_DAYS = 30;
const PIE_COLORS = ['#1f77ff', '#e53935', '#2bb673', '#f0b429', '#7e57c2', '#00a8a8', '#ff7f50', '#546e7a'];

function setCookie(name, value, days = 30) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${secure}`;
}

function getCookie(name) {
  const encodedName = `${encodeURIComponent(name)}=`;
  const cookies = document.cookie ? document.cookie.split('; ') : [];

  for (const cookie of cookies) {
    if (cookie.startsWith(encodedName)) {
      return decodeURIComponent(cookie.slice(encodedName.length));
    }
  }

  return '';
}

function deleteCookie(name) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax${secure}`;
}

function showTextInputDialog(options = {}) {
  const {
    title = 'Input Required',
    message = '',
    defaultValue = '',
    placeholder = '',
    confirmText = 'Submit',
    cancelText = 'Cancel',
    required = false,
    multiline = false,
    secret = false
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:16px',
      'background:rgba(15,23,42,0.45)'
    ].join(';');

    const dialog = document.createElement('div');
    dialog.style.cssText = [
      'width:min(92vw,480px)',
      'max-height:calc(100vh - 32px)',
      'overflow:auto',
      'background:#ffffff',
      'border:1px solid #dbe6f3',
      'border-radius:16px',
      'padding:16px',
      'box-shadow:0 24px 44px rgba(15,23,42,0.22)'
    ].join(';');

    const heading = document.createElement('h3');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 8px;font-size:18px;color:#0f172a;';

    const text = document.createElement('p');
    text.textContent = message;
    text.style.cssText = 'margin:0 0 12px;font-size:14px;color:#475569;line-height:1.5;';

    const field = multiline
      ? document.createElement('textarea')
      : document.createElement('input');

    if (!multiline) {
      field.type = secret ? 'password' : 'text';
    }

    field.value = defaultValue;
    field.placeholder = placeholder;
    field.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'border:1px solid #cbd5e1',
      'border-radius:10px',
      'padding:10px 12px',
      'font-size:14px',
      'font-family:inherit',
      multiline ? 'min-height:92px' : 'min-height:42px'
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = cancelText;
    cancelBtn.style.cssText = 'border:1px solid #cbd5e1;background:#ffffff;color:#475569;padding:8px 12px;border-radius:10px;cursor:pointer;';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = confirmText;
    confirmBtn.style.cssText = 'border:none;background:#1f77ff;color:#ffffff;padding:8px 12px;border-radius:10px;cursor:pointer;';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    dialog.appendChild(heading);
    if (message) {
      dialog.appendChild(text);
    }
    dialog.appendChild(field);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (value) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };

    const submit = () => {
      const value = field.value.trim();
      if (required && !value) {
        field.focus();
        field.style.borderColor = '#dc2626';
        return;
      }
      close(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        close(null);
      }

      if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        submit();
      }
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });

    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', submit);
    document.addEventListener('keydown', onKeyDown);

    setTimeout(() => field.focus(), 0);
  });
}

function getApiCandidates() {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname;
  const savedBase = (localStorage.getItem(API_BASE_STORAGE_KEY) || '').trim();
  const urlParams = new URLSearchParams(window.location.search);
  const urlBase = (urlParams.get('apiBase') || urlParams.get('api') || '').trim().replace(/\/$/, '');
  const sameOriginBase = window.location.origin || '';
  const isLocalPage = host === 'localhost' || host === '127.0.0.1';
  const candidates = isLocalPage
    ? [urlBase, savedBase, sameOriginBase, `${protocol}//${host}:3000`, 'http://127.0.0.1:3000', 'http://localhost:3000', '']
    : [urlBase, savedBase, sameOriginBase, ''];

  if (host) {
    candidates.push(`${protocol}//${host}:3000`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function tryApiBase(base) {
  const response = await fetch(`${base}/api/health`, {
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`API health check failed (${response.status})`);
  }

  API_BASE = base;
  localStorage.setItem(API_BASE_STORAGE_KEY, base);
}

async function resolveApiBase() {
  const candidates = getApiCandidates();
  const errors = [];
  for (const base of candidates) {
    try {
      await tryApiBase(base);
      return;
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }

  console.error('[admin] API auto-detection failed. Tried:', errors);

  throw new Error('Cannot connect to API server. Start backend on http://127.0.0.1:3000 (run: npm run start).');
}

async function fetchCsrfToken() {
  const response = await fetch(`${API_BASE}/api/csrf-token`, {
    credentials: 'include'
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch CSRF token (${response.status})`);
  }

  const payload = await response.json();
  CSRF_TOKEN = payload.token || '';
  if (!CSRF_TOKEN) {
    throw new Error('Server did not provide CSRF token');
  }
}

async function loadAdminApiKey() {
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = (urlParams.get('adminKey') || urlParams.get('key') || '').trim();
  const fromCookie = getCookie(ADMIN_KEY_COOKIE_NAME).trim();
  const fromStorage = (localStorage.getItem(ADMIN_KEY_STORAGE_KEY) || '').trim();
  const saved = fromUrl || fromCookie || fromStorage;

  if (saved) {
    ADMIN_API_KEY = saved;
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, saved);
    if (!fromCookie) {
      setCookie(ADMIN_KEY_COOKIE_NAME, saved, ADMIN_KEY_COOKIE_DAYS);
    }
    return;
  }

  const provided = await showTextInputDialog({
    title: 'Admin API Key Required',
    message: `Enter admin API key for ${API_BASE || 'this server'}.`,
    placeholder: 'Admin API key',
    confirmText: 'Continue',
    required: true,
    secret: true
  });

  if (provided === null) {
    throw new Error('Admin API key is required');
  }

  ADMIN_API_KEY = provided.trim();
  if (!ADMIN_API_KEY) {
    throw new Error('Admin API key is required');
  }

  localStorage.setItem(ADMIN_KEY_STORAGE_KEY, ADMIN_API_KEY);
  setCookie(ADMIN_KEY_COOKIE_NAME, ADMIN_API_KEY, ADMIN_KEY_COOKIE_DAYS);
}

function clearAdminApiKey() {
  ADMIN_API_KEY = '';
  localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
  deleteCookie(ADMIN_KEY_COOKIE_NAME);
}

async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };

  if (path.startsWith('/api/admin')) {
    headers['X-Admin-Key'] = ADMIN_API_KEY;
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers['X-CSRF-Token'] = CSRF_TOKEN;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const url = `${API_BASE}${path}`;
  try {
    return await fetch(url, {
      ...options,
      method,
      headers,
      credentials: 'include'
    });
  } catch (error) {
    console.error(`[admin] Network error for ${method} ${url}:`, error);
    throw error;
  }
}

function getStatusClass(status) {
  return status === 'approved' ? 'status approved' : 'status pending';
}

function loadItems() {
  const table = document.getElementById('itemTable');
  table.innerHTML = '';

  if (items.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="10">No reports found.</td>`;
    table.appendChild(row);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.id}</td>
      <td><span class="${getStatusClass(item.status)}">${item.status}</span></td>
      <td>${item.type || '-'}</td>
      <td>${item.cat || '-'}</td>
      <td>${item.title}</td>
      <td>${item.desc}</td>
      <td>${item.loc}</td>
      <td>${item.contact}</td>
      <td>${item.date}</td>
      <td>
        ${item.status !== 'approved' ? `<button class="action-btn approve" onclick="approveItem(${item.id})">Approve Post</button>` : ''}
        <button class="action-btn delete" onclick="deleteItem(${item.id})">Delete</button>
      </td>
    `;
    table.appendChild(row);
  });
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function getClaimStatusClass(status) {
  const normalizedStatus = normalizeClaimStatus(status);

  if (normalizedStatus === 'pending') {
    return 'status pending';
  }

  if (normalizedStatus === 'rejected') {
    return 'status pending';
  }

  return 'status approved';
}

function normalizeClaimStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'approved') {
    return 'verified';
  }

  return normalized;
}

function normalizeClaimType(type) {
  return String(type || '').trim().toLowerCase();
}

function formatClaimDisplayId(id) {
  const numericId = Number(id);
  if (Number.isNaN(numericId)) {
    return String(id || '-');
  }

  return String(numericId).padStart(2, '0');
}

function findClaimById(claimId) {
  const normalizedId = String(claimId);
  return claims.find((entry) => String(entry.id) === normalizedId);
}

function getClaimStatusLabel(status) {
  const normalizedStatus = normalizeClaimStatus(status);

  if (normalizedStatus === 'pending') {
    return 'PENDING';
  }

  if (normalizedStatus === 'verified') {
    return 'VERIFIED';
  }

  if (normalizedStatus === 'rejected') {
    return 'REJECTED';
  }

  if (normalizedStatus === 'certificate_issued') {
    return 'CERTIFICATE_ISSUED';
  }

  return String(status || '').toUpperCase() || '-';
}

function getMatchStatusClass(status) {
  if (status === 'approved') {
    return 'status approved';
  }

  if (status === 'rejected') {
    return 'status pending';
  }

  return 'status pending';
}

function daysBetween(dateA, dateB) {
  const first = new Date(dateA);
  const second = new Date(dateB);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) {
    return '-';
  }

  const diff = Math.abs(first.getTime() - second.getTime()) / (1000 * 60 * 60 * 24);
  return diff.toFixed(1);
}

function loadClaims() {
  const table = document.getElementById('claimTable');
  const badge = document.getElementById('claim-badge');
  const pendingCount = claims.filter((claim) => normalizeClaimStatus(claim.status) === 'pending').length;

  badge.textContent = String(pendingCount);
  badge.classList.toggle('hidden', pendingCount === 0);

  table.innerHTML = '';

  if (claims.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="14">No ownership requests.</td>';
    table.appendChild(row);
    return;
  }

  claims.forEach((claim) => {
    const claimStatus = normalizeClaimStatus(claim.status);
    const claimType = normalizeClaimType(claim.type);
    const isPending = claimStatus === 'pending';
    const isVerified = claimStatus === 'verified';
    const isCertificateIssued = claimStatus === 'certificate_issued';
    const canIssueCertificate = claimType === 'found' && isVerified;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatClaimDisplayId(claim.id)}</td>
      <td>${claim.type || '-'}</td>
      <td>${claim.cat || '-'}</td>
      <td>${claim.title}</td>
      <td>${claim.claimant_name || '-'}</td>
      <td>${claim.claimant_student_id || '-'}</td>
      <td>${claim.claim_message || '-'}</td>
      <td>${claim.proof_image ? `<button class="action-btn" onclick="viewProof(${claim.id})">View Proof</button>` : '-'}</td>
      <td>${claim.loc}</td>
      <td>${formatDateTime(claim.requested_at)}</td>
      <td><span class="${getClaimStatusClass(claim.status)}">${getClaimStatusLabel(claim.status)}</span></td>
      <td>${claim.admin_note || '-'}</td>
      <td>${claimType === 'found' ? (claim.cert_name || '-') : '-'}</td>
      <td>
        ${isPending ? `<button class="action-btn approve" onclick="verifyClaim(${claim.id})">Verify Claim</button>` : ''}
        ${isPending ? `<button class="action-btn delete" onclick="rejectClaim(${claim.id})">Reject</button>` : ''}
        ${(canIssueCertificate && !isCertificateIssued) ? `<button class="action-btn approve" onclick="issueCertificate(${claim.id})">Issue Certificate</button>` : ''}
      </td>
    `;
    table.appendChild(row);
  });
}

function loadMatches() {
  const table = document.getElementById('matchTable');
  table.innerHTML = '';

  if (matches.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="12">No system-detected matches yet.</td>';
    table.appendChild(row);
    return;
  }

  matches.forEach((match) => {
    const keywordText = Array.isArray(match.matched_keywords) && match.matched_keywords.length > 0
      ? match.matched_keywords.slice(0, 6).join(', ')
      : '-';

    const score = Number(match.score || 0).toFixed(1);
    const sourceLabel = `#${match.source_item_id} ${match.source_title || '-'}`;
    const targetLabel = `#${match.target_item_id} ${match.target_title || '-'}`;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${match.id}</td>
      <td><span class="status approved">${score}%</span></td>
      <td><span class="${getMatchStatusClass(match.status)}">${match.status}</span></td>
      <td>${sourceLabel}</td>
      <td>${targetLabel}</td>
      <td>${match.source_cat || match.target_cat || '-'}</td>
      <td>${match.source_loc || '-'} / ${match.target_loc || '-'}</td>
      <td>${daysBetween(match.source_date, match.target_date)} day(s)</td>
      <td>${keywordText}</td>
      <td>${formatDateTime(match.requested_at)}</td>
      <td>${formatDateTime(match.reviewed_at)}</td>
      <td>
        ${match.status === 'pending' ? `<button class="action-btn approve" onclick="approveMatch(${match.id})">Approve Match</button>` : ''}
        ${match.status === 'pending' ? `<button class="action-btn delete" onclick="rejectMatch(${match.id})">Reject Match</button>` : ''}
        <button class="action-btn" onclick="viewMatchDetails(${match.id})">View</button>
      </td>
    `;

    table.appendChild(row);
  });
}

function viewProof(claimId) {
  const claim = findClaimById(claimId);
  if (!claim || !claim.proof_image) {
    alert('No proof image available for this claim.');
    return;
  }

  const win = window.open('', '_blank', 'width=860,height=700');
  if (!win) {
    alert('Popup blocked. Please allow popups to view proof image.');
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Claim Proof</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 24px; background: #f4f7fb; color: #1f2937; }
    .sheet { max-width: 780px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 14px 30px rgba(16, 24, 40, 0.12); }
    h1 { margin: 0 0 12px; font-size: 20px; }
    p { margin: 8px 0; }
    img { width: 100%; border-radius: 10px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>Proof for Claim #${claim.id}</h1>
    <p><strong>Founder:</strong> ${claim.claimant_name || '-'}</p>
    <p><strong>Student ID:</strong> ${claim.claimant_student_id || '-'}</p>
    <p><strong>Claim Note:</strong> ${claim.claim_message || '-'}</p>
    <img src="${claim.proof_image}" alt="Claim proof image" />
  </div>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

function setPie(chartId, segments) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total === 0) {
    document.getElementById(chartId).style.background = '#e7edf6';
    return;
  }

  let progress = 0;
  const parts = segments.map((segment) => {
    const size = (segment.value / total) * 360;
    const start = progress;
    const end = progress + size;
    progress = end;
    return `${segment.color} ${start}deg ${end}deg`;
  });

  document.getElementById(chartId).style.background = `conic-gradient(${parts.join(', ')})`;
}

function countBy(itemsList, getKey) {
  const map = new Map();
  itemsList.forEach((item) => {
    const key = (getKey(item) || 'Unknown').toString().trim() || 'Unknown';
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function mapToSegments(countMap, limit = null) {
  let entries = Array.from(countMap.entries()).sort((a, b) => b[1] - a[1]);

  if (limit && entries.length > limit) {
    const top = entries.slice(0, limit);
    const othersCount = entries.slice(limit).reduce((sum, entry) => sum + entry[1], 0);
    entries = [...top, ['Others', othersCount]];
  }

  return entries.map((entry, index) => ({
    label: entry[0],
    value: entry[1],
    color: PIE_COLORS[index % PIE_COLORS.length]
  }));
}

function renderLegend(containerId, segments) {
  const container = document.getElementById(containerId);

  if (segments.length === 0) {
    container.innerHTML = '<p>No approved data yet.</p>';
    return;
  }

  container.innerHTML = segments
    .map((segment) => `<p><span class="dot" style="background:${segment.color}"></span> ${segment.label}: <strong>${segment.value}</strong></p>`)
    .join('');
}

function renderDashboard() {
  const approvedItems = items.filter((item) => item.status === 'approved');
  const totalApproved = approvedItems.length;
  const pendingPosts = items.filter((item) => item.status === 'pending').length;
  const pendingClaims = claims.filter((claim) => normalizeClaimStatus(claim.status) === 'pending').length;
  const verifiedClaims = claims.filter((claim) => {
    const status = normalizeClaimStatus(claim.status);
    return status === 'verified' || status === 'certificate_issued';
  }).length;
  const approved = totalApproved;
  const lost = approvedItems.filter((item) => item.type === 'lost').length;
  const found = approvedItems.filter((item) => item.type === 'found').length;

  const categorySegments = mapToSegments(countBy(approvedItems, (item) => item.cat));
  const locationSegments = mapToSegments(countBy(approvedItems, (item) => item.loc), 5);

  document.getElementById('stat-pending-posts').textContent = String(pendingPosts);
  document.getElementById('stat-pending-claims').textContent = String(pendingClaims);
  document.getElementById('stat-verified-claims').textContent = String(verifiedClaims);

  document.getElementById('pie-status-pending-value').textContent = String(pendingPosts);
  document.getElementById('pie-status-approved-value').textContent = String(approved);
  document.getElementById('pie-type-lost-value').textContent = String(lost);
  document.getElementById('pie-type-found-value').textContent = String(found);

  setPie('pie-status', [
    { value: pendingPosts, color: '#f0b429' },
    { value: approved, color: '#2bb673' }
  ]);

  setPie('pie-type', [
    { value: lost, color: '#e53935' },
    { value: found, color: '#1f77ff' }
  ]);

  setPie('pie-category', categorySegments);
  setPie('pie-location', locationSegments);

  renderLegend('legend-category', categorySegments);
  renderLegend('legend-location', locationSegments);
}

async function fetchAdminItems() {
  const response = await apiFetch('/api/admin/items');
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(`Unauthorized admin key (401) for ${API_BASE}`);
    }

    throw new Error(`Failed to fetch admin items (${response.status})`);
  }

  const payload = await response.json();
  items = payload.data || [];
  loadItems();
  renderDashboard();
}

async function fetchClaimRequests() {
  const response = await apiFetch('/api/admin/claims');
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(`Unauthorized admin key (401) for ${API_BASE}`);
    }

    throw new Error(`Failed to fetch claim requests (${response.status})`);
  }

  const payload = await response.json();
  claims = payload.data || [];
  loadClaims();
  renderDashboard();
}

async function fetchAdminMatches() {
  const response = await apiFetch('/api/admin/matches');
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(`Unauthorized admin key (401) for ${API_BASE}`);
    }

    throw new Error(`Failed to fetch detected matches (${response.status})`);
  }

  const payload = await response.json();
  matches = payload.data || [];
  loadMatches();
}

function viewMatchDetails(matchId) {
  const match = matches.find((entry) => entry.id === matchId);
  if (!match) {
    alert('Match details not found.');
    return;
  }

  const keywordText = Array.isArray(match.matched_keywords) && match.matched_keywords.length > 0
    ? match.matched_keywords.join(', ')
    : 'None';

  const details = [
    `Match #${match.id}`,
    `Score: ${Number(match.score || 0).toFixed(1)}%`,
    `Status: ${match.status}`,
    '',
    `Source Item (#${match.source_item_id})`,
    `Type: ${match.source_type}`,
    `Title: ${match.source_title}`,
    `Description: ${match.source_desc || '-'}`,
    `Location: ${match.source_loc || '-'}`,
    `Date: ${match.source_date || '-'}`,
    '',
    `Target Item (#${match.target_item_id})`,
    `Type: ${match.target_type}`,
    `Title: ${match.target_title}`,
    `Description: ${match.target_desc || '-'}`,
    `Location: ${match.target_loc || '-'}`,
    `Date: ${match.target_date || '-'}`,
    '',
    `Matched Keywords: ${keywordText}`,
    `Action Note: ${match.action_note || '-'}`
  ];

  alert(details.join('\n'));
}

async function approveMatch(matchId) {
  const noteInput = await showTextInputDialog({
    title: 'Approve Match',
    message: 'Optional note for match approval:',
    defaultValue: '',
    placeholder: 'Add note (optional)',
    confirmText: 'Approve'
  });
  if (noteInput === null) {
    return;
  }

  try {
    const response = await apiFetch(`/api/admin/matches/${matchId}/approve`, {
      method: 'PATCH',
      body: JSON.stringify({ actionNote: noteInput.trim() })
    });

    if (!response.ok) {
      throw new Error(`Approve match failed (${response.status})`);
    }

    await fetchAdminMatches();
    alert(`Match ${matchId} approved.`);
  } catch (error) {
    console.error('[admin] Failed to approve match:', error);
    alert(error.message || 'Failed to approve match.');
  }
}

async function rejectMatch(matchId) {
  const noteInput = await showTextInputDialog({
    title: 'Reject Match',
    message: 'Reason for rejecting this match (optional):',
    defaultValue: '',
    placeholder: 'Add reason (optional)',
    confirmText: 'Reject'
  });
  if (noteInput === null) {
    return;
  }

  try {
    const response = await apiFetch(`/api/admin/matches/${matchId}/reject`, {
      method: 'PATCH',
      body: JSON.stringify({ actionNote: noteInput.trim() })
    });

    if (!response.ok) {
      throw new Error(`Reject match failed (${response.status})`);
    }

    await fetchAdminMatches();
    alert(`Match ${matchId} rejected.`);
  } catch (error) {
    console.error('[admin] Failed to reject match:', error);
    alert(error.message || 'Failed to reject match.');
  }
}

function showCertificatePopup(claim) {
  const win = window.open('', '_blank', 'width=900,height=650');
  if (!win) {
    alert('Popup blocked. Please allow popups to view the certificate.');
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Certificate of Appreciation</title>
  <style>
    body { font-family: Georgia, serif; background: linear-gradient(180deg, #eef3ff, #f7fbff); margin: 0; padding: 30px; color: #10294f; }
    .sheet { max-width: 860px; margin: 0 auto; background: #fff; border: 10px double #0f2a52; padding: 34px; text-align: center; box-shadow: 0 20px 44px rgba(16, 24, 40, 0.14); }
    .eyebrow { font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; color: #4b658f; margin-bottom: 10px; }
    h1 { margin: 0 0 8px; color: #0f2a52; letter-spacing: 1px; font-size: 30px; }
    h2 { margin: 0 0 22px; font-weight: normal; color: #2b4570; font-size: 18px; }
    .name { font-size: 36px; font-weight: bold; color: #10294f; margin: 18px 0 14px; }
    .statement { max-width: 720px; margin: 0 auto; font-size: 17px; line-height: 1.8; color: #243b63; }
    .panel { margin-top: 22px; padding: 18px 20px; border-radius: 16px; background: #f7faff; border: 1px solid #d9e3f5; text-align: left; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; font-size: 15px; line-height: 1.7; color: #203455; }
    .grid strong { color: #0f2a52; }
    .cert-id { margin-top: 18px; font-size: 15px; font-weight: 700; color: #0f2a52; }
    .verify { margin-top: 12px; font-size: 14px; color: #36527c; word-break: break-all; }
    .footer { margin-top: 22px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: 14px; color: #324c74; border-top: 1px solid #d8e2f1; padding-top: 16px; }
    .btn { margin-top: 26px; padding: 10px 18px; border: none; background: #0f2a52; color: #fff; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="eyebrow">${claim.system_name}</div>
    <h1>${claim.title}</h1>
    <h2>${claim.institution}</h2>
    <p>This certificate is proudly presented to</p>
    <div class="name">${claim.finder_name}</div>
    <p class="statement">This certificate is proudly presented to ${claim.finder_name} in recognition of their honesty and integrity for finding and returning a lost item through the FoundU Lost and Found System. Their actions helped reunite the item with its rightful owner and contributed to building a trustworthy campus community.</p>
    <div class="panel">
      <div class="grid">
        <div><strong>Item Name:</strong> ${claim.item_name}</div>
        <div><strong>Category:</strong> ${claim.category}</div>
        <div><strong>Location Found:</strong> ${claim.location_found}</div>
        <div><strong>Date Returned:</strong> ${formatDateTime(claim.date_returned)}</div>
      </div>
      <div class="cert-id">Certificate ID: ${claim.certificate_id}</div>
      <div class="verify">Verification: ${claim.verification_url}</div>
    </div>
    <div class="footer">
      <div><strong>${claim.footer_name}</strong><br/>${claim.system_name}</div>
      <div><strong>Date Issued:</strong> ${formatDateTime(claim.date_issued)}</div>
    </div>
    <button class="btn" onclick="window.print()">Print Certificate</button>
  </div>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

async function issueCertificate(claimId) {
  const claim = findClaimById(claimId);
  if (!claim) {
    alert('Claim request not found.');
    return;
  }

  if ((claim.type || '').toLowerCase() !== 'found') {
    alert('Certificates can only be issued for found items.');
    return;
  }

  if (!claim.claimant_name) {
    alert('Missing finder name for certificate generation.');
    return;
  }

  const verifyMessage = `Verify the finder details before issuing certificate:\nName: ${claim.claimant_name}\n\nClick OK to continue.`;
  if (!confirm(verifyMessage)) {
    return;
  }

  const certName = await showTextInputDialog({
    title: 'Issue Certificate',
    message: 'Confirm finder name for the certificate:',
    defaultValue: claim.claimant_name,
    placeholder: 'Finder name',
    confirmText: 'Continue',
    required: true
  });
  if (certName === null) {
    return;
  }

  const normalizedName = certName.trim();
  if (!normalizedName) {
    alert('Finder name is required.');
    return;
  }

  const adminNoteInput = await showTextInputDialog({
    title: 'Issue Certificate',
    message: 'Optional admin note (reason or details):',
    defaultValue: claim.admin_note || '',
    placeholder: 'Optional admin note',
    confirmText: 'Issue'
  });
  if (adminNoteInput === null) {
    return;
  }

  const adminNote = adminNoteInput.trim();

  try {
    const response = await apiFetch(`/api/admin/claims/${claimId}/certificate`, {
      method: 'PATCH',
      body: JSON.stringify({ certName: normalizedName, adminNote })
    });

    if (!response.ok) {
      throw new Error(`Issue certificate failed (${response.status})`);
    }

    const payload = await response.json();
    await fetchClaimRequests();
    showCertificatePopup(payload.data);
  } catch (error) {
    console.error('[admin] Failed to issue certificate:', error);
    alert('Failed to issue certificate.');
  }
}

async function verifyClaim(claimId) {
  const claim = findClaimById(claimId);
  if (!claim) {
    await fetchClaimRequests();
    alert('Claim was already removed or processed. The table has been refreshed.');
    return;
  }

  const adminNoteInput = await showTextInputDialog({
    title: 'Verify Claim',
    message: 'Optional note for verification:',
    defaultValue: claim.admin_note || '',
    placeholder: 'Optional verification note',
    confirmText: 'Verify'
  });
  if (adminNoteInput === null) {
    return;
  }

  try {
    const requestVerify = async () => apiFetch(`/api/admin/claims/${claimId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ adminNote: adminNoteInput.trim() })
    });

    let response = await requestVerify();

    if (response.status === 404) {
      response = await apiFetch(`/api/admin/claims/${claimId}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({ adminNote: adminNoteInput.trim() })
      });
    }

    if (response.status === 403) {
      await fetchCsrfToken();
      response = await requestVerify();

      if (response.status === 404) {
        response = await apiFetch(`/api/admin/claims/${claimId}/approve`, {
          method: 'PATCH',
          body: JSON.stringify({ adminNote: adminNoteInput.trim() })
        });
      }
    }

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      const reason = errorPayload && errorPayload.error
        ? errorPayload.error
        : `Verify claim failed (${response.status})`;

      if (response.status === 404) {
        await fetchClaimRequests();
        throw new Error('Claim was not found anymore. It may have been removed or processed already.');
      }

      if (response.status === 403) {
        throw new Error('CSRF validation failed. Please refresh the admin page and try again.');
      }

      throw new Error(reason);
    }

    await fetchClaimRequests();
    alert(`Claim ${claimId} verified.`);
  } catch (error) {
    console.error('[admin] Failed to verify claim:', error);
    alert(error.message || 'Failed to verify claim request.');
  }
}

async function rejectClaim(claimId) {
  const claim = findClaimById(claimId);
  if (!claim) {
    await fetchClaimRequests();
    alert('Claim was already removed or processed. The table has been refreshed.');
    return;
  }

  const adminNoteInput = await showTextInputDialog({
    title: 'Reject Claim',
    message: 'Reason for rejection (optional):',
    defaultValue: claim.admin_note || '',
    placeholder: 'Optional rejection reason',
    confirmText: 'Reject'
  });
  if (adminNoteInput === null) {
    return;
  }

  try {
    const requestReject = async () => apiFetch(`/api/admin/claims/${claimId}/reject`, {
      method: 'PATCH',
      body: JSON.stringify({ adminNote: adminNoteInput.trim() })
    });

    let response = await requestReject();

    if (response.status === 403) {
      await fetchCsrfToken();
      response = await requestReject();
    }

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      const reason = errorPayload && errorPayload.error
        ? errorPayload.error
        : `Reject claim failed (${response.status})`;

      if (response.status === 404) {
        await fetchClaimRequests();
        throw new Error('Claim was not found anymore. It may have been removed or processed already.');
      }

      if (response.status === 403) {
        throw new Error('CSRF validation failed. Please refresh the admin page and try again.');
      }

      throw new Error(reason);
    }

    await fetchClaimRequests();
    alert(`Claim ${claimId} rejected.`);
  } catch (error) {
    console.error('[admin] Failed to reject claim:', error);
    alert(error.message || 'Failed to reject claim request.');
  }
}

async function clearOwnershipHistory() {
  if (!confirm('Clear ownership history records? Pending requests will be kept.')) {
    return;
  }

  try {
    const response = await apiFetch('/api/admin/claims/history', {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(`Clear history failed (${response.status})`);
    }

    const payload = await response.json();
    await fetchClaimRequests();
    alert(`Ownership history cleared (${payload.cleared || 0} record(s) removed).`);
  } catch (error) {
    console.error('[admin] Failed to clear ownership history:', error);
    alert('Failed to clear ownership history.');
  }
}

async function approveItem(id) {
  try {
    const response = await apiFetch(`/api/admin/items/${id}/approve`, {
      method: 'PATCH'
    });

    if (!response.ok) {
      throw new Error(`Approve failed (${response.status})`);
    }

    await fetchAdminItems();
    await fetchAdminMatches();
    alert(`Item ${id} approved.`);
  } catch (error) {
    console.error('[admin] Failed to approve item:', error);
    alert('Failed to approve item.');
  }
}

async function deleteItem(id) {
  if (!confirm(`Delete item ${id}? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await apiFetch(`/api/admin/items/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(`Delete failed (${response.status})`);
    }

    await fetchAdminItems();
    await fetchAdminMatches();
    alert(`Item ${id} deleted.`);
  } catch (error) {
    console.error('[admin] Failed to delete item:', error);
    alert('Failed to delete item.');
  }
}

// Navigation
function showSection(sectionId) {
  document.querySelectorAll('main section').forEach((section) => section.classList.remove('active'));
  document.getElementById(sectionId).classList.add('active');

  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === sectionId);
  });
}

window.onload = async () => {
  try {
    await resolveApiBase();
    await loadAdminApiKey();
    await fetchCsrfToken();
    await fetchAdminItems();
    await fetchClaimRequests();
    await fetchAdminMatches();
  } catch (error) {
    const isUnauthorized = /\(401\)|Unauthorized admin key/i.test(error.message || '');

    if (isUnauthorized) {
      try {
        clearAdminApiKey();
        alert(`Admin key was rejected by ${API_BASE}. Please enter it again.`);
        await loadAdminApiKey();
        await fetchAdminItems();
        await fetchClaimRequests();
        await fetchAdminMatches();
        return;
      } catch (retryError) {
        console.error('[admin] Startup retry failed:', retryError);
        alert(`Startup failed after retry: ${retryError.message}`);
        return;
      }
    }

    console.error('[admin] Startup failed:', error);
    alert(`Startup failed: ${error.message}`);
  }
};
