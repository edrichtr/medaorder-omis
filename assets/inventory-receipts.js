import { collection, doc, getDocs, onSnapshot, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-firestore.js";
import { db, readyAdmin, fmtDateTimeVN, fmtDateVN, textForHtml } from "./meda.js";

const DRAFT_KEY = "meda_inventory_receipt_draft_v1";
const money = value => Number(value || 0).toLocaleString("vi-VN") + " đ";

export function normalizeReceiptDraft(draft) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(draft.id || "")) throw new Error("Mã phiên nhập không hợp lệ.");
    const text = (value, max) => String(value || "").trim().slice(0, max);
    const result = {
        session: text(draft.session, 80), operator: text(draft.operator, 80),
        supplier: text(draft.supplier, 160), note: text(draft.note, 500)
    };
    if (!result.session || !result.operator) throw new Error("Nhập tên phiên/ca và người nhập.");
    if (!Array.isArray(draft.items) || !draft.items.length || draft.items.length > 100) throw new Error("Mỗi phiếu cần từ 1 đến 100 nguyên liệu.");
    const ids = new Set();
    result.items = draft.items.map(item => {
        if (!item.ingId || item.ingId.includes("/") || ids.has(item.ingId)) throw new Error("Chọn nguyên liệu; mỗi nguyên liệu chỉ xuất hiện một lần trong phiếu.");
        ids.add(item.ingId);
        const quantity = Number(item.quantity), cost = Number(item.cost);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.0001) {
            throw new Error("Số lượng nhập phải lớn hơn 0, tối đa 1 tỷ và tối đa 3 chữ số thập phân.");
        }
        if (item.cost === "" || item.cost == null || !Number.isSafeInteger(cost) || cost < 0 || cost > 1e12) throw new Error("Nhập thành tiền nguyên liệu bằng VNĐ (số nguyên từ 0 đến 1.000 tỷ).");
        return { ingId: item.ingId, quantity, cost, unit: text(item.unit, 30) };
    });
    return result;
}

export async function postInventoryReceipt(draft) {
    const { uid: createdByUid } = await readyAdmin();
    const input = normalizeReceiptDraft(draft);
    const requestKey = JSON.stringify(input);
    const receiptRef = doc(db, "inventoryReceipts", draft.id);
    const financeRef = doc(db, "config", "finance");
    const inventoryRefs = input.items.map(item => doc(db, "inventory", item.ingId));
    const createdAtMs = Date.now();
    return runTransaction(db, async tx => {
        const existing = await tx.get(receiptRef);
        if (existing.exists()) {
            if (existing.data().requestKey !== requestKey || existing.data().createdByUid !== createdByUid) {
                throw new Error("Phiếu này đã được chốt với nội dung khác. Kiểm tra lịch sử trước khi tạo phiên mới.");
            }
            return existing.data();
        }
        const snapshots = await Promise.all(inventoryRefs.map(ref => tx.get(ref)));
        const finance = await tx.get(financeRef);
        const items = input.items.map((item, index) => {
            if (!snapshots[index].exists()) throw new Error("Nguyên liệu đã bị xóa. Mở lại phiếu và chọn nguyên liệu khác.");
            const ing = snapshots[index].data();
            if (String(ing.unit || "") !== item.unit) throw new Error("Đơn vị nguyên liệu đã thay đổi. Chọn lại nguyên liệu để kiểm tra số lượng.");
            const quantityBefore = Number(ing.quantity);
            if (!Number.isFinite(quantityBefore) || quantityBefore < 0) throw new Error("Tồn kho hiện tại không hợp lệ: " + ing.name);
            const quantityAfter = quantityBefore + item.quantity;
            if (quantityAfter > 1e12) throw new Error("Tồn kho vượt giới hạn cho phép.");
            return { ...item, name: String(ing.name || ""), quantityBefore, quantityAfter };
        });
        const totalCost = items.reduce((sum, item) => sum + item.cost, 0);
        const previousCost = finance.exists() ? Number(finance.data().ingredientCosts || 0) : 0;
        if (!Number.isFinite(previousCost) || previousCost < 0 || !Number.isSafeInteger(previousCost + totalCost)) throw new Error("Chi phí nguyên liệu hiện tại không hợp lệ.");
        const receipt = {
            ...input, id: draft.id, code: "PN-" + fmtDateVN(new Date(createdAtMs)).split("/").reverse().join("") + "-" + draft.id.slice(0, 8).toUpperCase(),
            status: "posted", createdAt: serverTimestamp(), createdAtMs, dateKey: fmtDateVN(new Date(createdAtMs)),
            createdByUid, items, totalCost, requestKey
        };
        items.forEach((item, index) => tx.update(inventoryRefs[index], { quantity: item.quantityAfter }));
        tx.set(financeRef, { ingredientCosts: previousCost + totalCost }, { merge: true });
        tx.set(receiptRef, receipt);
        return receipt;
    });
}

