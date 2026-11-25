import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-app.js";
import { initializeAuth, browserSessionPersistence, onAuthStateChanged, signOut, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-auth.js";
import {
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    query,
    where,
    getDocs,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    runTransaction,
    serverTimestamp,
    increment
} from "https://www.gstatic.com/firebasejs/10.5.0/firebase-firestore.js";

export const firebaseConfig = {
    apiKey: "AIzaSyA1-ZXjG4PxPf49ca1apqGU6uQIF85wXjs",
    authDomain: "baitapwebmeda.firebaseapp.com",
    projectId: "baitapwebmeda",
    storageBucket: "baitapwebmeda.firebasestorage.app",
    messagingSenderId: "861447527432",
    appId: "1:861447527432:web:fd50d27fd77becba3185bd",
    measurementId: "G-5XTSYM41VX"
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function initFastFirestore(firebaseApp) {
    if (!/\/(index\.html)?$/.test(location.pathname)) return getFirestore(firebaseApp);
    try {
        return initializeFirestore(firebaseApp, {
            localCache: persistentLocalCache({
                tabManager: persistentMultipleTabManager()
            })
        });
    } catch (_) {
        return getFirestore(firebaseApp);
    }
}

export function textForHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const db = initFastFirestore(app);
export const auth = initializeAuth(app, { persistence: browserSessionPersistence });

const DEFAULT_ADMIN_PASS = "meda2026";
const DEFAULT_STAFF_PASS = "nhanvien123";
const SESSION_ROLE_KEY = "meda_session_role";
const ORDER_HOLD_MS = 15 * 60 * 1000;

// Băm SHA-256 cho mật khẩu
export async function sha256Pass(text, prefix = "meda_admin::") {
    const raw = prefix + String(text || "").trim();
    try {
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
            return "sha256:" + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
    } catch (_) {}
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let i = 0; i < raw.length; i++) {
        h1 = Math.imul(h1 ^ raw.charCodeAt(i), 16777619) >>> 0;
        h2 = Math.imul(h2 + raw.charCodeAt(i) * (i + 7), 2654435761) >>> 0;
    }
    return "fb:" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ==================== TIỆN ÍCH NGÀY GIỜ & CHUẨN HÓA TIMESTAMP ĐƠN HÀNG ====================

function getVNDateParts(d = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Ho_Chi_Minh",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).formatToParts(d);
        const map = {};
        parts.forEach(p => { map[p.type] = p.value; });
        return {
            day: (map.day || "01").padStart(2, "0"),
            month: (map.month || "01").padStart(2, "0"),
            year: map.year || String(d.getFullYear()),
            hour: (map.hour === "24" ? "00" : (map.hour || "00")).padStart(2, "0"),
            minute: (map.minute || "00").padStart(2, "0"),
            second: (map.second || "00").padStart(2, "0")
        };
    } catch (_) {
        const vn = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
        return {
            day: String(vn.getDate()).padStart(2, "0"),
            month: String(vn.getMonth() + 1).padStart(2, "0"),
            year: String(vn.getFullYear()),
            hour: String(vn.getHours()).padStart(2, "0"),
            minute: String(vn.getMinutes()).padStart(2, "0"),
            second: String(vn.getSeconds()).padStart(2, "0")
        };
    }
}

export function fmtDateVN(d = new Date()) {
    const p = getVNDateParts(d);
    return `${p.day}/${p.month}/${p.year}`;
}

export function fmtDateTimeVN(d = new Date()) {
    const p = getVNDateParts(d);
    return `${p.hour}:${p.minute}:${p.second} ${p.day}/${p.month}/${p.year}`;
}

function getVNCurrentHour() {
    return Number(getVNDateParts(new Date()).hour) || 0;
}

function parseVoucherExpiryMs(expiresAt) {
    if (!expiresAt) return null;
    const raw = String(expiresAt).trim();
    const hasTz = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
    const ms = new Date(hasTz ? raw : raw + "+07:00").getTime();
    return Number.isFinite(ms) ? ms : null;
}

export function getOrderTimeMs(order) {
    if (!order || typeof order !== "object") return 0;

    if (typeof order.createdAtMs === "number" && Number.isFinite(order.createdAtMs) && order.createdAtMs > 0) {
        return order.createdAtMs;
    }

    const ts = order.timestamp;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
        return ts > 1e11 ? ts : ts * 1000;
    }
    if (ts && typeof ts === "object") {
        if (typeof ts.toMillis === "function") {
            const ms = ts.toMillis();
            if (Number.isFinite(ms) && ms > 0) return ms;
        }
        const sec = typeof ts.seconds === "number" ? ts.seconds : (typeof ts._seconds === "number" ? ts._seconds : null);
        if (sec !== null && Number.isFinite(sec)) {
            const nano = Number(ts.nanoseconds || ts._nanoseconds || 0);
            return sec * 1000 + Math.floor(nano / 1e6);
        }
    }

    if (order.createdAt && typeof order.createdAt === "string") {
        const s = order.createdAt.trim();
        const dateMatch = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (dateMatch) {
            const day = parseInt(dateMatch[1], 10);
            const month = parseInt(dateMatch[2], 10);
            const year = parseInt(dateMatch[3], 10);
            const timeMatch = s.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
            const hr = timeMatch ? parseInt(timeMatch[1], 10) : 0;
            const min = timeMatch ? parseInt(timeMatch[2], 10) : 0;
            const sec = (timeMatch && timeMatch[3]) ? parseInt(timeMatch[3], 10) : 0;
            const parsed = new Date(year, month - 1, day, hr, min, sec).getTime();
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        const fallback = Date.parse(s);
        if (Number.isFinite(fallback) && fallback > 0) return fallback;
    }

    const rawId = String(order.id || order.orderId || "");
    const idMatch = rawId.match(/ord_(\d{10,15})/);
    if (idMatch) {
        const idNum = parseInt(idMatch[1], 10);
        if (Number.isFinite(idNum) && idNum > 0) return idNum > 1e11 ? idNum : idNum * 1000;
    }

    return 0;
}

export function getOrderDateKeyVN(order) {
    if (!order || typeof order !== "object") return "";
    if (typeof order.dateKey === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(order.dateKey)) {
        return order.dateKey;
    }
    if (order.createdAt && typeof order.createdAt === "string") {
        const m = order.createdAt.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (m) {
            const d = m[1].padStart(2, "0");
            const mo = m[2].padStart(2, "0");
            const y = m[3];
            return `${d}/${mo}/${y}`;
        }
    }
    const ms = getOrderTimeMs(order);
    if (ms > 0) return fmtDateVN(new Date(ms));
    return "";
}

// ==================== XÁC THỰC & PHIÊN LÀM VIỆC (SPARK FREE TIER — 1 VAI TRÒ / SESSION) ====================

const authLoaded = new Promise(resolve => {
    const stop = onAuthStateChanged(auth, () => { stop(); resolve(); });
});

let authReadyPromise = null;
export async function ready() {
    await authLoaded;
    if (auth.currentUser) return auth.currentUser;
    if (!authReadyPromise) {
        authReadyPromise = signInAnonymously(auth)
            .then(cred => {
                if (!cred.user?.uid) throw Object.assign(new Error("Firebase chưa cấp phiên đăng nhập hợp lệ."), { code: "auth/session-unavailable" });
                return cred.user;
            })
            .catch(error => {
                const messages = {
                    "auth/configuration-not-found": "Firebase Authentication chưa được khởi tạo. Quản trị viên cần vào Authentication → Bắt đầu, rồi bật phương thức Anonymous.",
                    "auth/operation-not-allowed": "Firebase chưa bật phương thức đăng nhập Anonymous. Quản trị viên cần bật phương thức này trong Authentication → Sign-in method.",
                    "auth/admin-restricted-operation": "Firebase đang chặn tạo phiên Anonymous. Quản trị viên cần kiểm tra cấu hình Authentication.",
                    "auth/network-request-failed": "Không kết nối được dịch vụ đăng nhập. Kiểm tra mạng rồi thử lại; bản nháp vẫn được giữ.",
                    "auth/too-many-requests": "Dịch vụ đăng nhập đang giới hạn yêu cầu. Vui lòng chờ một lát rồi thử lại."
                };
                const failure = new Error(messages[error.code] || error.message || "Không tạo được phiên đăng nhập Firebase. Vui lòng thử lại.");
                failure.code = error.code || "auth/session-unavailable";
                throw failure;
            })
            .finally(() => { authReadyPromise = null; });
    }
    return await authReadyPromise;
}

export async function role() {
    await authLoaded;
    try {
        const r = sessionStorage.getItem(SESSION_ROLE_KEY);
        if (r === "admin" || r === "staff") return r;
    } catch (_) {}
    return "";
}

export async function readyAdmin() {
    if (await role() !== "admin") {
        throw new Error("Vui lòng đăng nhập quản trị.");
    }
    const user = await ready();
    return { uid: user.uid, admin: true };
}

export async function clearWorkSession() {
    await authLoaded;
    const keys = [
        SESSION_ROLE_KEY,
        "meda_zalo_unlocked",
        "meda_admin_authenticated",
        "meda_admin_pass_hash",
        "meda_staff_authenticated",
        "meda_role"
    ];
    for (const key of keys) {
        try { sessionStorage.removeItem(key); } catch (_) {}
        try { localStorage.removeItem(key); } catch (_) {}
    }
    if (auth.currentUser && !auth.currentUser.isAnonymous) {
        await signOut(auth).catch(() => {});
    }
}

export async function loginAdmin(password) {
    const pass = String(password || "").trim();
    if (!pass) throw new Error("Vui lòng nhập mật khẩu!");

    if (await role() === "staff") {
        await clearWorkSession();
        location.replace("index.html");
        throw new Error("Đang đăng nhập tài khoản nhân viên. Vui lòng quay về trang chủ để đăng nhập quản trị.");
    }

    await clearWorkSession();
    await ready();

    const inputHash = await sha256Pass(pass, "meda_admin::");
    const adminRef = doc(db, "config", "admin");
    const snap = await getDoc(adminRef).catch(() => null);

    if (snap && snap.exists() && (snap.data().passHash || snap.data().password)) {
        const savedHash = snap.data().passHash;
        const savedPlain = snap.data().password;
        if (inputHash !== savedHash && pass !== savedPlain) {
            throw new Error("Sai mật khẩu quản trị! Vui lòng kiểm tra lại.");
        }
    } else {
        if (pass !== DEFAULT_ADMIN_PASS && pass !== "admin123" && pass !== "123456") {
            throw new Error(`Sai mật khẩu! (Mật khẩu mặc định lần đầu là: ${DEFAULT_ADMIN_PASS})`);
        }
        await setDoc(adminRef, {
            passHash: inputHash,
            recoveryCode: "meda2026",
            updatedAt: Date.now()
        }, { merge: true }).catch(() => {});
    }

    sessionStorage.setItem(SESSION_ROLE_KEY, "admin");
    return { uid: "admin", admin: true };
}

export async function loginStaff(password) {
    const pass = String(password || "").trim();
    if (!pass) throw new Error("Vui lòng nhập mật khẩu nhân viên!");

    await clearWorkSession();
    await ready();

    const inputHash = await sha256Pass(pass, "meda_staff::");
    const staffRef = doc(db, "config", "staff");
    const snap = await getDoc(staffRef).catch(() => null);

    if (snap && snap.exists() && (snap.data().passHash || snap.data().password)) {
        const savedHash = snap.data().passHash;
        const savedPlain = snap.data().password;
        if (inputHash !== savedHash && pass !== savedPlain) {
            throw new Error("Sai mật khẩu nhân viên! Vui lòng kiểm tra lại.");
        }
    } else {
        if (pass !== DEFAULT_STAFF_PASS && pass !== "123456" && pass !== "nhanvien") {
            throw new Error(`Sai mật khẩu! (Mật khẩu mặc định nhân viên là: ${DEFAULT_STAFF_PASS})`);
        }
        await setDoc(staffRef, {
            passHash: inputHash,
            updatedAt: Date.now()
        }, { merge: true }).catch(() => {});
    }

    sessionStorage.setItem(SESSION_ROLE_KEY, "staff");
    return { uid: "staff", staff: true };
}

export async function logoutAdmin() {
    await clearWorkSession();
    location.replace("index.html");
}

export async function changeAdminPassword(oldPassword, newPassword) {
    const oldP = String(oldPassword || "").trim();
    const newP = String(newPassword || "").trim();
    if (newP.length < 6) throw new Error("Mật khẩu mới phải có ít nhất 6 ký tự!");

    await ready();
    const oldHash = await sha256Pass(oldP, "meda_admin::");
    const adminRef = doc(db, "config", "admin");
    const snap = await getDoc(adminRef);
    if (snap.exists() && (snap.data().passHash || snap.data().password)) {
        if (oldHash !== snap.data().passHash && oldP !== snap.data().password) {
            throw new Error("Mật khẩu hiện tại không đúng!");
        }
    } else if (oldP !== DEFAULT_ADMIN_PASS && oldP !== "admin123" && oldP !== "123456") {
        throw new Error("Mật khẩu hiện tại không đúng!");
    }

    const newHash = await sha256Pass(newP, "meda_admin::");
    await setDoc(adminRef, { passHash: newHash, updatedAt: Date.now() }, { merge: true });
    return { ok: true };
}

async function setStaffPasswordDirect(password) {
    if (await role() !== "admin") throw new Error("Chỉ quản trị viên được đổi mật khẩu nhân viên.");
    const pass = String(password || "").trim();
    if (pass.length < 6) throw new Error("Mật khẩu nhân viên cần ít nhất 6 ký tự.");
    const passHash = await sha256Pass(pass, "meda_staff::");
    await setDoc(doc(db, "config", "staff"), { passHash, updatedAt: Date.now() }, { merge: true });
    return { ok: true };
}

async function recoverAdminPasswordDirect(code, newPassword) {
    await ready();
    const recCode = String(code || "").trim();
    const pass = String(newPassword || "").trim();
    if (!recCode) throw new Error("Vui lòng nhập mã khôi phục!");
    if (pass.length < 6) throw new Error("Mật khẩu mới cần ít nhất 6 ký tự!");

    const adminRef = doc(db, "config", "admin");
    const snap = await getDoc(adminRef).catch(() => null);
    const savedCode = (snap && snap.exists() && snap.data().recoveryCode) ? String(snap.data().recoveryCode) : "meda2026";
    if (recCode !== savedCode) throw new Error("Mã khôi phục không đúng! (Mặc định: meda2026)");

    const newHash = await sha256Pass(pass, "meda_admin::");
    await setDoc(adminRef, { passHash: newHash, recoveryCode: savedCode, updatedAt: Date.now() }, { merge: true });
    return { ok: true };
}

// ==================== ĐẶT HÀNG TRỰC TIẾP TRÊN FIRESTORE (VOUCHER + TỒN KHO + SEPAY CODE DH...) ====================

async function placeOrderDirect(payload = {}) {
    const user = await ready();
    const customerName = String(payload.customerName || "").trim().slice(0, 80);
    if (!customerName) throw new Error("Vui lòng nhập tên để nhận món.");

    const orderType = payload.orderType === "Mang về" ? "Mang về" : "Tại chỗ";
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (!rawItems.length) throw new Error("Giỏ hàng trống!");

    const itemQtyMap = new Map();
    for (const it of rawItems) {
        const id = String(it && it.id || "").trim();
        const qty = Number(it && it.quantity);
        if (!id || !Number.isInteger(qty) || qty <= 0 || qty > 99) {
            throw new Error("Số lượng món đặt không hợp lệ.");
        }
        itemQtyMap.set(id, (itemQtyMap.get(id) || 0) + qty);
    }

    const voucherCode = String(payload.voucherCode || "").trim().toUpperCase().replace(/\s+/g, "");
    if (voucherCode && !/^[A-Z0-9_-]{1,40}$/.test(voucherCode)) {
        throw new Error("Mã voucher không hợp lệ.");
    }

    const rawReqId = String(payload.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const reqDocRef = rawReqId ? doc(db, "orderRequests", `${user.uid || "guest"}_${rawReqId}`) : null;

    return runTransaction(db, async (tx) => {
        if (reqDocRef) {
            const existingReq = await tx.get(reqDocRef);
            if (existingReq.exists()) {
                const prev = existingReq.data();
                return { code: prev.orderCode, total: prev.total, expiresAtMs: prev.expiresAtMs || 0 };
            }
        }

        const productIds = Array.from(itemQtyMap.keys());
        const prodRefs = productIds.map(id => doc(db, "products", id));
        const prodSnaps = await Promise.all(prodRefs.map(r => tx.get(r)));

        const orderItems = [];
        const requiredIng = new Map();
        let subtotal = 0;

        prodSnaps.forEach((snap, idx) => {
            const pid = productIds[idx];
            if (!snap.exists()) throw new Error("Có món trong giỏ hàng không còn tồn tại.");
            const p = snap.data();
            const qty = itemQtyMap.get(pid);
            const price = Math.max(0, Math.round(Number(p.price || 0)));
            subtotal += price * qty;
            orderItems.push({ id: pid, name: String(p.name || "Món nước"), price, quantity: qty });

            if (Array.isArray(p.recipe)) {
                for (const r of p.recipe) {
                    const ingId = String(r && r.ingId || "").trim();
                    const amt = Number(r && r.amount || 0);
                    if (ingId && amt > 0) {
                        requiredIng.set(ingId, (requiredIng.get(ingId) || 0) + amt * qty);
                    }
                }
            }
        });

        const ingIds = Array.from(requiredIng.keys());
        const ingRefs = ingIds.map(id => doc(db, "inventory", id));
        const seqRef = doc(db, "config", "paymentSequence");
        const queueRef = doc(db, "config", "queue");
        const voucherRef = voucherCode ? doc(db, "vouchers", voucherCode) : null;

        const [ingSnaps, seqSnap, queueSnap, voucherSnap] = await Promise.all([
            Promise.all(ingRefs.map(r => tx.get(r))),
            tx.get(seqRef),
            tx.get(queueRef),
            voucherRef ? tx.get(voucherRef) : Promise.resolve(null)
        ]);

        const heldIngredients = [];
        const ingUpdates = [];
        ingSnaps.forEach((snap, idx) => {
            const ingId = ingIds[idx];
            const need = requiredIng.get(ingId);
            const have = snap.exists() ? Number(snap.data().quantity || 0) : 0;
            if (!snap.exists() || have < need) {
                const ingName = snap.exists() ? (snap.data().name || ingId) : ingId;
                throw new Error(`Rất tiếc! Nguyên liệu "${ingName}" hiện không đủ số lượng cho giỏ hàng của bạn.`);
            }
            heldIngredients.push({ ingId, amount: need });
            ingUpdates.push({ ref: ingRefs[idx], nextQty: Math.max(0, have - need) });
        });

        let discountAmount = 0;
        if (voucherCode) {
            if (!voucherSnap || !voucherSnap.exists()) throw new Error("Mã voucher không tồn tại.");
            const v = voucherSnap.data();
            if (v.active === false) throw new Error("Mã voucher này đã ngừng hoạt động.");
            const expMs = parseVoucherExpiryMs(v.expiresAt);
            if (expMs !== null && expMs < Date.now()) throw new Error("Mã voucher này đã hết hạn sử dụng.");
            const limit = Number(v.usageLimit || 0);
            const used = Number(v.usedCount || 0);
            if (limit > 0 && used >= limit) throw new Error("Mã voucher này đã hết lượt sử dụng.");
            const pct = Number(v.discountPercent || 0);
            const fix = Number(v.discountFixed || 0);
            if (pct > 0) discountAmount = Math.round((subtotal * pct) / 100);
            else if (fix > 0) discountAmount = Math.min(Math.round(fix), subtotal);
            discountAmount = Math.max(0, Math.min(subtotal, discountAmount));
        }

        const total = Math.max(0, subtotal - discountAmount);
        const now = Date.now();
        const today = fmtDateVN(new Date(now));
        const nowStr = fmtDateTimeVN(new Date(now));

        const prevSeq = seqSnap.exists() ? Number(seqSnap.data().last || 1000) : 1000;
        const nextSeq = Math.max(1000, prevSeq) + 1;
        const orderCode = `DH${nextSeq}`;

        for (const u of ingUpdates) {
            tx.update(u.ref, { quantity: u.nextQty });
        }
        if (voucherRef) {
            tx.update(voucherRef, { usedCount: increment(1) });
        }
        tx.set(seqRef, { last: nextSeq, updatedAt: now }, { merge: true });

        const orderRef = doc(db, "orders", orderCode);
        let expiresAtMs = 0;

        if (total === 0) {
            const qData = queueSnap.exists() ? queueSnap.data() : {};
            const sameDay = (qData.dateKey === today || qData.date === today);
            const prevQ = sameDay ? Number(qData.count || qData.current || 0) : 0;
            const queueNumber = prevQ + 1;
            tx.set(queueRef, { dateKey: today, date: today, count: queueNumber, current: queueNumber, updatedAt: now }, { merge: true });
            tx.set(orderRef, {
                orderId: orderCode,
                order_code: orderCode,
                ownerUid: user.uid,
                customerName,
                orderType,
                items: orderItems,
                subtotal,
                voucherCode,
                discountAmount,
                total: 0,
                received: 0,
                payment_status: "PAID",
                status: "Chờ pha chế",
                queueNumber,
                stockHold: false,
                expired: false,
                requiresReconciliation: false,
                dateKey: today,
                createdAt: nowStr,
                createdAtMs: now,
                timestamp: serverTimestamp(),
                paid_at: nowStr,
                zaloNotified: false
            });
        } else {
            expiresAtMs = now + ORDER_HOLD_MS;
            tx.set(orderRef, {
                orderId: orderCode,
                order_code: orderCode,
                ownerUid: user.uid,
                customerName,
                orderType,
                items: orderItems,
                subtotal,
                voucherCode,
                discountAmount,
                total,
                received: 0,
                payment_status: "PENDING",
                status: "Chờ thanh toán",
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
                timestamp: serverTimestamp(),
                zaloNotified: false
            });
        }

        if (reqDocRef) {
            tx.set(reqDocRef, { orderCode, total, expiresAtMs, createdAtMs: now });
        }

        return { code: orderCode, total, expiresAtMs };
    });
}

// Bộ định tuyến thay thế hoàn toàn Cloud Functions trên gói Spark miễn phí
export async function remote(name, data = {}) {
    switch (name) {
        case "adminLogin": return loginAdmin(data.password);
        case "staffLogin": return loginStaff(data.password);
        case "adminChangePassword": return changeAdminPassword(data.oldPassword, data.newPassword);
        case "setStaffPassword": return setStaffPasswordDirect(data.password);
        case "recoverAdminPassword": return recoverAdminPasswordDirect(data.code, data.password);
        case "placeOrder": return placeOrderDirect(data);
        case "zaloPushStock": return callFn("zaloPushStock", data);
        case "zaloPushReport": return callFn("zaloPushReport", data);
        default: return callFn(name, data);
    }
}

window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

// ==================== HỆ THỐNG ZALO TRỰC TIẾP & ĐỒNG BỘ 24/7 ====================

let cachedZaloSettings = null;
let cachedZaloSettingsAt = 0;
const ZALO_CACHE_TTL_MS = 20000;

async function loadFullZaloSettings(forceRefresh = false) {
    if (!forceRefresh && cachedZaloSettings && (Date.now() - cachedZaloSettingsAt < ZALO_CACHE_TTL_MS)) {
        return cachedZaloSettings;
    }
    const [zaloSnap, tokenSnap] = await Promise.all([
        getDoc(doc(db, "config", "zalo")).catch(() => null),
        getDoc(doc(db, "config", "zaloToken")).catch(() => null)
    ]);
    const cfg = (zaloSnap && zaloSnap.exists()) ? zaloSnap.data() : {};
    const tokData = (tokenSnap && tokenSnap.exists()) ? tokenSnap.data() : {};
    const botToken = tokData.botToken || tokData.token || cfg.botToken || "";
    cachedZaloSettings = {
        mode: cfg.mode || "zalo_bot",
        botToken,
        botTokenSet: Boolean(botToken),
        botChatId: cfg.botChatId || "",
        webhookUrl: cfg.webhookUrl || "",
        oaAccessToken: cfg.oaAccessToken || "",
        oaTokenSet: Boolean(cfg.oaAccessToken),
        oaRecipientId: cfg.oaRecipientId || "",
        corsProxy: cfg.corsProxy || "",
        phone: cfg.phone || "",
        enableAuto: cfg.enableAuto !== false,
        notifyLowStock: cfg.notifyLowStock !== false,
        notifyOutProduct: cfg.notifyOutProduct !== false,
        notifyOrderDaily: cfg.notifyOrderDaily !== false,
        autoDailySummary: cfg.autoDailySummary !== false,
        summaryHour: cfg.summaryHour ?? 21,
        lastDailySummaryDate: cfg.lastDailySummaryDate || "",
        lastDailySummaryAt: cfg.lastDailySummaryAt || 0,
        lastOrderMessage: cfg.lastOrderMessage || "",
        lastOrderSentAt: cfg.lastOrderSentAt || 0,
        zaloCodeHash: cfg.zaloCodeHash || ""
    };
    cachedZaloSettingsAt = Date.now();
    return cachedZaloSettings;
}

export async function sendMessageToZalo(text, type = "notification", extraData = {}) {
    const cfg = await loadFullZaloSettings();
    const mode = cfg.mode || "zalo_bot";
    const safeText = String(text || "").slice(0, 3900);

    if (mode === "zalo_bot") {
        if (!cfg.botToken || !cfg.botChatId) {
            return { ok: false, reason: "Chưa cấu hình Zalo Bot Token hoặc Chat ID!", message: safeText };
        }
        const targetUrl = `https://bot-api.zapps.me/bot${cfg.botToken}/sendMessage`;
        const formBody = new URLSearchParams();
        formBody.append("chat_id", cfg.botChatId);
        formBody.append("text", safeText);

        const requests = [];
        if (cfg.corsProxy) {
            requests.push(
                fetch(cfg.corsProxy, {
                    method: "POST",
                    mode: "no-cors",
                    keepalive: true,
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify({
                        action: "sendZalo",
                        botToken: cfg.botToken,
                        chatId: cfg.botChatId,
                        text: safeText,
                        type,
                        data: extraData
                    })
                }).catch(() => null)
            );
        }

        requests.push(
            fetch(targetUrl, {
                method: "POST",
                mode: "no-cors",
                keepalive: true,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: formBody.toString()
            }).catch(() => null)
        );

        await Promise.allSettled(requests);
        return { ok: true, message: safeText, text: safeText };
    }

    if (mode === "webhook") {
        if (!cfg.webhookUrl) {
            return { ok: false, reason: "Chưa nhập Webhook URL!", message: safeText };
        }
        await fetch(cfg.webhookUrl, {
            method: "POST",
            mode: "no-cors",
            keepalive: true,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                shop: "Mê Đá",
                type,
                timestamp: fmtDateTimeVN(),
                message: safeText,
                text: safeText,
                content: safeText,
                data: extraData
            })
        }).catch(() => null);
        return { ok: true, message: safeText, text: safeText };
    }

    if (mode === "zalo_oa") {
        if (!cfg.oaAccessToken || !cfg.oaRecipientId) {
            return { ok: false, reason: "Chưa nhập Zalo OA Access Token hoặc User ID!", message: safeText };
        }
        const oaEndpoint = cfg.corsProxy || "https://openapi.zalo.me/v3.0/oa/message/cs";
        await fetch(oaEndpoint, {
            method: "POST",
            keepalive: true,
            headers: {
                "Content-Type": "application/json",
                "access_token": cfg.oaAccessToken
            },
            body: JSON.stringify({
                recipient: { user_id: cfg.oaRecipientId },
                message: { text: safeText }
            })
        }).catch(() => null);
        return { ok: true, message: safeText, text: safeText };
    }

    return { ok: false, reason: "Phương thức Zalo không hợp lệ.", message: safeText };
}

