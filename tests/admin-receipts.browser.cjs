// Uses only local fixtures. Every external network request is intercepted/blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const requireTools = createRequire(path.join(__dirname, '../.task-tools/package.json'));
const { chromium } = requireTools('playwright');
const root = path.resolve(__dirname, '..');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

(async () => {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const target = path.resolve(root, '.' + pathname);
        if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        if (pathname === '/assets/meda.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fixture('browser-meda.mjs')); return; }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404).end(); return; }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
        res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }); fs.createReadStream(target).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
        const errors = [], dialogs = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        await page.route('**/*', async route => {
            const url = route.request().url();
            if (url.startsWith('https://www.gstatic.com/firebasejs/')) return route.fulfill({ contentType: 'text/javascript', body: fixture('browser-firestore.mjs') });
            if (url.startsWith('http://127.0.0.1:')) return route.continue();
            await route.abort();
        });
        const url = `http://127.0.0.1:${server.address().port}/admin.html#inventory`;
        async function login() {
            await page.fill('#adminPass', 'fixture-only'); await page.click('#adminLoginButton');
            await page.waitForFunction(() => document.querySelector('#inventoryTable').textContent.includes('Trà lài'));
        }
        await page.goto(url); await login();
        assert.equal(await page.locator('#ingQuantity').count(), 0);
        assert.equal(await page.locator('#finIng').getAttribute('readonly'), '');
        await page.getByRole('button', { name: '+ Lập phiếu nhập', exact: true }).click();
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.activeElement.type), 'submit');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'receipt-session');
        await page.fill('#receipt-session', 'Ca sáng kiểm thử'); await page.fill('#receipt-operator', 'Lan');
        await page.fill('#receipt-supplier', 'Nhà cung cấp mẫu'); await page.fill('#receipt-note', '=1+2');
        await page.locator('#receiptLines select').selectOption('tea');
        await page.locator('#receiptLines input').nth(0).fill('250.5');
        await page.locator('#receiptLines input').nth(1).fill('50000');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('meda_inventory_receipt_draft_v1')).operator), 'Lan', JSON.stringify(errors));
        await page.getByRole('button', { name: 'Đóng / giữ nháp' }).click();
        await page.reload(); await login();
        await page.getByRole('button', { name: '+ Lập phiếu nhập', exact: true }).click();
        assert.equal(await page.inputValue('#receipt-operator'), 'Lan');
        assert.equal(await page.locator('#receiptLines input').nth(0).inputValue(), '250.5');
        await page.click('#receiptAddLine');
        await page.locator('#receiptLines select').nth(1).selectOption('milk');
        await page.locator('#receiptLines input').nth(2).fill('1000');
        await page.locator('#receiptLines input').nth(3).fill('35000');
        await page.screenshot({ path: path.join(root, '.task-backup/receipt-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(root, '.task-backup/receipt-mobile.png') });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile document must not overflow horizontally');
        await page.getByRole('button', { name: 'Chốt phiếu nhập', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#receiptHistory').textContent.includes('Ca sáng kiểm thử'));
        assert.equal(await page.evaluate(() => window.__testStore.get('inventory/tea').quantity), 350.5);
        assert.equal(await page.evaluate(() => window.__testStore.get('inventory/milk').quantity), 2000);
        assert.equal(await page.evaluate(() => window.__testStore.get('config/finance').ingredientCosts), 105000);
        assert.equal(await page.evaluate(() => localStorage.getItem('meda_inventory_receipt_draft_v1')), null);
        await page.getByRole('button', { name: 'Xem phiếu', exact: true }).click();
        assert.match(await page.textContent('#receiptDetailLines'), /Trà lài/);
        await page.locator('#modalReceiptDetail').getByRole('button', { name: 'Đóng', exact: true }).click();
        const downloadPromise = page.waitForEvent('download');
        await page.click('#receiptExport');
        const download = await downloadPromise;
        assert.match(download.suggestedFilename(), /\.xlsx$/);
        await download.saveAs(path.join(root, '.task-backup/receipt-browser-test.xlsx'));
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.screenshot({ path: path.join(root, '.task-backup/receipt-history.png') });
        assert.deepEqual(errors, []);
        assert.equal(dialogs.some(message => message.includes('Lỗi khi tải') || message.includes('Không xuất') || message.includes('Chưa chốt')), false);
        console.log('PASS: admin login, no direct quantity edit, draft reload, two-line posting, history, mobile overflow, details and actual XLSX download; no browser exceptions.');
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
