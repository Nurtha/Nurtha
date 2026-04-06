let items = [];
let claims = [];
let API_BASE = '';
let CSRF_TOKEN = '';
let ADMIN_API_KEY = '';
const API_BASE_STORAGE_KEY = 'founduApiBase';
const PIE_COLORS = ['#1f77ff', '#e53935', '#2bb673', '#f0b429', '#7e57c2', '#00a8a8', '#ff7f50', '#546e7a'];

function getApiCandidates() {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname;
  const savedBase = (localStorage.getItem(API_BASE_STORAGE_KEY) || '').trim();
  const isLocalPage = host === 'localhost' || host === '127.0.0.1';
  const candidates = isLocalPage
    ? [`${protocol}//${host}:3000`, `${protocol}//${host}`, 'http://localhost:3000', 'http://127.0.0.1:3000', savedBase, '']
    : [savedBase, ''];

  if (host) {
    candidates.push(`${protocol}//${host}`);
    candidates.push(`${protocol}//${host}:3000`);
  }

  candidates.push('http://localhost:3000');
  candidates.push('http://127.0.0.1:3000');

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
  for (const base of candidates) {
    try {
      await tryApiBase(base);
      return;
    } catch (error) {
      // Try next candidate.
    }
  }

  const savedBase = (localStorage.getItem(API_BASE_STORAGE_KEY) || '').trim();
  const customBaseInput = prompt(
    'Cannot auto-detect API server. Enter API URL (e.g. https://xxxx.ngrok-free.app or http://localhost:3000):',
    savedBase || 'http://localhost:3000'
  );

  if (customBaseInput === null) {
    throw new Error('API server URL is required');
  }

  const customBase = customBaseInput.trim().replace(/\/$/, '');
  if (!customBase) {
    throw new Error('API server URL is required');
  }

  await tryApiBase(customBase);
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

function loadAdminApiKey() {
  const saved = localStorage.getItem('founduAdminApiKey') || '';
  const provided = prompt(`Enter admin API key for ${API_BASE || 'this server'}:`, saved || '');

  if (provided === null) {
    throw new Error('Admin API key is required');
  }

  ADMIN_API_KEY = provided.trim();
  if (!ADMIN_API_KEY) {
    throw new Error('Admin API key is required');
  }

  localStorage.setItem('founduAdminApiKey', ADMIN_API_KEY);
}

function clearAdminApiKey() {
  ADMIN_API_KEY = '';
  localStorage.removeItem('founduAdminApiKey');
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

  return fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include'
  });
}

function getStatusClass(status) {
  return status === 'approved' ? 'status approved' : 'status pending';
}

function loadItems() {
  const table = document.getElementById('itemTable');
  table.innerHTML = '';

  if (items.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="8">No reports found.</td>`;
    table.appendChild(row);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.id}</td>
      <td><span class="${getStatusClass(item.status)}">${item.status}</span></td>
      <td>${item.title}</td>
      <td>${item.desc}</td>
      <td>${item.loc}</td>
      <td>${item.contact}</td>
      <td>${item.date}</td>
      <td>
        ${item.status !== 'approved' ? `<button class="action-btn approve" onclick="approveItem(${item.id})">Approve</button>` : ''}
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
  if (status === 'pending') {
    return 'status pending';
  }

  if (status === 'rejected') {
    return 'status pending';
  }

  return 'status approved';
}

function loadClaims() {
  const table = document.getElementById('claimTable');
  const badge = document.getElementById('claim-badge');
  const pendingCount = claims.filter((claim) => claim.status === 'pending').length;

  badge.textContent = String(pendingCount);
  badge.classList.toggle('hidden', pendingCount === 0);

  table.innerHTML = '';

  if (claims.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="11">No ownership requests.</td>';
    table.appendChild(row);
    return;
  }

  claims.forEach((claim) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${claim.id}</td>
      <td>${claim.title}</td>
      <td>${claim.claimant_name || '-'}</td>
      <td>${claim.claimant_student_id || '-'}</td>
      <td>${claim.claim_message || '-'}</td>
      <td>${claim.proof_image ? `<button class="action-btn" onclick="viewProof(${claim.id})">View Proof</button>` : '-'}</td>
      <td>${claim.loc}</td>
      <td>${formatDateTime(claim.requested_at)}</td>
      <td><span class="${getClaimStatusClass(claim.status)}">${claim.status}</span></td>
      <td>${claim.admin_note || '-'}</td>
      <td>${claim.cert_name || '-'}</td>
      <td>
        ${claim.status === 'pending' ? `<button class="action-btn approve" onclick="issueCertificate(${claim.id})">Issue Certificate</button>` : ''}
        ${claim.status === 'pending' ? `<button class="action-btn delete" onclick="rejectClaim(${claim.id})">Reject</button>` : ''}
      </td>
    `;
    table.appendChild(row);
  });
}

