# Hướng Dẫn Chạy Web & Kết Nối SePay (Tương Thích Gói Firebase Spark Miễn Phí)

## 1. Tài khoản mặc định (Chạy ngay trên Live Server 127.0.0.1:5500 không cần deploy Cloud Functions)
- **Trang Quản Trị (`admin.html`):** Tên đăng nhập `admin`, mật khẩu đã lưu trên Firestore (mặc định lần đầu: `meda2026`).
- **Trang Nhân Viên (`nhanvien.html`):** Tên đăng nhập `nhanvien`, mật khẩu mặc định lần đầu: `nhanvien123` (có thể đổi trong mục **Mật khẩu nhân viên** ở menu trái trang Admin).
- **Quy tắc phiên:** Mỗi phiên chỉ đăng nhập 1 vai trò; từ `nhanvien.html` không có đường dẫn sang `admin.html`; Admin từ `admin.html` sang `nhanvien.html` vào thẳng không cần đăng nhập lại; mỗi lần mở `admin.html` đều xóa phiên cũ và bắt buộc nhập lại mật khẩu.

## 2. Nhận Webhook SePay tự động miễn phí 100% (Google Apps Script)
Vì gói Firebase Spark không hỗ trợ Cloud Functions, bạn dùng file `sepay-webhook-apps-script.gs` kèm sẵn:
1. Truy cập https://script.google.com -> **Dự án mới** -> dán toàn bộ nội dung file `sepay-webhook-apps-script.gs`.
2. Trong **Cài đặt dự án → Thuộc tính tập lệnh (Script Properties)**, thêm `SEPAY_API_KEY` là chuỗi bí mật riêng (dài ít nhất 24–32 ký tự). Bản sao này để trống khóa trong mã nguồn. Giá trị phải khớp `?secret=...` trên SePay.
3. Bấm **Triển khai (Deploy)** -> **Tùy chọn triển khai mới** -> **Ứng dụng web (Web app)**:
   - Thực thi dưới danh nghĩa: **Tôi (Me)**
   - Người có quyền truy cập: **Bất kỳ ai (Anyone)**
   -> Copy đường dẫn `https://script.google.com/macros/s/AKfycb.../exec`.
4. Vào `my.sepay.vn` -> **Tích hợp WebHooks** -> **Sửa** webhook VietinBank `105883045437`:
   - **Gọi đến URL:** `https://script.google.com/macros/s/AKfycb.../exec?secret=CHUOI_BI_MAT_CUA_BAN`
   - **Kiểu chứng thực:** Chọn **Không cần chứng thực** (mã bí mật đã nằm trong `?secret=...`).
   - **Request Content Type:** `application/json` -> bấm **Cập nhật**.

5. Trong Admin → Cấu hình Zalo, lưu **Bot Token**, **Chat ID**, bật **Tự động** và **Đơn mới**. Apps Script đọc token từ `config/zaloToken.botToken`, `config/zaloToken.token` hoặc cấu hình cũ `config/zalo.botToken`. Có thể đặt `ZALO_BOT_TOKEN` và `ZALO_CHAT_ID` trong Script Properties để ghi đè. Với Zalo OA, có thể đặt `ZALO_OA_ACCESS_TOKEN`; người nhận vẫn lấy từ cấu hình Admin. Apps Script gọi Zalo trực tiếp, không cần CORS proxy.
6. Trong trình soạn thảo Apps Script, chọn hàm **`setupZaloRetryTrigger` → Chạy (Run)** một lần, đăng nhập chủ dự án và cấp quyền Google yêu cầu. Hàm tạo lịch gửi lại mỗi 5 phút; chạy lại không tạo lịch trùng. Trong mục **Triggers / Trình kích hoạt**, kiểm tra đã có `retryPendingZaloNotifications`.

Ngay khi khách chuyển đủ tiền và nội dung `SEVQR DH...`, SePay gọi Apps Script → ghi thanh toán, số thứ tự, doanh thu, mã giao dịch và hàng đợi Zalo trong cùng một lần ghi nguyên tử → gửi Zalo trực tiếp. Không cần mở Admin, trang bếp hoặc trang thanh toán. Giao dịch chuyển thiếu chỉ gửi thông báo khi chuyển đủ; đơn hết hạn hoặc cần đối soát không gửi thông báo đơn bình thường.

