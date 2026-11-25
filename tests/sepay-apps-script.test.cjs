const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function encode(value) {
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
    if (value && typeof value === 'object') return { mapValue: { fields: fields(value) } };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    return { stringValue: value };
}
const fields = data => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)]));
function setup(overrides = {}) {
    const records = new Map(); let version = 0, locked = false;
    const state = { botCalls: 0, botResponse: { status: 200, body: { ok: true, result: { message_id: 123 } } }, failCommit: false, failGet: '', beforeCommit: null, now: 1795392000000, triggers: [] };
    const put = (key, value) => records.set(key, { name: key, fields: fields(value), updateTime: String(++version) });
    put('orders/DH12345', { total: 100, received: 0, payment_status: 'PENDING', stockHold: true, customerName: 'Lan', items: [{ name: 'Trà lài', quantity: 2 }], ...overrides });
    put('config/finance', { totalRevenue: 900, ingredientCosts: 500 });
    put('config/queue', { dateKey: '23/11/2026', count: 2 });
    put('config/zalo', { mode: 'zalo_bot', botChatId: 'test-chat', enableAuto: true, notifyOrderDaily: true });
    put('config/zaloToken', { botToken: 'test-token' });
    const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body) });
    const sandbox = {
        console, Date: class extends Date { static now() { return state.now; } },
        ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SEPAY_API_KEY' ? 'test-secret' : '' }) },
        Utilities: { formatDate: (_date, _tz, format) => format === 'dd/MM/yyyy' ? '23/11/2026' : '08:00:00 23/11/2026', sleep() {} },
        LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; }, tryLock() { if (locked) return false; locked = true; return true; }, hasLock: () => locked, releaseLock() { locked = false; } }) },
        ScriptApp: {
            getProjectTriggers: () => state.triggers.map(name => ({ getHandlerFunction: () => name })),
            newTrigger(name) { return { timeBased() { return this; }, everyMinutes(minutes) { assert.equal(minutes, 5); return this; }, create() { state.triggers.push(name); } }; }
        },
        UrlFetchApp: { fetch(url, options = {}) {
            if (!url.startsWith('https://firestore.googleapis.com/')) {
                state.botCalls++; state.lastBotPayload = JSON.parse(options.payload); state.lastBotUrl = url;
                if (state.botResponse.throw) throw new Error(url + ' network failure');
                return response(state.botResponse.status, state.botResponse.body);
            }
            const suffix = url.split('/documents')[1];
            if (suffix === ':commit') {
                if (state.failCommit) return response(503, {});
                const writes = JSON.parse(options.payload).writes;
                if (state.beforeCommit) { const fn = state.beforeCommit; state.beforeCommit = null; fn(put); }
                for (const write of writes) {
                    if (!write.update || !write.currentDocument) continue;
                    const key = write.update.name.split('/documents/')[1], current = records.get(key);
                    if (write.currentDocument.exists === false && current) return response(409, {});
                    if (write.currentDocument.updateTime && write.currentDocument.updateTime !== current?.updateTime) return response(409, {});
                }
                for (const write of writes) {
                    if (write.delete) { records.delete(write.delete.split('/documents/')[1]); continue; }
                    const key = write.update.name.split('/documents/')[1];
                    records.set(key, { name: key, fields: { ...records.get(key)?.fields, ...write.update.fields }, updateTime: String(++version) });
                }
                return response(200, {});
            }
            if (suffix === ':runQuery') {
                const query = JSON.parse(options.payload).structuredQuery;
                assert.equal(query.from[0].collectionId, 'zaloOutbox');
                return response(200, [...records].filter(([key, value]) => key.startsWith('zaloOutbox/') && Number(value.fields.nextAttemptAt.integerValue) <= state.now).slice(0, 20).map(([, document]) => ({ document })));
            }
            const key = suffix.slice(1);
            if (state.failGet === key) return response(503, {});
            return records.has(key) ? response(200, records.get(key)) : response(404, {});
        } }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../sepay-webhook-apps-script.gs'), 'utf8'), sandbox);
    const value = (key, field) => { const f = records.get(key)?.fields[field]; return f?.booleanValue ?? f?.stringValue ?? (f?.integerValue !== undefined ? Number(f.integerValue) : f?.doubleValue); };
    const post = (data = {}, secret = 'test-secret') => JSON.parse(sandbox.doPost({ parameter: { secret }, postData: { contents: JSON.stringify({ id: 'tx1', code: 'DH12345', transferType: 'in', transferAmount: 100, ...data }) } }).text);
    return { sandbox, records, state, put, value, post };
}