export function filterInventoryReceipts(receipts, from = "", to = "") {
    return receipts.filter(receipt => {
        const date = String(receipt.dateKey || "").split("/").reverse().join("-");
        return (!from || date >= from) && (!to || date <= to);
    }).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function buildReceiptWorkbook(XLSX, receipts) {
    const summary = [["Mã phiếu", "Thời gian (Việt Nam)", "Phiên/ca nhập", "Người nhập", "Nhà cung cấp", "Số nguyên liệu", "Tổng tiền (VNĐ)", "Ghi chú"]];
    const details = [["Mã phiếu", "Thời gian (Việt Nam)", "Phiên/ca nhập", "Người nhập", "Nhà cung cấp", "Nguyên liệu", "Đơn vị", "Số lượng nhập", "Thành tiền (VNĐ)", "Tồn trước", "Tồn sau", "Ghi chú"]];
    receipts.forEach(receipt => {
        const common = [String(receipt.code || ""), fmtDateTimeVN(new Date(receipt.createdAtMs)), String(receipt.session || ""), String(receipt.operator || ""), String(receipt.supplier || "")];
        summary.push([...common, receipt.items.length, Number(receipt.totalCost), String(receipt.note || "")]);
        receipt.items.forEach(item => details.push([...common, String(item.name || ""), String(item.unit || ""), Number(item.quantity), Number(item.cost), Number(item.quantityBefore), Number(item.quantityAfter), String(receipt.note || "")]));
    });
    const workbook = XLSX.utils.book_new();
    // aoa_to_sheet keeps user-entered text as strings, including strings starting with '='.
    [["Phiếu nhập", summary, [28, 24, 25, 22, 28, 18, 22, 45]], ["Chi tiết", details, [28, 24, 25, 22, 28, 28, 12, 18, 22, 18, 18, 45]]].forEach(([name, rows, widths]) => {
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        sheet["!cols"] = widths.map(wch => ({ wch }));
        sheet["!autofilter"] = { ref: sheet["!ref"] };
        XLSX.utils.book_append_sheet(workbook, sheet, name);
    });
    return workbook;
}

export function initializeInventoryReceipts(getInventory) {
    const $ = id => document.getElementById(id);
    let draft = null, receipts = [], unsubscribe = null, saving = false;
    let returnFocus = null;
    const visibleDialog = () => [$("modalInventoryReceipt"), $("modalReceiptDetail")].find(modal => modal.style.display === "flex");
    document.addEventListener("keydown", event => {
        const modal = visibleDialog();
        if (!modal) return;
        if (event.key === "Escape") { event.preventDefault(); if (!saving) window.closeModals(); }
        if (event.key !== "Tab") return;
        const controls = Array.from(modal.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")).filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    const status = message => { $("receiptDraftStatus").textContent = message; };
    function persist() {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); status("Bản nháp được giữ trên trình duyệt này. Chỉ chốt phiếu mới cộng tồn kho."); return true; }
        catch (_) { status("Không lưu được bản nháp. Kiểm tra bộ nhớ trình duyệt trước khi chốt."); return false; }
    }
    function readFields() {
        ["session", "operator", "supplier", "note"].forEach(key => { draft[key] = $("receipt-" + key).value; });
    }
    function blankLine(ingId = "") {
        return { ingId, unit: getInventory().find(item => item.id === ingId)?.unit || "", quantity: "", cost: "" };
    }
    function updateTotal() {
        $("receiptTotal").textContent = money(draft.items.reduce((sum, item) => sum + (Number(item.cost) || 0), 0));
    }
    function renderLines() {
        $("receiptLines").replaceChildren();
        draft.items.forEach((line, index) => {
            const row = document.createElement("tr");
            row.innerHTML = '<td><select aria-label="Nguyên liệu"></select></td><td class="receipt-unit"></td><td><input aria-label="Số lượng nhập" type="number" min="0.001" max="1000000000" step="0.001" required></td><td><input aria-label="Thành tiền (VNĐ)" type="number" min="0" max="1000000000000" step="1" required></td><td><button type="button" class="btn btn-danger btn-small">Bỏ dòng</button></td>';
            const select = row.querySelector("select");
            const placeholder = document.createElement("option");
            placeholder.value = ""; placeholder.textContent = "Chọn nguyên liệu";
            select.append(placeholder);
            getInventory().forEach(ing => {
                const option = document.createElement("option");
                option.value = ing.id; option.textContent = ing.name + " (" + ing.unit + ")";
                select.append(option);
            });
            select.value = line.ingId;
            select.required = true;
            row.querySelector(".receipt-unit").textContent = line.unit;
            select.onchange = () => {
                line.ingId = select.value;
                line.unit = getInventory().find(item => item.id === select.value)?.unit || "";
                row.querySelector(".receipt-unit").textContent = line.unit;
                persist();
            };
            row.querySelectorAll("input").forEach((input, inputIndex) => {
                const key = inputIndex ? "cost" : "quantity";
                input.value = line[key];
                input.oninput = () => { line[key] = input.value; persist(); updateTotal(); };
            });
            row.querySelector("button").onclick = () => { draft.items.splice(index, 1); persist(); renderLines(); };
            $("receiptLines").append(row);
        });
        updateTotal();
    }
    window.openInventoryReceipt = function(ingId = "") {
        if (saving) return;
        returnFocus = document.activeElement;
        if (!draft) {
            try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (_) {}
            if (!draft || !Array.isArray(draft.items) || !draft.id) {
                draft = { id: doc(collection(db, "inventoryReceipts")).id, session: "Nhập " + fmtDateTimeVN(), operator: "", supplier: "", note: "", items: [blankLine(ingId)] };
            } else if (ingId && !draft.items.some(item => item.ingId === ingId)) {
                draft.items.push(blankLine(ingId));
            }
        }
        ["session", "operator", "supplier", "note"].forEach(key => { $("receipt-" + key).value = draft[key] || ""; });
        persist(); renderLines();
        $("modalInventoryReceipt").style.display = "flex";
        $("receipt-session").focus();
    };
    $("receiptForm").addEventListener("input", () => { if (draft && !saving) { readFields(); persist(); } });
    $("receiptAddLine").onclick = () => {
        if (draft.items.length >= 100) return alert("Mỗi phiếu tối đa 100 nguyên liệu.");
        draft.items.push(blankLine()); persist(); renderLines();
    };
    $("receiptDiscard").onclick = () => {
        if (saving || !confirm("Hủy toàn bộ bản nháp phiên nhập này? Kho chưa bị thay đổi.")) return;
        try { localStorage.removeItem(DRAFT_KEY); } catch (_) { return alert("Không xóa được bản nháp trên trình duyệt."); }
        draft = null; $("modalInventoryReceipt").style.display = "none";
        returnFocus?.focus();
    };
    $("receiptForm").onsubmit = async event => {
        event.preventDefault();
        if (saving) return;
        readFields();
        try {
            const checked = normalizeReceiptDraft(draft);
            if (!persist()) return;
            const total = checked.items.reduce((sum, item) => sum + item.cost, 0);
            if (!confirm(`Chốt phiên “${checked.session}” gồm ${checked.items.length} nguyên liệu, tổng ${money(total)}?\nPhiếu đã chốt không thể sửa hoặc xóa.`)) return;
            saving = true; $("receiptFields").disabled = true;
            status("Đang chốt phiếu… Vui lòng giữ trang mở.");
            const receipt = await postInventoryReceipt(draft);
            try { localStorage.removeItem(DRAFT_KEY); sessionStorage.removeItem("meda_menu_cache"); } catch (_) {}
            draft = null;
            $("modalInventoryReceipt").style.display = "none";
            returnFocus?.focus();
            alert("Đã chốt phiếu " + receipt.code + ". Tồn kho, chi phí và lịch sử đã được lưu.");
        } catch (err) { status(err.message); alert("Chưa chốt được phiếu: " + err.message + "\nBản nháp vẫn được giữ; có thể bấm chốt lại mà không cộng trùng."); }
        finally { saving = false; $("receiptFields").disabled = false; }
    };
    function selectedReceipts() {
        const from = $("receiptFrom").value, to = $("receiptTo").value;
        if (from && to && from > to) throw new Error("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.");
        return filterInventoryReceipts(receipts, from, to);
    }
    function viewReceipt(receipt) {
        returnFocus = document.activeElement;
        $("receiptDetailTitle").textContent = receipt.code;
        $("receiptDetailMeta").textContent = `${fmtDateTimeVN(new Date(receipt.createdAtMs))} · ${receipt.session} · Người nhập: ${receipt.operator}\nNhà cung cấp: ${receipt.supplier || "—"}\nGhi chú: ${receipt.note || "—"}`;
        $("receiptDetailLines").innerHTML = receipt.items.map(item => `<tr><td>${textForHtml(item.name)}</td><td>${textForHtml(item.unit)}</td><td>${Number(item.quantity)}</td><td>${money(item.cost)}</td><td>${Number(item.quantityBefore)}</td><td>${Number(item.quantityAfter)}</td></tr>`).join("");
        $("receiptDetailTotal").textContent = money(receipt.totalCost);
        $("modalReceiptDetail").style.display = "flex";
        $("modalReceiptDetail").querySelector("button").focus();
    }
    function renderHistory() {
        const tbody = $("receiptHistory");
        tbody.replaceChildren();
        try {
            const filtered = selectedReceipts();
            $("receiptHistoryStatus").textContent = `${filtered.length} phiếu · Tổng chi phí: ${money(filtered.reduce((sum, receipt) => sum + receipt.totalCost, 0))}`;
            filtered.forEach(receipt => {
                const row = document.createElement("tr");
                row.innerHTML = `<td>${textForHtml(receipt.code)}</td><td>${textForHtml(fmtDateTimeVN(new Date(receipt.createdAtMs)))}</td><td>${textForHtml(receipt.session)}</td><td>${textForHtml(receipt.operator)}</td><td>${money(receipt.totalCost)}</td><td><button type="button" class="btn btn-info btn-small">Xem phiếu</button></td>`;
                row.querySelector("button").onclick = () => viewReceipt(receipt);
                tbody.append(row);
            });
            if (!filtered.length) tbody.innerHTML = '<tr><td colspan="6">Chưa có phiếu nhập trong khoảng thời gian này.</td></tr>';
        } catch (err) { $("receiptHistoryStatus").textContent = err.message; }
    }
    $("receiptFrom").onchange = renderHistory;
    $("receiptTo").onchange = renderHistory;
    $("receiptExport").onclick = async () => {
        $("receiptExport").disabled = true;
        try {
            await readyAdmin();
            // Read again so exporting immediately after posting includes the committed receipt.
            const snapshot = await getDocs(collection(db, "inventoryReceipts"));
            receipts = snapshot.docs.map(row => row.data());
            const filtered = selectedReceipts();
            if (!filtered.length) throw new Error("Không có phiếu nhập để xuất.");
            const XLSX = await import("./vendor/xlsx.mjs");
            const workbook = buildReceiptWorkbook(XLSX, filtered);
            XLSX.writeFile(workbook, "lich-su-nhap-nguyen-lieu-" + fmtDateVN().replaceAll("/", "-") + ".xlsx");
            renderHistory();
        } catch (err) { alert("Không xuất được Excel: " + err.message); }
        finally { $("receiptExport").disabled = false; }
    };
    return {
        isSaving: () => saving,
        restoreFocus() { if (visibleDialog()) returnFocus?.focus(); },
        start() {
            if (unsubscribe) unsubscribe();
            $("receiptHistoryStatus").textContent = "Đang tải lịch sử…";
            unsubscribe = onSnapshot(collection(db, "inventoryReceipts"), snapshot => {
                receipts = snapshot.docs.map(row => row.data()); renderHistory();
            }, err => { $("receiptHistoryStatus").textContent = "Không tải được lịch sử: " + err.message; });
        },
        stop() { if (unsubscribe) unsubscribe(); unsubscribe = null; receipts = []; }
    };
}