### Cập nhật dự án đang chạy

- Dán mã mới vào **đúng dự án Apps Script đang nhận SePay**, giữ cấu hình bí mật tương ứng; chạy `setupZaloRetryTrigger` như trên.
- Chọn **Triển khai → Quản lý các bản triển khai → Sửa (biểu tượng bút) → Phiên bản mới → Triển khai**. Giữ URL `/exec` hiện có để không phải thay webhook SePay. Chỉ bấm Lưu mã trong trình soạn thảo chưa cập nhật bản web app đã triển khai.
- Cập nhật website và Firestore Rules cùng lúc: chạy `firebase deploy --only hosting,firestore:rules` sau khi đã đăng nhập Firebase và xác nhận đúng dự án `baitapwebmeda`. Nếu còn dùng Cloud Functions trên Blaze, triển khai lại `onOrderPaid` để nó bỏ qua những thông báo do Apps Script quản lý.
- Đơn mới đã được Apps Script xử lý có `zaloNotificationOwner: "apps_script"`; trình duyệt và Cloud Functions bỏ qua để tránh gửi cùng một đơn từ nhiều nơi.

### Kiểm tra Zalo và xử lý lỗi

- Dùng một đơn thử do bạn tạo, thanh toán qua SePay rồi kiểm tra trong **Apps Script → Executions / Lượt thực thi**. Không gửi lại giao dịch ngân hàng thật chỉ để thử.
- Chỉ khi Zalo trả HTTP thành công và nội dung xác nhận thành công, đơn mới có `zaloNotified: true`. Khi Zalo lỗi, thanh toán vẫn giữ nguyên; hàng đợi `zaloOutbox/{mã đơn}` giữ lỗi, số lần thử và thời điểm thử tiếp. Admin cũng hiện lỗi gần nhất trong phần xem trước tin Zalo.
- Sửa token/Chat ID hoặc bật lại tự động, rồi chờ lịch 5 phút. Các lần thất bại tiếp theo được giãn tối đa 1 giờ. Có thể chạy `retryPendingZaloNotifications` thủ công khi đến thời điểm thử tiếp.
- Webhook SePay gọi lại cùng mã giao dịch không cộng thêm tiền, doanh thu hay số thứ tự, nhưng có thể thử gửi lại thông báo chưa thành công.
- Zalo không cung cấp khóa chống trùng cho `sendMessage`: nếu Zalo đã nhận tin nhưng kết nối bị ngắt trước khi lưu xác nhận, một lần thử lại vẫn có thể gửi trùng. Mã đơn luôn nằm trong tin để nhận biết. Không tự đánh dấu đã gửi khi không có phản hồi xác nhận.
- Đơn cũ đã bị trình duyệt đánh dấu nhầm là đã gửi không được tự động gửi lại hàng loạt. Cần đối chiếu các đơn đó riêng.

## 3. Nhập nguyên liệu theo phiếu và phiên

