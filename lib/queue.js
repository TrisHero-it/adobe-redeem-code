/**
 * Hàng đợi quét có chạy song song (nhiều luồng), nền tảng SQLite.
 * - importFromSheet(): nạp link + code sẵn có từ Google Sheet vào DB.
 * - enqueue(): tạo job (link, sản phẩm) cần lấy.
 * - Runner: pool N luồng, mỗi luồng 1 browserContext riêng (tránh tráo mã),
 *   lấy code -> lưu DB + đồng bộ ô Sheet, có retry/nghỉ khi lỗi.
 */
const puppeteer = require('puppeteer');
const core = require('./core');
const dbm = require('./db');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phân tích danh sách proxy. Mỗi dòng nhận các định dạng:
//   host:port | host:port:user:pass | user:pass@host:port | http://user:pass@host:port | socks5://host:port
function parseProxyLine(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^(https?|socks[45]):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      };
    } catch { return null; }
  }
  let user = '', pass = '';
  if (s.includes('@')) {
    const [cred, hostpart] = s.split('@');
    const ci = cred.split(':'); user = ci[0] || ''; pass = ci[1] || '';
    s = hostpart;
  }
  const p = s.split(':');
  if (p.length === 4) return { server: `http://${p[0]}:${p[1]}`, username: p[2], password: p[3] };
  if (p.length === 2) return { server: `http://${p[0]}:${p[1]}`, username: user, password: pass };
  if (p.length === 3) return { server: `http://${p[0]}:${p[1]}`, username: user, password: pass };
  return null;
}
function parseProxies(text) {
  return String(text || '')
    .split(/[\r\n,]+/)
    .map(parseProxyLine)
    .filter(Boolean);
}

// Nạp link + code hiện có từ Sheet vào DB (chạy 1 lần hoặc khi muốn đồng bộ xuống)
async function importFromSheet() {
  const rows = await core.readRows(); // [{rowNumber, purl, codes[], filled}]
  let links = 0, codes = 0;
  const importTxn = dbm.db.transaction((items) => {
    for (const r of items) {
      const id = dbm.upsertLink(r.purl, r.rowNumber);
      links++;
      core.COL_ORDER.forEach((key, i) => {
        const code = (r.codes[i] || '').trim();
        if (code) { dbm.setCode(id, key, code); codes++; }
      });
    }
  });
  importTxn(rows);
  return { links, codes };
}

// Tạo job cho các (link, sản phẩm) cần lấy.
// opts: { products:[key], all:bool, limit:number }
function enqueue(opts = {}) {
  let products = Array.isArray(opts.products) && opts.products.length ? opts.products : core.COL_ORDER.slice();
  products = products.filter((p) => core.COL_ORDER.includes(p));
  const all = !!opts.all;
  const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 0;

  const links = dbm.allLinks.all();
  let added = 0, usedLinks = 0;
  const txn = dbm.db.transaction(() => {
    for (const link of links) {
      if (limit && usedLinks >= limit) break;
      let addedForThis = 0;
      for (const key of products) {
        const has = dbm.getCode.get(link.id, key);
        if (all || !has) { dbm.addJob(link.id, key); added++; addedForThis++; }
      }
      if (addedForThis) usedLinks++;
    }
  });
  txn();
  return { jobs: added, links: usedLinks };
}

class Runner {
  constructor({ concurrency = 2, headless = true, onLog = () => {}, proxies = [] } = {}) {
    this.concurrency = Math.max(1, Math.min(5, Number(concurrency) || 2));
    this.headless = headless;
    this.onLog = onLog;
    this.proxies = Array.isArray(proxies) ? proxies : [];
    this.stopFlag = false;
    this.running = false;
    this.active = 0; // số luồng đang xử lý job
    this.restMs = Number(process.env.REST_MS || 45000);
    this.retryMs = Number(process.env.RETRY_MS || 4000);
    this.maxAttempts = Number(process.env.MAX_ATTEMPTS || 30);
    this.notfoundMax = Number(process.env.NOTFOUND_MAX || 3);
  }

  log(m) { this.onLog(m); }
  stop() { this.stopFlag = true; }

  async start() {
    if (this.running) throw new Error('Runner đang chạy.');
    this.running = true;
    this.stopFlag = false;
    dbm.resetRunning(); // dọn job 'running' kẹt từ lần trước

    this.browser = await puppeteer.launch({
      headless: this.headless ? 'new' : false,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const workers = [];
    for (let i = 0; i < this.concurrency; i++) workers.push(this._worker(i + 1));
    try {
      await Promise.all(workers);
    } finally {
      await this.browser.close().catch(() => {});
      this.running = false;
    }
    return { stopped: this.stopFlag };
  }

  async _worker(wid) {
    // Mỗi luồng dùng 1 proxy (xoay vòng nếu số proxy ít hơn số luồng)
    const proxy = this.proxies.length ? this.proxies[(wid - 1) % this.proxies.length] : null;
    const ctxOpts = proxy ? { proxyServer: proxy.server } : {};
    const ctx = await this.browser.createBrowserContext(ctxOpts);
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    if (proxy && proxy.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
    }
    this.log(`[L${wid}] proxy: ${proxy ? proxy.server : '(không dùng proxy)'}`);

    try {
      while (!this.stopFlag) {
        const job = dbm.claimJob();
        if (!job) {
          // hết job pending: nếu không còn luồng nào đang xử lý -> xong
          if (this.active === 0) break;
          await sleep(500);
          continue;
        }
        this.active++;
        try {
          await this._process(wid, ctx, page, job);
        } catch (e) {
          dbm.setJob(job.id, 'error', (job.attempts || 0) + 1, e.message);
          this.log(`[L${wid}] job#${job.id} lỗi: ${e.message}`);
        } finally {
          this.active--;
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _process(wid, ctx, page, job) {
    const link = dbm.getLink.get(job.link_id);
    const name = core.HEADERS[core.COL_ORDER.indexOf(job.product_key)] || job.product_key;
    const attempts = (job.attempts || 0) + 1;

    const { link: redeem, error } = await core.scanProduct(ctx, page, link.purl, job.product_key);

    if (redeem) {
      dbm.setCode(job.link_id, job.product_key, redeem);
      try {
        await core.writeSheetCell(link.sheet_row, job.product_key, redeem);
      } catch (we) {
        this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: lấy được nhưng GHI SHEET lỗi (${we.message})`);
      }
      dbm.setJob(job.id, 'done', attempts, null);
      this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: OK`);
      return;
    }

    if (error === 'notfound') {
      if (attempts >= this.notfoundMax) {
        dbm.setJob(job.id, 'notfound', attempts, 'link không có sản phẩm này');
        this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: link KHÔNG có sản phẩm này (bỏ)`);
      } else {
        dbm.setJob(job.id, 'pending', attempts, 'notfound');
        this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: chưa thấy nút (${attempts}/${this.notfoundMax})`);
        await sleep(this.retryMs);
      }
      return;
    }

    // load (timeout/mạng) hoặc nocode -> thử lại tới maxAttempts
    if (attempts >= this.maxAttempts) {
      dbm.setJob(job.id, 'error', attempts, error);
      this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: bỏ sau ${attempts} lần (${error})`);
      return;
    }
    dbm.setJob(job.id, 'pending', attempts, error);
    const wait = error === 'load' ? this.restMs : this.retryMs;
    this.log(`[L${wid}] dòng ${link.sheet_row} ${name}: ${error}, nghỉ ${Math.round(wait / 1000)}s rồi thử lại`);
    await sleep(wait);
  }
}

module.exports = { importFromSheet, enqueue, Runner, parseProxies };
