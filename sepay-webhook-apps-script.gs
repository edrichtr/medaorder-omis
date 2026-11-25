/**
 * ============================================================================
 *  MÊ ĐÁ — SEPAY WEBHOOK BRIDGE (GOOGLE APPS SCRIPT — MIỄN PHÍ 100%)
 * ----------------------------------------------------------------------------
 *  Dành cho dự án Firebase gói Spark miễn phí (không cần nâng cấp Blaze).
 *  Cách triển khai:
 *   1. Vào https://script.google.com -> Dự án mới -> dán toàn bộ file này.
 *   2. Thay SEPAY_API_KEY bên dưới bằng chuỗi bí mật riêng của bạn (24-32 ký tự).
 *   3. Bấm Triển khai (Deploy) -> Tùy chọn triển khai mới -> Ứng dụng web (Web app):
 *        - Thực thi dưới danh nghĩa: Tôi (Me)
 *        - Người có quyền truy cập: Bất kỳ ai (Anyone)
 *      -> Copy URL dạng https://script.google.com/macros/s/AKfycb.../exec
 *   4. Vào my.sepay.vn -> Tích hợp WebHooks -> Sửa webhook VietinBank 105883045437:
 *        - Gọi đến URL: https://script.google.com/macros/s/AKfycb.../exec?secret=CHUOI_BI_MAT_CUA_BAN
 *        - Kiểu chứng thực: Không cần chứng thực (vì Google Apps Script không đọc Header Authorization)
 *        - Request Content Type: application/json
 *   5. Lưu Bot Token + Chat ID và bật Tự động / Đơn mới trong Admin.
 *   6. Chạy setupZaloRetryTrigger một lần và cấp quyền để gửi lại khi Zalo lỗi.
 *   Khi cập nhật: Quản lý bản triển khai -> Sửa -> Phiên bản mới -> Triển khai.
 *   Script Properties SEPAY_API_KEY ghi đè hằng số cũ bên dưới nếu được đặt.
 * ============================================================================
 */

const SEPAY_API_KEY = ""; // Set SEPAY_API_KEY in Script Properties.
const FIREBASE_PROJECT_ID = "baitapwebmeda";
const FS_BASE = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents";

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDateKeyVN() {
  return Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "dd/MM/yyyy");
}

function getDateTimeVN() {
  return Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "HH:mm:ss dd/MM/yyyy");
}

function fsRequest(path, options) {
  const res = UrlFetchApp.fetch(FS_BASE + path, Object.assign({ muteHttpExceptions: true }, options || {}));
  const code = res.getResponseCode();
  if (code === 404 && !options) return null;
  if (code < 200 || code >= 300) {
    const err = new Error("Firestore HTTP " + code);
    err.conflict = code === 409 || code === 412;
    throw err;
  }
  return JSON.parse(res.getContentText());
}

function fsGet(path) { return fsRequest("/" + path); }

function fsValue(value) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function fsWrite(path, values, previous) {
  const fields = {};
  Object.keys(values).forEach(function (key) { fields[key] = fsValue(values[key]); });
  const write = {
    update: { name: FS_BASE.replace("https://firestore.googleapis.com/v1/", "") + "/" + path, fields: fields },
    updateMask: { fieldPaths: Object.keys(fields) }
  };
  if (previous !== undefined) write.currentDocument = previous ? { updateTime: previous.updateTime } : { exists: false };
  return write;
}

function fsCommit(writes) {
  return fsRequest(":commit", { method: "post", contentType: "application/json", payload: JSON.stringify({ writes: writes }) });
}

function fsPatch(path, values) { return fsCommit([fsWrite(path, values)]); }

function numVal(fields, key, def) {
  const f = (fields || {})[key] || {};
  return Number(f.integerValue !== undefined ? f.integerValue : f.doubleValue !== undefined ? f.doubleValue : def || 0);
}

function strVal(fields, key, def) { return String(((fields || {})[key] || {}).stringValue || def || ""); }
function boolVal(fields, key, def) {
  const value = ((fields || {})[key] || {}).booleanValue;
  return value === undefined ? Boolean(def) : value;
}

