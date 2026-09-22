#!/usr/bin/env node
/**
 * Quét toàn bộ sản phẩm trên 1 PURL và trích link redeem.adobe.com (rc code)
 * từ URL popup (đọc redirect_uri), KHÔNG đăng nhập / KHÔNG bấm redeem.
 *
 * Chạy:  node scan-all.js <PURL_hoặc_link> [--headless]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = 'https://www.adobepartneroffer.com/';

function normalizeUrl(input) {
  if (!input) return null;
  return /^https?:\/\//i.test(input) ? input : BASE + input.replace(/^\/+/, '');
}

// Lấy link redeem.adobe.com thật từ URL auth (nằm trong redirect_uri, encode 1-2 lớp)
function extractRedeemLink(authUrl) {
  try {
    let s = decodeURIComponent(authUrl);
    // giải mã tiếp cho tới khi thấy redeem.adobe.com dạng thường
    for (let i = 0; i < 3 && !/https:\/\/redeem\.adobe\.com\/[^"'\s&]*\?rc=/i.test(s); i++) {
      s = decodeURIComponent(s);
    }
    const m = s.match(/https:\/\/redeem\.adobe\.com\/[^\s"'&]*\?rc=[A-Z0-9-]+(?:&sdid=[A-Z0-9]+)?(?:&mv=[a-z]+)?/i);
    if (m) return m[0];
    // fallback: bắt riêng rc
    const rc = s.match(/rc=([A-Z0-9-]{10,})/i);
    return rc ? `rc=${rc[1]}` : null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const headless = argv.includes('--headless');
  const url = normalizeUrl(argv.find((a) => !a.startsWith('--')));
  if (!url) {
    console.error('Thiếu link. Ví dụ: node scan-all.js 5EB971BE4DDB4998B66F475B804D5102');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const results = [];

  // Lấy danh sách nút Select 1 lần
  const page0 = (await browser.pages())[0];
  await page0.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  );
  await page0.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  const buttons = await page0.evaluate(() =>
    [...document.querySelectorAll('input[type=submit]')]
      .filter((b) => /select/i.test(b.value || ''))
      .map((b) => {
        const oc = b.getAttribute('onclick') || '';
        const idm = oc.match(/GetProductID\("(\d+)"\)/);
        let name = '';
        let p = b.parentElement;
        for (let d = 0; d < 4 && p; d++) {
          const lines = (p.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean).filter((x) => !/^Select$/i.test(x));
          if (lines.length) { name = lines.find((l) => /adobe|photograph|substance|acrobat|stock|creative/i.test(l)) || lines[0]; break; }
          p = p.parentElement;
        }
        return { id: b.id, productId: idm ? idm[1] : null, name };
      })
  );

  console.log(`Tìm thấy ${buttons.length} sản phẩm.\n`);

  for (const btn of buttons) {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

    const newTarget = new Promise((resolve) => {
      browser.once('targetcreated', (t) => resolve(t));
    });

    await page.click(`#${btn.id}`).catch(() => {});

    let authUrl = null;
    const t = await Promise.race([newTarget, new Promise((r) => setTimeout(() => r(null), 12000))]);
    if (t) {
      const pp = await t.page().catch(() => null);
      // Popup mở dạng about:blank rồi JS mới redirect sang Adobe -> poll tới khi có URL Adobe
      const target = pp || t;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        let u = '';
        try { u = pp ? pp.url() : t.url(); } catch {}
        if (u && /adobe|redirect_uri|rc=/i.test(u) && u !== 'about:blank') { authUrl = u; break; }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!authUrl) { try { authUrl = pp ? pp.url() : t.url(); } catch {} }
      if (pp) await pp.close().catch(() => {});
    }

    const redeem = authUrl ? extractRedeemLink(authUrl) : null;
    results.push({ product: btn.name, productId: btn.productId, redeem, authUrl });
    console.log(`• ${btn.name} (ID ${btn.productId})`);
    console.log(`  ${redeem || '[không bắt được]'}\n`);

    await page.close().catch(() => {});
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scan-all.json'), JSON.stringify(results, null, 2));
  console.log('Đã lưu output/scan-all.json');

  await browser.close();
}

main().catch((e) => { console.error('Lỗi:', e); process.exit(1); });
