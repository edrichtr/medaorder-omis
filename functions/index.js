/* ============================================================================
 *  MÊ ĐÁ - BACKEND (Firebase Cloud Functions Gen 2)
 * ----------------------------------------------------------------------------
 *  Vai trò:
 *   1. Giữ Token Zalo Bot ngoài tầm tay trình duyệt (Secret / Firestore khoá).
 *   2. Nhận đơn hàng, tự tính lại giá (chống sửa giá từ trình duyệt),
 *      cấp số thứ tự, trừ kho, cộng doanh thu - tất cả trong 1 lần gọi.
 *   3. Tự động gửi Zalo 24/7:
 *        - Đơn mới        : kích hoạt theo Firestore trigger (tức thì)
 *        - Báo cáo cuối ngày: lịch 15 phút/lần, tự gửi bù ngày bị bỏ sót
 *        - Cảnh báo kho   : lịch 30 phút/lần, chống spam
 *   4. Cấp quyền admin qua Custom Token (mật khẩu kiểm tra ở server).
 * ========================================================================== */

'use strict';

const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');

initializeApp();

// Toàn bộ Gen 2 function dùng chung region này.
// PHẢI khớp với `getFunctions(app, "asia-southeast1")` trong assets/meda.js,
// nếu không client sẽ không tìm thấy function (lỗi 404 not-found).
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });

const db = getFirestore();
const auth = getAuth();

/* ---------------------------------------------------------------- secrets */
// Mật khẩu admin dùng lần đầu (sau đó hệ thống lưu hash trong Firestore).
const ADMIN_PASSWORD = defineSecret('ADMIN_PASSWORD');
// Tuỳ chọn: Token Zalo đặt qua Secret Manager sẽ GHI ĐÈ token trong Firestore.
const ZALO_BOT_TOKEN = defineSecret('ZALO_BOT_TOKEN');

const ADMIN_UID = 'meda-owner-001';      // UID cố định của admin
const TZ = 'Asia/Ho_Chi_Minh';
const SHOP = 'Mê Đá';

/* ------------------------------------------------------------------ utils */
const P2 = (n) => String(n).padStart(2, '0');

