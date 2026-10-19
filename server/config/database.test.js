// The real pg Pool (database.js without USE_PGLITE) on its own, outside the running server.
// Each case runs in a fresh Node process, so a crash shows up as an exit code.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverDir = path.join(__dirname, '..');

/** Run a CommonJS snippet in a fresh Node process from server/. */
function run(source) {
  return new Promise((resolve, reject) => {
    // DATABASE_URL picks the real pg Pool. It only connects on its first query, and these
    // snippets never send one.
    const child = spawn(process.execPath, ['-e', source], {
      cwd: serverDir,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://127.0.0.1:1/none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, out }));
  });
}

test('an error on an idle database connection is logged and the process keeps running', async () => {
  // pg emits 'error' on the pool when an idle client's connection drops (a database restart,
  // a network blip). With no listener Node treats it as uncaught and the server exits.
  const { code, out } = await run(`
    const pool = require('./config/database');
    setTimeout(() => pool.emit('error', new Error('Connection terminated unexpectedly')));
    setTimeout(() => { console.log('still running'); process.exit(0); }, 200);
  `);
  assert.strictEqual(code, 0, out);
  assert.match(out, /Postgres idle client error: Connection terminated unexpectedly/);
  assert.match(out, /still running/);
});

test('an error on a checked-out client is logged and the process keeps running', async () => {
  // A client handed out by pool.connect() has no pool listener while it is out, so a drop
  // between two queries emits 'error' on the client itself.
  const { code, out } = await run(`
    const { Client } = require('pg');
    const pool = require('./config/database');
    const client = new Client();
    pool.emit('connect', client);
    setTimeout(() => client.emit('error', new Error('Connection terminated unexpectedly')));
    setTimeout(() => { console.log('still running'); process.exit(0); }, 200);
  `);
  assert.strictEqual(code, 0, out);
  assert.match(out, /Postgres client error: Connection terminated unexpectedly/);
  assert.match(out, /still running/);
});
