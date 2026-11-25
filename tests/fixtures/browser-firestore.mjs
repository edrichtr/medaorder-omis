export const store = new Map([
    ['inventory/tea', { id: 'tea', name: 'Trà lài', unit: 'g', quantity: 100 }],
    ['inventory/milk', { id: 'milk', name: 'Sữa tươi', unit: 'ml', quantity: 1000 }],
    ['config/finance', { totalRevenue: 500000, ingredientCosts: 20000, fixedCosts: 10000 }],
    ['config/zalo', { enableAuto: false, zaloCodeHash: 'test-only' }]
]);
const listeners = new Set(); let sequence = 0;
export const collection = (_db, path) => ({ path, collection: true });
export function doc(...args) { const path = args.length === 1 ? args[0].path + '/testReceipt' + (++sequence).toString().padStart(10, '0') : args.slice(1).join('/'); return { path, id: path.split('/').pop() }; }
function snapshot(ref) {
    if (ref.collection) {
        const docs = [...store.keys()].filter(key => key.startsWith(ref.path + '/')).map(path => snapshot({ path }));
        return { docs, empty: !docs.length, docChanges: () => docs.map(doc => ({ type: 'added', doc })) };
    }
    return { id: ref.path.split('/').pop(), exists: () => store.has(ref.path), data: () => structuredClone(store.get(ref.path)), get: key => store.get(ref.path)?.[key] };
}
const emit = () => listeners.forEach(({ ref, callback }) => callback(snapshot(ref)));
export const getDoc = async ref => snapshot(ref);
export const getDocs = async ref => snapshot(ref);
export function onSnapshot(ref, callback) { const listener = { ref, callback }; listeners.add(listener); queueMicrotask(() => callback(snapshot(ref))); return () => listeners.delete(listener); }
export const query = ref => ref;
export const serverTimestamp = () => ({ seconds: Math.floor(Date.now() / 1000) });
export async function setDoc(ref, data, options) { store.set(ref.path, options?.merge ? { ...store.get(ref.path), ...data } : data); emit(); }
export const updateDoc = (ref, data) => setDoc(ref, data, { merge: true });
export async function deleteDoc(ref) { store.delete(ref.path); emit(); }
export async function runTransaction(_db, fn) {
    const writes = [];
    const result = await fn({ get: getDoc, update: (ref, data) => writes.push([ref, data, true]), set: (ref, data, options) => writes.push([ref, data, !!options?.merge]) });
    writes.forEach(([ref, data, merge]) => store.set(ref.path, merge ? { ...store.get(ref.path), ...data } : data)); emit(); return result;
}
window.__testStore = store;