/** Ngày theo múi giờ VN, định dạng DD/MM/YYYY (khớp với createdAt của đơn). */
function dayKey(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.day}/${p.month}/${p.year}`;
}

/** Ngày giờ đầy đủ theo múi giờ VN, định dạng HH:mm:ss DD/MM/YYYY. */
function dateTimeVN(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hr = p.hour === '24' ? '00' : p.hour;
  return `${hr}:${p.minute}:${p.second} ${p.day}/${p.month}/${p.year}`;
}

/** Giờ (0-23) theo múi giờ VN. */
function hourNow() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false
  }).format(new Date()));
}

/** Ngày trước `n` ngày, theo múi giờ VN. */
function dayKeyOffset(n) {
  const nowVN = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  nowVN.setDate(nowVN.getDate() - n);
  return dayKey(nowVN);
}

const vn = (n) => Number(n || 0).toLocaleString('vi-VN');
const money = (n) => `${vn(n)} VNĐ`;

function cleanStr(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max);
}

/** So sánh chuỗi an toàn về thời gian (tránh dò mật khẩu theo thời gian). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return safeEqual(calc, hash);
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------- cấu hình Zalo */
async function getZaloSecret() {
  // 1. Ưu tiên Secret Manager
  try {
    const v = ZALO_BOT_TOKEN.value();
    if (v) return v;
  } catch (e) { /* secret chưa được cấu hình */ }

  // 2. Token lưu trong tài liệu khoá
  const snap = await db.doc('config/zaloToken').get();
  if (snap.exists && snap.data().token) return cleanStr(snap.data().token, 300);

  // 3. MIGRATION: Token cũ còn nằm trong config/zalo.botToken (trước khi siết Rules).
  //    Tự chuyển sang khoá để hệ thống chạy tiếp mà không phải nhập lại.
  const legacy = await db.doc('config/zalo').get();
  if (legacy.exists && legacy.data().botToken) {
    const token = cleanStr(legacy.data().botToken, 300);
    if (token) {
      await db.doc('config/zaloToken').set(
        { token, migratedAt: FieldValue.serverTimestamp() }, { merge: true }
      );
      logger.warn('Đã chuyển Token Bot cũ sang khoá config/zaloToken và xoá bản rõ khỏi config/zalo.');
      const patch = { botToken: FieldValue.delete() };
      await db.doc('config/zalo').set(patch, { merge: true });
      return token;
    }
  }
  return '';
}

async function getZaloConfig() {
  const snap = await db.doc('config/zalo').get();
  const cfg = snap.exists ? snap.data() : {};
  return {
    mode: cfg.mode || 'zalo_bot',
    botToken: (await getZaloSecret()) || '',
    botChatId: cleanStr(cfg.botChatId, 120),
    webhookUrl: cleanStr(cfg.webhookUrl, 500),
    oaAccessToken: cleanStr(cfg.oaAccessToken, 500),
    oaRecipientId: cleanStr(cfg.oaRecipientId, 120),
    corsProxy: cleanStr(cfg.corsProxy, 500),
    phone: cleanStr(cfg.phone, 30),
    enableAuto: cfg.enableAuto !== false,
    notifyLowStock: cfg.notifyLowStock !== false,
    notifyOutProduct: cfg.notifyOutProduct !== false,
    notifyOrderDaily: cfg.notifyOrderDaily !== false,
    autoDailySummary: cfg.autoDailySummary !== false,
    summaryHour: Number(cfg.summaryHour) || 21,
    lastDailySummaryDate: cleanStr(cfg.lastDailySummaryDate, 20),
    lastDailySummaryAt: Number(cfg.lastDailySummaryAt) || 0,
  };
}

/** Cấu hình đã che khoá bí mật - mới được gửi xuống trình duyệt. */
function publicZaloConfig(cfg) {
  return {
    mode: cfg.mode, botChatId: cfg.botChatId,
    webhookUrl: cfg.webhookUrl, oaRecipientId: cfg.oaRecipientId,
    phone: cfg.phone,
    enableAuto: cfg.enableAuto, notifyLowStock: cfg.notifyLowStock,
    notifyOutProduct: cfg.notifyOutProduct, notifyOrderDaily: cfg.notifyOrderDaily,
    autoDailySummary: cfg.autoDailySummary, summaryHour: cfg.summaryHour,
    lastDailySummaryDate: cfg.lastDailySummaryDate,
    lastDailySummaryAt: cfg.lastDailySummaryAt,
    botTokenSet: !!cfg.botToken, oaTokenSet: !!cfg.oaAccessToken,
  };
}

/* --------------------------------------------------------- gửi tin Zalo */
async function sendZalo(text) {
  const cfg = await getZaloConfig();
  const message = String(text || '').slice(0, 3900);

  try {
    if (cfg.mode === 'zalo_bot') {
      if (!cfg.botToken) return { ok: false, reason: 'Chưa cấu hình Token Zalo Bot.' };
      if (!cfg.botChatId) return { ok: false, reason: 'Chưa cấu hình Chat ID nhận báo cáo.' };
      const res = await fetch(
        `https://bot-api.zapps.me/bot${cfg.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.botChatId, text: message })
        }
      );
      const data = await res.json().catch(() => ({}));
      const code = data.error_code != null ? data.error_code : data.error;
      if (code != null && code !== 0) {
        return { ok: false, reason: `Zalo Bot lỗi ${code}: ${data.description || data.message || ''}` };
      }
      return { ok: true };
    }

    if (cfg.mode === 'webhook') {
      if (!cfg.webhookUrl) return { ok: false, reason: 'Chưa nhập Webhook URL.' };
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop: SHOP, type: 'backend', timestamp: new Date().toLocaleString('vi-VN'),
          message, text: message, content: message,
        })
      });
      return res.ok ? { ok: true } : { ok: false, reason: `Webhook HTTP ${res.status}` };
    }

    if (cfg.mode === 'zalo_oa') {
      if (!cfg.oaAccessToken || !cfg.oaRecipientId) {
        return { ok: false, reason: 'Chưa nhập đủ Zalo OA Access Token và User ID.' };
      }
      const endpoint = cfg.corsProxy || 'https://openapi.zalo.me/v3.0/oa/message/cs';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: cfg.oaAccessToken },
        body: JSON.stringify({ recipient: { user_id: cfg.oaRecipientId }, message: { text: message } })
      });
      const data = await res.json().catch(() => ({}));
      if (data.error && data.error !== 0) {
        return { ok: false, reason: data.message || `Zalo OA lỗi ${data.error}` };
      }
      return { ok: true };
    }

    return { ok: false, reason: 'Chưa chọn phương thức kết nối Zalo.' };
  } catch (e) {
    logger.error('Lỗi gửi Zalo', e);
    return { ok: false, reason: e.message || String(e) };
  }
}

