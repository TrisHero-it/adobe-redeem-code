/**
 * Logic dùng chung cho CLI và web server:
 * - đọc/ghi Google Sheet
 * - quét link Adobe Partner Offer lấy code redeem theo từng sản phẩm
 */
const path = require('path');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SPREADSHEET_ID = process.env.SHEET_ID || '1ZiRo9z5-GXRlN-rDFVZwUwN2T9KfnQTqp7joD5rcNLo';
const TAB = 'sheet1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Cột cố định B,C,D,E,F theo ProductID (nút bấm)
const COL_ORDER = ['1563', '1565', '1564', '1566', '1567'];
const HEADERS = ['Creative Cloud Pro', 'Substance 3D', 'Acrobat Standard', 'Photography 1TB', 'Stock'];
const CREDENTIALS = path.join(__dirname, '..', 'credentials.json');

function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readRows() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB}!A1:Z200`,
  });
  const values = res.data.values || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const purl = (row[0] || '').trim();
    if (!/adobepartneroffer\.com/i.test(purl)) continue;
    rows.push({
      rowNumber: i + 1,
      purl,
      codes: HEADERS.map((_, k) => (row[k + 1] || '').trim()),
      filled: HEADERS.filter((_, k) => (row[k + 1] || '').trim() !== '').length,
    });
  }
  return rows;
}

function extractRedeemLink(u) {
  try {
    let s = u;
    for (let i = 0; i < 3 && !/https:\/\/redeem\.adobe\.com\/[^"'\s&]*\?rc=/i.test(s); i++) s = decodeURIComponent(s);
    const m = s.match(/https:\/\/redeem\.adobe\.com\/[^\s"'&]*\?rc=[A-Z0-9-]+(?:&sdid=[A-Z0-9]+)?(?:&mv=[a-z]+)?/i);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quét 1 PURL: mỗi productId tải trang mới, tìm đúng nút theo GetProductID rồi bấm.
// Quét ĐÚNG 1 sản phẩm. Trả về { link, error } với error:
//   'load'    = không tải được trang (timeout/mạng -> nên nghỉ)
//   'notfound'= không thấy nút sản phẩm
//   'nocode'  = bấm được nhưng chưa lấy được code
//   null      = thành công
async function scanOne(browser, page, purl, pid) {
  try {
    await page.goto(purl, { waitUntil: 'networkidle2', timeout: 120000 });
  } catch (e) {
    return { link: null, error: 'load' };
  }
  const btnId = await page.evaluate((wantPid) => {
    const b = [...document.querySelectorAll('input[type=submit]')]
      .filter((x) => /select/i.test(x.value || ''))
      .find((x) => (x.getAttribute('onclick') || '').includes(`GetProductID("${wantPid}")`));
    return b ? b.id : null;
  }, pid).catch(() => null);
  if (!btnId) return { link: null, error: 'notfound' };

  const newTarget = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t)));
  await page.click(`#${btnId}`).catch(() => {});
  const t = await Promise.race([newTarget, sleep(12000).then(() => null)]);

  let authUrl = null;
  if (t) {
    const pp = await t.page().catch(() => null);
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      let u = '';
      try { u = pp ? pp.url() : t.url(); } catch {}
      if (u && u !== 'about:blank' && /adobe|redirect_uri|rc=/i.test(u)) { authUrl = u; break; }
      await sleep(700);
    }
    if (!authUrl) { try { authUrl = pp ? pp.url() : t.url(); } catch {} }
    if (pp) await pp.close().catch(() => {});
  }
  const link = authUrl ? extractRedeemLink(authUrl) : null;
  return { link, error: link ? null : 'nocode' };
}

const colLetter = (pid) => String.fromCharCode(66 + COL_ORDER.indexOf(pid)); // B..F

/**
 * Quét và ghi vào sheet.
 * opts: {
 *   all: bool,               // true = quét lại kể cả ô đã có; false = chỉ ô trống
 *   headless: bool,
 *   products: string[],      // danh sách productId cần lấy (mặc định tất cả)
 *   onProgress: fn(evt)
 * }
 * Chỉ ghi các cột được chọn; KHÔNG đụng tới các cột không chọn.
 */
