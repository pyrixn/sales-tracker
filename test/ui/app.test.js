// Drives the built static site (dist/index.html + dist/config.js) in Chromium at phone size. The page's
// Edge Function calls are answered by the real edge router over a seeded fake db (test/support/ui-host.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { buildSite } = require('../../tools/build.js');
const Adapter = require('../../src/adapters/postgres.js');
const { startUiHost } = require('../support/ui-host');

const DIST = path.join(__dirname, '..', '..', 'dist');
const PAGE = pathToFileURL(path.join(DIST, 'index.html')).href;
let browser;
const contexts = [];

test.before(async () => {
  buildSite({ outDir: DIST });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
});
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close().catch(() => {}))); });
test.after(async () => { if (browser) await browser.close(); });

async function open(opts) {
  const state = opts && opts.state;
  opts = Object.assign({}, opts); delete opts.state;
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 360, height: 740 } }, opts));
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const { tables } = await startUiHost(page, state ? { state } : undefined);
  const rows = tab => Array.from(tables[Adapter.SPEC[tab].table].values());
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  return { page, errors, ctx, rows };
}
test('Today shows what is owed', async () => {
  const { page, errors } = await open();
  await assert.doesNotReject(page.getByTestId('today-owed').filter({ hasText: '৳1,360' }).waitFor());
  assert.match(await page.locator('#screen').innerText(), /jamilhq/);
  assert.deepEqual(errors, []);
});

test('New sale for a new customer, saved once even when Save is double-clicked', async () => {
  const { page, errors, rows } = await open();
  const before = rows('Sales_Log').length;
  await page.getByRole('button', { name: 'New sale' }).click();
  await page.getByRole('button', { name: 'Netflix', exact: false }).first().click();
  const firstAccount = page.locator('[data-testid="account-chip"]').first();
  assert.match(await firstAccount.innerText(), /NFX-03/);
  assert.match(await firstAccount.getAttribute('aria-pressed'), /true/, 'emptiest account is preselected');
  await page.getByLabel('Customer').fill('Rahim Test');
  await page.getByText('Add new customer "Rahim Test"').click();
  await assert.doesNotReject(page.getByLabel('Contact via').waitFor());
  await page.getByLabel('Contact via').selectOption('WhatsApp');
  await page.getByLabel('Number or username').fill('01711111111');
  await page.getByLabel('Paid now').fill('290');
  assert.match(await page.getByTestId('paid-till').innerText(), /2026-11-18/);
  await page.getByRole('button', { name: 'Save sale' }).dblclick();
  await page.getByTestId('toast').filter({ hasText: 'Sale saved' }).waitFor();
  assert.equal(rows('Sales_Log').length, before + 1);
  await page.getByRole('button', { name: 'Customers' }).click();
  await page.getByLabel('Search customers').fill('rahim');
  await page.getByText('Rahim Test').first().click();
  await page.getByText('Netflix Premium profile').first().waitFor();
  assert.deepEqual(errors, []);
});

test('Got paid clears a due', async () => {
  const { page, errors } = await open();
  await page.getByRole('button', { name: 'Dues' }).click();
  await page.getByTestId('dues-list').getByText('Kabir').waitFor();
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Got paid' }).click();
  await page.getByLabel('Customer').fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await assert.doesNotReject(page.locator('#dueBox').getByText('owes ৳300').waitFor());
  assert.equal(await page.getByLabel('Amount').inputValue(), '300', 'prefilled with what they owe');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await page.getByTestId('toast').filter({ hasText: 'Payment saved' }).waitFor();
  await page.getByRole('button', { name: 'Dues' }).click();
  await page.getByTestId('dues-list').waitFor();
  assert.doesNotMatch(await page.getByTestId('dues-list').innerText(), /Kabir/);
  assert.deepEqual(errors, []);
});

test('Dues search filters and Paid opens the payment form already filled', async () => {
  const { page, errors } = await open();
  await page.getByRole('button', { name: 'Dues' }).click();
  await page.getByTestId('dues-list').waitFor();
  await page.getByLabel('Search').fill('tariq');
  // wait for the debounce (120ms) to redraw without Kabir
  await page.getByTestId('dues-list').getByText('tariq').waitFor();
  await assert.doesNotReject(page.getByTestId('dues-list').getByText('Kabir').waitFor({ state: 'detached', timeout: 2000 }));
  await page.getByTestId('due-pay').first().click();
  await page.getByRole('button', { name: 'Save payment' }).waitFor();
  assert.match(await page.locator('#cp').inputValue(), /tariq/i);
  assert.ok(Number(await page.getByLabel('Amount').inputValue()) > 0, 'amount prefilled from the due');
  assert.deepEqual(errors, []);
});

