const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// SUGGESTION IMPLEMENTED: this used to always read/write local JSON files
// directly. On managed hosting (Hostinger Business, Render, Railway, etc.)
// the local filesystem is generally NOT guaranteed to survive a redeploy —
// Hostinger's own support confirmed this explicitly: "Redeploy ke dauran
// runtime-written files ke survive hone ki guarantee nahi hai." That meant
// every booking, customer, and setting could vanish the next time this app
// was redeployed.
//
// Now: if DB_HOST is set (MySQL configured), every read/write goes through
// a real MySQL database instead — durable across redeploys, restarts, and
// host migrations. If DB_HOST is NOT set, it falls back to the exact same
// local-file behavior as before, so local development (and anyone not
// ready to set up MySQL yet) keeps working with zero configuration.
//
// HOW THIS AVOIDS TOUCHING THE REST OF THE APP:
// Every route in server.js and every lib/*.js file calls readData(name)/
// writeData(name, data) SYNCHRONOUSLY (no `await`) — there are 150+ call
// sites across ~4000 lines. Rewriting every one of them to be async would
// be a huge, error-prone change. Instead: initDb() (called once, awaited,
// right before the server starts listening — see server.js) loads every
// row from MySQL into an in-memory cache up front. readData() then reads
// from that in-memory cache instantly (still synchronous, zero code
// changes needed anywhere else). writeData() updates the in-memory cache
// immediately (so anything read back later in the same request sees the
// change right away, exactly like before) AND fires off the real MySQL
// write in the background — logged loudly if it ever fails, since that's
// the one case where "looked like it saved" and "actually saved" could
// briefly disagree.
//
// LIMITATION TO KNOW ABOUT: this in-memory cache is per-process. It's the
// right trade-off for how this app is actually deployed (one Node
// process on Hostinger Business / a single Render or Railway instance) —
// but if this ever grows into MULTIPLE server instances behind a load
// balancer, each instance's cache would drift from the others, and this
// caching layer would need to be replaced with direct per-request MySQL
// queries (or a shared cache like Redis) at that point.
const USE_MYSQL = !!process.env.DB_HOST;

let pool = null;
let cache = {}; // name -> parsed JS value (array or object)
let ready = false;

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

// Must be called once, and awaited, before the server starts accepting
// requests (see server.js). Populates `cache` from MySQL (or from the
// local data/*.json files if MySQL isn't configured).
async function initDb() {
  if (USE_MYSQL) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_data (
        name VARCHAR(191) NOT NULL PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [rows] = await pool.query('SELECT name, data FROM app_data');
    for (const row of rows) {
      cache[row.name] = JSON.parse(row.data);
    }

    // One-time migration: any local data/*.json file whose key ISN'T yet
    // in MySQL gets seeded in now. Safe to leave this in permanently —
    // it only ever fills in missing keys, never overwrites an existing
    // MySQL row, so re-deploying a second time is a no-op here.
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace(/\.json$/, '');
        if (!(name in cache)) {
          const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
          cache[name] = parsed;
          await pool.query(
            'INSERT INTO app_data (name, data) VALUES (?, ?)',
            [name, JSON.stringify(parsed)]
          );
          console.log(`[db] Migrated data/${file} into MySQL (first run only).`);
        }
      }
    }

    console.log(`[db] Connected to MySQL (${process.env.DB_HOST}/${process.env.DB_NAME}) — ${Object.keys(cache).length} data keys loaded.`);
  } else {
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace(/\.json$/, '');
        cache[name] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
      }
    }
    console.log('[db] DB_HOST not set — using local JSON files in ./data (fine for local dev; set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME for MySQL in production so data survives redeploys).');
  }
  ready = true;
}

function assertReady() {
  if (!ready) {
    throw new Error('db.js: readData()/writeData() called before initDb() finished. initDb() must be awaited before the server starts listening — see the bottom of server.js.');
  }
}

function readData(name) {
  assertReady();
  if (!(name in cache)) {
    throw new Error(`readData: no data found for "${name}". If this is a brand new key, create it once via writeData("${name}", ...) first.`);
  }
  // Deep-copy so a caller mutating the returned array/object (very common
  // in this codebase: readData → push/modify → writeData) can never
  // accidentally corrupt the shared in-memory cache before writeData()
  // is explicitly called — matches the old file-based behavior, where
  // every readData() call freshly re-parsed the file into an independent
  // object each time.
  return JSON.parse(JSON.stringify(cache[name]));
}

// Writes via a temp file + rename instead of writing the target file
// directly (file mode only). A direct write that gets interrupted partway
// (server crash, restart, out-of-disk) leaves a truncated, corrupted JSON
// file that then fails to parse on the very next read — effectively
// crashing every route that touches that file. Renaming a fully-written
// temp file over the original is atomic on the filesystem: readers only
// ever see either the old complete file or the new complete file, never a
// half-written one.
// DURABILITY FIX: this used to fire the MySQL write with pool.query(...)
// and a bare .catch() for logging, never returned/awaited by callers — so
// every route calling writeData() got its HTTP response back (and told
// the customer/admin "success") before the database write had actually
// completed, or even if it silently failed entirely. A crash in that
// window meant a booking/setting that looked confirmed to the caller was
// never actually persisted.
//
// writeData is now `async` and awaits the MySQL write before resolving.
// This is backward-compatible: existing call sites that don't `await`
// writeData(...) behave exactly as before (fire-and-forget, in-memory
// cache still updates synchronously first). Call sites for
// durability-sensitive writes (e.g. creating a booking) now explicitly
// `await writeData(...)` so a persistence failure surfaces as a proper
// error response instead of a false "success".
async function writeData(name, data) {
  assertReady();
  cache[name] = data; // update the in-memory copy immediately, synchronously
  if (USE_MYSQL) {
    try {
      await pool.query(
        'INSERT INTO app_data (name, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
        [name, JSON.stringify(data)]
      );
    } catch (e) {
      console.error(`[db] FAILED to persist "${name}" to MySQL:`, e.message);
      throw e;
    }
  } else {
    const target = filePath(name);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
  }
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 10000)}`;
}

// A simple per-key async mutex, in-process only. Node runs JS single
// -threaded, so two requests can never truly execute at the same instant —
// but if a request's read-modify-write sequence has an `await` in the
// middle (e.g. an SMS call, a payment step added later), another request
// CAN slip in between the read and the write and get its own changes
// silently overwritten (a "lost update"). Wrapping that sequence in
// withLock(name, fn) queues same-name callers so each one's full
// read-modify-write runs to completion before the next one starts, no
// matter what async work happens inside.
const locks = {};
function withLock(name, fn) {
  const previous = locks[name] || Promise.resolve();
  const result = previous.then(fn, fn);
  locks[name] = result.then(() => undefined, () => undefined);
  return result;
}

// ADDED: needed for the Admin Panel's "Download Backup" feature — since
// this app's storage (whether local JSON files or the MySQL fallback) has
// no built-in backup/export tool of its own, and Render's free tier wipes
// the local filesystem back to whatever's in the git repo on every
// redeploy, real customer/booking data that only ever lived in the live
// site's data files had no way to survive a deploy. Returns everything
// currently in the in-memory cache (a plain copy, not a live reference,
// so the caller can't accidentally mutate the actual cache).
function getAllData() {
  return JSON.parse(JSON.stringify(cache));
}

module.exports = { readData, writeData, genId, withLock, initDb, getAllData };
