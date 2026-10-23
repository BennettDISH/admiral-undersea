// A stand-in for Waypoint's guest check (POST /api/auth/proxy/guests), for the sweep tests.
// Unless told otherwise it calls every id it is asked about an unclaimed guest.
//   const waypoint = await startWaypoint();   waypoint.url, waypoint.env()
//   waypoint.set({ claimed: [...], gone: [...], unknown: [...] })   ids by what Waypoint says
//   waypoint.status = 404 | 500 | ...   answers that status to everything
//   waypoint.delay = ms                 holds every answer back
//   waypoint.requests                   the bodies it was sent
//   waypoint.reset()                    back to the default; await waypoint.close() at the end
const http = require('node:http');

async function startWaypoint({ clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
  const w = { requests: [], status: null, delay: 0, claimed: new Set(), gone: new Set(), unknown: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/api/auth/proxy/guests') return send(404, { error: 'Not found' });
      let body;
      try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
      w.requests.push(body);
      if (w.status) return send(w.status, { error: 'stand-in failure' });
      if (body.client_id !== clientId || body.client_secret !== clientSecret) return send(401, { error: 'Invalid client credentials' });
      if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 500) return send(400, { error: 'ids must be a list of 1 to 500 central user ids' });
      const out = { guests: [], claimed: [], gone: [], unknown: [] };
      for (const id of body.ids) {
        const key = String(id);
        out[w.claimed.has(key) ? 'claimed' : w.gone.has(key) ? 'gone' : w.unknown.has(key) ? 'unknown' : 'guests'].push(id);
      }
      return setTimeout(() => send(200, out), w.delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  w.url = `http://127.0.0.1:${server.address().port}`;
  w.env = () => ({ AUTH_SERVICE_URL: w.url, SSO_CLIENT_ID: clientId, SSO_CLIENT_SECRET: clientSecret });
  w.set = ({ claimed = [], gone = [], unknown = [] } = {}) => {
    w.claimed = new Set(claimed.map(String)); w.gone = new Set(gone.map(String)); w.unknown = new Set(unknown.map(String));
  };
  w.reset = () => { w.requests.length = 0; w.status = null; w.delay = 0; w.set(); };
  w.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return w;
}

module.exports = { startWaypoint };