test('Undo from the toast reverses the last save', async () => {
  const { page, errors, rows } = await open();
  await page.getByRole('button', { name: 'Got paid' }).click();
  await page.getByLabel('Customer').fill('tariq');
  await page.getByRole('option', { name: /^tariq/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await page.getByTestId('toast').filter({ hasText: 'Payment saved' }).waitFor();
  const hasPayment = () => rows('Payments').filter(r => r.payment_id === 'PM-00091').length;
  assert.equal(hasPayment(), 1, 'the payment exists before undo');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByTestId('toast').filter({ hasText: 'Undone' }).waitFor();
  assert.equal(hasPayment(), 0, 'the payment is gone after undo');
  assert.deepEqual(errors, []);
});

test('Remind opens WhatsApp with the message', async () => {
  const { page } = await open();
  const link = page.getByTestId('remind-link').first();
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /^https:\/\/wa\.me\/8801711111111\?text=Hi%20jamilhq/);
});

test('Renew from a customer page continues from Paid till', async () => {
  const { page, errors } = await open();
  await page.getByRole('button', { name: 'Customers' }).click();
  await page.getByLabel('Search customers').fill('farid');
  await page.getByText('farid', { exact: true }).first().click();
  await page.getByTestId('line-N44').getByRole('button', { name: 'Renew' }).click();
  assert.match(await page.getByTestId('paid-till').innerText(), /2027-01-12/);
  await page.getByRole('button', { name: 'Save renewal' }).click();
  await page.getByTestId('toast').filter({ hasText: 'Renewed N44' }).waitFor();
  assert.deepEqual(errors, []);
});

test('Editing Months offers to move Paid till, and leaves it alone unless asked', async () => {
  const { page, errors } = await open();
  await page.getByRole('button', { name: 'Customers' }).click();
  await page.getByLabel('Search customers').fill('farid');
  await page.getByText('farid', { exact: true }).first().click();
  await page.getByTestId('line-N44').getByRole('button', { name: 'Edit' }).click();
  const months = page.locator('#sMonths'), till = page.locator('#sTill');
  const before = await till.inputValue();
  const oldMonths = Number(await months.inputValue());
  assert.match(before, /^\d{4}-\d{2}-\d{2}$/);
  await months.fill(String(oldMonths + 1));
  assert.equal(await till.inputValue(), before, 'unticked: Months does not move Paid till');
  await page.locator('#sMoveTill').check();
  const expected = await page.evaluate(a => Core.util.suggestPaidTill(a[0], a[1], a[2], 30), [before, oldMonths, oldMonths + 1]);
  assert.equal(await till.inputValue(), expected, 'ticked: Paid till follows Months');
  assert.deepEqual(errors, []);
});

test('Fits a 360px phone without sideways scrolling, in light and dark', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, ctx } = await open({ colorScheme: scheme });
    for (const tab of ['Today', 'Customers', 'Dues', 'Book', 'More']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForTimeout(250);
      const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
      assert.ok(w <= 360, tab + ' (' + scheme + ') scrollWidth ' + w);
    }
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('button', { name: 'New sale' }).click();
    const w2 = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w2 <= 360, 'New sale scrollWidth ' + w2);
    await ctx.close();
  }
});

test('Profit dashboard shows category profits', async () => {
  const { page } = await open();
  await page.getByRole('button', { name: 'Profit' }).click();
  await page.getByText(/By category/i).waitFor({ timeout: 10000 });
  const text = await page.locator('#screen').innerText();
  assert.match(text, /By category/i);
  assert.match(text, /Revenue/i);
  assert.match(text, /Cost/i);
  assert.match(text, /Net Profit/i);
  assert.match(text, /Margin/i);
});

test('Suppliers sheet opens from More tab', async () => {
  const { page } = await open();
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="suppliers"]').click();
  await page.getByText('Add supplier').waitFor({ timeout: 5000 });
  await page.getByText('Add supplier').click();
  await page.getByLabel('Supplier Name').waitFor({ timeout: 5000 });
  assert.ok(await page.getByLabel('Supplier Name').isVisible());
});

test('Bybit USDT Calculator opens and calculates BDT', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  st.liveRates = [{ ID: 'usdt_bdt', Rate: 128, Fetched_At: new Date().toISOString() }];
  const { page } = await open({ state: st });
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="calc"]').click();
  await page.getByText('USDT to BDT Calculator').waitFor({ timeout: 5000 });
  await page.locator('#calcUsdt').fill('10');
  const bdtVal = await page.locator('#calcBdt').inputValue();
  assert.equal(Number(bdtVal), 1280);
});