export function calcMaxCups(product, inventory) {
    if (!product || !product.recipe || product.recipe.length === 0) return 999;
    let maxCups = Infinity;
    product.recipe.forEach(ri => {
        const inv = inventory.find(i => i.id === ri.ingId);
        const amt = Number(ri.amount || 0);
        if (amt <= 0) return;
        if (!inv || Number(inv.quantity) < amt) maxCups = 0;
        else maxCups = Math.min(maxCups, Math.floor(Number(inv.quantity) / amt));
    });
    return maxCups === Infinity ? 0 : maxCups;
}

async function generateStockAlertMessage() {
    const [invSnap, prodSnap] = await Promise.all([
        getDocs(collection(db, "inventory")),
        getDocs(collection(db, "products"))
    ]);
    const inventory = invSnap.docs.map(d => ({ ...d.data(), id: d.data().id || d.id }));
    const products = prodSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    const outIngs = inventory.filter(i => Number(i.quantity) <= 0).map(i => `• ❌ ${i.name}: HẾT SẠCH (0 ${i.unit})`);
    const lowIngs = inventory.filter(i => Number(i.quantity) > 0 && Number(i.quantity) <= 50).map(i => `• ⚠️ ${i.name}: Sắp hết (còn ${i.quantity} ${i.unit})`);
    const outProds = products.filter(p => calcMaxCups(p, inventory) === 0).map(p => `• 🚫 ${p.name}: HẾT MÓN (không đủ nguyên liệu)`);

    const hasAlert = outIngs.length > 0 || lowIngs.length > 0 || outProds.length > 0;
    const msg = [
        `⚠️ [MÊ ĐÁ] CẢNH BÁO KHO NGUYÊN LIỆU & MÓN (${fmtDateVN()})`,
        `🕒 Lúc: ${new Date().toLocaleTimeString("vi-VN")}`,
        `========================`,
        ...(hasAlert
            ? [
                ...(outIngs.length ? ["🔴 NGUYÊN LIỆU ĐÃ HẾT:", ...outIngs] : []),
                ...(lowIngs.length ? ["🟡 NGUYÊN LIỆU SẮP HẾT:", ...lowIngs] : []),
                ...(outProds.length ? ["🚫 MÓN TẠM HẾT TRÊN MENU:", ...outProds] : [])
              ]
            : ["✅ Toàn bộ nguyên liệu và các món trong thực đơn đều còn đầy đủ!"])
    ].join("\n");

    return { msg, hasAlert, outIngs, lowIngs, outProds };
}

