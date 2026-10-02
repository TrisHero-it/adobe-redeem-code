/**
 * Tầng cơ sở dữ liệu (SQLite) — nguồn chính cho link, code và hàng đợi job.
 *   - links:  mỗi link partner offer (kèm số dòng trên Sheet để đồng bộ ngược)
 *   - codes:  mã redeem theo (link, sản phẩm)
 *   - jobs:   hàng đợi quét, mỗi job = 1 (link, sản phẩm)
 */
const path = require('path');
const Database = require('better-sqlite3');
const { COL_ORDER } = require('./core');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  purl       TEXT UNIQUE NOT NULL,
  sheet_row  INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS codes (
  link_id     INTEGER NOT NULL,
  product_key TEXT NOT NULL,
  redeem_link TEXT NOT NULL,
  got_at      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (link_id, product_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  product_key TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|notfound|error
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (link_id, product_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

// --- Links ---
const upsertLinkStmt = db.prepare(`
  INSERT INTO links (purl, sheet_row) VALUES (@purl, @sheet_row)
  ON CONFLICT(purl) DO UPDATE SET sheet_row = excluded.sheet_row
  RETURNING id
`);
function upsertLink(purl, sheetRow) {
  return upsertLinkStmt.get({ purl, sheet_row: sheetRow ?? null }).id;
}
const getLink = db.prepare('SELECT * FROM links WHERE id = ?');
const getLinkByPurl = db.prepare('SELECT * FROM links WHERE purl = ?');
const allLinks = db.prepare('SELECT * FROM links ORDER BY id');

// --- Codes ---
const setCodeStmt = db.prepare(`
  INSERT INTO codes (link_id, product_key, redeem_link) VALUES (@link_id, @product_key, @redeem_link)
  ON CONFLICT(link_id, product_key) DO UPDATE SET redeem_link = excluded.redeem_link, got_at = datetime('now')
`);
function setCode(linkId, productKey, redeemLink) {
  setCodeStmt.run({ link_id: linkId, product_key: productKey, redeem_link: redeemLink });
}
const getCode = db.prepare('SELECT redeem_link FROM codes WHERE link_id = ? AND product_key = ?');
const codesForLink = db.prepare('SELECT product_key, redeem_link FROM codes WHERE link_id = ?');

// --- Jobs (hàng đợi) ---
const addJobStmt = db.prepare(`
  INSERT INTO jobs (link_id, product_key, status, attempts, last_error)
  VALUES (@link_id, @product_key, 'pending', 0, NULL)
  ON CONFLICT(link_id, product_key) DO UPDATE SET status='pending', attempts=0, last_error=NULL, updated_at=datetime('now')
`);
function addJob(linkId, productKey) { addJobStmt.run({ link_id: linkId, product_key: productKey }); }

// Lấy & khóa 1 job pending (nguyên tử, an toàn với nhiều luồng)
const claimStmt = db.transaction(() => {
  const row = db.prepare(`SELECT * FROM jobs WHERE status='pending' ORDER BY id LIMIT 1`).get();
  if (!row) return null;
  db.prepare(`UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?`).run(row.id);
  return row;
});
function claimJob() { return claimStmt(); }

const setJobStmt = db.prepare(`UPDATE jobs SET status=@status, attempts=@attempts, last_error=@last_error, updated_at=datetime('now') WHERE id=@id`);
function setJob(id, status, attempts, lastError) {
  setJobStmt.run({ id, status, attempts, last_error: lastError ?? null });
}

function queueStats() {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM jobs GROUP BY status`).all();
  const out = { pending: 0, running: 0, done: 0, notfound: 0, error: 0 };
  rows.forEach((r) => { out[r.status] = r.c; });
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
function clearJobs() { db.prepare('DELETE FROM jobs').run(); }
// Reset các job 'running' còn kẹt (vd server bị tắt giữa chừng) về pending
function resetRunning() { db.prepare(`UPDATE jobs SET status='pending' WHERE status='running'`).run(); }

function linkSummary() {
  return db.prepare(`
    SELECT l.id, l.purl, l.sheet_row,
      (SELECT COUNT(*) FROM codes c WHERE c.link_id=l.id) AS filled
    FROM links l ORDER BY l.id
  `).all();
}

// Dữ liệu cho bảng: mỗi link kèm code & trạng thái job theo từng sản phẩm.
function tableData() {
  const links = db.prepare('SELECT id, purl, sheet_row FROM links ORDER BY sheet_row, id').all();
  const codes = db.prepare('SELECT link_id, product_key, redeem_link FROM codes').all();
  const jobs = db.prepare('SELECT link_id, product_key, status FROM jobs').all();
  const codeMap = {}, jobMap = {};
  for (const c of codes) (codeMap[c.link_id] = codeMap[c.link_id] || {})[c.product_key] = c.redeem_link;
  for (const j of jobs) (jobMap[j.link_id] = jobMap[j.link_id] || {})[j.product_key] = j.status;
  return links.map((l) => ({
    id: l.id,
    purl: l.purl,
    sheetRow: l.sheet_row,
    codes: codeMap[l.id] || {},
    jobs: jobMap[l.id] || {},
  }));
}

module.exports = {
  db, DB_PATH, COL_ORDER,
  upsertLink, getLink, getLinkByPurl, allLinks,
  setCode, getCode, codesForLink,
  addJob, claimJob, setJob, queueStats, clearJobs, resetRunning,
  linkSummary, tableData,
};
