const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function getCsrfSession() {
  const response = await fetch(`${BASE_URL}/api/csrf-token`);
  assert.equal(response.status, 200, 'csrf-token endpoint should return 200');

  const payload = await response.json();
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];

  assert.ok(payload.token, 'csrf token should be returned');
  assert.ok(cookie.startsWith('foundu_csrf='), 'csrf cookie should be set');

  return { token: payload.token, cookie };
}

test('health endpoint returns ok', async () => {
  const response = await fetch(`${BASE_URL}/api/health`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
});

test('item validation rejects missing required fields', async () => {
  const csrf = await getCsrfSession();

  const response = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({
      type: 'lost'
    })
  });

  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.ok(payload.error);
});