async function fetchOrdersForDateVN(targetDateStr) {
    try {
        const indexedQ = query(collection(db, "orders"), where("dateKey", "==", targetDateStr));
        const indexedSnap = await getDocs(indexedQ);
        if (!indexedSnap.empty) {
            return indexedSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(o => !o.requiresReconciliation && (!o.payment_status || o.payment_status === "PAID"));
        }
    } catch (_) {}

    const ordersSnap = await getDocs(collection(db, "orders"));
    return ordersSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(o => !o.requiresReconciliation && (!o.payment_status || o.payment_status === "PAID"))
        .filter(o => getOrderDateKeyVN(o) === targetDateStr || (o.createdAt && String(o.createdAt).includes(targetDateStr)));
}

async function generateDailyReportMessage(targetDateStr = fmtDateVN()) {
    const [finSnap, invSnap, prodSnap, dayOrders] = await Promise.all([
        getDoc(doc(db, "config", "finance")),
        getDocs(collection(db, "inventory")),
        getDocs(collection(db, "products")),
        fetchOrdersForDateVN(targetDateStr)
    ]);

    const fin = finSnap.exists() ? finSnap.data() : { fixedCosts: 0, ingredientCosts: 0, totalRevenue: 0 };
    const inventory = invSnap.docs.map(d => ({ ...d.data(), id: d.data().id || d.id }));
    const products = prodSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    let dailyRevenue = 0;
    let dailyCups = 0;
    const soldMap = {};

    dayOrders.forEach(o => {
        dailyRevenue += Number(o.total || 0);
        if (Array.isArray(o.items)) {
            o.items.forEach(it => {
                const key = it.id || it.name;
                if (!soldMap[key]) soldMap[key] = { name: it.name, qty: 0, rev: 0 };
                soldMap[key].qty += Number(it.quantity || 0);
                soldMap[key].rev += Number(it.price || 0) * Number(it.quantity || 0);
                dailyCups += Number(it.quantity || 0);
            });
        }
    });

    const soldArr = Object.values(soldMap).sort((a, b) => b.qty - a.qty);
    const soldLines = soldArr.length
        ? soldArr.map((s, idx) => `${idx + 1}. ${s.name}: ${s.qty} ly (${s.rev.toLocaleString("vi-VN")}đ)`).join("\n")
        : "• Chưa có món nào bán ra trong ngày.";

    const totalCosts = Number(fin.fixedCosts || 0) + Number(fin.ingredientCosts || 0);
    const totalProfit = Number(fin.totalRevenue || 0) - totalCosts;

    const outIngs = inventory.filter(i => Number(i.quantity) <= 0).map(i => `• ❌ ${i.name} (0 ${i.unit})`);
    const lowIngs = inventory.filter(i => Number(i.quantity) > 0 && Number(i.quantity) <= 50).map(i => `• ⚠️ ${i.name} (còn ${i.quantity} ${i.unit})`);
    const outProds = products.filter(p => calcMaxCups(p, inventory) === 0).map(p => `• 🚫 ${p.name} (Hết món)`);

    const msg = [
        `📊 [MÊ ĐÁ] BÁO CÁO TỔNG KẾT NGÀY ${targetDateStr}`,
        `🕒 Xuất lúc: ${new Date().toLocaleTimeString("vi-VN")}`,
        `========================`,
        `💰 1. DOANH THU HÔM NAY (${targetDateStr}):`,
        `• Tổng số đơn: ${dayOrders.length} đơn (${dailyCups} ly)`,
        `• Doanh thu trong ngày: ${dailyRevenue.toLocaleString("vi-VN")} VNĐ`,
        `------------------------`,
        `📈 LŨY KẾ THÁNG HIỆN TẠI:`,
        `• Tổng thu lũy kế: ${Number(fin.totalRevenue || 0).toLocaleString("vi-VN")} VNĐ`,
        `• Tổng chi phí: ${totalCosts.toLocaleString("vi-VN")} VNĐ`,
        `• Lãi ròng ước tính: ${totalProfit.toLocaleString("vi-VN")} VNĐ`,
        `========================`,
        `🧋 2. CHI TIẾT CÁC MÓN BÁN TRONG NGÀY:`,
        soldLines,
        `========================`,
        `📦 3. TÌNH TRẠNG KHO & THỰC ĐƠN:`,
        ...(outIngs.length || lowIngs.length || outProds.length
            ? [...outIngs, ...lowIngs, ...outProds]
            : ["✅ Nguyên liệu và các món đều còn đủ."])
    ].join("\n");

    return { msg, dailyRevenue, dailyCups, orderCount: dayOrders.length };
}