function viewProof(claimId) {
  const claim = claims.find((entry) => entry.id === claimId);
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
  const pending = 0;
  const approved = totalApproved;
  const lost = approvedItems.filter((item) => item.type === 'lost').length;
  const found = approvedItems.filter((item) => item.type === 'found').length;

  const categorySegments = mapToSegments(countBy(approvedItems, (item) => item.cat));
  const locationSegments = mapToSegments(countBy(approvedItems, (item) => item.loc), 5);

  document.getElementById('stat-approved-total').textContent = String(totalApproved);
  document.getElementById('stat-approved-categories').textContent = String(categorySegments.length);
  document.getElementById('stat-approved-locations').textContent = String(locationSegments.length);

  document.getElementById('pie-status-pending-value').textContent = String(pending);
  document.getElementById('pie-status-approved-value').textContent = String(approved);
  document.getElementById('pie-type-lost-value').textContent = String(lost);
  document.getElementById('pie-type-found-value').textContent = String(found);

  setPie('pie-status', [
    { value: pending, color: '#f0b429' },
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
  <title>Founder Certificate</title>
  <style>
    body { font-family: Georgia, serif; background: #f2f4f8; margin: 0; padding: 30px; }
    .sheet { max-width: 760px; margin: 0 auto; background: #fff; border: 8px double #0f2a52; padding: 36px; text-align: center; }
    h1 { margin: 0 0 8px; color: #0f2a52; letter-spacing: 1px; }
    h2 { margin: 0 0 20px; font-weight: normal; color: #2b4570; }
    .name { font-size: 34px; font-weight: bold; color: #10294f; margin: 20px 0; }
    .meta { margin-top: 28px; font-size: 16px; color: #304b74; line-height: 1.8; }
    .btn { margin-top: 26px; padding: 10px 18px; border: none; background: #0f2a52; color: #fff; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>CERTIFICATE OF FOUNDER VERIFICATION</h1>
    <h2>FoundU Lost and Found System</h2>
    <p>This certifies that</p>
    <div class="name">${claim.cert_name}</div>
    <p>is the verified founder of the reported item below:</p>
    <div class="meta">
      <div><strong>Student ID:</strong> ${claim.claimant_student_id || '-'}</div>
      <div><strong>Item:</strong> ${claim.title}</div>
      <div><strong>Location:</strong> ${claim.loc}</div>
      <div><strong>Item Date:</strong> ${claim.date}</div>
      <div><strong>Issued:</strong> ${formatDateTime(claim.issued_at)}</div>
      <div><strong>Claim Reference:</strong> #${claim.id}</div>
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
  const claim = claims.find((entry) => entry.id === claimId);
  if (!claim) {
    alert('Claim request not found.');
    return;
  }

  if (!claim.claimant_name || !claim.claimant_student_id) {
    alert('Missing founder verification details (name or student ID).');
    return;
  }

  const verifyMessage = `Verify founder details before issuing certificate:\nName: ${claim.claimant_name}\nStudent ID: ${claim.claimant_student_id}\n\nClick OK to continue.`;
  if (!confirm(verifyMessage)) {
    return;
  }

  const certName = prompt('Confirm founder name for the certificate:', claim.claimant_name);
  if (certName === null) {
    return;
  }

  const normalizedName = certName.trim();
  if (!normalizedName) {
    alert('Founder name is required.');
    return;
  }

  const adminNoteInput = prompt('Optional admin note (reason or details):', claim.admin_note || '');
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

async function rejectClaim(claimId) {
  await fetchClaimRequests();

  const claim = claims.find((entry) => entry.id === claimId);
  if (!claim) {
    alert('Claim was already removed or processed. The table has been refreshed.');
    return;
  }

  const adminNoteInput = prompt('Reason for rejection (optional):', claim.admin_note || '');
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
    loadAdminApiKey();
    await fetchCsrfToken();
    await fetchAdminItems();
    await fetchClaimRequests();
  } catch (error) {
    const isUnauthorized = /\(401\)|Unauthorized admin key/i.test(error.message || '');

    if (isUnauthorized) {
      try {
        clearAdminApiKey();
        alert(`Admin key was rejected by ${API_BASE}. Please enter it again.`);
        loadAdminApiKey();
        await fetchAdminItems();
        await fetchClaimRequests();
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