// Preconditions make payment, queue, revenue, transaction log and notification queue atomic,
// including when an order or stock receipt is being updated by another browser.
function recordPayment(data, txId, orderCode, amount) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (fsGet("sepayTransactions/" + txId)) return { duplicate: true, orderCode: orderCode };
      const orderDoc = fsGet("orders/" + orderCode);
      const txDate = String(data.transactionDate || getDateTimeVN());
      const txWrite = fsWrite("sepayTransactions/" + txId, {
        txId: txId, orderCode: orderCode, transferAmount: amount,
        transactionDate: txDate, matched: !!orderDoc
      }, null);
      if (!orderDoc) {
        fsCommit([txWrite]);
        return { matched: false, orderCode: orderCode };
      }
      const f = orderDoc.fields || {};
      const total = numVal(f, "total");
      const received = numVal(f, "received") + amount;
      if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(received)) throw new Error("Số tiền đơn hàng không hợp lệ.");
      const changes = { received: received, sepay_tx_id: txId, paid_at: txDate };
      const writes = [];
      if (boolVal(f, "expired")) {
        changes.requiresReconciliation = true;
      } else if (strVal(f, "payment_status") === "PAID") {
        changes.requiresReconciliation = received > total;
      } else if (received >= total) {
        const today = getDateKeyVN();
        const queue = fsGet("config/queue");
        const qf = queue ? queue.fields : {};
        const sameDay = strVal(qf, "dateKey") === today || strVal(qf, "date") === today;
        const next = (sameDay ? numVal(qf, "count", numVal(qf, "current")) : 0) + 1;
        const finance = fsGet("config/finance");
        writes.push(fsWrite("config/queue", { dateKey: today, date: today, count: next, current: next, updatedAt: Date.now() }, queue));
        writes.push(fsWrite("config/finance", { totalRevenue: numVal(finance && finance.fields, "totalRevenue") + total }, finance));
        Object.assign(changes, {
          payment_status: "PAID", status: "Chờ pha chế", queueNumber: next, stockHold: false,
          requiresReconciliation: received > total, zaloNotified: false, zaloNotificationOwner: "apps_script"
        });
        if (received === total) {
          writes.push(fsWrite("zaloOutbox/" + orderCode, { orderCode: orderCode, attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now() }));
        }
      } else {
        changes.payment_status = "PARTIAL";
      }
      writes.push(fsWrite("orders/" + orderCode, changes, orderDoc), txWrite);
      fsCommit(writes);
      return { matched: true, orderCode: orderCode, received: received };
    } catch (err) {
      if (!err.conflict || attempt === 4) throw err;
      Utilities.sleep(100 * (attempt + 1));
    }
  }
}

function buildPaidOrderMessage(orderCode, f) {
  const items = (((f.items || {}).arrayValue || {}).values || []);
  return [
    "🛎️ [MÊ ĐÁ] ĐÃ THANH TOÁN — ĐƠN #" + numVal(f, "queueNumber"),
    "🧾 Mã đơn: " + orderCode,
    "🕒 Thanh toán: " + strVal(f, "paid_at"),
    "👤 Khách hàng: " + strVal(f, "customerName", "Khách hàng"),
    "🏷️ Hình thức: " + strVal(f, "orderType", "Tại chỗ"),
    "------------------------"
  ].concat(items.map(function (item) {
    const row = (item.mapValue || {}).fields || {};
    return "• " + strVal(row, "name") + " x" + numVal(row, "quantity");
  }), [
    "💰 Tổng thanh toán: " + numVal(f, "total").toLocaleString("vi-VN") + " VNĐ",
    "📌 Trạng thái: " + strVal(f, "status", "Chờ pha chế")
  ]).join("\n").slice(0, 3900);
}