1. Vào **Admin → Kho nguyên liệu → + Nguyên liệu** để khai báo tên và đơn vị; nguyên liệu mới bắt đầu bằng 0. Số lượng hiện có của các nguyên liệu cũ được giữ nguyên.
2. Chọn **+ Lập phiếu nhập**, điền **phiên/ca**, **người nhập**, nhà cung cấp và ghi chú/số hóa đơn nếu có. Mỗi lần nhận hàng tạo một phiếu riêng.
3. Thêm các nguyên liệu, số lượng tăng và **thành tiền cả dòng** bằng VNĐ (không phải đơn giá). Dùng đơn vị đã khai báo, ví dụ 2 kg nguyên liệu có đơn vị g thì nhập 2000. Không dùng số âm; nguyên liệu miễn phí phải nhập rõ thành tiền 0.
4. Kiểm tra các dòng và tổng tiền rồi **Chốt phiếu nhập**. Bản nháp chưa làm thay đổi tồn kho; có thể đóng để giữ nháp trên trình duyệt này. Nếu mất mạng khi chốt, giữ bản nháp và bấm chốt lại cùng phiếu để tránh cộng trùng.
5. Phiếu chốt lưu mã phiếu, thời gian, người nhập, phiên, nhà cung cấp, ghi chú, số lượng, tiền và tồn trước/sau từng nguyên liệu. Kho, chi phí và phiếu được ghi trong cùng một Firestore transaction, kể cả khi có người khác đặt hàng hoặc nhập cùng lúc.
6. **Lịch sử nhập nguyên liệu** cho lọc từ ngày/đến ngày, xem chi tiết và **Xuất Excel (.xlsx)**. Excel có hai trang **Phiếu nhập** và **Chi tiết**, xuất đúng khoảng ngày đang chọn; để trống ngày để xuất toàn bộ.

Phiếu chốt không có thao tác sửa/xóa; Firestore Rules cũng chặn cập nhật/xóa `inventoryReceipts`. Không sửa trực tiếp số tồn hoặc chi phí nguyên liệu trong giao diện. Nguyên liệu chỉ được sửa tên, giữ nguyên đơn vị; bỏ thao tác xóa kho để tránh mất tồn không có chứng từ. Nếu nhập sai phiếu đã chốt, cần đối soát trước khi điều chỉnh dữ liệu; không tạo thêm phiếu để bù một số lượng đã nhập thừa.

Lịch sử chỉ có từ khi dùng phiếu mới, vì dữ liệu cũ không lưu các lần nhập. **Reset Tháng Mới** vẫn làm mới tổng tài chính như trước, nhưng không xóa lịch sử phiếu và không đổi tồn kho.

### Quyền và thư viện

- Cần bật **Firebase Authentication → Anonymous** để lưu/đọc lịch sử phiếu. Phiếu lưu UID của phiên và tên người nhập; luồng đăng nhập Admin hiện có được giữ nguyên.
- Quy tắc cũ của dự án cho phép truy cập công khai các collection khác. Bản cập nhật này khóa sửa/xóa phiếu; chưa chuyển toàn hệ thống sang phân quyền admin tại máy chủ. Vì vậy đây chưa phải lớp bảo vệ chống người cố ý gọi thẳng Firestore để thay đổi kho hoặc cấu hình.
- Xuất Excel dùng SheetJS CE **0.20.3**, đóng gói tại `assets/vendor/xlsx.mjs` cùng giấy phép Apache 2.0. Thư viện chỉ tải khi xuất, không phụ thuộc CDN khi sử dụng và không gửi dữ liệu phiếu sang dịch vụ ngoài.

## 4. Kiểm thử cục bộ

Chạy `node --test tests/*.test.cjs` (Node.js 20 trở lên). Các kiểm thử mô phỏng Firestore/Zalo, không gửi tin hoặc ghi dữ liệu thật; bao gồm trả tiền thiếu/đủ/trùng, lỗi API/HTTP, xung đột ghi, gửi lại, phiếu nhiều dòng, giữ nguyên dữ liệu khi lỗi và đọc lại file Excel.

Kiểm tra tích hợp tùy chọn trên Windows (cần Chrome và Java 21 trong PATH):

```powershell
npm install --prefix .task-tools --no-audit --no-fund playwright@1.58.2 @firebase/rules-unit-testing@5.0.0 firebase@12.9.0 firebase-tools@15.5.1
node tests/admin-receipts.browser.cjs
node .task-tools/node_modules/firebase-tools/lib/bin/firebase.js emulators:exec --only firestore --project demo-meda-test --config .task-firebase.json "node tests/firestore-rules.emulator.cjs"
```

Kiểm thử trình duyệt chặn tất cả kết nối ngoài và dùng dữ liệu mẫu; kiểm thử Rules chỉ dùng dự án giả `demo-meda-test` trong Emulator. Các thư mục kiểm thử, sao lưu và công cụ cục bộ đều được loại khỏi Firebase Hosting.