export function formatIncomingOrderZaloMessage(orderData, dailyStats = null, stockAlerts = []) {
    const items = Array.isArray(orderData.items) ? orderData.items : [];
    const totalOrderCups = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const itemLines = items.length
        ? items.map((i, idx) => `  ${idx + 1}. ${i.name} x${i.quantity} — ${(Number(i.price || 0) * Number(i.quantity || 0)).toLocaleString("vi-VN")}đ`).join("\n")
        : "  • (Không rõ món)";

    const todayStr = orderData.dateKey || getOrderDateKeyVN(orderData) || fmtDateVN();
    const lines = [
        `🛎️ [MÊ ĐÁ] ĐƠN HÀNG MỚI #${String(orderData.queueNumber || 1).padStart(2, "0")}`,
        `🧾 Mã đơn: #${orderData.orderId || orderData.id}`,
        `🕒 Thời gian: ${orderData.createdAt || fmtDateTimeVN()}`,
        `👤 Khách hàng: ${orderData.customerName || "Khách hàng"}`,
        `🏷️ Hình thức: ${orderData.orderType || "Tại chỗ"}`,
        `------------------------`,
        `🧋 CHI TIẾT MÓN ĐẶT (${totalOrderCups} ly):`,
        itemLines,
        ...(orderData.voucherCode ? [`🎟 Voucher: ${orderData.voucherCode} (-${Number(orderData.discountAmount || 0).toLocaleString("vi-VN")}đ)`] : []),
        `💰 TỔNG THANH TOÁN: ${Number(orderData.total || 0).toLocaleString("vi-VN")} VNĐ`,
        `📌 Trạng thái: ${orderData.status || "Chờ pha chế"}`
    ];

    if (dailyStats && Number.isFinite(dailyStats.dailyRevenue)) {
        lines.push(
            `========================`,
            `📈 LŨY KẾ HÔM NAY (${todayStr}):`,
            `• Tổng số đơn: ${dailyStats.dailyOrders || 1} đơn (${dailyStats.dailyCups || totalOrderCups} ly)`,
            `• Doanh thu ngày: ${Number(dailyStats.dailyRevenue || 0).toLocaleString("vi-VN")} VNĐ`
        );
    }

    if (Array.isArray(stockAlerts) && stockAlerts.length > 0) {
        lines.push(
            `========================`,
            `⚠️ CẢNH BÁO KHO NGUYÊN LIỆU / MÓN:`,
            ...stockAlerts
        );
    }

    return lines.join("\n");
}

