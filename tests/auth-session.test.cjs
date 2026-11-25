const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function setup(errorCode = '', initialRole = 'admin') {
    const auth = { currentUser: null };
    const state = { errorCode, signInCalls: 0, reads: 0, writes: 0 };
    const storage = new Map([['meda_session_role', initialRole], ['meda_inventory_receipt_draft_v1', 'saved-draft']]);
    const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    const bindings = {
        auth, SESSION_ROLE_KEY: 'meda_session_role', DEFAULT_ADMIN_PASS: 'test-password',
        sessionStorage: localStorage, localStorage, db: {}, location: { replace() {} },
        onAuthStateChanged: (_auth, callback) => { queueMicrotask(callback); return () => {}; },
        signInAnonymously: async () => {
            state.signInCalls++;
            if (state.errorCode) throw Object.assign(new Error(state.errorCode), { code: state.errorCode });
            auth.currentUser = { uid: 'firebase-real-uid', isAnonymous: true };
            return { user: auth.currentUser };
        },
        signOut: async () => { auth.currentUser = null; },
        sha256Pass: async () => 'test-hash', doc: () => 'config/admin',
        getDoc: async () => { state.reads++; return { exists: () => true, data: () => ({ passHash: 'test-hash' }) }; },
        setDoc: async () => { state.writes++; }
    };
    const source = fs.readFileSync(path.join(__dirname, '../assets/meda.js'), 'utf8');
    const authCode = source.slice(source.indexOf('const authLoaded ='), source.indexOf('export async function loginStaff')).replace(/^export /gm, '');
    const api = new Function(...Object.keys(bindings), authCode + '\nreturn { ready, readyAdmin, loginAdmin };')(...Object.values(bindings));
    return { ...api, auth, state, storage };
}

test('Firebase auth failures never produce a fake UID or grant an admin session', async () => {
    for (const code of ['auth/configuration-not-found', 'auth/operation-not-allowed', 'auth/network-request-failed']) {
        const api = setup(code);
        await assert.rejects(api.ready(), { code });
        assert.equal(api.auth.currentUser, null);
        await assert.rejects(api.loginAdmin('test-password'), { code });
        assert.equal(api.storage.has('meda_session_role'), false);
        assert.equal(api.storage.get('meda_inventory_receipt_draft_v1'), 'saved-draft');
        assert.equal(api.state.reads, 0);
        assert.equal(api.state.writes, 0);
    }
});

test('authentication can recover after configuration/network repair and concurrent calls share one request', async () => {
    const api = setup('auth/configuration-not-found');
    await assert.rejects(api.ready(), /Authentication chưa được khởi tạo/);
    api.state.errorCode = '';
    const users = await Promise.all([api.ready(), api.ready(), api.ready()]);
    assert.equal(api.state.signInCalls, 2);
    assert.ok(users.every(user => user.uid === 'firebase-real-uid'));
    assert.deepEqual(await api.readyAdmin(), { uid: 'firebase-real-uid', admin: true });
    assert.equal(api.state.signInCalls, 2);
});

test('admin guard checks the local role and returns the real Firebase UID after a valid login', async () => {
    const api = setup('', '');
    await assert.rejects(api.readyAdmin(), /đăng nhập quản trị/);
    assert.equal(api.state.signInCalls, 0);
    await api.loginAdmin('test-password');
    assert.deepEqual(await api.readyAdmin(), { uid: 'firebase-real-uid', admin: true });
    assert.equal(api.storage.get('meda_session_role'), 'admin');
    assert.equal(api.storage.get('meda_inventory_receipt_draft_v1'), 'saved-draft');
});
