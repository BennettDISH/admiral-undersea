const fs = require('fs');
const path = require('path');
const pool = require('./database');

// Apply the schema on boot so a fresh Railway Postgres comes up with all tables
// (and existing databases pick up new columns). Every statement in schema.sql is
// idempotent, so this is safe to run on every start.
async function initDb() {
  const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Database schema applied');
}

module.exports = initDb;
