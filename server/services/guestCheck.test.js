// The Waypoint guest check (server/services/guestCheck.js) against a stand-in Waypoint.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startWaypoint } = require('./fakeWaypoint');
const { checkGuests } = require('./guestCheck');

let waypoint;
before(async () => { waypoint = await startWaypoint(); });
after(() => waypoint.close());
beforeEach(() => waypoint.reset());

const ask = (ids, opts = {}) => checkGuests(ids, { env: waypoint.env(), ...opts });

test('guests and gone may go; claimed and unknown stay', async () => {
  waypoint.set({ claimed: [2], gone: [3], unknown: [4] });
  const r = await ask(['1', '2', '3', '4']);
  assert.deepEqual(r, { ok: true, clear: ['1', '3'], claimed: ['2'], unknown: ['4'] });
  assert.equal(waypoint.requests.length, 1);
  assert.deepEqual(waypoint.requests[0].ids, [1, 2, 3, 4]);
  assert.equal(waypoint.requests[0].client_id, 'test-client');
});

test('ids go in batches of 500, repeats once, and ids that cannot be central ids are never asked', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
  const r = await ask([...ids, '7', 'guest-abc', '0', '4294967296', '12abc']);
  assert.equal(r.ok, true);
  assert.equal(r.clear.length, 501);
  assert.deepEqual(waypoint.requests.map((b) => b.ids.length), [500, 1]);
  assert.deepEqual(r.unknown, ['guest-abc', '0', '4294967296', '12abc']);
});

test('an empty list asks nothing', async () => {
  assert.deepEqual(await ask([]), { ok: true, clear: [], claimed: [], unknown: [] });
  assert.equal(waypoint.requests.length, 0);
});

test('an id Waypoint does not mention stays', async () => {
  const r = await checkGuests(['1', '2'], {
    env: waypoint.env(),
    fetchImpl: async () => ({ status: 200, json: async () => ({ guests: [1], claimed: [], gone: [], unknown: [] }) }),
  });
  assert.deepEqual(r, { ok: true, clear: ['1'], claimed: [], unknown: ['2'] });
});

test('an answer that is not 200 means nobody may go', async () => {
  for (const status of [400, 401, 404, 500, 502]) {
    waypoint.status = status;
    assert.deepEqual(await ask(['1']), { ok: false, reason: `Waypoint answered ${status}` });
  }
});

test('wrong credentials mean nobody may go', async () => {
  const r = await checkGuests(['1'], { env: { ...waypoint.env(), SSO_CLIENT_SECRET: 'nope' } });
  assert.deepEqual(r, { ok: false, reason: 'Waypoint answered 401' });
});

test('an answer that makes no sense means nobody may go', async () => {
  const odd = async (body) => checkGuests(['1'], { env: waypoint.env(), fetchImpl: async () => ({ status: 200, json: async () => body }) });
  for (const body of [{}, null, { guests: [1] }, { guests: 'x', claimed: [], gone: [], unknown: [] }]) {
    const r = await odd(body);
    assert.equal(r.ok, false, JSON.stringify(body));
  }
  const bad = await checkGuests(['1'], { env: waypoint.env(), fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }) });
  assert.equal(bad.ok, false);
});

test('a second batch that fails means nobody may go, even if the first answered', async () => {
  let n = 0;
  const r = await checkGuests(Array.from({ length: 501 }, (_, i) => String(i + 1)), {
    env: waypoint.env(),
    fetchImpl: async () => (++n === 1 ? { status: 200, json: async () => ({ guests: Array.from({ length: 500 }, (_, i) => i + 1), claimed: [], gone: [], unknown: [] }) } : { status: 500 }),
  });
  assert.deepEqual(r, { ok: false, reason: 'Waypoint answered 500' });
});

test('no answer in time means nobody may go', async () => {
  waypoint.delay = 400;
  const r = await ask(['1'], { timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not answer in/);
});

test('an unreachable Waypoint means nobody may go', async () => {
  const dead = await startWaypoint();
  const env = dead.env();
  await dead.close();
  const r = await checkGuests(['1'], { env });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be reached/);
});

test('not configured means nobody may go, and nothing is sent', async () => {
  for (const drop of ['AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) {
    const env = { ...waypoint.env(), [drop]: '' };
    assert.deepEqual(await checkGuests(['1'], { env }), { ok: false, reason: 'Waypoint is not configured here' });
  }
  assert.equal(waypoint.requests.length, 0);
});

test('the secret never shows in a reason', async () => {
  waypoint.status = 500;
  const r = await ask(['1']);
  assert.ok(!JSON.stringify(r).includes('test-secret'));
});