/* ------------------------------------------------- phân tích kho & món */
function calcMaxCups(p, inventory) {
  if (!Array.isArray(p.recipe) || p.recipe.length === 0) return 999;
  let max = Infinity;
  for (const ri of p.recipe) {
    const inv = inventory.find((i) => i.id === ri.ingId);
    const have = inv ? Number(inv.quantity) : 0;
    const need = Number(ri.amount) || 0;
    if (!inv || have < need) max = 0;
    else max = Math.min(max, Math.floor(have / need));
  }
  return max === Infinity ? 0 : max;
}

async function loadStock() {
  const [invSnap, prodSnap] = await Promise.all([
    db.collection('inventory').get(), db.collection('products').get()
  ]);
  const inventory = invSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
  const products = prodSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
  return { inventory, products };
}

function buildStockReport({ inventory, products }) {
  const outIngredients = [], lowIngredients = [], outProducts = [], lowProducts = [];

  inventory.forEach((ing) => {
    const q = Number(ing.quantity) || 0;
    if (q <= 0) outIngredients.push(`- ❌ ${ing.name}: HẾT SẠCH (0 ${ing.unit || ''})`);
    else if (q <= 50) lowIngredients.push(`- ⚠️ ${ing.name}: Còn ${q} ${ing.unit || ''}`);
  });

  products.forEach((p) => {
    const cups = calcMaxCups(p, inventory);
    if (cups <= 0) outProducts.push(`- 🚫 ${p.name}: HẾT MÓN (0 ly)`);
    else if (cups <= 5) lowProducts.push(`- ⏳ ${p.name}: Chỉ còn pha được ${cups} ly`);
  });

  const lines = [
    `🚨 [${SHOP.toUpperCase()}] BÁO CÁO KHO & MÓN`,
    `🕒 ${new Date().toLocaleString('vi-VN')}`,
    `------------------------`,
    `📦 1. TÌNH TRẠNG NGUYÊN LIỆU:`
  ];
  if (!outIngredients.length && !lowIngredients.length) lines.push('✅ Tất cả nguyên liệu đều đầy đủ.');
  else lines.push(...outIngredients, ...lowIngredients);

  lines.push(`------------------------`, `☕ 2. TÌNH TRẠNG MÓN TRÊN MENU:`);
  if (!outProducts.length && !lowProducts.length) lines.push('✅ Tất cả các món đều sẵn sàng phục vụ.');
  else lines.push(...outProducts, ...lowProducts);

  return {
    hasAlert: !!(outIngredients.length || lowIngredients.length || outProducts.length || lowProducts.length),
    signature: [outIngredients, lowIngredients, outProducts, lowProducts].map((a) => a.join('|')).join('##'),
    outIngredients, lowIngredients, outProducts, lowProducts,
    text: lines.join('\n'),
  };
}

/* ---------------------------------------------- truy vấn đơn theo ngày (ưu tiên index dateKey) */
async function getDailyOrders(day) {
  try {
    const snap = await db.collection('orders').where('dateKey', '==', day).get();
    if (!snap.empty) return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  } catch (_) {}
  const allSnap = await db.collection('orders').get();
  return allSnap.docs
    .map((d) => ({ ...d.data(), id: d.id }))
    .filter(o=>!o.requiresReconciliation && (!o.payment_status || o.payment_status==='PAID'))
    .filter((o) => o.dateKey === day || (o.createdAt && String(o.createdAt).includes(day)));
}

