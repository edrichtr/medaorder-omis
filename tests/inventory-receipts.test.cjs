const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function setup() {
    const records = new Map([
        ['inventory/tea', { name: 'Trà lài', unit: 'g', quantity: 50.1234 }],
        ['inventory/milk', { name: 'Sữa tươi', unit: 'ml', quantity: 1000 }],
        ['config/finance', { ingredientCosts: 100, totalRevenue: 900, fixedCosts: 70 }]
    ]);
    const versions = new Map();
    const state = { failBeforeCommit: false, failAfterCommit: false, beforeCommit: null, authError: null };
    const sandbox = {
        db: {}, readyAdmin: async () => { if (state.authError) throw state.authError; return { uid: 'test-admin', admin: true }; },
        doc: (_db, collection, id) => `${collection}/${id}`,
        serverTimestamp: () => ({ seconds: 1795392000 }),
        fmtDateVN: () => '23/11/2026', fmtDateTimeVN: () => '08:00:00 23/11/2026',
        runTransaction: async (_db, fn) => {
            for (let attempt = 0; attempt < 5; attempt++) {
                const reads = new Map(), writes = [];
                const tx = {
                    get: async ref => {
                        assert.equal(writes.length, 0, 'all reads must precede writes');
                        reads.set(ref, versions.get(ref) || 0);
                        const value = structuredClone(records.get(ref));
                        return { exists: () => value !== undefined, data: () => value };
                    },
                    update: (ref, data) => writes.push({ ref, data, merge: true }),
                    set: (ref, data, options) => writes.push({ ref, data, merge: options?.merge })
                };
                const result = await fn(tx);
                if (state.beforeCommit) { const hook = state.beforeCommit; state.beforeCommit = null; hook(records, versions); }
                if ([...reads].some(([ref, version]) => version !== (versions.get(ref) || 0))) continue;
                if (state.failBeforeCommit) throw new Error('offline');
                writes.forEach(({ ref, data, merge }) => {
                    records.set(ref, structuredClone(merge ? { ...records.get(ref), ...data } : data));
                    versions.set(ref, (versions.get(ref) || 0) + 1);
                });
                if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error('response lost'); }
                return result;
            }
            throw new Error('transaction conflict');
        }
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, '../assets/inventory-receipts.js'), 'utf8').replace(/^import .+;\r?$/gm, '').replace(/^export /gm, '');
    vm.runInContext(source + '\nglobalThis.api = { normalizeReceiptDraft, postInventoryReceipt, filterInventoryReceipts, buildReceiptWorkbook };', sandbox);
    return { ...sandbox.api, records, state };
}

function draft(id = 'test_receipt_001') {
    return { id, session: 'Ca sáng', operator: 'Lan', supplier: 'Nhà cung cấp A', note: '=1+2', items: [
        { ingId: 'tea', unit: 'g', quantity: '100.5', cost: '15000' },
        { ingId: 'milk', unit: 'ml', quantity: '2000', cost: '60000' }
    ] };
}

test('posts all lines, costs and immutable historical snapshots together; same ID only once', async () => {
    const api = setup();
    await api.postInventoryReceipt(draft());
    assert.equal(api.records.get('inventory/tea').quantity, 150.6234);
    assert.equal(api.records.get('inventory/milk').quantity, 3000);
    assert.equal(api.records.get('config/finance').ingredientCosts, 75100);
    assert.equal(api.records.get('config/finance').totalRevenue, 900);
    assert.equal(api.records.get('config/finance').fixedCosts, 70);
    const receipt = api.records.get('inventoryReceipts/test_receipt_001');
    assert.equal(receipt.items[0].quantityBefore, 50.1234);
    assert.equal(receipt.totalCost, 75000);
    await api.postInventoryReceipt(draft());
    assert.equal(api.records.get('inventory/milk').quantity, 3000);
    api.records.get('inventory/tea').name = 'Tên mới';
    assert.equal(receipt.items[0].name, 'Trà lài');
    const changed = draft(); changed.items[0].quantity = 900;
    await assert.rejects(api.postInventoryReceipt(changed), /đã được chốt/);
});

test('rejects invalid, duplicate, missing or changed-unit lines with no partial writes', async () => {
    for (const mutate of [
        d => { d.items[0].quantity = -1; }, d => { d.items[0].quantity = 'NaN'; },
        d => { d.items[0].quantity = 0.0001; }, d => { d.items[0].cost = ''; },
        d => { d.items[0].cost = -1; }, d => { d.items[0].cost = 1.5; },
        d => { d.items.push({ ...d.items[0] }); }, d => { d.items[1].ingId = 'missing'; },
        d => { d.items[1].unit = 'litre'; }, d => { d.operator = ''; }, d => { d.items = []; }
    ]) {
        const api = setup(), input = draft(), before = JSON.stringify([...api.records]);
        mutate(input);
        await assert.rejects(api.postInventoryReceipt(input));
        assert.equal(JSON.stringify([...api.records]), before);
    }
});

