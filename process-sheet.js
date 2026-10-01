/**
 * CLI: quét link Adobe Partner Offer ở cột A (tab sheet1) và ghi code vào B..F.
 * Dùng chung logic với web server (lib/core.js) — có cơ chế "lấy bằng được"
 * (gặp lỗi thì nghỉ rồi thử lại tới khi đủ code đã chọn).
 *
 * Sản phẩm nhận diện theo TÊN cạnh nút (không theo ProductID, vì mỗi link có
 * bộ ID khác nhau). Key sản phẩm: creative, substance, acrobat, photography, stock.
 *
 * Chạy:
 *   node process-sheet.js                        # chỉ ô trống, tất cả sản phẩm
 *   node process-sheet.js --all                  # quét lại & ghi đè
 *   node process-sheet.js --headless             # chạy ẩn trình duyệt
 *   node process-sheet.js --limit 10             # chỉ chạy 10 link đầu (thỏa điều kiện)
 *   node process-sheet.js --products stock,creative   # chỉ lấy Stock + Creative Cloud Pro
 */
const { runScan, COL_ORDER } = require('./lib/core');

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const headless = argv.includes('--headless');

let products = COL_ORDER.slice();
const pi = argv.indexOf('--products');
if (pi !== -1 && argv[pi + 1]) products = argv[pi + 1].split(',').map((s) => s.trim());

let limit = 0;
const li = argv.indexOf('--limit');
if (li !== -1 && argv[li + 1]) limit = parseInt(argv[li + 1], 10) || 0;

runScan({
  all,
  headless,
  products,
  limit,
  onProgress: (evt) => {
    if (evt.type === 'log') console.log(evt.msg);
  },
})
  .then((r) => console.log(`\nHoàn tất. Đã xử lý ${r.done} hàng.`))
  .catch((e) => { console.error('LỖI:', e.message); process.exit(1); });