/* ---------------------------------------------- báo cáo doanh thu ngày */
async function buildDailyReport(dateStr) {
  const day = dateStr || dayKey();
  const [todayOrders, finSnap, stock] = await Promise.all([
    getDailyOrders(day),
    db.doc('config/finance').get(),
    loadStock()
  ]);

  let revenue = 0, cups = 0, dineIn = 0, takeAway = 0;
  const summary = {};

  todayOrders.forEach((o) => {
    revenue += Number(o.total) || 0;
    if (o.orderType === 'Tại chỗ') dineIn++; else takeAway++;
    (Array.isArray(o.items) ? o.items : []).forEach((it) => {
      const key = it.id || it.name;
      if (!summary[key]) summary[key] = { name: it.name, qty: 0, amount: 0, price: Number(it.price) || 0 };
      const q = Number(it.quantity) || 0;
      summary[key].qty += q;
      summary[key].amount += (Number(it.price) || 0) * q;
      cups += q;
    });
  });

  const fin = finSnap.exists ? finSnap.data() : {};
  const totalRevenue = Number(fin.totalRevenue) || 0;
  const ingCost = Number(fin.ingredientCosts) || 0;
  const fixedCost = Number(fin.fixedCosts) || 0;

  const sold = Object.values(summary).sort((a, b) => b.qty - a.qty);
  const lines = [
    `📊 [${SHOP.toUpperCase()}] BÁO CÁO CHI TIẾT NGÀY ${day}`,
    `🕒 Cập nhật lúc: ${dateTimeVN()}`,
    `========================`,
    `💰 1. SỐ TIỀN CHI TIẾT TRONG NGÀY:`,
    `• Doanh thu hôm nay: ${money(revenue)}`,
    `• Tổng số đơn: ${todayOrders.length} đơn (Tại quán: ${dineIn} | Mang về: ${takeAway})`,
    `• Tổng số ly đã bán: ${cups} ly`,
    `------------------------`,
    `📈 TỔNG KẾT LŨY KẾ:`,
    `• Tổng doanh thu lũy kế: ${money(totalRevenue)}`,
    `• Chi phí nguyên liệu: ${money(ingCost)}`,
    `• Chi phí cố định/khác: ${money(fixedCost)}`,
    `• Tiền lãi ròng ước tính: ${money(totalRevenue - ingCost - fixedCost)}`,
    `========================`,
    `🧋 2. HÔM NAY BÁN ĐƯỢC NHỮNG GÌ:`
  ];

  if (!sold.length) lines.push(`- Chưa có món nào được bán trong ngày ${day}.`);
  else sold.forEach((s, i) => lines.push(`${i + 1}. ${s.name}: ${s.qty} ly x ${vn(s.price)}đ = ${money(s.amount)}`));

  lines.push(`========================`, `⚠️ 3. TÌNH TRẠNG HẾT MÓN / NGUYÊN LIỆU:`);
  const sr = buildStockReport(stock);
  if (!sr.outIngredients.length && !sr.outProducts.length) lines.push('✅ Không có nguyên liệu hoặc món nào bị hết.');
  else lines.push(...sr.outIngredients, ...sr.outProducts);

  return { text: lines.join('\n'), revenue, cups, orderCount: todayOrders.length };
}

function buildNewOrderMessage(order, stock, dailyStats = null) {
  const itemsArr = Array.isArray(order.items) ? order.items : [];
  let orderCups = 0;
  const itemLines = itemsArr.map((it, idx) => {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    orderCups += qty;
    return `${idx + 1}. ${it.name}: ${qty} ly x ${vn(price)}đ = ${money(price * qty)}`;
  });

  const todayStr = order.dateKey || dayKey();
  const dailyOrders = dailyStats && dailyStats.dailyOrders ? dailyStats.dailyOrders : 1;
  const dailyRevenue = dailyStats && dailyStats.dailyRevenue ? dailyStats.dailyRevenue : (Number(order.total) || 0);
  const dailyCups = dailyStats && dailyStats.dailyCups ? dailyStats.dailyCups : orderCups;

  const lines = [
    `🔔 [${SHOP.toUpperCase()}] ĐƠN HÀNG MỚI #${order.queueNumber}`,
    `🕒 Thời gian: ${order.createdAt || dateTimeVN()}`,
    `🧾 Mã đơn: #${order.orderId || 'N/A'}`,
    `👤 Khách hàng: ${order.customerName || 'Khách lạ'} (${order.orderType || 'Tại chỗ'})`,
    `------------------------`,
    `🧋 CHI TIẾT ĐƠN HÀNG (${orderCups} ly):`,
    ...(itemLines.length ? itemLines : ['(không rõ món)']),
    `💰 TỔNG ĐƠN NÀY: ${money(order.total)}`,
    `========================`,
    `📈 LŨY KẾ HÔM NAY (${todayStr}):`,
    `• Tổng đơn hôm nay: ${dailyOrders} đơn (${dailyCups} ly)`,
    `• Doanh thu tạm tính: ${money(dailyRevenue)}`
  ];

  const alerts = [];
  if (stock) {
    const sr = buildStockReport(stock);
    if (sr.outProducts.length) alerts.push(...sr.outProducts);
    if (sr.outIngredients.length) alerts.push(...sr.outIngredients);
    if (sr.lowProducts.length) alerts.push(...sr.lowProducts);
    if (sr.lowIngredients.length) alerts.push(...sr.lowIngredients);
  }
  if (alerts.length) {
    lines.push(`========================`, `⚠️ CẢNH BÁO TỒN KHO:`);
    lines.push(...alerts.slice(0, 12));
  }
  return lines.join('\n');
}

