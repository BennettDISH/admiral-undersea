const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID;
const SSO_CLIENT_SECRET = process.env.SSO_CLIENT_SECRET;

const SSO_ENABLED = !!(AUTH_SERVICE_URL && SSO_CLIENT_ID && SSO_CLIENT_SECRET);

async function centralRegister({ username, email, password, first_name, last_name }) {
  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth/proxy/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, first_name, last_name, client_id: SSO_CLIENT_ID, client_secret: SSO_CLIENT_SECRET })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Central registration failed');
  }
  return response.json();
}

async function centralLogin({ email, password }) {
  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth/proxy/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, client_id: SSO_CLIENT_ID, client_secret: SSO_CLIENT_SECRET })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Central login failed');
  }
  return response.json();
}

async function exchangeCode(code) {
  const response = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: SSO_CLIENT_ID, client_secret: SSO_CLIENT_SECRET })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'SSO token exchange failed');
  }
  return response.json();
}

module.exports = { SSO_ENABLED, centralRegister, centralLogin, exchangeCode };
