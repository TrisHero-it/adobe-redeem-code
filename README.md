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
npm start          # mở http://localhost:3000
```

- **Chọn code muốn lấy**: tích các sản phẩm cần (Creative Cloud Pro, Substance 3D, Acrobat Standard, Photography 1TB, Stock).
- **▶ Chạy (chỉ ô trống)**: chỉ điền ô trống của các cột đã chọn.
- **↻ Chạy lại (ghi đè)**: làm mới code cho các cột đã chọn.
- Trạng thái + log cập nhật trực tiếp; bảng hiển thị link & code hiện có.

## Dùng bằng CLI

```bash
node process-sheet.js            # điền code cho hàng còn trống
node process-sheet.js --all      # quét lại & ghi đè tất cả
node process-sheet.js --headless # chạy ẩn trình duyệt
node scan-all.js <PURL>          # quét 1 link, in ra code
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

## Ghi chú kỹ thuật

- Trang Adobe **đảo thứ tự sản phẩm mỗi lần tải**, nên tool bấm nút theo `GetProductID(...)` chứ không theo vị trí.
- Mỗi PURL thực chất chỉ **redeem được 1 sản phẩm**; các cột là để lựa chọn.
- Nếu gặp `timeout` (bị giới hạn tần suất): đợi vài phút rồi chạy lại. Tool **không xoá** dữ liệu cũ khi quét hỏng.

## Cấu trúc

- `server.js` — web server (Express)
- `public/index.html` — giao diện quản lý
- `lib/core.js` — logic quét Puppeteer + đọc/ghi Google Sheet
- `process-sheet.js`, `scan-all.js` — công cụ dòng lệnh