/* ==========================================================================
 * 1. ĐĂNG NHẬP ADMIN  (mật khẩu kiểm tra ở server, cấp Custom Token)
 * ========================================================================== */
exports.staffLogin = onCall(async req => {
  const snap = await db.doc('config/staffCredentials').get();
  const password = String(req.data?.password || '');
  if (!snap.exists || !password || !verifyPassword(password,snap.get('salt'),snap.get('hash'))) throw new HttpsError('unauthenticated','Sai mật khẩu nhân viên.');
  return {token:await auth.createCustomToken('meda-staff',{staff:true})};
});
exports.setStaffPassword = onCall(async req => {
  if (!req.auth?.token.admin) throw new HttpsError('permission-denied','Chỉ dành cho quản trị viên.');
  const pass=String(req.data?.password || '');
  if(pass.length<6) throw new HttpsError('invalid-argument','Mật khẩu cần ít nhất 6 ký tự.');
  await db.doc('config/staffCredentials').set(hashPassword(pass));
  return {ok:true};
});
exports.recoverAdminPassword = onCall({secrets:[ADMIN_PASSWORD]},async req=>{
  if(!safeEqual(req.data?.code || '',ADMIN_PASSWORD.value()) || !ADMIN_PASSWORD.value()) throw new HttpsError('permission-denied','Mã khôi phục không đúng.');
  const pass=String(req.data?.password || '');
  if(pass.length<6) throw new HttpsError('invalid-argument','Mật khẩu cần ít nhất 6 ký tự.');
  await db.doc('config/admin').set(hashPassword(pass));
  return {ok:true};
});

exports.adminLogin = onCall(
  { secrets: [ADMIN_PASSWORD], cors: true },
  async (req) => {
    const pass = String((req.data && req.data.password) || '');
    if (req.auth?.token.staff) throw new HttpsError('permission-denied','Vui lòng đăng xuất về trang chủ.');
    if (!pass) throw new HttpsError('invalid-argument', 'Thiếu mật khẩu.');

    const snap = await db.doc('config/admin').get();
    let ok;
    if (snap.exists && snap.data().hash) {
      ok = verifyPassword(pass, snap.data().salt, snap.data().hash);
    } else {
      // Lần đầu: lấy mật khẩu từ Secret ADMIN_PASSWORD
      const initial = ADMIN_PASSWORD.value();
      ok = snap.get('passHash') ? safeEqual(snap.get('passHash'),'sha256:'+crypto.createHash('sha256').update('meda_admin::'+pass).digest('hex')) : !!initial && safeEqual(pass, initial);
      if (ok) {
        const { salt, hash } = hashPassword(pass);
        await db.doc('config/admin').set({ salt, hash, updatedAt: FieldValue.serverTimestamp() });
        logger.info('Đã khoá mật khẩu admin vào Firestore ở lần đăng nhập đầu.');
      }
    }
    if (!ok) {
      logger.warn('Đăng nhập admin thất bại.');
      throw new HttpsError('unauthenticated', 'Sai tài khoản hoặc mật khẩu!');
    }

    const token = await auth.createCustomToken(ADMIN_UID, { admin: true });
    return { token, uid: ADMIN_UID };
  }
);

