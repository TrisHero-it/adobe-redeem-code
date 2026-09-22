/**
 * Đọc link Adobe Partner Offer ở cột A của tab "sheet1", quét lấy các link
 * redeem.adobe.com (rc code) và ghi sang các cột bên cạnh (B, C, ...).
 *
 * Chạy:  node process-sheet.js            # chỉ điền hàng còn trống cột B
 *        node process-sheet.js --all      # quét lại tất cả hàng (ghi đè)
 *        node process-sheet.js --headless # chạy ẩn trình duyệt
 */
const path = require('path');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SPREADSHEET_ID = process.env.SHEET_ID || '1ZiRo9z5-GXRlN-rDFVZwUwN2T9KfnQTqp7joD5rcNLo';
const TAB = 'sheet1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const DO_ALL = argv.includes('--all');
const HEADLESS = argv.includes('--headless');

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
// Quy ước cột cố định theo ProductID (nút bấm) -> thứ tự cột B,C,D,E,F
// B=Creative Cloud Pro, C=Substance 3D, D=Acrobat Standard, E=Photography 1TB, F=Stock
const COL_ORDER = ['1563', '1565', '1564', '1566', '1567'];
const HEADERS = ['Creative Cloud Pro', 'Substance 3D', 'Acrobat Standard', 'Photography 1TB', 'Stock'];

async function scanPurl(browser, purl) {
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setUserAgent(UA);

  const byProduct = {}; // productId -> link
  // QUAN TRỌNG: trang ĐẢO THỨ TỰ sản phẩm mỗi lần tải, nên KHÔNG bấm theo số
  // thứ tự nút. Mỗi lần tải lại phải tra đúng nút theo GetProductID(productId).
  for (const pid of COL_ORDER) {
    await page.goto(purl, { waitUntil: 'networkidle2', timeout: 120000 });
    // tìm buttonId ứng với productId trên LẦN TẢI HIỆN TẠI
    const btnId = await page.evaluate((wantPid) => {
      const b = [...document.querySelectorAll('input[type=submit]')]
        .filter((x) => /select/i.test(x.value || ''))
        .find((x) => (x.getAttribute('onclick') || '').includes(`GetProductID("${wantPid}")`));
      return b ? b.id : null;
    }, pid);
    if (!btnId) { console.log(`   (không thấy nút cho productId ${pid})`); continue; }

    const newTarget = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t)));
    await page.click(`#${btnId}`).catch(() => {});
    const t = await Promise.race([newTarget, new Promise((r) => setTimeout(() => r(null), 12000))]);
    let authUrl = null;
    if (t) {
      const pp = await t.page().catch(() => null);
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        let u = '';
        try { u = pp ? pp.url() : t.url(); } catch {}
        if (u && u !== 'about:blank' && /adobe|redirect_uri|rc=/i.test(u)) { authUrl = u; break; }
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!authUrl) { try { authUrl = pp ? pp.url() : t.url(); } catch {} }
      if (pp) await pp.close().catch(() => {});
    }
    const link = authUrl ? extractRedeemLink(authUrl) : null;
    if (link) byProduct[pid] = link;
    await new Promise((r) => setTimeout(r, 500));
  }
  // trả về mảng theo đúng thứ tự cột B,C,D,E,F
  return COL_ORDER.map((pid) => byProduct[pid] || '');
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB}!A1:Z200`,
  });
  const rows = res.data.values || [];

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  // ghi tiêu đề cột B..F theo quy ước
  const updates = [{ range: `${TAB}!B1:F1`, values: [HEADERS] }];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const purl = (row[0] || '').trim();
    if (!/adobepartneroffer\.com/i.test(purl)) continue;
    const hasCode = (row[1] || '').trim() !== '';
    if (hasCode && !DO_ALL) {
      console.log(`Hàng ${i + 1}: đã có code, bỏ qua.`);
      continue;
    }
    console.log(`Hàng ${i + 1}: quét ${purl} ...`);
    let links = COL_ORDER.map(() => '');
    try {
      links = await scanPurl(browser, purl);
    } catch (e) {
      console.log(`  Lỗi quét: ${e.message}`);
    }
    const got = links.filter(Boolean).length;
    console.log(`  Lấy được ${got}/5 code:`);
    HEADERS.forEach((h, k) => console.log(`   ${String.fromCharCode(66 + k)} [${h}]: ${links[k] || '(trống)'}`));
    if (got === 0) {
      console.log('   -> Không lấy được mã nào, GIỮ NGUYÊN hàng (không ghi đè).');
      continue;
    }
    // xoá sạch B->Z của hàng rồi ghi lại 5 cột cố định
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB}!B${i + 1}:Z${i + 1}`,
    });
    updates.push({ range: `${TAB}!B${i + 1}:F${i + 1}`, values: [links] });
  }

  await browser.close();

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
    console.log(`\nĐã ghi ${updates.length} hàng vào Google Sheet.`);
  } else {
    console.log('\nKhông có gì để ghi.');
  }
}

main().catch((e) => {
  console.error('LỖI:', e.errors ? JSON.stringify(e.errors) : e.message);
  process.exit(1);
});
