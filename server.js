/**
 * Server quản lý — dùng DB (SQLite) + hàng đợi song song.
 * Chạy:  node server.js   ->  http://localhost:3001
 */
const express = require('express');
const path = require('path');
const { HEADERS, COL_ORDER, SPREADSHEET_ID, TAB, addLinks } = require('./lib/core');
const { importFromSheet, enqueue, Runner, parseProxies } = require('./lib/queue');
const dbm = require('./lib/db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;

// Trạng thái trong bộ nhớ
const state = {
  phase: 'idle', // idle | running | done | stopped | error
  concurrency: 2,
  logs: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};
let runner = null;
function pushLog(msg) {
  state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (state.logs.length > 800) state.logs.shift();
}

app.get('/api/info', (req, res) => {
  res.json({
    columns: HEADERS,
    productIds: COL_ORDER,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
    tab: TAB,
    dbPath: dbm.DB_PATH,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    phase: state.phase,
    concurrency: state.concurrency,
    stats: dbm.queueStats(),
    links: dbm.allLinks.all().length,
    logs: state.logs,
    error: state.error,
    stopRequested: runner ? runner.stopFlag : false,
  });
});

// Nạp link + code từ Sheet vào DB
app.post('/api/import', async (req, res) => {
  try {
    const r = await importFromSheet();
    pushLog(`Import từ Sheet: ${r.links} link, ${r.codes} code.`);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Thêm link mới (ghi Sheet + đồng bộ vào DB)
app.post('/api/add-links', async (req, res) => {
  try {
    const r = await addLinks(req.body && req.body.text);
    if (r.added) await importFromSheet();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chạy: import -> enqueue -> start runner
app.post('/api/run', async (req, res) => {
  if (state.phase === 'running') return res.status(409).json({ error: 'Đang chạy rồi.' });
  const body = req.body || {};
  let products = Array.isArray(body.products) ? body.products.map(String).filter((p) => COL_ORDER.includes(p)) : COL_ORDER.slice();
  if (!products.length) return res.status(400).json({ error: 'Chưa chọn sản phẩm nào.' });
  const all = !!body.all;
  const limit = Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : 0;
  const concurrency = Math.max(1, Math.min(5, Number(body.concurrency) || 2));
  const headless = body.headless === false ? false : true;
  const proxies = parseProxies(body.proxies);

  Object.assign(state, {
    phase: 'running', concurrency, logs: [], startedAt: Date.now(), finishedAt: null, error: null,
  });
  res.json({ ok: true });

  try {
    const imp = await importFromSheet();
    pushLog(`Đồng bộ Sheet -> DB: ${imp.links} link, ${imp.codes} code có sẵn.`);
    const eq = enqueue({ products, all, limit });
    const names = products.map((p) => HEADERS[COL_ORDER.indexOf(p)]).join(', ');
    pushLog(`Tạo ${eq.jobs} job cho ${eq.links} link (${all ? 'quét lại' : 'ô trống'}${limit ? `, giới hạn ${limit}` : ''}).`);
    pushLog(`Sản phẩm: ${names} | ${concurrency} luồng | ${proxies.length ? proxies.length + ' proxy' : 'không proxy'}.`);
    if (eq.jobs === 0) { state.phase = 'done'; state.finishedAt = Date.now(); pushLog('Không có job nào cần chạy.'); return; }

    runner = new Runner({ concurrency, headless, onLog: pushLog, proxies });
    const r = await runner.start();
    state.phase = r.stopped ? 'stopped' : 'done';
    state.finishedAt = Date.now();
    pushLog(r.stopped ? 'Đã dừng.' : 'Hoàn tất hàng đợi.');
  } catch (e) {
    state.phase = 'error';
    state.error = e.message;
    state.finishedAt = Date.now();
    pushLog(`LỖI: ${e.message}`);
  } finally {
    runner = null;
  }
});

app.post('/api/stop', (req, res) => {
  if (state.phase !== 'running' || !runner) return res.status(409).json({ error: 'Không có tiến trình đang chạy.' });
  runner.stop();
  pushLog('⏹ Nhận yêu cầu DỪNG — đang kết thúc an toàn...');
  res.json({ ok: true });
});

// Dọn toàn bộ job (reset hàng đợi)
app.post('/api/clear-queue', (req, res) => {
  if (state.phase === 'running') return res.status(409).json({ error: 'Đang chạy, không thể dọn.' });
  dbm.clearJobs();
  pushLog('Đã dọn hàng đợi.');
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Trang quản lý: http://localhost:${PORT}\n  DB: ${dbm.DB_PATH}\n`);
});