/** Đổi mật khẩu admin (chỉ admin đã đăng nhập). */
exports.adminChangePassword = onCall(async (req) => {
  if (!(req.auth && req.auth.token && req.auth.token.admin === true)) {
    throw new HttpsError('permission-denied', 'Chỉ quản trị viên được đổi mật khẩu.');
  }
  const oldPass = String((req.data && req.data.oldPassword) || '');
  const newPass = String((req.data && req.data.newPassword) || '');
  if (newPass.length < 6) throw new HttpsError('invalid-argument', 'Mật khẩu mới phải có ít nhất 6 ký tự!');

  const snap = await db.doc('config/admin').get();
  if (!snap.exists || !snap.data().hash) throw new HttpsError('failed-precondition', 'Chưa thiết lập mật khẩu.');
  if (!verifyPassword(oldPass, snap.data().salt, snap.data().hash)) {
    throw new HttpsError('unauthenticated', 'Mật khẩu hiện tại không đúng!');
  }

  const { salt, hash } = hashPassword(newPass);
  await db.doc('config/admin').set({ salt, hash, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ==========================================================================
 * 2. ĐẶT HÀNG  (dành cho khách - giá luôn được tính lại ở server)
 * ========================================================================== */
Object.assign(exports, require('./payments'));

/* ==========================================================================
 * 3. TỰ ĐỘNG BÁO ĐƠN MỚI  (Firestore trigger - tức thì, 24/7)
 * ========================================================================== */
exports.onOrderPaid = onDocumentWritten(
  { document: 'orders/{orderId}', secrets: [ZALO_BOT_TOKEN], retry: true },
  async (event) => {
    const snap = event.data.after;
    if (!snap.exists || (event.data.before.exists && (!snap.get("payment_status") || event.data.before.get("payment_status") === "PAID"))) return;
    if (snap.get('requiresReconciliation')) return;
    const order = snap.data();
    if (order.zaloNotificationOwner === 'apps_script') return;
    if (order.payment_status && order.payment_status !== "PAID") return;

    // Tránh gửi trùng nếu trình duyệt POS đã gửi Zalo thành công
    if (order.zaloNotified === true) {
      logger.info(`Đơn ${event.params.orderId} đã được báo Zalo từ POS, bỏ qua.`);
      return;
    }

    try {
      const todayStr = order.dateKey || dayKey();
      const [cfg, stock, todayOrders] = await Promise.all([
        getZaloConfig(),
        loadStock(),
        getDailyOrders(todayStr)
      ]);

      let dailyRevenue = 0, dailyCups = 0;
      todayOrders.forEach((o) => {
        dailyRevenue += Number(o.total) || 0;
        (Array.isArray(o.items) ? o.items : []).forEach((it) => {
          dailyCups += Number(it.quantity) || 0;
        });
      });
      const dailyStats = {
        dailyOrders: Math.max(1, todayOrders.length),
        dailyRevenue: Math.max(Number(order.total) || 0, dailyRevenue),
        dailyCups: Math.max(1, dailyCups)
      };

      const msg = buildNewOrderMessage(order, stock, dailyStats);
      await db.doc('config/zalo').set({
        lastOrderMessage: msg,
        lastOrderSentAt: Date.now()
      }, { merge: true });

      if (!cfg.enableAuto || !cfg.notifyOrderDaily) return;

      const res = await sendZalo(msg);
      if (!res.ok) {
        logger.warn(`Đơn ${event.params.orderId}: gửi Zalo thất bại - ${res.reason}`);
      } else {
        await db.doc(`orders/${event.params.orderId}`).set({
          zaloNotified: true,
          zaloNotifiedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info(`Đã báo đơn #${order.queueNumber} qua Zalo.`);
      }
    } catch (e) {
      logger.error('onOrderCreated lỗi', e);
      throw e;   // để Firestore retry
    }
  }
);

/* ==========================================================================
 * 4. LỊCH BÁO CÁO CUỐI NGÀY  (mỗi 15 phút - tự gửi + tự gửi bù)
 * ========================================================================== */
exports.dailyReportScheduler = onSchedule(
  { schedule: 'every 15 minutes', timeZone: TZ, secrets: [ZALO_BOT_TOKEN], retryCount: 2 },
  async () => {
    const cfg = await getZaloConfig();
    if (!cfg.enableAuto || !cfg.autoDailySummary) return;

    const today = dayKey();
    const hour = hourNow();
    const lastSent = cfg.lastDailySummaryDate || '';
    if (lastSent === today) return;                 // hôm nay đã gửi rồi

    const ordersSnap = await db.collection('orders').get();
    const orders = ordersSnap.docs.map((d) => d.data()).filter(o=>!o.payment_status || o.payment_status==='PAID');

    // --- Gửi bù: các ngày đã qua mà chưa từng có báo cáo ---
    const missed = [];
    for (let i = 1; i <= 3; i++) {
      const key = dayKeyOffset(i);
      if (key === lastSent) break;
      if (orders.some((o) => o.createdAt && String(o.createdAt).includes(key))) missed.push(key);
    }

    for (const key of missed) {
      const report = await buildDailyReport(key);
      const res = await sendZalo(report.text);
      if (!res.ok) { logger.warn(`Gửi bù ${key} thất bại: ${res.reason}`); return; }
      await db.doc('config/zalo').set(
        { lastDailySummaryDate: key, lastDailySummaryAt: Date.now() }, { merge: true }
      );
      logger.info(`Đã gửi bù báo cáo ngày ${key}.`);
    }

    // --- Báo cáo hôm nay, chỉ khi đã tới giờ hẹn ---
    if (hour < cfg.summaryHour) return;
    const report = await buildDailyReport(today);
    const res = await sendZalo(report.text);
    if (!res.ok) { logger.warn(`Báo cáo ${today} thất bại: ${res.reason}`); return; }

    await db.doc('config/zalo').set(
      { lastDailySummaryDate: today, lastDailySummaryAt: Date.now() }, { merge: true }
    );
    logger.info(`Đã gửi báo cáo ngày ${today}.`);
  }
);

/* ==========================================================================
 * 5. LỊCH CẢNH BÁO KHO  (mỗi 30 phút, chống spam 6 giờ)
 * ========================================================================== */
exports.stockAlertScheduler = onSchedule(
  { schedule: 'every 30 minutes', timeZone: TZ, secrets: [ZALO_BOT_TOKEN], retryCount: 1 },
  async () => {
    const cfg = await getZaloConfig();
    if (!cfg.enableAuto) return;
    if (!cfg.notifyLowStock && !cfg.notifyOutProduct) return;

    const stock = await loadStock();
    const report = buildStockReport(stock);
    if (!report.hasAlert) return;

    const ref = db.doc('system/lastStockAlert');
    const snap = await ref.get();
    const lastSig = snap.exists ? snap.data().signature : '';
    const lastAt = snap.exists ? Number(snap.data().at) || 0 : 0;

    // Tình trạng không đổi và vừa báo -> im
    if (lastSig === report.signature && Date.now() - lastAt < 6 * 60 * 60 * 1000) return;

    const res = await sendZalo(report.text);
    if (!res.ok) { logger.warn(`Cảnh báo kho thất bại: ${res.reason}`); return; }
    await ref.set({ signature: report.signature, at: Date.now() }, { merge: true });
    logger.info('Đã gửi cảnh báo kho.');
  }
);

/* ==========================================================================
 * 6. API CHO TRANG QUẢN TRỊ
 * ========================================================================== */
function requireAdmin(req) {
  if (!(req.auth && req.auth.token && req.auth.token.admin === true)) {
    throw new HttpsError('permission-denied', 'Vui lòng đăng nhập quản trị.');
  }
}

exports.getZaloConfig = onCall(async (req) => {
  requireAdmin(req);
  return publicZaloConfig(await getZaloConfig());
});

exports.saveZaloConfig = onCall(async (req) => {
  requireAdmin(req);
  const d = req.data || {};
  const patch = {
    mode: ['zalo_bot', 'webhook', 'zalo_oa'].includes(d.mode) ? d.mode : 'zalo_bot',
    botChatId: cleanStr(d.botChatId, 120),
    webhookUrl: cleanStr(d.webhookUrl, 500),
    oaAccessToken: cleanStr(d.oaAccessToken, 500),
    oaRecipientId: cleanStr(d.oaRecipientId, 120),
    corsProxy: cleanStr(d.corsProxy, 500),
    phone: cleanStr(d.phone, 30),
    enableAuto: d.enableAuto !== false,
    notifyLowStock: d.notifyLowStock !== false,
    notifyOutProduct: d.notifyOutProduct !== false,
    notifyOrderDaily: d.notifyOrderDaily !== false,
    autoDailySummary: d.autoDailySummary !== false,
    summaryHour: Math.min(23, Math.max(0, Number(d.summaryHour) || 21)),
  };
  await db.doc('config/zalo').set(patch, { merge: true });
  // Dọn Token cũ nằm nhầm trong config/zalo nếu có
  await db.doc('config/zalo').set({ botToken: FieldValue.delete() }, { merge: true });
  return { ok: true, config: publicZaloConfig(await getZaloConfig()) };
});

/** Lưu Token Bot. Token KHÔNG bao giờ được gửi lại xuống trình duyệt. */
exports.setZaloToken = onCall(async (req) => {
  requireAdmin(req);
  const token = cleanStr((req.data || {}).token, 300);
  if (!token) throw new HttpsError('invalid-argument', 'Token không được để trống.');
  await db.doc('config/zaloToken').set(
    { token, updatedAt: FieldValue.serverTimestamp() }, { merge: true }
  );
  return { ok: true, botTokenSet: true };
});

/** Lấy tin nhắn mới từ Bot (dùng để tìm Chat ID nhận báo cáo). */
exports.zaloFetchUpdates = onCall(
  { secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 60, cors: true },
  async (req) => {
    requireAdmin(req);
    const timeout = Math.min(30, Math.max(0, Number(req.data && req.data.timeout) || 5));
    const token = await getZaloSecret();
    if (!token) throw new HttpsError('failed-precondition', 'Chưa cấu hình Token Zalo Bot.');

    const url = `https://bot-api.zapps.me/bot${token}/getUpdates?timeout=${timeout}`;
    let data;
    try {
      const res = await fetch(url, { method: 'GET' });
      data = await res.json().catch(() => null);
    } catch (e) {
      throw new HttpsError('unavailable', 'Không gọi được Zalo Bot: ' + (e.message || e));
    }
    if (!data) throw new HttpsError('unavailable', 'Zalo Bot trả về dữ liệu không đọc được.');

    const found = extractChatIdDeep(data.result != null ? data.result : data);
    return { ok: true, found: found || null };
  }
);

/** Tìm đệ quy Chat ID trong mọi cấu trúc JSON của Zalo Bot API. */
function extractChatIdDeep(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.chat && (obj.chat.id || obj.chat.chat_id)) {
    return {
      id: String(obj.chat.id || obj.chat.chat_id),
      name: (obj.from && (obj.from.display_name || obj.from.first_name || obj.from.name)) || obj.chat.title || ''
    };
  }
  if (obj.sender && obj.sender.id) return { id: String(obj.sender.id), name: obj.sender.name || '' };
  if (obj.from && obj.from.id) return { id: String(obj.from.id), name: obj.from.display_name || obj.from.name || '' };
  if (obj.chat_id) return { id: String(obj.chat_id), name: '' };
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const hit = extractChatIdDeep(obj[i]);
      if (hit) return hit;
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (key === 'ok' || key === 'error_code') continue;
      const hit = extractChatIdDeep(obj[key]);
      if (hit) return hit;
    }
  }
  return null;
}

/** Gửi tin nhắn Zalo kiểm tra từ trang quản trị. */
exports.zaloTest = onCall(async (req) => {
  requireAdmin(req);
  return sendZalo(
    `🔔 [${SHOP.toUpperCase()}] TEST KẾT NỐI ZALO THÀNH CÔNG!\n` +
    `🕒 ${new Date().toLocaleString('vi-VN')}\n` +
    `✅ Hệ thống đã tự động đẩy:\n1. Đơn mới\n2. Hết nguyên liệu\n` +
    `3. Hết món\n4. Báo cáo chi tiết cuối ngày`
  );
});

exports.zaloPushReport = onCall(async (req) => {
  if (!req.auth?.token.staff) requireAdmin(req);
  const date = req.data && req.data.date ? cleanStr(req.data.date, 10) : dayKey();
  const report = await buildDailyReport(date);
  const res = await sendZalo(report.text);
  if (res.ok && date === dayKey()) {
    await db.doc('config/zalo').set(
      { lastDailySummaryDate: date, lastDailySummaryAt: Date.now() }, { merge: true }
    );
  }
  return res;
});

exports.zaloPushStock = onCall(async (req) => {
  if (!req.auth?.token.staff) requireAdmin(req);
  const stock = await loadStock();
  const res = await sendZalo(buildStockReport(stock).text);
  if (res.ok) {
    const r = buildStockReport(stock);
    await db.doc('system/lastStockAlert').set({ signature: r.signature, at: Date.now() }, { merge: true });
  }
  return res;
});

/** Chạy tay toàn bộ tác vụ tự động (dùng để kiểm tra sau khi deploy). */
exports.runAutomationNow = onCall(
  { secrets: [ZALO_BOT_TOKEN] },
  async (req) => {
    requireAdmin(req);
    const cfg = await getZaloConfig();
    const today = dayKey();
    const out = { today, summaryHour: cfg.summaryHour, nowHour: hourNow(), sent: [], errors: [] };

    const stock = await loadStock();
    const sr = await sendZalo(buildStockReport(stock).text);
    (sr.ok ? out.sent : out.errors).push(`báo cáo kho: ${sr.ok ? 'OK' : sr.reason}`);

    if (hourNow() >= cfg.summaryHour) {
      const rep = await buildDailyReport(today);
      const rr = await sendZalo(rep.text);
      if (rr.ok) {
        await db.doc('config/zalo').set(
          { lastDailySummaryDate: today, lastDailySummaryAt: Date.now() }, { merge: true }
        );
        out.sent.push(`báo cáo ${today}: OK`);
      } else out.errors.push(`báo cáo ${today}: ${rr.reason}`);
    } else {
      out.errors.push(`chưa tới giờ ${cfg.summaryHour}:00 nên chưa gửi báo cáo ngày.`);
    }
    return out;
  }
);

/** Ping kiểm tra server còn sống (không cần quyền admin). */
exports.health = onRequest((req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, service: 'meda-zalo', time: new Date().toISOString() });
});
