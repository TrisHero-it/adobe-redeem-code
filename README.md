# Adobe Redeem Code Tool

Tool tự động lấy link/code redeem từ trang **Adobe Partner Offer** và ghi vào Google Sheet, kèm **trang quản lý web** (chọn sản phẩm, nút chạy, trạng thái/log trực tiếp).

## Cài đặt

```bash
npm install
```

Tạo file `credentials.json` (service account của Google, xem `credentials.example.json`) và **share Google Sheet cho email service account** với quyền Editor.

> ⚠️ `credentials.json` là khóa bí mật — đã được `.gitignore`, không commit lên GitHub.

## Trang quản lý (khuyên dùng)

```bash
npm start          # mở http://localhost:3001 (chỉ localhost)
```

- **Thêm link mới vào sheet**: dán link (mỗi dòng một link) → tự thêm vào cột A, bỏ trùng. Khỏi mở Google Sheets.
- **Chọn code muốn lấy**: tích các sản phẩm cần (Creative Cloud Pro, Substance 3D, Acrobat Standard, Photography 1TB, Stock).
- **Số lượng link cần chạy**: để trống = tất cả, điền N = chỉ chạy N link đầu.
- **▶ Chạy (chỉ ô trống)**: chỉ điền ô trống của các cột đã chọn.
- **↻ Chạy lại (ghi đè)**: làm mới code cho các cột đã chọn.
- **⏹ Dừng**: ngắt an toàn giữa chừng, giữ các mã đã lấy.
- Trạng thái + log cập nhật trực tiếp.

## Dùng bằng CLI

```bash
node process-sheet.js                       # điền code cho hàng còn trống
node process-sheet.js --all                 # quét lại & ghi đè tất cả
node process-sheet.js --headless            # chạy ẩn trình duyệt
node process-sheet.js --limit 10            # chỉ chạy 10 link đầu
node process-sheet.js --products stock,creative   # chỉ lấy Stock + Creative Cloud Pro
node scan-all.js <PURL>                      # quét 1 link, in ra code
npm test                                     # chạy test
```

## Quy ước cột trong Google Sheet (tab `sheet1`)

| Cột | Sản phẩm |
|-----|----------|
| A | Link partner offer (đầu vào) |
| B | Creative Cloud Pro |
| C | Substance 3D |
| D | Acrobat Standard |
| E | Photography 1TB |
| F | Stock |

## Kiến trúc: DB + hàng đợi

- **SQLite (`data.db`)** là nguồn chính: lưu `links`, `codes` (mã theo từng sản phẩm) và `jobs` (hàng đợi). File này nằm ngoài git.
- Khi bấm Chạy: tool **đồng bộ Sheet → DB** (nạp link mới + code có sẵn), tạo **job** cho các (link, sản phẩm) cần lấy, rồi chạy **nhiều luồng song song** (2–5, chỉnh ở ô "Số luồng").
- Mỗi luồng dùng một `browserContext` riêng để **không tráo mã** giữa các luồng.
- **Proxy**: dán danh sách proxy (mỗi dòng một proxy) ở dashboard — mỗi luồng dùng 1 proxy (xoay vòng nếu ít hơn số luồng). Định dạng: `host:port`, `host:port:user:pass`, `user:pass@host:port`, hoặc `http://`/`socks5://...`. Nên đặt số proxy ≥ số luồng để mỗi luồng một IP, giảm bị giới hạn tần suất.
- Lấy được mã nào **lưu ngay** vào DB **và** ghi ô tương ứng trên Google Sheet.
- Job lỗi (timeout/chưa ra code) tự **nghỉ rồi thử lại**; "link không có sản phẩm" thử 3 lần rồi bỏ. Tắt server giữa chừng, job `running` sẽ về `pending` ở lần chạy sau (resume).
- Thống kê hàng đợi (chờ / đang chạy / xong / link không có / lỗi) hiện realtime trên dashboard.

## Ghi chú kỹ thuật

- Trang Adobe **đảo thứ tự sản phẩm mỗi lần tải** và **mỗi link có bộ ProductID riêng**, nên tool nhận diện sản phẩm theo **TÊN** cạnh nút (Stock/Creative Cloud/Substance/Acrobat/Photography), không theo vị trí hay ProductID.
- Mỗi PURL thực chất chỉ **redeem được 1 sản phẩm**; các cột là để lựa chọn.
- Nếu gặp `timeout` (bị giới hạn tần suất): đợi vài phút rồi chạy lại. Tool **không xoá** dữ liệu cũ khi quét hỏng.

## Cấu trúc

- `server.js` — web server (Express)
- `public/index.html` — giao diện quản lý
- `lib/core.js` — logic quét Puppeteer + đọc/ghi Google Sheet
- `process-sheet.js`, `scan-all.js` — công cụ dòng lệnh
