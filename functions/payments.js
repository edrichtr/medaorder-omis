'use strict';

const crypto = require('crypto');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');

if (!getApps().length) initializeApp();

const db = getFirestore();
const TZ = 'Asia/Ho_Chi_Minh';
const ORDER_HOLD_MS = 15 * 60 * 1000; // Giữ kho 15 phút chờ chuyển khoản

function cleanStr(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function dayKey(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.day}/${p.month}/${p.year}`;
}

function dateTimeVN(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hr = p.hour === '24' ? '00' : p.hour;
  return `${hr}:${p.minute}:${p.second} ${p.day}/${p.month}/${p.year}`;
}

function parseVoucherExpiryMs(expiresAt) {
  if (!expiresAt) return null;
  const raw = String(expiresAt).trim();
  const hasTz = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
  const ms = new Date(hasTz ? raw : raw + '+07:00').getTime();
  return Number.isFinite(ms) ? ms : null;
}

/* ==========================================================================
 * 1. ĐẶT HÀNG & GIỮ KHO (placeOrder)
 *    - Tính lại toàn bộ giá & voucher ở server (chống sửa giá từ trình duyệt)
 *    - Kiểm tra tồn kho nguyên liệu dùng chung theo giao dịch (Transaction)
 *    - Cấp mã đơn dạng DH1001..DH99999999 khớp cú pháp SePay
 * ========================================================================== */
exports.placeOrder = onCall({ cors: true }, async (req) => {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError('unauthenticated', 'Phiên đặt hàng chưa sẵn sàng, vui lòng tải lại trang.');
  }

  const d = req.data || {};
  const customerName = cleanStr(d.customerName, 80);
  if (!customerName) {
    throw new HttpsError('invalid-argument', 'Vui lòng nhập tên để nhận món.');
  }
  const orderType = d.orderType === 'Mang về' ? 'Mang về' : 'Tại chỗ';
  const rawItems = Array.isArray(d.items) ? d.items : [];
  if (rawItems.length === 0 || rawItems.length > 50) {
    throw new HttpsError('invalid-argument', 'Giỏ hàng không hợp lệ.');
  }

  // Gộp các món trùng ID và kiểm tra số lượng nguyên dương
  const itemQtyMap = new Map();
  for (const it of rawItems) {
    const id = cleanStr(it && it.id, 80);
    const qty = Number(it && it.quantity);
    if (!id || !Number.isInteger(qty) || qty <= 0 || qty > 99) {
      throw new HttpsError('invalid-argument', 'Số lượng món đặt không hợp lệ.');
    }
    itemQtyMap.set(id, (itemQtyMap.get(id) || 0) + qty);
  }

  const voucherCode = cleanStr(d.voucherCode, 40).toUpperCase().replace(/\s+/g, '');
  if (voucherCode && !/^[A-Z0-9_-]{1,40}$/.test(voucherCode)) {
    throw new HttpsError('invalid-argument', 'Mã voucher không hợp lệ.');
  }

  const rawReqId = cleanStr(d.requestId, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  const reqDocRef = rawReqId ? db.doc(`orderRequests/${req.auth.uid}_${rawReqId}`) : null;

  return db.runTransaction(async (tx) => {
    // 1. Chống gửi trùng đơn khi khách bấm đúp
    if (reqDocRef) {
      const existingReq = await tx.get(reqDocRef);
      if (existingReq.exists) {
        const prev = existingReq.data();
        return { code: prev.orderCode, total: prev.total, expiresAtMs: prev.expiresAtMs || 0 };
      }
    }

    // 2. Đọc toàn bộ sản phẩm đặt mua
    const productIds = Array.from(itemQtyMap.keys());
    const prodRefs = productIds.map((id) => db.doc(`products/${id}`));
    const prodSnaps = await Promise.all(prodRefs.map((r) => tx.get(r)));

    const orderItems = [];
    const requiredIng = new Map();
    let subtotal = 0;

    prodSnaps.forEach((snap, idx) => {
      const pid = productIds[idx];
      if (!snap.exists) {
        throw new HttpsError('not-found', `Sản phẩm không tồn tại hoặc đã ngừng bán.`);
      }
      const p = snap.data();
      const qty = itemQtyMap.get(pid);
      const price = Math.max(0, Math.round(Number(p.price || 0)));
      subtotal += price * qty;
      orderItems.push({ id: pid, name: cleanStr(p.name, 120), price, quantity: qty });

      if (Array.isArray(p.recipe)) {
        for (const r of p.recipe) {
          const ingId = cleanStr(r && r.ingId, 80);
          const amt = Number(r && r.amount || 0);
          if (ingId && amt > 0) {
            requiredIng.set(ingId, (requiredIng.get(ingId) || 0) + amt * qty);
          }
        }
      }
    });

    // 3. Đọc song song tồn kho, voucher, bộ đếm mã đơn và bộ đếm số thứ tự
    const ingIds = Array.from(requiredIng.keys());
    const ingRefs = ingIds.map((id) => db.doc(`inventory/${id}`));
    const seqRef = db.doc('config/paymentSequence');
    const queueRef = db.doc('config/queue');
    const finRef = db.doc('config/finance');
    const voucherRef = voucherCode ? db.doc(`vouchers/${voucherCode}`) : null;

    const [ingSnaps, seqSnap, queueSnap, voucherSnap] = await Promise.all([
      Promise.all(ingRefs.map((r) => tx.get(r))),
      tx.get(seqRef),
      tx.get(queueRef),
      voucherRef ? tx.get(voucherRef) : Promise.resolve(null),
    ]);

    // 4. Kiểm tra đủ tồn kho nguyên liệu
    const heldIngredients = [];
    const ingUpdates = [];
    ingSnaps.forEach((snap, idx) => {
      const ingId = ingIds[idx];
      const need = requiredIng.get(ingId);
      const have = snap.exists ? Number(snap.data().quantity || 0) : 0;
      if (!snap.exists || have < need) {
        const ingName = snap.exists ? (snap.data().name || ingId) : ingId;
        throw new HttpsError(
          'failed-precondition',
          `Rất tiếc! Nguyên liệu "${ingName}" hiện không đủ số lượng cho giỏ hàng của bạn.`
        );
      }
      heldIngredients.push({ ingId, amount: need });
      ingUpdates.push({ ref: ingRefs[idx], nextQty: Math.max(0, have - need) });
    });

    // 5. Kiểm tra và tính giảm giá Voucher
    let discountAmount = 0;
    if (voucherCode) {
      if (!voucherSnap || !voucherSnap.exists) {
        throw new HttpsError('failed-precondition', 'Mã voucher không tồn tại.');
      }
      const v = voucherSnap.data();
      if (v.active === false) {
        throw new HttpsError('failed-precondition', 'Mã voucher này đã ngừng hoạt động.');
      }
      const expMs = parseVoucherExpiryMs(v.expiresAt);
      if (expMs !== null && expMs < Date.now()) {
        throw new HttpsError('failed-precondition', 'Mã voucher này đã hết hạn sử dụng.');
      }
      const limit = Number(v.usageLimit || 0);
      const used = Number(v.usedCount || 0);
      if (limit > 0 && used >= limit) {
        throw new HttpsError('failed-precondition', 'Mã voucher này đã hết lượt sử dụng.');
      }
      const pct = Number(v.discountPercent || 0);
      const fix = Number(v.discountFixed || 0);
      if (pct > 0) discountAmount = Math.round((subtotal * pct) / 100);
      else if (fix > 0) discountAmount = Math.min(Math.round(fix), subtotal);
      discountAmount = Math.max(0, Math.min(subtotal, discountAmount));
    }

    const total = Math.max(0, subtotal - discountAmount);
    const now = Date.now();
    const today = dayKey(new Date(now));
    const nowStr = dateTimeVN(new Date(now));

    // 6. Cấp mã đơn hàng liên tiếp dạng DH1001...
    const prevSeq = seqSnap.exists ? Number(seqSnap.data().last || 1000) : 1000;
    const nextSeq = Math.max(1000, prevSeq) + 1;
    const orderCode = `DH${nextSeq}`;

    // 7. Ghi giảm kho & giữ lượt voucher
    for (const u of ingUpdates) {
      tx.update(u.ref, { quantity: u.nextQty });
    }
    if (voucherRef) {
      tx.update(voucherRef, { usedCount: FieldValue.increment(1) });
    }
    tx.set(seqRef, { last: nextSeq, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const orderRef = db.doc(`orders/${orderCode}`);
    let expiresAtMs = 0;

    if (total === 0) {
      // Đơn 0đ (giảm 100%) -> xác nhận thanh toán ngay lập tức
      const prevQ = queueSnap.exists && queueSnap.data().dateKey === today
        ? Number(queueSnap.data().count || 0) : 0;
      const queueNumber = prevQ + 1;
      tx.set(queueRef, { dateKey: today, count: queueNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(orderRef, {
        orderId: orderCode,
        order_code: orderCode,
        ownerUid: req.auth.uid,
        customerName,
        orderType,
        items: orderItems,
        subtotal,
        voucherCode,
        discountAmount,
        total: 0,
        received: 0,
        payment_status: 'PAID',
        status: 'Chờ pha chế',
        queueNumber,
        stockHold: false,
        expired: false,
        requiresReconciliation: false,
        dateKey: today,
        createdAt: nowStr,
        createdAtMs: now,
        timestamp: FieldValue.serverTimestamp(),
        paid_at: nowStr,
        zaloNotified: false,
      });
    } else {
      expiresAtMs = now + ORDER_HOLD_MS;
      tx.set(orderRef, {
        orderId: orderCode,
        order_code: orderCode,
        ownerUid: req.auth.uid,
        customerName,
        orderType,
        items: orderItems,
        subtotal,
        voucherCode,
        discountAmount,
        total,
        received: 0,
        payment_status: 'PENDING',
        status: 'Chờ thanh toán',
        queueNumber: 0,
        stockHold: true,
        heldIngredients,
        voucherReserved: Boolean(voucherCode),
        expired: false,
        expiresAtMs,
        requiresReconciliation: false,
        dateKey: today,
        createdAt: nowStr,
        createdAtMs: now,
        timestamp: FieldValue.serverTimestamp(),
        zaloNotified: false,
      });
    }

    if (reqDocRef) {
      tx.set(reqDocRef, { orderCode, total, expiresAtMs, createdAtMs: now });
    }

    // Tham chiếu finRef giữ sẵn để đảm bảo biến không dư (chỉ cộng doanh thu khi PAID > 0)
    void finRef;

    return { code: orderCode, total, expiresAtMs };
  });
});

/* ==========================================================================
 * 2. NHẬN WEBHOOK BIẾN ĐỘNG SỐ DƯ TỪ SEPAY (sepayWebhook)
 *    Endpoint sau khi deploy Hosting: https://<domain>/api/sepay-webhook
 *    Xác thực: Header Authorization: Apikey <SEPAY_API_KEY>
 * ========================================================================== */
exports.sepayWebhook = onRequest({ cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const expectedKey = String(process.env.SEPAY_API_KEY || '').trim();
  if (!expectedKey) {
    logger.error('Thiếu biến môi trường SEPAY_API_KEY trong functions/.env');
    return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
  }

  const authHeader = String(req.get('authorization') || '').trim();
  if (!safeEqual(authHeader, `Apikey ${expectedKey}`)) {
    logger.warn('SePay Webhook bị từ chối do sai API Key.');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const data = req.body && typeof req.body === 'object' ? req.body : {};
  if (data.transferType !== 'in') {
    return res.status(200).json({ success: true, ignored: 'not_incoming' });
  }

  const txId = cleanStr(data.id != null ? String(data.id) : (data.referenceCode || ''), 120);
  const transferAmount = Math.round(Number(data.transferAmount || 0));
  const transactionDate = cleanStr(data.transactionDate || '', 60) || dateTimeVN();

  let orderCode = cleanStr(data.code || '', 30).toUpperCase();
  if (!/^DH\d{4,8}$/.test(orderCode)) {
    const rawContent = `${data.content || ''} ${data.description || ''}`;
    const match = rawContent.match(/DH\d{4,8}/i);
    orderCode = match ? match[0].toUpperCase() : '';
  }

  if (!txId || transferAmount <= 0 || !orderCode) {
    logger.info('SePay Webhook bỏ qua giao dịch không khớp mã đơn DH...', { txId, transferAmount, orderCode });
    return res.status(200).json({ success: true, ignored: 'no_order_code' });
  }

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const txRef = db.doc(`sepayTransactions/${txId}`);
      const orderRef = db.doc(`orders/${orderCode}`);
      const queueRef = db.doc('config/queue');
      const finRef = db.doc('config/finance');

      const [txSnap, orderSnap, queueSnap] = await Promise.all([
        tx.get(txRef),
        tx.get(orderRef),
        tx.get(queueRef),
      ]);

      // Chống xử lý trùng giao dịch (idempotency)
      if (txSnap.exists) {
        return { duplicate: true };
      }

      const txLogBase = {
        txId,
        referenceCode: cleanStr(data.referenceCode || '', 120),
        gateway: cleanStr(data.gateway || '', 60),
        accountNumber: cleanStr(data.accountNumber || '', 40),
        orderCode,
        transferAmount,
        transactionDate,
        content: cleanStr(data.content || '', 300),
        processedAt: FieldValue.serverTimestamp(),
      };

      if (!orderSnap.exists) {
        tx.set(txRef, { ...txLogBase, matched: false });
        return { matched: false };
      }

      const order = orderSnap.data();
      const orderTotal = Number(order.total || 0);
      const newReceived = Number(order.received || 0) + transferAmount;
      const isOverpaid = newReceived > orderTotal;

      if (order.expired === true) {
        // Khách chuyển tiền sau khi đơn đã hết hạn giữ hàng -> đưa vào danh sách đối soát trên Admin
        tx.update(orderRef, {
          received: newReceived,
          requiresReconciliation: true,
          sepay_tx_id: txId,
          paid_at: transactionDate,
          sepayTxIds: FieldValue.arrayUnion(txId),
        });
      } else if (order.payment_status === 'PAID') {
        // Đơn đã thanh toán trước đó nhưng khách chuyển thêm
        tx.update(orderRef, {
          received: newReceived,
          requiresReconciliation: isOverpaid,
          sepayTxIds: FieldValue.arrayUnion(txId),
        });
      } else if (newReceived >= orderTotal) {
        // Đủ tiền -> chốt đơn PAID, cấp số thứ tự, cộng doanh thu lũy kế
        const today = dayKey();
        const prevQ = queueSnap.exists && queueSnap.data().dateKey === today
          ? Number(queueSnap.data().count || 0) : 0;
        const queueNumber = prevQ + 1;

        tx.set(queueRef, { dateKey: today, count: queueNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(finRef, { totalRevenue: FieldValue.increment(orderTotal) }, { merge: true });
        tx.update(orderRef, {
          payment_status: 'PAID',
          status: 'Chờ pha chế',
          received: newReceived,
          stockHold: false,
          queueNumber,
          sepay_tx_id: txId,
          paid_at: transactionDate,
          requiresReconciliation: isOverpaid,
          sepayTxIds: FieldValue.arrayUnion(txId),
          zaloNotified: false,
        });
      } else {
        // Chuyển thiếu tiền -> đánh dấu PARTIAL để khách chuyển nốt phần còn lại
        tx.update(orderRef, {
          payment_status: 'PARTIAL',
          received: newReceived,
          sepay_tx_id: txId,
          paid_at: transactionDate,
          sepayTxIds: FieldValue.arrayUnion(txId),
        });
      }

      tx.set(txRef, { ...txLogBase, matched: true });
      return { matched: true, orderCode, newReceived };
    });

    logger.info('SePay Webhook xử lý thành công', outcome);
    return res.status(200).json({ success: true });
  } catch (e) {
    logger.error('Lỗi xử lý SePay Webhook', e);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

/* ==========================================================================
 * 3. TRA CỨU TRẠNG THÁI ĐƠN HÀNG (GET /api/order-status?code=DH1001)
 * ========================================================================== */
exports.orderStatus = onRequest({ cors: true }, async (req, res) => {
  const code = cleanStr(req.query.code || '', 30).toUpperCase();
  if (!/^DH\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid order code' });
  }
  const snap = await db.doc(`orders/${code}`).get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'Order not found' });
  }
  const o = snap.data();
  return res.status(200).json({
    code,
    payment_status: o.payment_status || 'PENDING',
    received: Number(o.received || 0),
    total: Number(o.total || 0),
    queueNumber: Number(o.queueNumber || 0),
    expired: Boolean(o.expired),
  });
});

/* ==========================================================================
 * 4. TỰ ĐỘNG HOÀN KHO ĐƠN QUÁ HẠN THANH TOÁN (chạy mỗi 5 phút)
 * ========================================================================== */
exports.releaseExpiredOrders = onSchedule(
  { schedule: 'every 5 minutes', timeZone: TZ, retryCount: 1 },
  async () => {
    const now = Date.now();
    const snap = await db.collection('orders')
      .where('stockHold', '==', true)
      .where('expiresAtMs', '<=', now)
      .limit(50)
      .get();

    if (snap.empty) return;

    for (const orderDoc of snap.docs) {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(orderDoc.ref);
        if (!fresh.exists) return;
        const o = fresh.data();
        if (!o.stockHold || o.payment_status === 'PAID' || Date.now() < Number(o.expiresAtMs || 0)) return;

        const held = Array.isArray(o.heldIngredients) ? o.heldIngredients : [];
        const ingRefs = held.map((h) => db.doc(`inventory/${h.ingId}`));
        const voucherRef = (o.voucherReserved && o.voucherCode) ? db.doc(`vouchers/${o.voucherCode}`) : null;

        const [ingSnaps, vSnap] = await Promise.all([
          Promise.all(ingRefs.map((r) => tx.get(r))),
          voucherRef ? tx.get(voucherRef) : Promise.resolve(null),
        ]);

        ingSnaps.forEach((isnap, idx) => {
          if (isnap.exists) {
            const cur = Number(isnap.data().quantity || 0);
            tx.update(ingRefs[idx], { quantity: cur + Number(held[idx].amount || 0) });
          }
        });

        if (voucherRef && vSnap && vSnap.exists) {
          const curUsed = Number(vSnap.data().usedCount || 0);
          tx.update(voucherRef, { usedCount: Math.max(0, curUsed - 1) });
        }

        const hasPartial = Number(o.received || 0) > 0;
        tx.update(orderDoc.ref, {
          stockHold: false,
          expired: true,
          status: 'Hết hạn',
          requiresReconciliation: hasPartial,
        });
      }).catch((e) => logger.error(`Lỗi hoàn kho đơn ${orderDoc.id}`, e));
    }
  }
);
