// Railway stops the old server with SIGTERM on every deploy, and a stop that doesn't end in exit 0 is
// mailed as "Deploy crashed" (cleanStop.js). Until 11-26 every stop did: `npm start` ran
// `sh -c "node server/index.js"`, sh died of npm's SIGTERM, and node, orphaned, never heard it, so
// the matches waiting to be written were never written either.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exitCleanlyOn } = require('./cleanStop');

const ROOT = path.join(__dirname, '..');
const startOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.start;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A script run the way npm runs one, `sh -c "<script>"`, from the repo root, with its output kept.
function run(t, script, env = process.env) {
  const child = spawn('sh', ['-c', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  // A second SIGTERM once the first one's close has begun: sent the moment that line is printed.
  let again = false;
  const onData = (d) => {
    out += String(d);
    if (again && out.includes('SIGTERM: closing')) {
      again = false;
      child.kill('SIGTERM');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return {
    exited,
    output: () => out,
    // Waits until the output has `text` in it; fails at once if the process ends first.
    async waitFor(text, ms = 30_000) {
      const until = Date.now() + ms;
      while (!out.includes(text) && Date.now() < until && child.exitCode === null && child.signalCode === null) await sleep(20);
      if (!out.includes(text)) throw new Error(`never printed ${JSON.stringify(text)}:\n${out}`);
    },
    // SIGTERM, and another while the first one's close is under way (Railway and npm may both send one).
    sigtermTwice() {
      again = true;
      child.kill('SIGTERM');
    },
  };
}

test('a close that fails, or never finishes, still ends in exit 0: a stop asked for is no crash', async () => {
  for (const close of [() => Promise.reject(new Error('disk full')), () => new Promise(() => {})]) {
    const target = new EventEmitter();
    const exits = [];
    const lines = [];
    exitCleanlyOn(close, { target, graceMs: 30, exit: (code) => exits.push(code), log: (line) => lines.push(line) });
    target.emit('SIGTERM', 'SIGTERM');
    await sleep(80);
    assert.deepEqual(exits, [0]);
    assert.match(lines.at(-1), /^stopped/);
  }
});

test('the start scripts exec node, so npm\'s SIGTERM reaches the server and not a shell', () => {
  assert.equal(startOf(ROOT), 'exec node server/index.js');
  assert.equal(startOf(__dirname), 'exec node index.js');
});

test('run as npm runs it, SIGTERM twice runs close() once and exits 0', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'closed');
  const fixture = path.join(dir, 'fixture.js');
  fs.writeFileSync(fixture, [
    `const fs = require('node:fs');`,
    `const { exitCleanlyOn } = require(${JSON.stringify(path.join(__dirname, 'cleanStop.js'))});`,
    `exitCleanlyOn(async () => {`,
    `  await new Promise((r) => setTimeout(r, 200));`,
    `  fs.writeFileSync(${JSON.stringify(marker)}, 'closed');`,
    `});`,
    `setInterval(() => {}, 1000);`,
    `console.log('ready');`,
  ].join('\n'));
  const p = run(t, `exec node '${fixture}'`);
  await p.waitFor('ready');
  p.sigtermTwice();
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  assert.ok(fs.existsSync(marker), 'close() ran to the end');
  assert.match(p.output(), /SIGTERM again: already stopping/);
});

test('the real server, started by the root script on PGlite, exits 0 on SIGTERM twice', { timeout: 120_000 }, async (t) => {
  const env = { ...process.env, USE_PGLITE: '1', JWT_SECRET: 'clean-stop-test-secret', PORT: '0', NODE_ENV: 'test' };
  for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'PGLITE_DIR', 'AUTH_SERVICE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET']) delete env[name];
  const p = run(t, startOf(ROOT), env);
  await p.waitFor('Server running on port', 90_000);
  p.sigtermTwice();
  // With no matches to write, the close can be over before the second signal lands: the exit is what counts.
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  assert.match(p.output(), /^SIGTERM: closing$/m);
  assert.match(p.output(), /^stopped$/m);
});