async function dispatchIncomingOrderZalo(orderDocId, orderData, dailyStats, stockAlerts) {
    if (orderData.zaloNotificationOwner === "apps_script") return { ok: false, skipped: true };
    try {
        const cfg = await loadFullZaloSettings();
        if (!cfg.enableAuto || !cfg.notifyOrderDaily) return { ok: false, skipped: true };

        const filteredAlerts = (cfg.notifyLowStock || cfg.notifyOutProduct) ? stockAlerts : [];
        const orderMsg = formatIncomingOrderZaloMessage(orderData, dailyStats, filteredAlerts);

        const res = await sendMessageToZalo(orderMsg, "new_order", {
            ...orderData,
            dailyStats,
            stockAlerts: filteredAlerts
        });

        if (res && res.ok) {
            updateDoc(doc(db, "orders", orderDocId), {
                zaloNotified: true,
                zaloNotifiedAt: Date.now()
            }).catch(() => {});

            setDoc(doc(db, "config", "zalo"), {
                lastOrderMessage: orderMsg,
                lastOrderSentAt: Date.now()
            }, { merge: true }).catch(() => {});
        }
        return res;
    } catch (err) {
        console.warn("Không gửi được thông báo Zalo cho đơn mới:", err);
        return { ok: false, reason: err.message || String(err) };
    }
}

