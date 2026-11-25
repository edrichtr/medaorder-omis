// Run with Firebase Emulator; optional test tools are installed under .task-tools.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireTools = createRequire(path.join(__dirname, '../.task-tools/package.json'));
const { initializeTestEnvironment, assertFails, assertSucceeds } = requireTools('@firebase/rules-unit-testing');
const firestore = requireTools('firebase/firestore');

(async () => {
    const env = await initializeTestEnvironment({ projectId: 'demo-meda-test', firestore: { host: '127.0.0.1', port: 8185, rules: fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8') } });
    try {
        await env.clearFirestore();
        const db = env.authenticatedContext('test-admin').firestore();
        await firestore.setDoc(firestore.doc(db, 'inventory/tea'), { name: 'Trà', unit: 'g', quantity: 5 });
        await firestore.setDoc(firestore.doc(db, 'config/finance'), { totalRevenue: 900, ingredientCosts: 0 });
        const bindings = { doc: firestore.doc, runTransaction: firestore.runTransaction, serverTimestamp: firestore.serverTimestamp, db, readyAdmin: async () => ({ uid: 'test-admin', admin: true }), fmtDateVN: () => '23/11/2026' };
        const source = fs.readFileSync(path.join(__dirname, '../assets/inventory-receipts.js'), 'utf8').replace(/^import .+;\r?$/gm, '').replace(/^export /gm, '');
        const post = new Function(...Object.keys(bindings), source + '\nreturn postInventoryReceipt;')(...Object.values(bindings));
        const draft = { id: 'rules_receipt', session: 'Ca sáng', operator: 'Lan', items: [{ ingId: 'tea', unit: 'g', quantity: 10, cost: 5000 }] };
        await assertSucceeds(post(draft));
        await assertSucceeds(post(draft));
        const ref = firestore.doc(db, 'inventoryReceipts/rules_receipt');
        const saved = await firestore.getDoc(ref);
        assert.equal(saved.data().totalCost, 5000);
        assert.equal((await firestore.getDoc(firestore.doc(db, 'inventory/tea'))).data().quantity, 15);
        assert.equal((await firestore.getDoc(firestore.doc(db, 'config/finance'))).data().ingredientCosts, 5000);
        await assertFails(firestore.updateDoc(ref, { totalCost: 0 }));
        await assertFails(firestore.setDoc(ref, { ...saved.data(), operator: 'Changed' }));
        await assertFails(firestore.deleteDoc(ref));
        await assertFails(firestore.getDoc(firestore.doc(env.unauthenticatedContext().firestore(), 'inventoryReceipts/rules_receipt')));
        await assertFails(firestore.setDoc(firestore.doc(db, 'inventoryReceipts/forged'), { ...saved.data(), id: 'forged', createdByUid: 'someone-else', createdAt: firestore.serverTimestamp() }));
        await assertFails(firestore.setDoc(firestore.doc(db, 'inventoryReceipts/empty'), { ...saved.data(), id: 'empty', items: [], createdAt: firestore.serverTimestamp() }));
        console.log('PASS: real Firestore transactions, idempotency, receipt creation/read, immutable update/delete, unauthenticated read and invalid creation.');
    } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
