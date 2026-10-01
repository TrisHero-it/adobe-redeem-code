/**
 * Logic dùng chung cho CLI và web server:
 * - đọc/ghi Google Sheet
 * - quét link Adobe Partner Offer lấy code redeem theo từng sản phẩm
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SPREADSHEET_ID = process.env.SHEET_ID || '1ZiRo9z5-GXRlN-rDFVZwUwN2T9KfnQTqp7joD5rcNLo';
const TAB = 'sheet1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Nhận diện sản phẩm theo TÊN cạnh nút (KHÔNG theo ProductID, vì mỗi link
// có bộ ProductID khác nhau). Thứ tự = thứ tự cột B,C,D,E,F.
const PRODUCTS = [
  { key: 'creative',    name: 'Creative Cloud Pro', re: /creative\s*cloud/i },
  { key: 'substance',   name: 'Substance 3D',       re: /substance/i },
  { key: 'acrobat',     name: 'Acrobat Standard',   re: /acrobat/i },
  { key: 'photography', name: 'Photography 1TB',    re: /photograph/i },
  { key: 'stock',       name: 'Stock',              re: /stock/i },
];
const COL_ORDER = PRODUCTS.map((p) => p.key);          // ['creative','substance',...]
const HEADERS = PRODUCTS.map((p) => p.name);
const CREDENTIALS = path.join(__dirname, '..', 'credentials.json');

function getSheets() {
  if (!fs.existsSync(CREDENTIALS)) {
    throw new Error(
      'Thiếu credentials.json (khóa service account Google). ' +
      'Tạo file này ở thư mục gốc dự án — xem credentials.example.json — và share Google Sheet cho email service account.'
    );
  }
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
    range: `${TAB}!A1:Z10000`,
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

// Chọn nút Select đúng sản phẩm dựa vào text cạnh nút. buttons: [{id,text}]
// Trả về id nút khớp, hoặc null nếu link không có sản phẩm đó.
function matchButton(buttons, key) {
  const prod = PRODUCTS.find((p) => p.key === key);
  if (!prod || !Array.isArray(buttons)) return null;
  const hit = buttons.find((b) => prod.re.test(b.text || ''));
  return hit ? hit.id : null;
}

// Quét 1 PURL: mỗi productId tải trang mới, tìm đúng nút theo GetProductID rồi bấm.
// Quét ĐÚNG 1 sản phẩm. Trả về { link, error } với error:
//   'load'    = không tải được trang (timeout/mạng -> nên nghỉ)
//   'notfound'= không thấy nút sản phẩm
//   'nocode'  = bấm được nhưng chưa lấy được code
//   null      = thành công
async function scanOne(browser, page, purl, key) {
  const prod = PRODUCTS.find((p) => p.key === key);
  if (!prod) return { link: null, error: 'notfound' };
  try {
    await page.goto(purl, { waitUntil: 'networkidle2', timeout: 120000 });
  } catch (e) {
    return { link: null, error: 'load' };
  }
  // Lấy tất cả nút Select kèm text sản phẩm cạnh nút (trên lần tải hiện tại)
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll('input[type=submit]')]
      .filter((x) => /select/i.test(x.value || ''))
      .map((x) => {
        let text = '';
        let p = x.parentElement;
        for (let d = 0; d < 5 && p; d++) {
          const s = (p.innerText || '').trim();
          if (s) { text = s; break; }
          p = p.parentElement;
        }
        return { id: x.id, text };
      });
  }).catch(() => null);
  if (!buttons) return { link: null, error: 'load' };
  const btnId = matchButton(buttons, key);
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

  // Cho phép dừng giữa chừng
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;
  class StopError extends Error {}
  // sleep có thể bị ngắt khi người dùng bấm Dừng
  const sleepStoppable = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (shouldStop()) throw new StopError();
      await sleep(Math.min(500, end - Date.now()));
    }
    if (shouldStop()) throw new StopError();
  };

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

  // Giới hạn số lượng link cần chạy (0/không set = tất cả)
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  const finalPlan = limit ? plan.slice(0, limit) : plan;

  const chosenNames = products.map((p) => HEADERS[COL_ORDER.indexOf(p)]).join(', ');
  onProgress({ type: 'start', total: finalPlan.length });
  log(`Sản phẩm chọn: ${chosenNames}`);
  log(`Sẽ quét ${finalPlan.length}/${rows.length} link (${all ? 'quét lại' : 'chỉ ô trống'}${limit ? `, giới hạn ${limit}` : ''}).`);

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
  let stopped = false;
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setUserAgent(UA);

    for (const { row, pids } of finalPlan) {
      if (shouldStop()) throw new StopError();
      log(`Hàng ${row.rowNumber}: ${row.purl}`);
      onProgress({ type: 'row', rowNumber: row.rowNumber, purl: row.purl, done, total: finalPlan.length });

      const remaining = new Set(pids); // các sản phẩm còn phải thử
      const gotten = new Set();         // sản phẩm ĐÃ lấy được code (thực sự ghi)
      const notOffered = new Set();     // sản phẩm link này không có
      const notfoundTries = {};         // đếm số lần không thấy nút (tránh kết luận vội)
      const NOTFOUND_MAX = 3;           // thử lại vài lần trước khi coi là "link không có"
      let round = 0;
      while (remaining.size && round < maxRounds) {
        round++;
        let loadFailed = false;
        for (const pid of [...remaining]) {
          if (shouldStop()) throw new StopError();
          const name = nameOf(pid);
          const { link, error } = await scanOne(browser, page, row.purl, pid);
          if (link) {
            try {
              await writeCell(row.rowNumber, pid, link);
              remaining.delete(pid);
              gotten.add(pid);
              log(`   ${name}: OK (đã ghi)`);
            } catch (we) {
              log(`   ${name}: lấy được code nhưng GHI SHEET lỗi (${we.message}) — sẽ thử lại`);
            }
          } else if (error === 'load') {
            loadFailed = true;
            log(`   ${name}: site timeout, sẽ nghỉ rồi thử lại`);
          } else if (error === 'notfound') {
            notfoundTries[pid] = (notfoundTries[pid] || 0) + 1;
            if (notfoundTries[pid] >= NOTFOUND_MAX) {
              remaining.delete(pid);   // đã thử đủ lần -> coi như link không có sản phẩm này
              notOffered.add(pid);
              log(`   ${name}: link này KHÔNG có sản phẩm này (bỏ qua sau ${NOTFOUND_MAX} lần thử)`);
            } else {
              log(`   ${name}: chưa thấy nút (lần ${notfoundTries[pid]}/${NOTFOUND_MAX}), sẽ thử lại`);
            }
          } else {
            log(`   ${name}: chưa ra code, sẽ thử lại`);
          }
          await sleepStoppable(400);
        }
        onProgress({
          type: 'row-progress', rowNumber: row.rowNumber,
          got: gotten.size, need: pids.length, round,
        });
        if (remaining.size) {
          const wait = loadFailed ? restMs : retryMs;
          log(`   Còn thiếu ${remaining.size}/${pids.length} mã — nghỉ ${Math.round(wait / 1000)}s (vòng ${round}).`);
          await sleepStoppable(wait);
        }
      }

      const got = gotten.size;
      const extras = [];
      if (notOffered.size) extras.push(`${notOffered.size} sản phẩm link không có`);
      if (remaining.size) extras.push(`${remaining.size} chưa lấy được`);
      const suffix = extras.length ? ` (${extras.join(', ')})` : '';
      if (got === pids.length) log(`   -> Hàng ${row.rowNumber}: ĐỦ ${got}/${pids.length} mã.`);
      else log(`   -> Hàng ${row.rowNumber}: lấy được ${got}/${pids.length} mã${suffix}.`);

      done++;
      onProgress({ type: 'row-done', rowNumber: row.rowNumber, got, done, total: finalPlan.length });
    }
  } catch (e) {
    if (e instanceof StopError) {
      stopped = true;
      log('⏹ Đã dừng theo yêu cầu. Các mã lấy được trước đó đã lưu.');
    } else {
      throw e;
    }
  } finally {
    await browser.close();
  }
  onProgress({ type: 'done', done, stopped });
  return { done, stopped };
}

// Thêm link mới vào cuối cột A của sheet (chỉ nhận link adobepartneroffer, bỏ trùng).
async function addLinks(rawText) {
  const sheets = getSheets();
  const incoming = String(rawText || '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /adobepartneroffer\.com/i.test(s));
  if (!incoming.length) return { added: 0, skipped: 0, total: 0 };

  const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${TAB}!A1:A10000` });
  const existing = new Set((cur.data.values || []).map((r) => (r[0] || '').trim()));
  const toAdd = [];
  const seen = new Set();
  for (const link of incoming) {
    if (existing.has(link) || seen.has(link)) continue;
    seen.add(link);
    toAdd.push([link]);
  }
  if (toAdd.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAdd },
    });
  }
  return { added: toAdd.length, skipped: incoming.length - toAdd.length, total: incoming.length };
}

module.exports = {
  SPREADSHEET_ID, TAB, COL_ORDER, HEADERS, PRODUCTS,
  readRows, runScan, addLinks,
  // export cho test
  extractRedeemLink, matchButton,
};