test('Supplier can be edited and deleted from the Suppliers sheet', async () => {
  const { page, errors, rows } = await open();
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="suppliers"]').click();
  await page.getByText('Add supplier').click();
  await page.locator('#sName').fill('UI Sup');
  await page.locator('#save').click();
  await page.locator('[data-more="suppliers"]').waitFor();
  await page.locator('[data-more="suppliers"]').click();
  await page.getByText('UI Sup').waitFor();
  await page.locator('[data-sup-edit]').last().click();
  await page.locator('#sName').fill('UI Sup Renamed');
  await page.locator('#sMarkup').fill('4');
  await page.locator('#save').click();
  await page.locator('[data-more="suppliers"]').click();
  await page.getByText('UI Sup Renamed').waitFor();
  assert.ok(rows('Suppliers').some(s => s.name === 'UI Sup Renamed' && Number(s.markup_percent) === 4));
  await page.locator('[data-sup-del]').last().click();
  await page.waitForFunction(() => !document.body.innerText.includes('UI Sup Renamed'));
  assert.ok(!rows('Suppliers').some(s => s.name === 'UI Sup Renamed'));
  assert.deepEqual(errors, []);
});

test('Gift-card batch can be created, renamed and deleted', async () => {
  const { page, errors, rows } = await open();
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="batches"]').click();
  await page.locator('#addBatchBtn').click();
  await page.locator('#bQty').fill('2');
  await page.locator('#bTag').fill('UI-B1');
  await page.locator('#save').click();
  await page.locator('[data-more="batches"]').click();
  await page.locator('[data-batch-edit="UI-B1"]').waitFor();
  assert.equal(rows('Code_Inventory').filter(c => c.batch_id === 'UI-B1').length, 2);
  await page.locator('[data-batch-edit="UI-B1"]').click();
  await page.locator('#bTag').fill('Renamed Batch');
  await page.locator('#save').click();
  await page.locator('[data-more="batches"]').click();
  await page.getByText('Renamed Batch').waitFor();
  await page.locator('[data-batch-del="UI-B1"]').click();
  await page.waitForFunction(() => !document.body.innerText.includes('Renamed Batch'));
  assert.equal(rows('Code_Inventory').filter(c => c.batch_id === 'UI-B1').length, 0);
  assert.deepEqual(errors, []);
});

test('Without a rate the panel says so; a manual rate in Settings shows as manual', async () => {
  const { page, errors } = await open();
  await page.getByRole('button', { name: 'Profit' }).click();
  await page.getByTestId('rate-line').waitFor();
  assert.match(await page.getByTestId('rate-line').innerText(), /No rate/);
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="settings"]').click();
  await page.locator('#tUsdt').fill('128.5');
  await page.locator('#save').click();
  await page.locator('#tUsdt').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Profit' }).click({ force: true });
  await page.waitForFunction(() => /128\.5 \/ USDT · manual/.test(document.querySelector('[data-testid="rate-line"]')?.innerText || ''));
  assert.doesNotMatch(await page.getByTestId('rate-line').innerText(), /stale/);
  assert.deepEqual(errors, []);
});

test('A stale bybit rate is labelled stale', async () => {
  const { makeUiState } = require('../support/seed');
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const st = makeUiState();
  st.liveRates = [{ ID: 'usdt_bdt', Rate: 127, Fetched_At: new Date(Date.now() - 3600 * 1000).toISOString() }];
  await startUiHost(page, { state: st });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await page.getByRole('button', { name: 'Profit' }).click();
  await page.getByTestId('rate-line').waitFor();
  assert.match(await page.getByTestId('rate-line').innerText(), /127 \/ USDT · Bybit · .*stale/);
});

test('Without the password the panel asks for it, rejects a wrong one, and loads with the right one', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await startUiHost(page);
  // Registered after the host, so it runs first: only the right password reaches the real handler.
  await page.route('**/functions/v1/api', route => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    if (req.headers()['x-app-secret'] === 'correct-horse') return route.fallback();
    return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) });
  });
  await page.goto(PAGE);
  await page.getByTestId('signin').waitFor();
  await page.locator('#appSecret').fill('wrong');
  await page.getByTestId('signin').click();
  await page.getByTestId('signin-error').waitFor();
  await page.locator('#appSecret').fill('correct-horse');
  await page.getByTestId('signin').click();
  await page.getByTestId('today-owed').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_secret')), 'correct-horse');
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('[data-more="signout"]').click();
  await page.getByTestId('signin').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_secret')), null);
  assert.deepEqual(errors, []);
});