function sendZaloMessage(message, cfg) {
  const mode = strVal(cfg, "mode", "zalo_bot");
  const props = PropertiesService.getScriptProperties();
  let url, payload, headers = {};
  if (mode === "zalo_bot") {
    const tokenDoc = fsGet("config/zaloToken");
    const tokenFields = tokenDoc ? tokenDoc.fields : {};
    const token = props.getProperty("ZALO_BOT_TOKEN") || strVal(tokenFields, "botToken") || strVal(tokenFields, "token") || strVal(cfg, "botToken");
    const chatId = props.getProperty("ZALO_CHAT_ID") || strVal(cfg, "botChatId");
    if (!token || !chatId) throw new Error("Thiếu Zalo Bot Token hoặc Chat ID.");
    url = "https://bot-api.zapps.me/bot" + token + "/sendMessage";
    payload = { chat_id: chatId, text: message };
  } else if (mode === "zalo_oa") {
    const token = props.getProperty("ZALO_OA_ACCESS_TOKEN") || strVal(cfg, "oaAccessToken");
    const recipient = strVal(cfg, "oaRecipientId");
    if (!token || !recipient) throw new Error("Thiếu Zalo OA Token hoặc người nhận.");
    url = "https://openapi.zalo.me/v3.0/oa/message/cs";
    headers.access_token = token;
    payload = { recipient: { user_id: recipient }, message: { text: message } };
  } else if (mode === "webhook") {
    url = strVal(cfg, "webhookUrl");
    if (!/^https:\/\//i.test(url)) throw new Error("Webhook Zalo phải là URL HTTPS.");
    payload = { shop: "Mê Đá", type: "new_order", message: message, text: message, content: message };
  } else {
    throw new Error("Phương thức Zalo không hợp lệ.");
  }
  let response;
  try {
    response = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (_) {
    // Fetch exceptions may contain the bot token in their URL.
    throw new Error("Không kết nối được máy chủ Zalo.");
  }
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error("Zalo HTTP " + status);
  let result = {};
  try { result = JSON.parse(response.getContentText()); } catch (_) {
    if (mode !== "webhook") throw new Error("Zalo trả về dữ liệu không hợp lệ.");
  }
  const code = result.error_code != null ? result.error_code : result.error;
  if (result.ok === false || result.success === false || (code != null && Number(code) !== 0)) {
    throw new Error("Zalo từ chối tin nhắn (mã " + (code == null ? "unknown" : code) + "). Kiểm tra token và người nhận.");
  }
  if (mode !== "webhook" && result.ok !== true && (code == null || Number(code) !== 0)) {
    throw new Error("Zalo chưa xác nhận gửi tin thành công.");
  }
}

// Call only while holding the script lock. Outbox survives failed sends and browser closure.
function deliverPendingZalo(orderCode) {
  const pending = fsGet("zaloOutbox/" + orderCode);
  if (!pending) return { skipped: true };
  const orderDoc = fsGet("orders/" + orderCode);
  const f = orderDoc ? orderDoc.fields : {};
  const remove = { delete: FS_BASE.replace("https://firestore.googleapis.com/v1/", "") + "/zaloOutbox/" + orderCode };
  if (!orderDoc || boolVal(f, "zaloNotified")) { fsCommit([remove]); return { skipped: true }; }
  if (strVal(f, "payment_status") !== "PAID" || boolVal(f, "requiresReconciliation") || boolVal(f, "expired")) {
    fsPatch("zaloOutbox/" + orderCode, { nextAttemptAt: Date.now() + 3600000 });
    return { skipped: true };
  }
  try {
    const cfgDoc = fsGet("config/zalo");
    const cfg = cfgDoc ? cfgDoc.fields : {};
    if (!boolVal(cfg, "enableAuto", true) || !boolVal(cfg, "notifyOrderDaily", true)) {
      fsPatch("zaloOutbox/" + orderCode, { nextAttemptAt: Date.now() + 300000 });
      return { skipped: true };
    }
    const message = buildPaidOrderMessage(orderCode, f);
    sendZaloMessage(message, cfg);
    fsCommit([
      fsWrite("orders/" + orderCode, { zaloNotified: true, zaloNotifiedAt: Date.now(), zaloLastError: "" }),
      fsWrite("config/zalo", { lastOrderMessage: message, lastOrderSentAt: Date.now(), lastOrderError: "" }),
      remove
    ]);
    return { sent: true };
  } catch (err) {
    const attempts = numVal(pending.fields, "attempts") + 1;
    const reason = String(err.message || "Gửi Zalo thất bại.").slice(0, 300);
    fsCommit([
      fsWrite("zaloOutbox/" + orderCode, { attempts: attempts, nextAttemptAt: Date.now() + Math.min(3600000, 300000 * attempts), lastError: reason }),
      fsWrite("orders/" + orderCode, { zaloLastError: reason }),
      fsWrite("config/zalo", { lastOrderError: orderCode + ": " + reason })
    ]);
    return { pending: true, reason: reason };
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const secret = String((e && e.parameter && e.parameter.secret) || "").trim();
    const expected = PropertiesService.getScriptProperties().getProperty("SEPAY_API_KEY") || SEPAY_API_KEY;
    if (!expected || secret !== expected) return jsonOut({ success: false, message: "Unauthorized" });
    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (data.transferType !== "in") return jsonOut({ success: true, ignored: "not_incoming" });
    const txId = String(data.id != null ? data.id : data.referenceCode || "");
    const amount = Number(data.transferAmount);
    let orderCode = String(data.code || "").trim().toUpperCase();
    if (!/^DH\d{4,8}$/.test(orderCode)) {
      const match = (String(data.content || "") + " " + String(data.description || "")).match(/\bDH\d{4,8}\b/i);
      orderCode = match ? match[0].toUpperCase() : "";
    }
    if (!orderCode) return jsonOut({ success: true, ignored: "no_order_code" });
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(txId) || !Number.isSafeInteger(amount) || amount <= 0) {
      return jsonOut({ success: false, message: "Invalid transaction" });
    }
    lock.waitLock(20000);
    const outcome = recordPayment(data, txId, orderCode, amount);
    // Payment has committed. A Zalo outage must not reapply the money on SePay retries.
    try { outcome.zalo = deliverPendingZalo(orderCode); } catch (_) { outcome.zalo = { pending: true }; }
    return jsonOut(Object.assign({ success: true }, outcome));
  } catch (err) {
    return jsonOut({ success: false, error: String(err.message || err) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function retryPendingZaloNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const rows = fsRequest(":runQuery", {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "zaloOutbox" }],
        where: { fieldFilter: { field: { fieldPath: "nextAttemptAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(Date.now()) } } },
        orderBy: [{ field: { fieldPath: "nextAttemptAt" }, direction: "ASCENDING" }], limit: 20
      } })
    });
    rows.forEach(function (row) {
      if (row.document) {
        try { deliverPendingZalo(strVal(row.document.fields, "orderCode")); }
        catch (_) { console.error("Không xử lý được một thông báo; giữ lại để thử lần sau."); }
      }
    });
  } finally { lock.releaseLock(); }
}

function setupZaloRetryTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getHandlerFunction() === "retryPendingZaloNotifications"; });
  if (!exists) ScriptApp.newTrigger("retryPendingZaloNotifications").timeBased().everyMinutes(5).create();
  console.log("Đã bật tự gửi lại Zalo mỗi 5 phút.");
}

function doGet() { return jsonOut({ ok: true, service: "MeDa SePay Webhook Bridge" }); }
