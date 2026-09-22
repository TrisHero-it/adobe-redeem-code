#!/usr/bin/env node
/**
 * Adobe Partner Offer - Code Extractor
 * ------------------------------------
 * Mở link Adobe Partner Offer (PURL), liệt kê các sản phẩm, và trích xuất
 * code redeem sinh ra sau khi bấm "Select".
 *
 * Cách chạy:
 *   node index.js <PURL_hoặc_link_đầy_đủ> [tùy chọn]
 *
 * Ví dụ:
 *   node index.js https://www.adobepartneroffer.com/5EB971BE4DDB4998B66F475B804D5102
 *   node index.js 5EB971BE4DDB4998B66F475B804D5102 --list          # chỉ liệt kê sản phẩm
 *   node index.js 5EB971BE4DDB4998B66F475B804D5102 --product 1563  # redeem theo ProductID
 *   node index.js 5EB971BE4DDB4998B66F475B804D5102 --index 0       # redeem sản phẩm thứ 0
 *
 * Tùy chọn:
 *   --list            Chỉ liệt kê sản phẩm, KHÔNG bấm Select (không redeem).
 *   --product <id>    Chọn sản phẩm theo ProductID (vd 1563).
 *   --index <n>       Chọn sản phẩm theo thứ tự (0-based).
 *   --headless        Chạy ẩn trình duyệt (mặc định: hiện, để bạn xử lý captcha nếu có).
 *   --timeout <ms>    Thời gian chờ tối đa (mặc định 120000).
 *
 * LƯU Ý: Bấm "Select" là hành động REDEEM thật và thường tiêu thụ offer.
 *        Dùng --list trước để xem, rồi mới redeem sản phẩm mong muốn.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = 'https://www.adobepartneroffer.com/';

function parseArgs(argv) {
  const args = { _: [], list: false, headless: false, product: null, index: null, timeout: 120000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--product') args.product = String(argv[++i]);
    else if (a === '--index') args.index = parseInt(argv[++i], 10);
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10);
    else args._.push(a);
  }
  return args;
}

function normalizeUrl(input) {
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  return BASE + input.replace(/^\/+/, '');
}

// Các mẫu code redeem thường gặp của Adobe / promo
function findCodes(text) {
  const patterns = [
    /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, // XXXX-XXXX-XXXX-XXXX
    /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g,             // XXXX-XXXX-XXXX
    /\b[A-Z0-9]{16,24}\b/g,                                  // chuỗi code liền
  ];
  const found = new Set();
  for (const p of patterns) {
    const m = text.match(p);
    if (m) m.forEach((x) => found.add(x));
  }
  return [...found];
}

async function extractFromPage(page) {
  return await page.evaluate(() => {
    const result = { url: location.href, title: document.title, text: '', inputs: [], links: [] };
    result.text = (document.body ? document.body.innerText : '') || '';
    result.inputs = [...document.querySelectorAll('input,textarea')]
      .map((i) => ({ id: i.id, name: i.name, type: i.type, value: i.value }))
      .filter((i) => i.value && i.type !== 'hidden');
    result.links = [...document.querySelectorAll('a[href]')]
      .map((a) => a.href)
      .filter((h) => /redeem|redemption|code|adobe\.com\/.*redeem|account\.adobe/i.test(h));
    return result;
  });
}

async function listProducts(page) {
  return await page.evaluate(() => {
    const panels = [...document.querySelectorAll('[id^="rptCobrandProducts_"], .ProductPanel, .ProductPanel2')];
    const out = [];
    const btns = [...document.querySelectorAll('input[type=submit]')].filter((b) => /select/i.test(b.value || ''));
    for (const b of btns) {
      const oc = b.getAttribute('onclick') || '';
      const idm = oc.match(/GetProductID\("(\d+)"\)/);
      const panel = b.closest('div');
      let name = '';
      let desc = '';
      // Tìm tên sản phẩm gần nút
      let p = b.parentElement;
      for (let depth = 0; depth < 4 && p; depth++) {
        const t = p.innerText || '';
        if (t.trim()) { name = t.trim().split('\n').filter(Boolean); break; }
        p = p.parentElement;
      }
      out.push({
        productId: idm ? idm[1] : null,
        buttonName: b.name,
        buttonId: b.id,
        lines: Array.isArray(name) ? name.slice(0, 4) : [],
      });
    }
    return out;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = normalizeUrl(args._[0]);
  if (!url) {
    console.error('Thiếu link. Ví dụ: node index.js https://www.adobepartneroffer.com/<PURL>');
    process.exit(1);
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: args.headless ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox'],
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  );

  console.log('→ Mở:', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: args.timeout });

  const products = await listProducts(page);
  console.log('\n=== Sản phẩm khả dụng ===');
  products.forEach((p, i) => {
    console.log(`[${i}] ProductID=${p.productId}  ${p.lines.filter((l) => !/^Select$/i.test(l)).join(' | ')}`);
  });

  if (args.list) {
    fs.writeFileSync(path.join(outDir, 'products.json'), JSON.stringify(products, null, 2));
    console.log('\nĐã lưu danh sách vào output/products.json (không redeem).');
    await browser.close();
    return;
  }

  // Chọn nút Select
  let target = null;
  if (args.product != null) target = products.find((p) => p.productId === String(args.product));
  else if (args.index != null) target = products[args.index];
  else target = products[0];

  if (!target) {
    console.error('\nKhông tìm thấy sản phẩm phù hợp. Dùng --list để xem, rồi --product <id> hoặc --index <n>.');
    await browser.close();
    process.exit(2);
  }

  console.log(`\n→ Redeem ProductID=${target.productId} (nút ${target.buttonId})`);

  // Bắt popup nếu redeem mở cửa sổ mới (hdnIMRA=true)
  const popupPromise = new Promise((resolve) => {
    browser.once('targetcreated', async (t) => {
      try {
        const p = await t.page();
        if (p) resolve(p);
        else resolve(null);
      } catch { resolve(null); }
    });
  });

  const navPromise = page
    .waitForNavigation({ waitUntil: 'networkidle2', timeout: args.timeout })
    .catch(() => null);

  await page.click(`#${target.buttonId}`);

  // Chờ popup hoặc điều hướng
  const popup = await Promise.race([
    popupPromise,
    new Promise((r) => setTimeout(() => r(null), 8000)),
  ]);
  await navPromise;

  const resultPage = popup || page;
  try {
    await resultPage.bringToFront();
    await resultPage.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
  } catch {}

  console.log('\n⚠ Nếu có reCAPTCHA/checkbox, hãy hoàn tất trong cửa sổ trình duyệt. Đang chờ code xuất hiện...');

  // Poll tối đa timeout để chờ code
  const deadline = Date.now() + args.timeout;
  let data = null;
  let codes = [];
  while (Date.now() < deadline) {
    data = await extractFromPage(resultPage);
    codes = findCodes(data.text);
    const inputCodes = data.inputs.map((i) => i.value).flatMap((v) => findCodes(v || ''));
    codes = [...new Set([...codes, ...inputCodes])];
    if (codes.length || data.links.length || /redeem|redemption code|your code/i.test(data.text)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Chụp màn hình + lưu HTML kết quả
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = path.join(outDir, `result-${target.productId}-${stamp}.png`);
  const htmlOut = path.join(outDir, `result-${target.productId}-${stamp}.html`);
  try { await resultPage.screenshot({ path: shot, fullPage: true }); } catch {}
  try { fs.writeFileSync(htmlOut, await resultPage.content()); } catch {}

  const summary = {
    url: data ? data.url : null,
    title: data ? data.title : null,
    productId: target.productId,
    codes,
    redemptionLinks: data ? data.links : [],
    visibleInputs: data ? data.inputs : [],
    screenshot: shot,
    html: htmlOut,
  };
  fs.writeFileSync(path.join(outDir, `result-${target.productId}-${stamp}.json`), JSON.stringify(summary, null, 2));

  console.log('\n=== KẾT QUẢ ===');
  if (codes.length) {
    console.log('CODE tìm được:');
    codes.forEach((c) => console.log('  •', c));
  } else {
    console.log('Không bắt được code theo mẫu. Xem file HTML/ảnh trong output/ để lấy thủ công.');
  }
  if (summary.redemptionLinks.length) {
    console.log('Link redeem:');
    summary.redemptionLinks.forEach((l) => console.log('  →', l));
  }
  console.log('\nĐã lưu: ', shot);
  console.log('         ', htmlOut);
  console.log('         ', path.join(outDir, `result-${target.productId}-${stamp}.json`));

  // Giữ trình duyệt mở 5s để bạn xem, rồi đóng (bỏ dòng dưới nếu muốn giữ mở)
  await new Promise((r) => setTimeout(r, 5000));
  await browser.close();
}

main().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(1);
});