test('paid webhook sends directly without browser, commits revenue/queue once and honors botToken field', () => {
    const api = setup();
    assert.equal(api.post().success, true);
    assert.equal(api.value('orders/DH12345', 'payment_status'), 'PAID');
    assert.equal(api.value('orders/DH12345', 'received'), 100);
    assert.equal(api.value('orders/DH12345', 'queueNumber'), 3);
    assert.equal(api.value('orders/DH12345', 'zaloNotificationOwner'), 'apps_script');
    assert.equal(api.value('orders/DH12345', 'zaloNotified'), true);
    assert.equal(api.value('config/finance', 'totalRevenue'), 1000);
    assert.equal(api.value('config/finance', 'ingredientCosts'), 500);
    assert.equal(api.state.lastBotPayload.chat_id, 'test-chat');
    assert.match(api.state.lastBotPayload.text, /Trà lài x2/);
    assert.equal(api.records.has('zaloOutbox/DH12345'), false);
    assert.equal(api.post().duplicate, true);
    assert.equal(api.value('orders/DH12345', 'received'), 100);
    assert.equal(api.value('config/queue', 'count'), 3);
    assert.equal(api.state.botCalls, 1);
});

test('partial payments only send on completion; expired, overpaid and unauthorized events do not send', () => {
    const api = setup();
    api.post({ transferAmount: 40 });
    assert.equal(api.value('orders/DH12345', 'payment_status'), 'PARTIAL');
    assert.equal(api.state.botCalls, 0);
    api.post({ id: 'tx2', transferAmount: 60 });
    assert.equal(api.state.botCalls, 1);
    for (const [overrides, payload, secret] of [
        [{ expired: true }, {}, 'test-secret'], [{}, { transferAmount: 101 }, 'test-secret'],
        [{}, {}, 'bad-secret'], [{}, { transferType: 'out' }, 'test-secret'],
        [{}, { transferAmount: 'invalid' }, 'test-secret'], [{}, { id: 'tx/1' }, 'test-secret']
    ]) {
        const fixture = setup(overrides); fixture.post(payload, secret); assert.equal(fixture.state.botCalls, 0);
    }
});

test('HTTP/API errors and opaque responses remain pending; timer retries and confirms success', () => {
    for (const botResponse of [
        { status: 500, body: {} }, { status: 200, body: { error_code: -201 } },
        { status: 200, body: { ok: false } }, { status: 200, body: {} },
        { status: 200, body: '<html>Error</html>' }, { throw: true }
    ]) {
        const api = setup(); api.state.botResponse = botResponse;
        assert.equal(api.post().success, true);
        assert.equal(api.value('orders/DH12345', 'zaloNotified'), false);
        assert.equal(api.value('zaloOutbox/DH12345', 'attempts'), 1);
        assert.doesNotMatch(api.value('orders/DH12345', 'zaloLastError'), /test-token/);
        api.sandbox.retryPendingZaloNotifications(); assert.equal(api.state.botCalls, 1);
        api.state.now += 300001; api.state.botResponse = { status: 200, body: { error_code: 0 } };
        api.sandbox.retryPendingZaloNotifications();
        assert.equal(api.state.botCalls, 2);
        assert.equal(api.value('orders/DH12345', 'zaloNotified'), true);
        assert.equal(api.value('config/finance', 'totalRevenue'), 1000);
    }
});

test('duplicate payment retries a failed notification without applying payment again; legacy token field works', () => {
    const api = setup(); api.put('config/zaloToken', { token: 'legacy-token' });
    api.state.botResponse = { status: 401, body: {} }; api.post();
    api.state.botResponse = { status: 200, body: { ok: true } };
    assert.equal(api.post().duplicate, true);
    assert.match(api.state.lastBotUrl, /botlegacy-token\/sendMessage$/);
    assert.equal(api.value('orders/DH12345', 'zaloNotified'), true);
    assert.equal(api.value('orders/DH12345', 'received'), 100);
});

test('Firestore outages cause no partial commit or false delivery; optimistic conflict preserves concurrent revenue', () => {
    for (const failure of ['commit', 'read']) {
        const api = setup();
        if (failure === 'commit') api.state.failCommit = true;
        else api.state.failGet = 'orders/DH12345';
        assert.equal(api.post().success, false);
        assert.equal(api.value('orders/DH12345', 'payment_status'), 'PENDING');
        assert.equal(api.value('config/finance', 'totalRevenue'), 900);
        assert.equal(api.records.has('sepayTransactions/tx1'), false);
        assert.equal(api.state.botCalls, 0);
    }
    const concurrent = setup();
    concurrent.state.beforeCommit = put => put('config/finance', { totalRevenue: 950, ingredientCosts: 600 });
    assert.equal(concurrent.post().success, true);
    assert.equal(concurrent.value('config/finance', 'totalRevenue'), 1050);
    assert.equal(concurrent.value('config/finance', 'ingredientCosts'), 600);
});

test('disabled auto keeps pending work and retry-trigger setup is idempotent', () => {
    const api = setup();
    api.put('config/zalo', { enableAuto: false });
    api.post();
    assert.equal(api.state.botCalls, 0);
    assert.equal(api.records.has('zaloOutbox/DH12345'), true);
    api.sandbox.setupZaloRetryTrigger(); api.sandbox.setupZaloRetryTrigger();
    assert.deepEqual(api.state.triggers, ['retryPendingZaloNotifications']);
});