const processedOrderZaloIds = new Set();

export async function ensureOrderZaloNotified(order, liveAllOrders = [], liveInventory = [], liveProducts = []) {
    if (!order || !order.id) return;
    // Apps Script owns these notifications, including retries; browser sends cannot verify delivery.
    if (order.zaloNotificationOwner === "apps_script") return;
    if (order.zaloNotified === true) {
        processedOrderZaloIds.add(order.id);
        return;
    }
    if (processedOrderZaloIds.has(order.id)) return;

    const orderMs = getOrderTimeMs(order);
    if (!orderMs || (Date.now() - orderMs > 10 * 60 * 1000)) {
        processedOrderZaloIds.add(order.id);
        return;
    }

    processedOrderZaloIds.add(order.id);

    try {
        const cfg = await loadFullZaloSettings();
        if (!cfg.enableAuto || !cfg.notifyOrderDaily) return;

        const todayStr = getOrderDateKeyVN(order) || fmtDateVN();
        let dailyOrders = 0, dailyRevenue = 0, dailyCups = 0;
        if (Array.isArray(liveAllOrders) && liveAllOrders.length > 0) {
            liveAllOrders.forEach(o => {
                if (getOrderDateKeyVN(o) === todayStr) {
                    dailyOrders++;
                    dailyRevenue += Number(o.total || 0);
                    if (Array.isArray(o.items)) {
                        o.items.forEach(it => { dailyCups += Number(it.quantity || 0); });
                    }
                }
            });
        }

        const stockAlerts = [];
        if (cfg.notifyLowStock && Array.isArray(liveInventory)) {
            liveInventory.filter(i => Number(i.quantity) <= 0).forEach(i => stockAlerts.push(`• ❌ Hết NL: ${i.name} (0 ${i.unit || ""})`));
            liveInventory.filter(i => Number(i.quantity) > 0 && Number(i.quantity) <= 50).forEach(i => stockAlerts.push(`• ⚠️ Sắp hết NL: ${i.name} (còn ${i.quantity} ${i.unit || ""})`));
        }
        if (cfg.notifyOutProduct && Array.isArray(liveProducts) && Array.isArray(liveInventory) && liveInventory.length) {
            liveProducts.filter(p => calcMaxCups(p, liveInventory) === 0).forEach(p => stockAlerts.push(`• 🚫 Hết món: ${p.name}`));
        }

        await dispatchIncomingOrderZalo(
            order.id,
            order,
            dailyOrders > 0 ? { dailyOrders, dailyRevenue, dailyCups } : null,
            stockAlerts
        );
    } catch (_) {}
}

