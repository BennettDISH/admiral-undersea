// Waypoint's word on which idle guests may go: POST /api/auth/proxy/guests, server to server,
// with this app's own SSO client (AUTH_SERVICE_URL, SSO_CLIENT_ID, SSO_CLIENT_SECRET).
//
// Claiming a guest account on Waypoint keeps its central id, but this app's own copy goes on
// saying is_guest until that player next signs in here, so going by the copy alone would delete
// a real account's work after 30 idle days. The sweep asks first, and Waypoint's answer is:
//   guests, gone  may go (still an unclaimed guest; or no Waypoint account has the id any more)
//   claimed       stays, and the copy stops saying guest
//   unknown       stays, and is logged (an account has the id, but not through this app)
// Anything else (not configured, no answer, a timeout, a status other than 200, an answer that
// makes no sense, an endpoint that is not deployed yet) means nobody may go this run: the
// sweep runs again tomorrow.
const BATCH = 500; // the most ids one request may carry
const TIMEOUT_MS = 5000;
const CENTRAL_ID = /^[1-9][0-9]{0,9}$/;
const MAX_ID = 2147483647;

const askable = (id) => CENTRAL_ID.test(id) && Number(id) <= MAX_ID;

/** Asks about central user ids (numbers or digit strings) and answers, as strings:
 *  { ok: true, clear, claimed, unknown } — clear may go, the others stay —
 *  or { ok: false, reason } when nobody may go. An id that cannot be a central id is never
 *  asked and never cleared (it lands in unknown). */
async function checkGuests(ids, { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const url = (env.AUTH_SERVICE_URL || '').replace(/\/$/, '');
  const clientId = env.SSO_CLIENT_ID || '';
  const clientSecret = env.SSO_CLIENT_SECRET || '';
  if (!url || !clientId || !clientSecret) return { ok: false, reason: 'Waypoint is not configured here' };
  const want = [...new Set([...ids].map(String))];
  const out = { ok: true, clear: [], claimed: [], unknown: want.filter((id) => !askable(id)) };
  const asking = want.filter(askable);
  try {
    for (let i = 0; i < asking.length; i += BATCH) {
      const batch = asking.slice(i, i + BATCH);
      const res = await fetchImpl(`${url}/api/auth/proxy/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ids: batch.map(Number) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) return { ok: false, reason: `Waypoint answered ${res.status}` };
      const body = await res.json();
      for (const k of ['guests', 'claimed', 'gone', 'unknown']) {
        if (!Array.isArray(body?.[k])) return { ok: false, reason: 'Waypoint answered with something unexpected' };
      }
      const [guests, claimed, gone] = ['guests', 'claimed', 'gone'].map((k) => new Set(body[k].map(String)));
      for (const id of batch) {
        if (claimed.has(id)) out.claimed.push(id);
        else if (guests.has(id) || gone.has(id)) out.clear.push(id);
        else out.unknown.push(id); // unknown, or not mentioned at all: stays either way
      }
    }
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? `Waypoint did not answer in ${timeoutMs / 1000} s` : `Waypoint could not be reached (${err?.cause?.code || err?.message || err})` };
  }
  return out;
}

module.exports = { checkGuests };
