/**
 * Server quản lý tool Adobe Partner Offer.
 * Chạy:  node server.js   ->  mở http://localhost:3000
 */
const express = require('express');
const path = require('path');
const { readRows, runScan, HEADERS, COL_ORDER, SPREADSHEET_ID, TAB } = require('./lib/core');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Trạng thái công việc trong bộ nhớ
const job = {
  state: 'idle', // idle | running | done | error
  all: false,
  total: 0,
  done: 0,
  current: null, // {rowNumber, purl}
  logs: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};
function pushLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > 500) job.logs.shift();
}

// Thông tin chung + cấu hình
app.get('/api/info', (req, res) => {
  res.json({
    spreadsheetId: SPREADSHEET_ID,
    tab: TAB,
    columns: HEADERS,
    productIds: COL_ORDER,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
  });
});

// Danh sách link + code hiện có trong sheet
app.get('/api/rows', async (req, res) => {
  try {
    const rows = await readRows();
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trạng thái công việc
app.get('/api/status', (req, res) => res.json(job));

// Chạy quét
app.post('/api/run', async (req, res) => {
  if (job.state === 'running') return res.status(409).json({ error: 'Đang chạy rồi.' });
  const all = !!(req.body && req.body.all);
  const headless = req.body && req.body.headless === false ? false : true;
  let products = req.body && Array.isArray(req.body.products) ? req.body.products.map(String) : COL_ORDER.slice();
  products = products.filter((p) => COL_ORDER.includes(p));
  if (!products.length) return res.status(400).json({ error: 'Chưa chọn sản phẩm nào.' });

  Object.assign(job, {
    state: 'running', all, products, total: 0, done: 0, current: null,
    logs: [], startedAt: Date.now(), finishedAt: null, error: null,
  });
  const names = products.map((p) => HEADERS[COL_ORDER.indexOf(p)]).join(', ');
  pushLog(`Bắt đầu quét (${all ? 'quét lại' : 'ô trống'}, ${headless ? 'ẩn' : 'hiện'} trình duyệt).`);
  pushLog(`Sản phẩm: ${names}`);
  res.json({ ok: true });

  runScan({
    all,
    headless,
    products,
    onProgress: (evt) => {
      if (evt.type === 'start') job.total = evt.total;
      else if (evt.type === 'row') job.current = { rowNumber: evt.rowNumber, purl: evt.purl };
      else if (evt.type === 'row-done') job.done = evt.done;
      else if (evt.type === 'log') pushLog(evt.msg);
    },
  })
    .then((r) => {
      job.state = 'done';
      job.current = null;
      job.finishedAt = Date.now();
      pushLog(`Hoàn tất. Đã xử lý ${r.done} hàng.`);
    })
    .catch((e) => {
      job.state = 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      pushLog(`LỖI: ${e.message}`);
    });
});

app.listen(PORT, () => {
  console.log(`\n  Trang quản lý: http://localhost:${PORT}\n`);
});