export async function callFn(name, payload = {}) {
    await ready();

    switch (name) {
        case "getZaloConfig": {
            return await loadFullZaloSettings(Boolean(payload && payload.force));
        }

        case "saveZaloConfig": {
            const clean = {
                mode: payload.mode || "zalo_bot",
                botChatId: String(payload.botChatId || "").trim(),
                webhookUrl: String(payload.webhookUrl || "").trim(),
                oaAccessToken: String(payload.oaAccessToken || "").trim(),
                oaRecipientId: String(payload.oaRecipientId || "").trim(),
                corsProxy: String(payload.corsProxy || "").trim(),
                phone: String(payload.phone || "").trim(),
                enableAuto: payload.enableAuto !== false,
                notifyLowStock: payload.notifyLowStock !== false,
                notifyOutProduct: payload.notifyOutProduct !== false,
                notifyOrderDaily: payload.notifyOrderDaily !== false,
                autoDailySummary: payload.autoDailySummary !== false,
                summaryHour: Number(payload.summaryHour ?? 21),
                updatedAt: Date.now()
            };
            await setDoc(doc(db, "config", "zalo"), clean, { merge: true });
            const full = await loadFullZaloSettings(true);
            return { ok: true, config: full };
        }

        case "setZaloToken": {
            const token = String(payload.token || "").trim();
            if (token) {
                await Promise.all([
                    setDoc(doc(db, "config", "zaloToken"), { botToken: token, token, updatedAt: Date.now() }, { merge: true }),
                    setDoc(doc(db, "config", "zalo"), { botToken: token, botTokenSet: true, updatedAt: Date.now() }, { merge: true })
                ]);
                cachedZaloSettings = null;
            }
            return { ok: true };
        }

        case "zaloFetchUpdates": {
            const cfg = await loadFullZaloSettings(true);
            const token = String(payload.token || cfg.botToken || "").trim();
            if (!token) {
                throw new Error("Bạn chưa lưu Zalo Bot Token! Hãy dán Token rồi bấm '💾 Lưu Cấu Hình Zalo' trước.");
            }
            const getUpdatesUrl = `https://bot-api.zapps.me/bot${token}/getUpdates`;
            const candidates = [
                getUpdatesUrl,
                `https://api.allorigins.win/raw?url=${encodeURIComponent(getUpdatesUrl)}`,
                `https://corsproxy.io/?${encodeURIComponent(getUpdatesUrl)}`
            ];

            let data = null;
            for (const url of candidates) {
                try {
                    const resp = await fetch(url, { method: "GET" });
                    if (resp.ok) {
                        const json = await resp.json();
                        if (json && (json.ok || json.result)) {
                            data = json;
                            break;
                        }
                    }
                } catch (_) {}
            }

            if (data && data.result) {
                const results = Array.isArray(data.result) ? data.result : [data.result];
                for (let i = results.length - 1; i >= 0; i--) {
                    const item = results[i];
                    const msg = item.message || item;
                    const chatId = (msg.chat && msg.chat.id) || (msg.from && msg.from.id) || item.chat_id;
                    const senderName = (msg.from && (msg.from.display_name || msg.from.name)) || "";
                    if (chatId) {
                        await setDoc(doc(db, "config", "zalo"), { botChatId: String(chatId) }, { merge: true });
                        cachedZaloSettings = null;
                        return { ok: true, found: { id: String(chatId), name: senderName } };
                    }
                }
            }
            return { ok: false, found: null };
        }

        case "zaloTest": {
            const msg = [
                `🔔 [MÊ ĐÁ] KIỂM TRA KẾT NỐI ZALO THÀNH CÔNG!`,
                `🕒 Thời gian: ${fmtDateTimeVN()}`,
                `✅ Hệ thống thông báo tự động của quán Mê Đá đã sẵn sàng hoạt động.`
            ].join("\n");
            return await sendMessageToZalo(msg, "test_connection");
        }

        case "zaloPushStock": {
            if (payload && (payload.message || payload.text)) {
                return await sendMessageToZalo(payload.message || payload.text, "stock_alert");
            }
            const { msg } = await generateStockAlertMessage();
            return await sendMessageToZalo(msg, "stock_alert");
        }

        case "zaloPushReport": {
            if (payload && (payload.message || payload.text)) {
                return await sendMessageToZalo(payload.message || payload.text, "daily_report", payload.data || {});
            }
            const todayStr = fmtDateVN();
            const { msg } = await generateDailyReportMessage(todayStr);
            const res = await sendMessageToZalo(msg, "daily_report");
            if (res.ok) {
                await setDoc(doc(db, "config", "zalo"), {
                    lastDailySummaryDate: todayStr,
                    lastDailySummaryAt: Date.now()
                }, { merge: true });
                cachedZaloSettings = null;
            }
            return res;
        }

        case "runAutomationNow": {
            const cfg = await loadFullZaloSettings(true);
            const nowHour = getVNCurrentHour();
            const todayStr = fmtDateVN();
            const sent = [];
            const errors = [];

            if (!cfg.enableAuto) {
                errors.push("Chế độ tự động đang TẮT.");
                return { summaryHour: cfg.summaryHour, nowHour, sent, errors };
            }

            if (cfg.notifyLowStock || cfg.notifyOutProduct) {
                const stockInfo = await generateStockAlertMessage();
                if (stockInfo.hasAlert) {
                    const r1 = await sendMessageToZalo(stockInfo.msg, "stock_alert");
                    if (r1.ok) sent.push("Đã gửi cảnh báo nguyên liệu / món sắp hết.");
                    else errors.push(r1.reason || "Không gửi được cảnh báo kho.");
                } else {
                    sent.push("Kho nguyên liệu & thực đơn đều đầy đủ (không có món hết).");
                }
            }

            if (cfg.autoDailySummary) {
                const rep = await generateDailyReportMessage(todayStr);
                const r2 = await sendMessageToZalo(rep.msg, "daily_report");
                if (r2.ok) {
                    await setDoc(doc(db, "config", "zalo"), {
                        lastDailySummaryDate: todayStr,
                        lastDailySummaryAt: Date.now()
                    }, { merge: true });
                    cachedZaloSettings = null;
                    sent.push(`Đã gửi báo cáo doanh thu ngày ${todayStr}.`);
                } else {
                    errors.push(r2.reason || "Không gửi được báo cáo doanh thu ngày.");
                }
            }

            return { summaryHour: cfg.summaryHour, nowHour, sent, errors };
        }

        case "placeOrder":
            return placeOrderDirect(payload);

        default:
            throw new Error("Tác vụ không xác định: " + name);
    }
}

if (typeof window !== "undefined") {
    window.medaReadyAdmin = readyAdmin;
    window.medaLogin = loginAdmin;
    window.medaLogout = logoutAdmin;
    window.medaChangePassword = changeAdminPassword;
    window.medaCallFn = callFn;
    window.medaGetOrderTimeMs = getOrderTimeMs;
    window.medaGetOrderDateKeyVN = getOrderDateKeyVN;
    window.medaEnsureOrderZaloNotified = ensureOrderZaloNotified;
}