test('offline commit leaves all data untouched; lost success response retries without double addition', async () => {
    const api = setup(), before = JSON.stringify([...api.records]);
    api.state.failBeforeCommit = true;
    await assert.rejects(api.postInventoryReceipt(draft()), /offline/);
    assert.equal(JSON.stringify([...api.records]), before);
    api.state.failBeforeCommit = false; api.state.failAfterCommit = true;
    await assert.rejects(api.postInventoryReceipt(draft()), /response lost/);
    await api.postInventoryReceipt(draft());
    assert.equal(api.records.get('config/finance').ingredientCosts, 75100);
});

test('failed authentication keeps the draft and all stock/finance data; retry uses the real authenticated UID', async () => {
    const api = setup(), input = draft(), originalDraft = JSON.stringify(input), before = JSON.stringify([...api.records]);
    api.state.authError = Object.assign(new Error('Anonymous authentication is not enabled'), { code: 'auth/operation-not-allowed' });
    await assert.rejects(api.postInventoryReceipt(input), { code: 'auth/operation-not-allowed' });
    assert.equal(JSON.stringify(input), originalDraft);
    assert.equal(JSON.stringify([...api.records]), before);
    api.state.authError = null;
    const saved = await api.postInventoryReceipt(input);
    assert.equal(saved.createdByUid, 'test-admin');
    assert.equal(api.records.get('inventory/milk').quantity, 3000);
});

test('concurrent receipt and order stock changes retry against current quantities and finances', async () => {
    const api = setup();
    api.state.beforeCommit = (records, versions) => {
        records.get('inventory/milk').quantity -= 200;
        records.get('config/finance').totalRevenue += 50;
        versions.set('inventory/milk', 1); versions.set('config/finance', 1);
    };
    await api.postInventoryReceipt(draft());
    assert.equal(api.records.get('inventory/milk').quantity, 2800);
    assert.equal(api.records.get('config/finance').totalRevenue, 950);
    const concurrent = setup();
    await Promise.all([concurrent.postInventoryReceipt(draft('session_a')), concurrent.postInventoryReceipt(draft('session_b'))]);
    assert.equal(concurrent.records.get('inventory/milk').quantity, 5000);
    assert.equal(concurrent.records.get('config/finance').ingredientCosts, 150100);
});

test('date filter includes both boundary dates and Excel round-trip preserves Vietnamese, numbers and literal formula-like text', async () => {
    const api = setup();
    const receipt = await api.postInventoryReceipt(draft());
    const list = [receipt, { ...receipt, dateKey: '22/11/2026', createdAtMs: receipt.createdAtMs - 86400000 }];
    assert.equal(api.filterInventoryReceipts(list, '2026-11-23', '2026-11-23').length, 1);
    assert.equal(api.filterInventoryReceipts(list, '2026-11-22', '2026-11-23').length, 2);
    const XLSX = await import(pathToFileURL(path.join(__dirname, '../assets/vendor/xlsx.mjs')).href);
    const wb = api.buildReceiptWorkbook(XLSX, [receipt]);
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    const restored = XLSX.read(bytes, { type: 'buffer' });
    assert.deepEqual(restored.SheetNames, ['Phiếu nhập', 'Chi tiết']);
    assert.equal(restored.Sheets['Phiếu nhập'].G2.v, 75000);
    assert.equal(restored.Sheets['Phiếu nhập'].H2.v, '=1+2');
    assert.equal(restored.Sheets['Phiếu nhập'].H2.f, undefined);
    assert.equal(restored.Sheets['Chi tiết'].F2.v, 'Trà lài');
    assert.equal(restored.Sheets['Chi tiết'].H2.t, 'n');
    assert.equal(restored.Sheets['Chi tiết'].H2.v, 100.5);
    const unsafe = api.buildReceiptWorkbook(XLSX, [{ ...receipt, code: { f: '1+2' }, note: { f: '1+2' } }]);
    assert.equal(unsafe.Sheets['Phiếu nhập'].A2.t, 's');
    assert.equal(unsafe.Sheets['Phiếu nhập'].A2.f, undefined);
    assert.equal(unsafe.Sheets['Phiếu nhập'].H2.f, undefined);
});