async function runScan(opts = {}) {
  const { all = false, headless = true, onProgress = () => {} } = opts;
  let products = Array.isArray(opts.products) && opts.products.length ? opts.products : COL_ORDER.slice();
  products = products.filter((p) => COL_ORDER.includes(p)); // lọc hợp lệ
  const log = (msg) => onProgress({ type: 'log', msg });

  // Cấu hình "lấy bằng được": thử lại tới khi đủ code đã chọn
  const maxRounds = Number(opts.maxRounds || process.env.MAX_ROUNDS || 100);   // số vòng tối đa mỗi hàng
  const restMs = Number(opts.restMs || process.env.REST_MS || 45000);          // nghỉ khi site timeout (mặc định 45s)
  const retryMs = Number(opts.retryMs || process.env.RETRY_MS || 4000);        // chờ ngắn khi chỉ chưa ra code

  const sheets = getSheets();
  const rows = await readRows();

  // Với mỗi hàng, xác định cột cần quét theo lựa chọn + chế độ
  const plan = rows
    .map((r) => {
      const pids = products.filter((pid) => {
        const idx = COL_ORDER.indexOf(pid);
        const hasCode = (r.codes[idx] || '') !== '';
        return all ? true : !hasCode; // all: quét lại; ngược lại chỉ ô trống
      });
      return { row: r, pids };
    })
    .filter((p) => p.pids.length);

  const chosenNames = products.map((p) => HEADERS[COL_ORDER.indexOf(p)]).join(', ');
  onProgress({ type: 'start', total: plan.length });
  log(`Sản phẩm chọn: ${chosenNames}`);
  log(`Sẽ quét ${plan.length}/${rows.length} link (${all ? 'quét lại' : 'chỉ ô trống'}).`);

  // ghi tiêu đề
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB}!B1:F1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const nameOf = (pid) => HEADERS[COL_ORDER.indexOf(pid)] || pid;
  // ghi ngay 1 ô khi lấy được code
  const writeCell = async (rowNumber, pid, link) => {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB}!${colLetter(pid)}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[link]] },
    });
  };

  let done = 0;
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setUserAgent(UA);

    for (const { row, pids } of plan) {
      log(`Hàng ${row.rowNumber}: ${row.purl}`);
      onProgress({ type: 'row', rowNumber: row.rowNumber, purl: row.purl, done, total: plan.length });

      const remaining = new Set(pids); // các sản phẩm còn phải lấy
      let round = 0;
      while (remaining.size && round < maxRounds) {
        round++;
        let loadFailed = false;
        for (const pid of [...remaining]) {
          const name = nameOf(pid);
          const { link, error } = await scanOne(browser, page, row.purl, pid);
          if (link) {
            await writeCell(row.rowNumber, pid, link);
            remaining.delete(pid);
            log(`   ${name}: OK (đã ghi)`);
          } else if (error === 'load') {
            loadFailed = true;
            log(`   ${name}: site timeout, sẽ nghỉ rồi thử lại`);
          } else if (error === 'notfound') {
            log(`   ${name}: không thấy nút (bỏ qua)`);
            remaining.delete(pid); // sản phẩm không tồn tại trên link này
          } else {
            log(`   ${name}: chưa ra code, sẽ thử lại`);
          }
          await sleep(400);
        }
        onProgress({
          type: 'row-progress', rowNumber: row.rowNumber,
          got: pids.length - remaining.size, need: pids.length, round,
        });
        if (remaining.size) {
          const wait = loadFailed ? restMs : retryMs;
          log(`   Còn thiếu ${remaining.size}/${pids.length} mã — nghỉ ${Math.round(wait / 1000)}s (vòng ${round}).`);
          await sleep(wait);
        }
      }

      const got = pids.length - remaining.size;
      if (remaining.size) log(`   -> Hàng ${row.rowNumber}: lấy được ${got}/${pids.length} (hết ${maxRounds} vòng, còn thiếu).`);
      else log(`   -> Hàng ${row.rowNumber}: ĐỦ ${got}/${pids.length} mã.`);

      done++;
      onProgress({ type: 'row-done', rowNumber: row.rowNumber, got, done, total: plan.length });
    }
  } finally {
    await browser.close();
  }
  onProgress({ type: 'done', done });
  return { done };
}

module.exports = {
  SPREADSHEET_ID, TAB, COL_ORDER, HEADERS,
  readRows, runScan,
};
