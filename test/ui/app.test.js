// Drives the built React panel (dist/, served by test/support/static-server.js) in Chromium at phone size.
// The page's Edge Function calls are answered by the real edge router over a seeded fake db
// (test/support/ui-host.js), so nothing reaches Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');
const { buildSite } = require('../../tools/build.js');
const Adapter = require('../../src/adapters/postgres.js');
const { startUiHost } = require('../support/ui-host');
const { serveDir } = require('../support/static-server');
const { makeUiState } = require('../support/seed');

const DIST = path.join(__dirname, '..', '..', 'dist');
let browser;
let server;
let PAGE;
const contexts = [];

test.before(async () => {
  buildSite({ outDir: DIST });
  server = await serveDir(DIST);
  PAGE = server.url;
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
});
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close().catch(() => {}))); });
test.after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function open(opts) {
  const state = opts && opts.state;
  opts = Object.assign({}, opts); delete opts.state;
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 360, height: 740 } }, opts));
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const { tables, api } = await startUiHost(page, state ? { state } : undefined);
  const rows = tab => Array.from(tables[Adapter.SPEC[tab].table].values());
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  return { page, errors, ctx, rows, tables, api };
}

// Quick actions live in the header menu on a phone and in the sidebar on a wide screen.
async function quick(page, name) {
  const menu = page.getByRole('button', { name: 'Quick actions' });
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole('menuitem', { name }).click();
  } else {
    await page.getByRole('button', { name }).click();
  }
}
const nav = (page, name) => page.getByRole('button', { name, exact: true }).click();
const toastOf = (page, text) => page.locator('[data-sonner-toast]').filter({ hasText: text });

test('Today shows what is owed', async () => {
  const { page, errors } = await open();
  await assert.doesNotReject(page.getByTestId('today-owed').filter({ hasText: '৳1,360' }).waitFor());
  assert.match(await page.locator('#screen').innerText(), /jamilhq/);
  assert.deepEqual(errors, []);
});

test('Today draws the 14-day renewal runway', async () => {
  const { page } = await open();
  const runway = page.getByRole('img', { name: /on day/ });
  await runway.waitFor();
  assert.match(await page.locator('#screen').innerText(), /Renewal runway/);
});

test('New sale for a new customer, saved once even when Save is double-clicked', async () => {
  const { page, errors, rows } = await open();
  const before = rows('Sales_Log').length;
  await quick(page, 'New sale');
  await page.getByRole('button', { name: 'Netflix', exact: false }).first().click();
  const firstAccount = page.locator('[data-testid="account-chip"]').first();
  assert.match(await firstAccount.innerText(), /NFX-03/);
  assert.match(await firstAccount.getAttribute('aria-pressed'), /true/, 'emptiest account is preselected');
  await page.getByLabel('Customer', { exact: true }).fill('Rahim Test');
  await page.getByText('Add new customer "Rahim Test"').click();
  await assert.doesNotReject(page.getByLabel('Contact via').waitFor());
  await page.getByLabel('Contact via').selectOption('WhatsApp');
  await page.getByLabel('Number or username').fill('01711111111');
  await page.getByLabel('Paid now').fill('290');
  assert.match(await page.getByTestId('paid-till').innerText(), /2026-11-18/);
  await page.getByRole('button', { name: 'Save sale' }).dblclick();
  await toastOf(page, 'Sale saved').waitFor();
  assert.equal(rows('Sales_Log').length, before + 1);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('rahim');
  await page.getByText('Rahim Test').first().click();
  await page.getByText('Netflix Premium profile').first().waitFor();
  assert.deepEqual(errors, []);
});

test('Got paid clears a due', async () => {
  const { page, errors } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').waitFor();
  await nav(page, 'Today');
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await assert.doesNotReject(page.locator('#dueBox').getByText('owes ৳300').waitFor());
  assert.equal(await page.getByLabel('Amount').inputValue(), '300', 'prefilled with what they owe');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="dues-list"]').innerText.includes('Kabir'));
  assert.deepEqual(errors, []);
});

test('Dues search filters and Paid opens the payment form already filled', async () => {
  const { page, errors } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await page.getByLabel('Search dues').fill('tariq');
  await page.getByTestId('dues-list').getByText('tariq').waitFor();
  await assert.doesNotReject(page.getByTestId('dues-list').getByText('Kabir').waitFor({ state: 'detached', timeout: 2000 }));
  await page.getByTestId('due-pay').first().click();
  await page.getByRole('button', { name: 'Save payment' }).waitFor();
  assert.match(await page.locator('#cp').inputValue(), /tariq/i);
  assert.ok(Number(await page.getByLabel('Amount').inputValue()) > 0, 'amount prefilled from the due');
  assert.deepEqual(errors, []);
});

test('Dues can be narrowed by how late they are, and exported as CSV', async () => {
  const { page } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  const all = await page.getByTestId('due-pay').count();
  assert.ok(all > 1);
  await page.getByRole('button', { name: /^30\+ days/ }).click();
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="due-pay"]').length < n, all);
  await page.getByRole('button', { name: /^All/ }).click();
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="due-pay"]').length === n, all);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export these dues as CSV' }).click()
  ]);
  assert.match(download.suggestedFilename(), /^dues-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('Undo from the toast reverses the last save', async () => {
  const { page, errors, rows } = await open();
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('tariq');
  await page.getByRole('option', { name: /^tariq/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  const hasPayment = () => rows('Payments').filter(r => r.payment_id === 'PM-00091').length;
  assert.equal(hasPayment(), 1, 'the payment exists before undo');
  await toastOf(page, 'Payment saved').getByRole('button', { name: 'Undo' }).click();
  await toastOf(page, 'Undone').waitFor();
  assert.equal(hasPayment(), 0, 'the payment is gone after undo');
  assert.deepEqual(errors, []);
});

test('Remind opens WhatsApp with the message', async () => {
  const { page } = await open();
  const link = page.getByTestId('remind-link').first();
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /^https:\/\/wa\.me\/8801711111111\?text=Hi%20jamilhq/);
});

function reminderState() {
  const state = makeUiState();
  state.settings = Object.assign({}, state.settings, { pay_base_url: 'https://pay.test' });
  state.sales.find(s => s.Sale_ID === 73).Pay_Token = 'tok73';
  return state;
}
const CLIP = { permissions: ['clipboard-read', 'clipboard-write'] };

test('Reminder preview shows the built message, Copy sends the edited text to the clipboard', async () => {
  const { page, errors } = await open(Object.assign({ state: reminderState() }, CLIP));
  await page.getByTestId('remind-preview-73-before').click();
  const box = page.locator('#msgText');
  await box.waitFor();
  await page.waitForFunction(() => document.querySelector('#msgText').value.length > 0);
  const built = await box.inputValue();
  assert.match(built, /jamilhq/);
  assert.match(built, /https:\/\/pay\.test\/pay\/tok73/);
  assert.equal(await page.locator('#msgWhatsApp').isEnabled(), true);
  await box.fill('Edited: hello jamilhq, pay soon');
  await page.locator('#msgCopy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Edited: hello jamilhq, pay soon');
  assert.deepEqual(errors, []);
});

test('Reminder preview for a customer with no contact still copies, with no WhatsApp or Messenger button', async () => {
  const { page, errors } = await open(Object.assign({ state: reminderState() }, CLIP));
  await page.getByRole('button', { name: /^Show all/ }).click();
  await page.getByTestId('remind-preview-46-due').click();
  await page.waitForFunction(() => document.querySelector('#msgText') && document.querySelector('#msgText').value.length > 0);
  assert.match(await page.locator('#msgText').inputValue(), /tariq/);
  assert.equal(await page.locator('#msgWhatsApp').count(), 0);
  assert.equal(await page.locator('#msgMessenger').count(), 0);
  await page.locator('#msgCopy').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /tariq/);
  assert.deepEqual(errors, []);
});

test('Switching the reminder language re-reads the builder', async () => {
  const { page, errors } = await open(Object.assign({ state: reminderState() }, CLIP));
  const langs = [];
  page.on('request', r => {
    const b = r.postData() || '';
    if (b.indexOf('"reminderMessage"') >= 0) langs.push(JSON.parse(b).payload.lang);
  });
  await page.getByTestId('remind-preview-73-before').click();
  await page.waitForFunction(() => document.querySelector('#msgText') && document.querySelector('#msgText').value.length > 0);
  const en = await page.locator('#msgText').inputValue();
  await page.locator('#msgLang').selectOption('bn');
  await page.waitForFunction(t => document.querySelector('#msgText').value !== t, en);
  assert.ok(langs.includes('bn'), 'asked the builder for bn, got ' + JSON.stringify(langs));
  assert.notEqual(await page.locator('#msgText').inputValue(), en);
  assert.deepEqual(errors, []);
});

test('Settings: insert {profile} with a chip, save, reload, and the Today preview carries the profile', async () => {
  const state = reminderState();
  state.sales.find(s => s.Sale_ID === 73).Contact = 'Profile 9';
  const { page, errors, tables } = await open(Object.assign({ state }, CLIP));
  await nav(page, 'More');
  await page.locator('[data-more="settings"]').click();
  // The screen opens on Business; on a phone the Message templates accordion holds the editor.
  await page.getByRole('button', { name: 'Message templates', exact: true }).click();
  const box = page.locator('#tplText');
  await box.fill('Hi {name}, ');
  await box.focus();
  await page.locator('[data-var="profile"]').click();
  assert.equal(await box.inputValue(), 'Hi {name}, {profile}');
  assert.match(await page.locator('#tplPreview').innerText(), /Hi Fahim, Profile 2/);
  assert.equal(await box.evaluate(el => document.activeElement === el), true, 'chip click keeps focus in the text');
  await page.locator('#tplSave').click();
  await toastOf(page, 'Saved').first().waitFor();
  assert.equal(await page.locator('#tplText').count(), 1, 'Settings stays open after saving a message');
  assert.match(tables.settings.get('msg_renew_en'), /\{profile\}/);
  await page.reload();
  await nav(page, 'Today');
  await page.getByTestId('today-owed').waitFor();
  await page.getByTestId('remind-preview-73-before').click();
  await page.waitForFunction(() => document.querySelector('#msgText') && document.querySelector('#msgText').value.length > 0);
  assert.match(await page.locator('#msgText').inputValue(), /Profile 9/);
  assert.deepEqual(errors, []);
});

test('Product messages: save a renew template, then Reset to default blanks it', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="accounts"]').click();
  await page.locator('[data-product-messages]').first().click();
  await page.locator('#tplText').fill('Product note for {name}');
  await page.locator('#tplSave').click();
  await toastOf(page, 'Saved').first().waitFor();
  assert.ok(rows('Product_Catalog').some(p => p.template_renew === 'Product note for {name}'), 'product template saved');
  await page.locator('#tplReset').click();
  await page.waitForFunction(() => document.querySelector('#tplText').value === '');
  await page.waitForFunction(() => document.querySelector('#tplReset').disabled);
  assert.ok(!rows('Product_Catalog').some(p => p.template_renew), 'reset stored blank text');
  assert.deepEqual(errors, []);
});

test('Reminder preview: empty text disables Copy and Mark as sent, and a failed language switch keeps the text', async () => {
  const { page, errors } = await open(Object.assign({ state: reminderState() }, CLIP));
  await page.getByTestId('remind-preview-73-before').click();
  await page.waitForFunction(() => document.querySelector('#msgText') && document.querySelector('#msgText').value.length > 0);
  const box = page.locator('#msgText');
  await box.fill('   ');
  assert.equal(await page.locator('#msgCopy').isDisabled(), true);
  assert.equal(await page.locator('#msgSent').isDisabled(), true);
  assert.equal(await page.locator('#msgEmptyHint').count(), 1);
  await box.fill('My edited text');
  assert.equal(await page.locator('#msgCopy').isDisabled(), false);
  await page.route('**/functions/v1/api', async route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'reminderMessage' && b.payload && b.payload.lang === 'bn') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Builder is down' }) });
    }
    return route.fallback();
  });
  await page.locator('#msgLang').selectOption('bn');
  await page.getByTestId('msgNotice').waitFor();
  assert.match(await page.getByTestId('msgNotice').innerText(), /Builder is down/);
  assert.equal(await box.inputValue(), 'My edited text', 'text kept');
  assert.equal(await page.locator('#msgLang').inputValue(), 'en', 'language stays as it was');
  assert.equal(await page.locator('#msgCopy').isDisabled(), false, 'unlocked again after the failure');
  assert.deepEqual(errors, []);
});

test('Renew from a customer page continues from Paid till', async () => {
  const { page, errors } = await open();
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('farid');
  await page.getByText('farid', { exact: true }).first().click();
  await page.getByTestId('line-N44').getByRole('button', { name: 'Renew' }).click();
  assert.match(await page.getByTestId('paid-till').innerText(), /2027-01-12/);
  await page.getByRole('button', { name: 'Save renewal' }).click();
  await toastOf(page, 'Renewed N44').waitFor();
  assert.deepEqual(errors, []);
});

test('Editing Months offers to move Paid till, and leaves it alone unless asked', async () => {
  const { page, errors } = await open();
  await nav(page, 'Customers');
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
    for (const tab of ['Today', 'Customers', 'Accounts', 'Dues', 'Money', 'More']) {
      await nav(page, tab);
      await page.waitForTimeout(350);
      const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
      assert.ok(w <= 360, tab + ' (' + scheme + ') scrollWidth ' + w);
    }
    await page.getByRole('tab', { name: 'Book' }).click().catch(() => {});
    await nav(page, 'Today');
    await quick(page, 'New sale');
    const w2 = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w2 <= 360, 'New sale scrollWidth ' + w2);
    await ctx.close();
  }
});

test('Accounts overview shows each account with its users, totals and open slots', async () => {
  const { page, errors } = await open();
  await nav(page, 'Accounts');
  await page.getByTestId('accounts-net').waitFor();
  const nfx = page.getByTestId('acct-NFX-03');
  await nfx.waitFor();
  const text = await nfx.innerText();
  assert.match(text, /NFX-03/);
  assert.match(text, /Open slot/);
  assert.match(await page.getByTestId('acct-net-NFX-03').innerText(), /\+৳340/);
  await page.getByRole('button', { name: /^Spotify/ }).click();
  await page.getByTestId('acct-NFX-01').waitFor({ state: 'detached' });
  await page.getByTestId('acct-SPT-01').waitFor();
  await page.getByRole('button', { name: /^Netflix/ }).click();
  await nfx.waitFor();
  await nfx.locator('[data-testid^="acct-user-"]').first().click();
  await page.getByRole('button', { name: 'Got paid' }).waitFor();
  assert.deepEqual(errors, []);
});

test('Money shows profit by category and the book', async () => {
  const { page } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByRole('heading', { name: 'By category' }).waitFor({ timeout: 10000 });
  const text = await page.locator('#screen').innerText();
  assert.match(text, /By category/i);
  assert.match(text, /Revenue/i);
  assert.match(text, /Cost/i);
  assert.match(text, /Net profit/i);
  assert.match(text, /Margin/i);
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.getByText('Net this month').waitFor();
  // The Book's Add expense button by id: the money cells' names also contain the word, so a name match is ambiguous now.
  await assert.doesNotReject(page.locator('#addExpense').waitFor());
});

test('Money opens on the Overview with the default widgets, every chart named', async () => {
  const { page, errors } = await open();
  await nav(page, 'Money');
  await page.getByTestId('widget-net').waitFor();
  for (const id of ['net', 'trend', 'cash', 'dues', 'products', 'forecast']) {
    assert.equal(await page.getByTestId('widget-' + id).count(), 1, id);
  }
  assert.equal(await page.getByTestId('widget-accounts').count(), 0);
  const names = await page.locator('#screen [role="img"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || ''));
  assert.ok(names.length >= 2, 'charts present');
  assert.ok(names.every(n => n.trim().length > 0), 'every chart has an aria-label');
  assert.deepEqual(errors, []);
});

test('An unknown widget id in the saved layout does not crash the Overview', async () => {
  const { makeUiState } = require('../support/seed');
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const st = makeUiState();
  st.settings = Object.assign({}, st.settings, { money_layout: 'bogus,net,cash' });
  await startUiHost(page, { state: st });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Money');
  await page.getByTestId('widget-net').waitFor();
  assert.equal(await page.getByTestId('widget-cash').count(), 1);
  assert.equal(await page.getByTestId('widget-bogus').count(), 0);
  assert.deepEqual(errors, []);
});

// Opens the panel on a custom state, signed in, and goes to Money > Overview.
async function openOverview(mutate, opts) {
  const { makeUiState } = require('../support/seed');
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 360, height: 740 } }, opts));
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const st = makeUiState();
  if (mutate) mutate(st);
  const { tables } = await startUiHost(page, { state: st });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Overview' }).click();
  return { page, errors, tables };
}
const usdtSales = st => { st.sales.forEach(x => { x.Sale_Date = '2026-10-05'; x.Buy_Currency = 'USDT'; x.Buy_Price_USDT = 2; }); };

test('Overview with no data shows empty states and no NaN', async () => {
  const { page, errors } = await openOverview(st => { st.sales = []; st.payments = []; st.expenses = []; st.purchases = []; });
  await page.getByTestId('widget-net').waitFor();
  await page.getByTestId('widget-products').waitFor();
  const text = await page.locator('#screen').innerText();
  assert.doesNotMatch(text, /NaN|undefined|Infinity/);
  assert.match(text, /No sales this month/);
  assert.deepEqual(errors, []);
});

test('A negative net month keeps its minus sign in the chart label', async () => {
  const { page } = await openOverview(st => {
    st.sales = []; st.payments = [];
    st.expenses = [{ Expense_ID: 'EXP-NEG', Date: '2026-10-03', Category: 'Other', Amount: 777, Method: 'bKash', Note: '' }];
  });
  await page.getByTestId('widget-net').waitFor();
  const label = await page.getByTestId('widget-net').locator('[role="img"][aria-label^="Net, last six months"]').getAttribute('aria-label');
  assert.match(label, /−/);
});

test('Changing the month reloads the Overview with the figures of that month', async () => {
  const { page, errors } = await openOverview(st => {
    st.sales = []; st.payments = []; st.purchases = [];
    st.expenses = [
      { Expense_ID: 'EXP-OCT', Date: '2026-10-03', Category: 'Other', Amount: 777, Method: 'bKash', Note: '' },
      { Expense_ID: 'EXP-SEP', Date: '2026-09-03', Category: 'Other', Amount: 123, Method: 'bKash', Note: '' }
    ];
  });
  const label = () => page.getByTestId('widget-net').locator('[role="img"][aria-label^="Net, last six months"]').getAttribute('aria-label');
  await page.getByTestId('widget-net').waitFor();
  const sel = page.locator('#overviewMonth');
  assert.equal(await sel.inputValue(), '2026-10');
  assert.match(await label(), /−777$/);
  await sel.selectOption('2026-09');
  await page.waitForFunction(() => /−123$/.test(document.querySelector('[data-testid="widget-net"] [role="img"][aria-label^="Net, last six months"]').getAttribute('aria-label')));
  const after = await label();
  assert.match(after, /−123$/);
  assert.doesNotMatch(after, /777/);
  assert.equal(await sel.inputValue(), '2026-09');
  assert.deepEqual(errors, []);
});

test('A failed month change keeps the old figures, the old month in the select, and exports that month', async () => {
  const { page, errors } = await openOverview(st => {
    st.sales = []; st.payments = []; st.purchases = [];
    st.expenses = [{ Expense_ID: 'EXP-OCT', Date: '2026-10-03', Category: 'Other', Amount: 777, Method: 'bKash', Note: '' },
      { Expense_ID: 'EXP-SEP', Date: '2026-09-03', Category: 'Other', Amount: 123, Method: 'bKash', Note: '' }];
  });
  await page.getByTestId('widget-net').waitFor();
  await page.route('**/functions/v1/api', route => {
    const d = route.request().postData() || '';
    if (/"moneyOverview"/.test(d) && /2026-09/.test(d)) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Month is unavailable.' }) });
    }
    return route.fallback();
  });
  const exports = [];
  page.on('request', r => { const d = r.postData() || ''; if (/"moneyExport"/.test(d)) exports.push(JSON.parse(d).payload); });
  await page.locator('#overviewMonth').selectOption('2026-09');
  await page.getByText('Month is unavailable.').waitFor();
  assert.equal(await page.locator('#overviewMonth').inputValue(), '2026-10');
  assert.match(await page.getByTestId('widget-net').locator('[role="img"][aria-label^="Net, last six months"]').getAttribute('aria-label'), /−777$/);
  await page.getByRole('button', { name: 'Export Overview as CSV' }).click();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(exports.length, 1);
  assert.equal(exports[0].month, '2026-10');
  assert.deepEqual(errors, []);
});

test('Rate-missing banner appears once for products and accounts widgets', async () => {
  for (const [layout, expected] of [['accounts', 1], ['products,accounts', 1], ['cash', 0]]) {
    const { page } = await openOverview(st => { usdtSales(st); st.settings = Object.assign({}, st.settings, { money_layout: layout }); });
    await page.locator('[data-testid^="widget-"]').first().waitFor();
    assert.equal(await page.getByTestId('rate-missing').count(), expected, layout);
  }
});

test('Overview fits a 375px phone without horizontal scroll', async () => {
  const { page } = await openOverview(null, { viewport: { width: 375, height: 812 } });
  await page.getByTestId('widget-trend').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('Suppliers sheet opens from More tab', async () => {
  const { page } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="suppliers"]').click();
  await page.getByRole('button', { name: 'Add supplier' }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByLabel('Supplier name').waitFor({ timeout: 5000 });
  assert.ok(await page.getByLabel('Supplier name').isVisible());
});

test('Bybit USDT Calculator opens and calculates BDT', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  st.liveRates = [{ ID: 'usdt_bdt', Rate: 128, Fetched_At: new Date().toISOString() }];
  const { page } = await open({ state: st });
  await nav(page, 'More');
  await page.locator('[data-more="calc"]').click();
  await page.getByText('USDT to BDT Calculator').waitFor({ timeout: 5000 });
  await page.locator('#calcUsdt').fill('10');
  const bdtVal = await page.locator('#calcBdt').inputValue();
  assert.equal(Number(bdtVal), 1280);
});

test('Supplier can be edited and deleted from the Suppliers sheet', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="suppliers"]').click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.locator('#sName').fill('UI Sup');
  await page.locator('#save').click();
  await page.getByText('UI Sup').waitFor();
  await page.locator('[data-sup-edit]').last().click();
  await page.locator('#sName').fill('UI Sup Renamed');
  await page.locator('#sMarkup').fill('4');
  await page.locator('#save').click();
  await page.getByText('UI Sup Renamed').waitFor();
  assert.ok(rows('Suppliers').some(s => s.name === 'UI Sup Renamed' && Number(s.markup_percent) === 4));
  await page.locator('[data-sup-del]').last().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('UI Sup Renamed'));
  assert.ok(!rows('Suppliers').some(s => s.name === 'UI Sup Renamed'));
  assert.deepEqual(errors, []);
});

test('Gift-card batch can be created, renamed and deleted', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="batches"]').click();
  await page.locator('#addBatchBtn').click();
  await page.locator('#bQty').fill('2');
  await page.locator('#bTag').fill('UI-B1');
  await page.locator('#save').click();
  await page.locator('[data-batch-edit="UI-B1"]').waitFor();
  assert.equal(rows('Code_Inventory').filter(c => c.batch_id === 'UI-B1').length, 2);
  await page.locator('[data-batch-edit="UI-B1"]').click();
  await page.locator('#bTag').fill('Renamed Batch');
  await page.locator('#save').click();
  await page.getByText('Renamed Batch').waitFor();
  await page.locator('[data-batch-del="UI-B1"]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Renamed Batch'));
  assert.equal(rows('Code_Inventory').filter(c => c.batch_id === 'UI-B1').length, 0);
  assert.deepEqual(errors, []);
});

test('Without a rate the panel says so; a manual rate in Settings shows as manual', async () => {
  const { page, errors } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByTestId('rate-line').waitFor();
  assert.match(await page.getByTestId('rate-line').innerText(), /No rate/);
  await nav(page, 'More');
  await page.locator('[data-more="settings"]').click();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await page.locator('#tUsdt').fill('128.5');
  await page.locator('#saveRates').click();
  await toastOf(page, 'Settings saved').first().waitFor();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
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
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
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
  await nav(page, 'More');
  await page.locator('[data-more="signout"]').click();
  await page.getByTestId('signin').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_secret')), null);
  assert.deepEqual(errors, []);
});

test('Ctrl+K finds a customer and opens their page', async () => {
  const { page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('tariq');
  await page.getByRole('option', { name: /tariq/ }).first().click();
  await page.getByRole('button', { name: 'Got paid' }).waitFor();
  assert.deepEqual(errors, []);
});

test('Keyboard shortcuts open the forms and jump between screens', async () => {
  const { page } = await open({ viewport: { width: 1280, height: 800 } });
  await page.keyboard.press('n');
  await page.getByRole('button', { name: 'Save sale' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save sale' }).waitFor({ state: 'detached' });
  await page.keyboard.press('5');
  await page.getByTestId('dues-list').waitFor();
  assert.match(await page.evaluate(() => location.hash), /dues/);
});

test('The theme can be forced and is remembered', async () => {
  const { page } = await open({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
  await page.getByRole('button', { name: /^Theme: system/ }).first().click();
  await page.getByRole('button', { name: /^Theme: light/ }).first().click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_theme')), 'dark');
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
});

// Settings' Appearance section, read through the accessible names: a named group with two toggles (Comfortable, Compact).
const densityGroup = page => page.getByRole('group', { name: 'Density' });
const densityAttr = page => page.evaluate(() => document.documentElement.getAttribute('data-density'));
async function goAppearance(page) {
  await goSettings(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await densityGroup(page).waitFor();
}
const dueRowHeight = page => page.getByTestId('dues-list').evaluate(el => el.firstElementChild.getBoundingClientRect().height);

// ---- uplift 5.3: density and accessibility settings ----
test('Density: Settings > Appearance offers Comfortable and Compact as pressed toggles, and Compact is stored', async () => {
  const { page, errors } = await open(WIDE);
  await goAppearance(page);
  const comfortable = densityGroup(page).getByRole('button', { name: 'Comfortable', exact: true });
  const compact = densityGroup(page).getByRole('button', { name: 'Compact', exact: true });
  assert.equal(await comfortable.getAttribute('aria-pressed'), 'true', 'comfortable is the default');
  assert.equal(await compact.getAttribute('aria-pressed'), 'false');
  await compact.click();
  assert.equal(await compact.getAttribute('aria-pressed'), 'true');
  assert.equal(await densityAttr(page), 'compact');
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_density')), 'compact');
  await comfortable.click();
  assert.equal(await densityAttr(page), 'comfortable');
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_density')), null, 'comfortable removes the stored value');
  assert.deepEqual(errors, []);
});

test('Density: at 1280px compact shortens a Dues row and a Customers table row, and the choice is set before the first paint after a reload', async () => {
  const { page, errors } = await open(WIDE);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  const duesComfortable = await dueRowHeight(page);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  const custComfortable = await custTable(page).locator('tbody td').first().evaluate(el => el.getBoundingClientRect().height);

  await goAppearance(page);
  await densityGroup(page).getByRole('button', { name: 'Compact', exact: true }).click();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  const duesCompact = await dueRowHeight(page);
  assert.ok(duesCompact < duesComfortable, 'Dues row ' + duesCompact + 'px compact, ' + duesComfortable + 'px comfortable');
  assert.ok(duesCompact >= 40, 'still a usable row: ' + duesCompact + 'px');
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  const custCompact = await custTable(page).locator('tbody td').first().evaluate(el => el.getBoundingClientRect().height);
  assert.ok(custCompact < custComfortable, 'Customers row ' + custCompact + 'px compact, ' + custComfortable + 'px comfortable');
  assert.ok(custCompact >= 40, 'still a usable row: ' + custCompact + 'px');

  // The attribute is set by theme-init.js, which runs before DOMContentLoaded: read it as soon as that event fires.
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await densityAttr(page), 'compact', 'set before the app script runs');
  await custTable(page).waitFor();   // the URL hash keeps the Customers screen
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  assert.ok(await dueRowHeight(page) < duesComfortable, 'still compact after a reload');
  assert.deepEqual(errors, []);
});

test('Density: at 360px compact stored leaves every phone row 64px or taller', async () => {
  const { page, errors } = await open();
  await page.evaluate(() => localStorage.setItem('sales_tracker_density', 'compact'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await densityAttr(page), 'compact');
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Customers');
  await page.getByTestId('cust-list').getByRole('button').first().waitFor();
  const card = await page.getByTestId('cust-list').getByRole('button').first().evaluate(el => el.getBoundingClientRect().height);
  assert.ok(card >= 64, 'customer card row ' + card + 'px');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  const due = await dueRowHeight(page);
  assert.ok(due >= 64, 'dues row ' + due + 'px');
  assert.deepEqual(errors, []);
});

test('Density: with localStorage throwing the page loads comfortable, and the toggle still works for the visit', async () => {
  const ctx = await browser.newContext(WIDE);
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await startUiHost(page);
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  assert.equal(await densityAttr(page), 'comfortable');
  await goAppearance(page);
  await densityGroup(page).getByRole('button', { name: 'Compact', exact: true }).click();
  assert.equal(await densityAttr(page), 'compact', 'compact applies for this visit');
  assert.equal(await densityGroup(page).getByRole('button', { name: 'Compact', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('Density: a change in one open tab reaches another tab of the same browser', async () => {
  const { page, ctx, errors } = await open(WIDE);
  const other = await ctx.newPage();
  const otherErrors = [];
  other.on('pageerror', e => otherErrors.push(String(e)));
  await startUiHost(other);
  await other.goto(PAGE);
  await other.getByTestId('today-owed').waitFor();
  assert.equal(await densityAttr(other), 'comfortable');
  await goAppearance(page);
  await densityGroup(page).getByRole('button', { name: 'Compact', exact: true }).click();
  await other.waitForFunction(() => document.documentElement.getAttribute('data-density') === 'compact');
  assert.equal(await densityAttr(other), 'compact');
  assert.deepEqual(errors, []);
  assert.deepEqual(otherErrors, []);
});

test('A wide screen shows the sidebar and a phone shows the dock', async () => {
  const wide = await open({ viewport: { width: 1280, height: 800 } });
  assert.ok(await wide.page.locator('aside').isVisible());
  assert.ok(!(await wide.page.getByRole('button', { name: 'Quick actions' }).isVisible()));
  const phone = await open();
  assert.ok(!(await phone.page.locator('aside').isVisible()));
  assert.ok(await phone.page.getByRole('button', { name: 'Quick actions' }).isVisible());
});

test('Orders: an order made in the panel is listed under More, and its link can be marked sent', async () => {
  const { page, errors, api, tables } = await open({ viewport: { width: 360, height: 740 } });
  tables.settings.set('pay_base_url', 'https://shop.example');   // the pay link needs the base address set in Settings
  const L = (await api('lookups', {})).data;
  const product = L.products.find(p => p.deliversAs === 'account');
  const made = await api('createOrder', { productId: product.id, months: 1, customerId: L.customers[0].id, requestId: 'ui-order-1' });
  assert.equal(made.ok, true, made.error);
  assert.match(made.data.url, /\/pay\//);
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'More');
  await page.locator('[data-more="orders"]').click();
  const card = page.locator('[data-order="' + made.data.orderId + '"]');
  await card.waitFor();
  assert.match(await card.innerText(), /New/);
  assert.match(await card.innerText(), /Copy pay link/);
  await card.getByRole('button', { name: 'Link sent' }).click();
  await card.getByText('Awaiting payment').waitFor();
  assert.equal(Array.from(tables.orders.values()).find(o => o.order_id === made.data.orderId).status, 'AwaitingPayment');
  assert.deepEqual(errors, []);
});

test('Pay links: generate missing links, copy one, and see the order status', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  await page.getByRole('button', { name: /^Pay links/ }).click();
  await page.getByTestId('paylinks-list').waitFor();
  assert.match(await page.locator('#screen').innerText(), /Customers pay here/);
  const generate = page.getByRole('button', { name: 'Generate links' });
  if (await generate.isVisible()) {
    await generate.click();
    await toastOf(page, 'pay token').waitFor();
    await generate.waitFor({ state: 'detached' });
  }
  assert.ok(rows('Sales_Log').every(s => !s.Sub_Code || s.Pay_Token), 'every line has a token');
  const first = page.locator('[data-testid^="paylink-"]').first();
  await first.getByRole('button', { name: 'Copy' }).click();
  await toastOf(page, 'Copied the link').waitFor();
  assert.match(await first.innerText(), /Not opened/);
  const href = await first.getByRole('link', { name: /Open the pay page/ }).getAttribute('href');
  assert.match(href, /\/pay\/[A-Za-z0-9_-]{16,}$/);
  assert.deepEqual(errors, []);
});

test('Pay links: the methods sheet turns Nagad on with a number and refuses a bad one', async () => {
  const { page, tables } = await open({ viewport: { width: 1280, height: 800 } });
  await page.getByRole('button', { name: /^Pay links/ }).click();
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.locator('#on-nagad').click();
  await page.locator('#n-nagad').fill('12345');
  await page.locator('#save').click();
  await page.getByText('The Nagad number must look like 01XXXXXXXXX.').waitFor();
  await page.locator('#n-nagad').fill('01811223344');
  await page.locator('#save').click();
  await page.locator('#n-nagad').waitFor({ state: 'detached' });
  const get = k => tables.settings.get(k);
  assert.equal(get('nagad_number'), '01811223344');
  assert.match(get('pay_methods'), /nagad/);
  await page.getByText('Nagad · by hand').waitFor();
});

const WIDE = { viewport: { width: 1280, height: 800 } };
function codeState() {
  const { makeUiState } = require('../support/seed');
  const state = makeUiState();
  state.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  state.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-UI-1234', Status: 'Available' });
  state.settings.bkash_number = '01711223344';
  state.settings.pay_base_url = PAGE.replace(/\/+$/, '');
  return state;
}
async function gotoPayLinks(page) {
  await page.getByRole('button', { name: /^Pay links/ }).click();
  await page.getByTestId('paylinks-list').waitFor();
}
// The Details section is closed by default; open it before touching anything inside it.
async function openDetails(page) {
  if ((await page.locator('#prDetailsToggle').getAttribute('aria-expanded')) !== 'true') await page.locator('#prDetailsToggle').click();
}
async function newLink(page, fields) {
  await page.getByRole('button', { name: 'New link' }).click();
  await page.locator('#prAmount').fill(fields.amount);
  if (fields.title || fields.product) await openDetails(page);
  if (fields.title) await page.locator('#prTitle').fill(fields.title);
  if (fields.product) await page.getByTestId('product-tree').getByRole('button', { name: fields.productName || fields.product, exact: true }).click();
  await page.locator('#save').click();
}

test('Pay links: a 500 BDT custom link is created, shown with its URL, copied and listed under Custom', async () => {
  const base = codeState();
  const { page, errors, rows } = await open({ ...WIDE, state: base });
  await gotoPayLinks(page);
  await newLink(page, { title: 'Logo design', amount: '500' });
  await page.locator('#prUrl').waitFor();
  assert.match(await page.locator('#prUrl').innerText(), /\/pay\/[A-Za-z0-9_-]{16,}$/);
  assert.match(await page.locator('#prWhatsapp').getAttribute('href'), /^https:\/\/wa\.me\/\?text=/);
  await page.locator('#prCopy').click();
  await toastOf(page, 'Copied the link').waitFor();
  await page.locator('#done').click();
  await page.locator('#prUrl').waitFor({ state: 'detached' });
  const made = rows('Pay_Requests');
  assert.equal(made.length, 1);
  assert.equal(Number(made[0].amount), 500);
  await page.getByTestId('filter-custom').click();
  const row = page.getByTestId('custom-list').locator('[data-testid^="custom-"]').first();
  assert.match(await row.innerText(), /Logo design/);
  assert.match(await row.innerText(), /500/);
  assert.match(await row.innerText(), /Open/);
  assert.match(await row.getByRole('link', { name: /Open the pay page/ }).getAttribute('href'), /\/pay\/[A-Za-z0-9_-]{16,}$/);
  await row.getByRole('button', { name: /^Copy link for/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-sonner-toast]').length >= 2);
  assert.deepEqual(errors, []);
});

test('Pay links: a code product link holds stock, a second one says Out of stock, and Cancel releases it', async () => {
  const { page, errors } = await open({ ...WIDE, state: codeState() });
  await gotoPayLinks(page);
  await page.getByRole('button', { name: 'New link' }).click();
  await openDetails(page);
  await page.getByTestId('product-tree').getByText('1 in stock', { exact: true }).first().waitFor();
  await page.getByTestId('product-tree').getByRole('button', { name: 'Gift card', exact: true }).click();
  assert.equal(await page.locator('#prTitle').inputValue(), 'Gift card', 'title prefilled from the product');
  await page.locator('#save').click();
  await page.locator('#prUrl').waitFor();
  await page.locator('#done').click();
  await page.getByRole('button', { name: 'New link' }).click();
  await openDetails(page);
  await page.getByTestId('product-tree').getByText('0 in stock', { exact: true }).waitFor();
  await page.getByTestId('product-tree').getByRole('button', { name: 'Gift card', exact: true }).click();
  await page.locator('#save').click();
  await page.getByText('Out of stock').waitFor();
  await page.getByRole('button', { name: 'Back' }).or(page.getByRole('button', { name: 'Close' })).first().click();
  await page.locator('#prTitle').waitFor({ state: 'detached' });
  await page.getByTestId('filter-custom').click();
  const row = page.getByTestId('custom-list').locator('[data-testid^="custom-"]').first();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Cancel link' }).click();
  await row.getByText('Cancelled').waitFor();
  await page.getByRole('button', { name: 'New link' }).click();
  await openDetails(page);
  await page.getByTestId('product-tree').getByText('1 in stock', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
});

test('Pay links: Got paid on a custom link confirms it and the row shows Confirmed with the delivery', async () => {
  const { page, errors, rows } = await open({ ...WIDE, state: codeState() });
  await gotoPayLinks(page);
  await newLink(page, { title: 'Gift card', amount: '500', product: 'GC', productName: 'Gift card' });
  await page.locator('#done').click();
  await page.getByTestId('filter-custom').click();
  const row = page.getByTestId('custom-list').locator('[data-testid^="custom-"]').first();
  await row.getByRole('button', { name: 'Got paid' }).click();
  assert.equal(await page.locator('#gpAmount').inputValue(), '500');
  await page.locator('#gpTrx').fill('UITRX7777');
  await page.getByRole('button', { name: 'Confirm payment' }).click();
  await row.getByText('Confirmed').waitFor();
  await row.getByText('Delivered').waitFor();
  assert.equal(rows('Pay_Requests')[0].status, 'Paid');
  assert.ok(rows('Payments').some(p => p.transaction_id === 'UITRX7777' || p.trx_id === 'UITRX7777'), 'payment recorded');
  assert.deepEqual(errors, []);
});

test('On a phone, Pay links is reached from More', async () => {
  const { page } = await open();
  assert.equal(await page.getByRole('button', { name: /^Pay links/ }).count(), 0, 'not in the bottom dock');
  await nav(page, 'More');
  await page.locator('[data-more="paylinks"]').click();
  await page.getByTestId('paylinks-list').waitFor();
  const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
  assert.ok(w <= 360, 'scrollWidth ' + w);
});

const PHONE = { viewport: { width: 375, height: 812 } };

test('Phone: New pay link from Today takes an amount, Enter makes the link, and More lists it', async () => {
  const { page, errors, rows } = await open({ ...PHONE, state: codeState() });
  await quick(page, 'New pay link');
  await page.locator('#prAmount').waitFor();
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('inputmode') === 'decimal');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT', 'amount is focused');
  assert.equal(await page.locator('#prDetailsToggle').getAttribute('aria-expanded'), 'false', 'Details closed by default');
  await page.locator('#prAmount').fill('500');
  await page.keyboard.press('Enter');
  await page.locator('#prUrl').waitFor();
  assert.match(await page.locator('#prUrl').innerText(), /\/pay\/[A-Za-z0-9_-]{16,}$/);
  const copyY = (await page.locator('#prCopy').boundingBox()).y;
  const waY = (await page.locator('#prWhatsapp').boundingBox()).y;
  assert.ok(copyY < waY, 'Copy comes before WhatsApp');
  await page.getByRole('button', { name: 'Copy link' }).click();
  await toastOf(page, 'Copied the link').waitFor();
  await page.locator('#done').click();
  await nav(page, 'More');
  const newRow = await page.locator('[data-more="newlink"]').boundingBox();
  const deliveryRow = await page.locator('[data-more="delivery"]').boundingBox();
  assert.ok(newRow.y < deliveryRow.y, 'New pay link is at the top of Money');
  await page.locator('[data-more="paylinks"]').click();
  await page.getByTestId('paylinks-list').waitFor();
  await page.getByTestId('filter-custom').click();
  const row = page.getByTestId('custom-list').locator('[data-testid^="custom-"]').first();
  assert.match(await row.innerText(), /Payment/);
  assert.match(await row.innerText(), /500/);
  assert.equal(rows('Pay_Requests').length, 1);
  const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
  assert.ok(w <= 375, 'scrollWidth ' + w);
  assert.deepEqual(errors, []);
});

test('Desktop: New link on Pay links makes a link from an amount alone', async () => {
  const { page, errors, rows } = await open({ ...WIDE, state: codeState() });
  await gotoPayLinks(page);
  await newLink(page, { amount: '250' });
  await page.locator('#prUrl').waitFor();
  await page.locator('#done').click();
  assert.equal(rows('Pay_Requests').length, 1);
  assert.equal(Number(rows('Pay_Requests')[0].amount), 250);
  await page.getByTestId('filter-custom').click();
  const row = page.getByTestId('custom-list').locator('[data-testid^="custom-"]').first();
  assert.match(await row.innerText(), /Payment/);
  assert.deepEqual(errors, []);
});

test('Desktop: Details opens and a customer-bound link still works', async () => {
  const st = codeState();
  const { page, errors, rows } = await open({ ...WIDE, state: st });
  await gotoPayLinks(page);
  await page.getByRole('button', { name: 'New link' }).click();
  await page.locator('#prAmount').fill('300');
  await openDetails(page);
  await page.getByRole('combobox', { name: /Customer/ }).fill('jamil');
  await page.getByRole('option', { name: /jamilhq/ }).first().click();
  await page.locator('#prTitle').fill('Monthly plan');
  await page.locator('#save').click();
  await page.locator('#prUrl').waitFor();
  await page.locator('#done').click();
  const made = rows('Pay_Requests');
  assert.equal(made.length, 1);
  assert.equal(made[0].customer_id || made[0].customerId, st.customers.find(c => c.Name === 'jamilhq').Customer_ID);
  assert.deepEqual(errors, []);
});

test('Desktop: a typed name that is already a customer opens Details and offers the list', async () => {
  const { page, errors, rows } = await open({ ...WIDE, state: codeState() });
  await gotoPayLinks(page);
  await page.getByRole('button', { name: 'New link' }).click();
  await page.locator('#prAmount').fill('300');
  await openDetails(page);
  await page.locator('#prCustomerName').fill('JAMILHQ');
  await page.locator('#prDetailsToggle').click();
  assert.equal(await page.locator('#prDetailsToggle').getAttribute('aria-expanded'), 'false');
  await page.locator('#save').click();
  await page.getByText('Pick them from the list', { exact: false }).waitFor();
  assert.equal(await page.locator('#prDetailsToggle').getAttribute('aria-expanded'), 'true', 'Details opened on the clash');
  assert.equal(rows('Pay_Requests').length, 0, 'nothing created');
  assert.deepEqual(errors, []);
});

test('Keyboard only: l opens the link sheet with the amount focused, and Enter makes the link', async () => {
  const { page, errors, rows } = await open({ ...WIDE, state: codeState() });
  await page.locator('body').click();
  await page.keyboard.press('l');
  await page.locator('#prAmount').waitFor();
  // The sheet moves focus to the amount a moment after it opens; typing before that lands nowhere.
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'prAmount');
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await page.locator('#prUrl').waitFor();
  assert.equal(rows('Pay_Requests').length, 1);
  assert.deepEqual(errors, []);
});

test('New sale: a product made on the spot is picked for the sale', async () => {
  const { page, errors, rows } = await open();
  await quick(page, 'New sale');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.locator('#pName').fill('Disney Plus');
  await page.locator('#pLetter').fill('D');
  await page.locator('#pCost').fill('600');
  await page.locator('#pPrice').fill('250');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.locator('#pName').waitFor({ state: 'detached' });
  assert.ok(rows('Product_Catalog').some(p => p.product_name === 'Disney Plus'));
  const chip = page.getByRole('button', { name: 'Disney Plus', exact: true });
  await chip.waitFor();
  assert.equal(await chip.getAttribute('aria-pressed'), 'true', 'the new product is selected');
  assert.equal(await page.locator('#price').inputValue(), '250', 'and its price is filled in');
  assert.deepEqual(errors, []);
});

test('Accounts: edit an account and a user line', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  await nav(page, 'Accounts');
  const card = page.getByTestId('acct-NFX-03');
  await card.waitFor();
  await card.getByRole('button', { name: 'Edit account' }).click();
  await page.locator('#acLabel').fill('renamed@login.test');
  await page.locator('#acCost').fill('950');
  await page.locator('#acNotes').fill('moved to a new login');
  await page.locator('#save').click();
  await page.locator('#acLabel').waitFor({ state: 'detached' });
  await page.getByTestId('acct-NFX-03').getByText('renamed@login.test').waitFor();
  const acct = rows('Accounts').find(a => a.account_id === 'NFX-03');
  assert.equal(acct.account_label, 'renamed@login.test');
  assert.equal(Number(acct.cycle_cost), 950);
  await page.getByTestId('acct-NFX-03').getByRole('button', { name: /^Edit .*'s line$/ }).first().click();
  await page.locator('#sProfile').fill('new-profile');
  await page.locator('#save').click();
  await page.locator('#sProfile').waitFor({ state: 'detached' });
  assert.ok(rows('Sales_Log').some(s => s.account_id === 'NFX-03' && s.contact === 'new-profile'));
  assert.deepEqual(errors, []);
});

test('Accounts: retire an account into the Retired log, then reactivate it', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  await nav(page, 'Accounts');
  await page.getByTestId('acct-NFX-03').getByRole('button', { name: 'Retire' }).click();
  await page.locator('#retDate').fill('2026-09-06');
  await page.locator('#save').click();
  await toastOf(page, 'NFX-03 retired').waitFor();
  assert.equal(rows('Accounts').find(a => a.account_id === 'NFX-03').account_status, 'Inactive');
  await page.getByTestId('acct-NFX-03').waitFor({ state: 'detached' });
  await page.getByTestId('retired-tab').click();
  const log = page.getByTestId('retired-NFX-03');
  await log.waitFor();
  assert.match(await log.innerText(), /retired 6 Sep\w* 2026/);
  assert.match(await page.getByTestId('retired-log').innerText(), /Netflix Premium profile/, 'grouped by product name');
  await log.getByRole('button', { name: 'Reactivate' }).click();
  await toastOf(page, 'NFX-03 is active again').waitFor();
  assert.equal(rows('Accounts').find(a => a.account_id === 'NFX-03').account_status, 'Active');
  assert.deepEqual(errors, []);
});

test('New sale: a 1-day rent product sells from the shared ExitLag pool on a random free account', async () => {
  const st = makeUiState();
  st.products.push({ Product_ID: 'EXLRENT1D', Product_Name: 'ExitLag rent 1D', Category: 'Subscription', Billing_Cycle_Days: 1,
    Default_Price: 50, Unit_Cost: 0, Letter: 'ER', Parent_ID: 'EXITLAG', Delivers_As: 'account', Active: 'Yes' });
  const { page, errors, rows } = await open({ state: st });
  await quick(page, 'New sale');
  await page.getByRole('button', { name: 'ExitLag rent 1D', exact: true }).click();
  assert.equal(await page.getByTestId('account-random').getAttribute('aria-pressed'), 'true', 'random account is the default');
  await page.getByLabel('Customer', { exact: true }).fill('Rahim Test');
  await page.getByText('Add new customer "Rahim Test"').click();
  await page.getByLabel('Contact via').selectOption('WhatsApp');
  await page.getByLabel('Number or username').fill('01711111111');
  await page.getByLabel('Buy cost (optional)').fill('30');
  await page.getByRole('button', { name: 'Save sale' }).click();
  await toastOf(page, 'Sale saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.product_id === 'EXLRENT1D');
  assert.ok(sale, 'the rent sale is saved');
  assert.match(sale.account_id, /^EXL-/);
  assert.equal(sale.paid_till, '2026-10-19');
  assert.equal(Number(sale.cost_snapshot), 30);
  assert.equal(Number(sale.unit_price), 50);
  assert.deepEqual(errors, []);
});

test('New sale: Total mode sends the total, shows the per-month figure, and the sale bills exactly the total', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  await quick(page, 'New sale');
  await page.getByRole('button', { name: 'Netflix Premium profile', exact: true }).click();
  await page.getByLabel('Customer', { exact: true }).fill('Total Tester');
  await page.getByText('Add new customer "Total Tester"').click();
  await page.getByLabel('Contact via').selectOption('WhatsApp');
  await page.getByLabel('Number or username').fill('01711111112');
  assert.equal(await page.locator('#price-mode-per').getAttribute('aria-pressed'), 'true', 'Per month is the default');
  await page.locator('#price-mode-total').click();
  await page.locator('#months').fill('6');
  await page.locator('#price').fill('800');
  assert.match(await page.locator('#price-hint').innerText(), /৳133\.33 a month/);
  await page.locator('#paidNow').fill('800');
  await page.getByRole('button', { name: 'Save sale' }).click();
  await toastOf(page, 'Sale saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.customer === 'Total Tester');
  assert.ok(sale);
  assert.equal(Number(sale.months), 6);
  assert.equal(Math.round(Number(sale.unit_price) * 6 * 100) / 100, 800);
  assert.equal(rows('Payments').filter(p => Number(p.sale_id) === Number(sale.sale_id)).reduce((a, p) => a + Number(p.amount), 0), 800);
  assert.deepEqual(errors, []);
});

test('Dues: the Total price cell for a multi-month line saves a total, the price per month follows', async () => {
  const { page, errors, api, tables } = await open({ viewport: { width: 1280, height: 800 } });
  const first = await dueOf(api, 'Kabir');
  const row = saleOf(tables, first.saleId);
  row.months = 3; row.unit_price = 100;
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await page.getByText(/৳300 for 3 mo$/).first().waitFor();
  await cellBtn(page, 'Total price', dueTarget(due)).click();
  await page.getByRole('spinbutton', { name: 'Edit Total price for ' + dueTarget(due), exact: true }).fill('400');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Total price: ৳400').waitFor();
  const saved = saleOf(tables, due.saleId);
  assert.equal(Math.round(Number(saved.unit_price) * 3 * 100) / 100, 400);
  assert.deepEqual(errors, []);
});

async function saveCustomItem(page, { title, price, cost, paid }) {
  await quick(page, 'New sale');
  await page.locator('#customItem').click();
  await page.locator('#cTitle').fill(title);
  await page.locator('#cPrice').fill(String(price));
  if (cost !== undefined) await page.locator('#cCost').fill(String(cost));
  const input = page.getByRole('combobox', { name: 'Customer' });
  await input.fill('Kabir');
  await page.getByRole('listbox').getByRole('option', { name: /Kabir/ }).first().click();
  if (paid !== undefined) await page.locator('#cPaid').fill(String(paid));
}

test('New sale: a custom item is saved with price and cost, and its payment is recorded', async () => {
  const { page, errors, rows } = await open();
  await saveCustomItem(page, { title: 'Tinder Premium', price: 600, cost: 450, paid: 600 });
  assert.match(await page.getByTestId('custom-total').innerText(), /profit ৳150 · paid in full/);
  await page.locator('#save').click();
  await toastOf(page, 'saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.product_id === 'CUSTOM');
  assert.ok(sale, 'the custom sale is saved');
  assert.equal(sale.notes, 'Tinder Premium');
  assert.equal(Number(sale.unit_price), 600);
  assert.equal(Number(sale.cost_snapshot), 450);
  assert.equal(sale.paid_till, '');
  assert.equal(sale.sub_code, '');
  assert.equal(sale.account_id, '');
  const pays = rows('Payments').filter(p => String(p.sale_id) === String(sale.sale_id));
  assert.equal(pays.length, 1);
  assert.equal(Number(pays[0].amount), 600);
  assert.deepEqual(errors, []);
});

test('Customer: a custom sale shows under Custom sales, not under Subscriptions', async () => {
  const { page, errors, rows } = await open();
  await saveCustomItem(page, { title: 'Tinder Premium', price: 600, cost: 450 });
  await page.locator('#save').click();
  await toastOf(page, 'saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.product_id === 'CUSTOM');
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('kabir');
  await page.getByText('Kabir').first().click();
  await assert.doesNotReject(page.getByTestId('custom-' + sale.sale_id).waitFor());
  const lines = page.locator('[data-testid^="line-"]');
  assert.equal(await lines.filter({ hasText: 'Tinder Premium' }).count(), 0, 'not in Subscriptions');
  assert.deepEqual(errors, []);
});

test('Dues: an unpaid custom sale shows without a ref', async () => {
  const { page, errors } = await open();
  await saveCustomItem(page, { title: 'Tinder Premium', price: 600, cost: 450 });
  await page.locator('#save').click();
  await toastOf(page, 'saved').waitFor();
  await nav(page, 'Dues');
  // Dues shows the first word of the product name (productShort): the row reads "Tinder · ..." with no ref.
  await page.getByText('Tinder', { exact: false }).first().waitFor();
  const lines = (await page.locator('#screen').innerText()).split('\n').filter(l => l.indexOf('Tinder') >= 0);
  assert.ok(lines.length > 0, 'the unpaid custom sale is listed in Dues');
  assert.ok(lines.every(l => l.indexOf('ref ') < 0), 'no ref on a custom sale: ' + JSON.stringify(lines));
  assert.deepEqual(errors, []);
});

test('Money Profit: the Custom category appears with its revenue', async () => {
  const { page, errors } = await open();
  await saveCustomItem(page, { title: 'Tinder Premium', price: 600, cost: 450, paid: 600 });
  await page.locator('#save').click();
  await toastOf(page, 'saved').waitFor();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByRole('heading', { name: 'By category' }).waitFor({ timeout: 10000 });
  const text = await page.locator('#screen').innerText();
  assert.match(text, /Custom/);
  assert.match(text, /600/);
  assert.deepEqual(errors, []);
});

test('New sale: product picker groups collapse, expand and survive a reload', async () => {
  const { page, errors } = await open();
  await quick(page, 'New sale');
  const tree = page.getByTestId('product-tree');
  const group = () => page.getByTestId('product-tree').getByRole('button', { name: /^Subscription/ }).first();
  const netflix = () => page.getByTestId('product-tree').getByRole('button', { name: 'Netflix Premium profile', exact: true });
  await netflix().waitFor();
  assert.equal(await group().getAttribute('aria-expanded'), 'true');
  await group().click();
  assert.equal(await group().getAttribute('aria-expanded'), 'false');
  assert.equal(await netflix().count(), 0, 'collapsed group hides its products');
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await quick(page, 'New sale');
  await tree.waitFor();
  assert.equal(await group().getAttribute('aria-expanded'), 'false', 'collapsed state survives reload');
  await group().click();
  await netflix().waitFor();
  assert.deepEqual(errors, []);
});

test('New sale: typing "na" lists the matching customers', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  const base = st.customers[0];
  st.customers.push(Object.assign({}, base, { Customer_ID: 'C9001', Name: 'Nafis', Handle: '' }), Object.assign({}, base, { Customer_ID: 'C9002', Name: 'nakib', Handle: '' }));
  const { page, errors } = await open({ state: st });
  await quick(page, 'New sale');
  const input = page.getByRole('combobox', { name: 'Customer' });
  await input.fill('na');
  const list = page.getByRole('listbox');
  await list.getByRole('option', { name: /Nafis/ }).waitFor();
  await list.getByRole('option', { name: /nakib/ }).waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.notEqual(await input.inputValue(), 'na', 'keyboard pick fills the field');
  assert.deepEqual(errors, []);
});

test('Customer field: Escape closes the list but keeps the text and the sheet; a second Escape closes the sheet', async () => {
  const { page, errors } = await open();
  await quick(page, 'New sale');
  const input = page.getByRole('combobox', { name: 'Customer' });
  await input.fill('ka');
  await page.getByRole('listbox').waitFor();
  await input.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), 'ka');
  assert.ok(await page.getByRole('button', { name: 'Save sale' }).isVisible(), 'sheet still open');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Save sale' }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('A code product in another category is treated as a code product', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  const base = st.products.find(p => p.Category === 'Game Code');
  st.products.push(Object.assign({}, base, { Product_ID: 'GIFTX', Product_Name: 'Zed Gift Card', Category: 'Gift Cards', Delivers_As: 'code', Letter: 'Z' }));
  const { page, errors } = await open({ state: st });
  await quick(page, 'New sale');
  await page.getByTestId('product-tree').getByRole('button', { name: 'Zed Gift Card', exact: true }).click();
  await page.getByText('No codes in stock', { exact: false }).waitFor();
  assert.equal(await page.getByText('+ Add account').count(), 0, 'code controls, not account controls');
  await page.keyboard.press('Escape');
  await nav(page, 'More');
  await page.locator('[data-more="accounts"]').click();
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByRole('button', { name: 'Netflix Premium profile', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Zed Gift Card', exact: true }).count(), 0, 'not offered for an account');
  assert.deepEqual(errors, []);
});

test('Accounts sheet groups products in the collapsible tree', async () => {
  const { page, errors } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="accounts"]').click();
  const tree = page.getByTestId('product-tree');
  await tree.waitFor();
  const group = tree.getByRole('button', { name: /^Subscription/ }).first();
  await group.click();
  assert.equal(await group.getAttribute('aria-expanded'), 'false');
  assert.equal(await tree.getByText('Netflix Premium profile').count(), 0);
  assert.deepEqual(errors, []);
});

// ── Phase 1 editing: Match sheet, edit payment, line and customer actions ──
const confirmIn = (page, name) => page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click();
async function openCustomer(page, name) {
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill(name);
  await page.getByText(name, { exact: true }).first().click();
}
const todayMatch = (page, trx) => page.getByTestId('unm-' + trx).getByRole('button', { name: 'Match' }).click();

test('Match: an adjusted amount is the recorded payment, and the inbox row is matched', async () => {
  const { page, errors, rows } = await open();
  await todayMatch(page, 'TESTTRX1');
  await page.locator('#mCustomer').fill('Kabir');
  await page.getByRole('option', { name: /^Kabir/ }).first().click();
  await page.getByText('Adjust amount, date or method').click();
  assert.equal(await page.locator('#mAmount').inputValue(), '290', 'prefilled from the SMS');
  await page.locator('#mAmount').fill('250');
  await page.locator('#mNote').fill('paid by his brother');
  await page.locator('#save').click();
  await toastOf(page, /Kabir/).waitFor();
  const pay = rows('Payments').find(p => p.transaction_id === 'TESTTRX1');
  assert.ok(pay, 'payment recorded');
  assert.equal(Number(pay.amount), 250, 'the changed amount, not the SMS amount');
  assert.equal(pay.note, 'paid by his brother');
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'TESTTRX1').status, 'Matched');
  assert.deepEqual(errors, []);
});

// A Netflix line (sale 44, customer farid) at 300 a month, expired on 2026-10-09, and a 1,200 Tk payment to split.
function splitState() {
  const st = makeUiState();
  const line = st.sales.find(s => s.Sub_Code === 'N44');
  line.Unit_Price = 300; line.Paid_Till = '2026-10-09';
  st.inbox.push({ Received: '2026-10-25 21:06', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 1200,
    Transaction_ID: 'DJP2JBSWHA', Reference: '', Status: 'Pending', Matched_Sale_ID: '',
    Raw_SMS: 'Cash In Tk 1,200.00 from 01XXXXXXXXX successful TrxID DJP2JBSWHA' });
  return st;
}

test('Match split: Netflix 2 months plus a custom item uses the whole payment', async () => {
  const { page, errors, rows } = await open({ state: splitState() });
  await todayMatch(page, 'DJP2JBSWHA');
  await page.locator('#mCustomer').fill('farid');
  await page.getByRole('option', { name: /^farid/ }).first().click();
  await page.locator('#splitToggle').click();
  await page.locator('#sLine-0').selectOption('N44');
  await page.locator('#sMonths-0').fill('2');
  assert.equal(await page.locator('#sPrice-0').inputValue(), '300', 'price per month from the line');
  assert.equal(await page.locator('#sFrom-0').inputValue(), 'oldPaidTill');
  assert.equal(await page.locator('#sTill-0').inputValue(), '2026-12-09', 'computed from the old paid-till');
  await page.locator('#sTill-0').fill('2026-11-09');
  await page.locator('#splitAdd').click();
  await page.locator('#sKind-1').selectOption('custom');
  await page.locator('#sTitle-1').fill('Tinder Premium');
  await page.locator('#sAmt-1').fill('600');
  await page.locator('#sCost-1').fill('450');
  assert.match(await page.getByTestId('split-left').innerText(), /৳0/);
  await page.locator('#save').click();
  await toastOf(page, /farid/i).waitFor();
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'DJP2JBSWHA').status, 'Matched');
  assert.equal(rows('Sales_Log').find(s => String(s.sale_id) === '44').record_status, 'Renewed');
  const renewal = rows('Sales_Log').find(s => s.sub_code === 'N44' && s.record_status === 'Active');
  assert.equal(Number(renewal.months), 2);
  assert.equal(Number(renewal.unit_price), 300);
  assert.equal(renewal.paid_till, '2026-11-09');
  const custom = rows('Sales_Log').find(s => s.product_id === 'CUSTOM');
  assert.equal(custom.notes, 'Tinder Premium');
  assert.equal(Number(custom.unit_price), 600);
  assert.equal(Number(custom.cost_snapshot), 450);
  const pays = rows('Payments').filter(p => p.transaction_id === 'DJP2JBSWHA');
  assert.equal(pays.length, 2);
  assert.deepEqual(pays.map(p => Number(p.amount)).sort((a, b) => a - b), [600, 600]);
  assert.ok(pays.every(p => p.date === '2026-10-25'));
  assert.deepEqual(errors, []);
});

test('Match split: left to assign is shown and Save is refused with an unassigned remainder', async () => {
  const { page, errors, rows } = await open({ state: splitState() });
  await todayMatch(page, 'DJP2JBSWHA');
  await page.locator('#mCustomer').fill('farid');
  await page.getByRole('option', { name: /^farid/ }).first().click();
  await page.locator('#splitToggle').click();
  await page.locator('#sKind-0').selectOption('custom');
  await page.locator('#sTitle-0').fill('Tinder Premium');
  await page.locator('#sAmt-0').fill('450');
  assert.match(await page.getByTestId('split-left').innerText(), /৳750/);
  await page.locator('#save').click();
  await page.getByText('৳750 of the payment is not assigned').waitFor();
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'DJP2JBSWHA').status, 'Pending', 'nothing written');
  await page.locator('#splitCredit').click();
  await page.locator('#save').click();
  await toastOf(page, /farid/i).waitFor();
  const credit = rows('Payments').find(p => p.transaction_id === 'DJP2JBSWHA' && !p.sale_id && Number(p.amount) === 750);
  assert.ok(credit, 'the 750 left over is kept as credit');
  assert.deepEqual(errors, []);
});

test('Match split: removing a row updates the total', async () => {
  const { page, errors } = await open({ state: splitState() });
  await todayMatch(page, 'DJP2JBSWHA');
  await page.locator('#splitToggle').click();
  await page.locator('#sKind-0').selectOption('custom');
  await page.locator('#sAmt-0').fill('100');
  await page.locator('#splitAdd').click();
  await page.locator('#sKind-1').selectOption('custom');
  await page.locator('#sAmt-1').fill('200');
  assert.match(await page.getByTestId('split-left').innerText(), /৳900/);
  await page.locator('#sRemove-1').click();
  assert.match(await page.getByTestId('split-left').innerText(), /৳1,?100/);
  assert.equal(await page.locator('[data-testid^="split-row-"]').count(), 1);
  assert.deepEqual(errors, []);
});

test('Match: Not a sale ignores the row after a confirm', async () => {
  const { page, errors, rows } = await open();
  await todayMatch(page, 'TESTTRX1');
  await page.locator('#mIgnore').click();
  await confirmIn(page, 'Not a sale');
  await toastOf(page, 'Message ignored').waitFor();
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'TESTTRX1').status, 'Ignored');
  await page.getByTestId('unm-TESTTRX1').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('Match: Delete removes the row after a confirm', async () => {
  const { page, errors, rows } = await open();
  await todayMatch(page, 'TESTTRX1');
  await page.locator('#mDelete').click();
  await confirmIn(page, 'Delete');
  await toastOf(page, 'Message deleted').waitFor();
  assert.equal(rows('Payment_Inbox').filter(r => r.transaction_id === 'TESTTRX1').length, 0);
  assert.deepEqual(errors, []);
});

test('Match: an over-cap row shows why it was not matched by itself', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  st.inbox.push({ Received: '2026-10-18 15:00', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 6000, Transaction_ID: 'CAPTRX1',
    Reference: 'N44', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'Cap test message' });
  const { page, errors } = await open({ state: st });
  await todayMatch(page, 'CAPTRX1');
  await page.locator('#mWhy').waitFor();
  assert.match(await page.locator('#mWhy').innerText(), /auto-match limit/);
  assert.deepEqual(errors, []);
});

test('Match: a new customer can be made from the sheet', async () => {
  const { page, errors, rows } = await open();
  await todayMatch(page, 'TESTTRX1');
  await page.locator('#mCustomer').fill('Brand New Buyer');
  await page.getByText('Add new customer "Brand New Buyer"').click();
  await page.locator('#save').click();
  await toastOf(page, /Brand New Buyer/).waitFor();
  assert.ok(rows('Customers').some(c => c.name === 'Brand New Buyer'));
  assert.equal(Number(rows('Payments').find(p => p.transaction_id === 'TESTTRX1').amount), 290);
  assert.deepEqual(errors, []);
});

function withCredit() {
  const { makeUiState } = require('../support/seed');
  const { cid } = require('../fixtures');
  const st = makeUiState();
  st.payments.push({ Payment_ID: 'PM-09002', Date: '2026-10-10', Customer_ID: cid(st, 'farid'), Sale_ID: '', Amount: 2290, Method: 'bKash', Source: 'App' });
  return st;
}

test('Edit a credit from 2290 to 2180 and the customer sheet updates', async () => {
  const { page, errors, rows } = await open({ state: withCredit() });
  await openCustomer(page, 'farid');
  const custSheet = page.getByRole('dialog', { name: 'farid', exact: true });
  await custSheet.getByText('credit ৳2,290').waitFor();
  await page.getByTestId('pay-PM-09002').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#pAmount').waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Edit credit' }).count(), 1, 'the title says credit');
  await page.locator('#pAmount').fill('2180');
  await page.locator('#save').click();
  await toastOf(page, 'Payment saved').waitFor();
  await custSheet.getByText('credit ৳2,180').waitFor();
  assert.equal(Number(rows('Payments').find(p => p.payment_id === 'PM-09002').amount), 2180);
  assert.deepEqual(errors, []);
});

test('Edit payment: Delete asks first, then removes the row', async () => {
  const { page, errors, rows } = await open({ state: withCredit() });
  await openCustomer(page, 'farid');
  await page.getByTestId('pay-PM-09002').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#pDelete').click();
  await confirmIn(page, 'Delete');
  await toastOf(page, 'Payment deleted').waitFor();
  assert.equal(rows('Payments').filter(p => p.payment_id === 'PM-09002').length, 0);
  assert.deepEqual(errors, []);
});

test('Edit payment: a used-credit refusal is shown inside the sheet', async () => {
  const st = withCredit();
  const { cid } = require('../fixtures');
  const f = cid(st, 'farid');
  st.payments.push({ Payment_ID: 'PM-09003', Date: '2026-10-11', Customer_ID: f, Sale_ID: 44, Amount: 2200, Method: '', Source: 'Credit' });
  st.payments.push({ Payment_ID: 'PM-09004', Date: '2026-10-11', Customer_ID: f, Sale_ID: '', Amount: -2200, Method: '', Source: 'Credit' });
  const { page, errors } = await open({ state: st });
  await openCustomer(page, 'farid');
  await page.getByTestId('pay-PM-09002').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#pAmount').fill('50');
  await page.locator('#save').click();
  await page.getByRole('alert').filter({ hasText: 'already used' }).waitFor();
  assert.ok(await page.locator('#pAmount').isVisible(), 'sheet stays open');
  assert.deepEqual(errors, []);
});

test('End a line and find it in Accounts, Retired', async () => {
  const { page, errors, rows } = await open();
  await openCustomer(page, 'farid');
  await page.getByTestId('line-N44').getByRole('button', { name: 'End line' }).click();
  assert.equal(await page.locator('#elDate').inputValue(), '2026-10-18', 'defaults to today');
  await page.locator('#elDate').fill('2026-10-17');
  await page.locator('#save').click();
  await toastOf(page, 'Line ended').waitFor();
  const sale = rows('Sales_Log').find(s => s.sub_code === 'N44' && s.record_status === 'Ended');
  assert.ok(sale, 'sale marked Ended');
  assert.equal(sale.paid_till, '2026-10-17');
  await page.getByTestId('line-N44').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await nav(page, 'Accounts');
  await page.getByTestId('retired-tab').click();
  const ended = page.getByTestId('ended-N44');
  await ended.waitFor();
  assert.match(await ended.innerText(), /farid/);
  assert.deepEqual(errors, []);
});

test('Void a line from the customer sheet after a confirm', async () => {
  const { page, errors, rows } = await open();
  await openCustomer(page, 'farid');
  await page.getByTestId('line-N44').getByRole('button', { name: 'Void' }).click();
  await confirmIn(page, 'Void line');
  await toastOf(page, 'Changes saved').waitFor();
  assert.ok(rows('Sales_Log').some(s => s.sub_code === 'N44' && s.record_status === 'Void'));
  await page.getByTestId('line-N44').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('Edit a line: cost and notes are saved', async () => {
  const { page, errors, rows } = await open();
  await openCustomer(page, 'farid');
  await page.getByTestId('line-N44').getByRole('button', { name: 'Edit' }).click();
  await page.locator('#sCost').fill('180');
  await page.locator('#sNotes').fill('2050 VP special');
  await page.locator('#save').click();
  await toastOf(page, 'Changes saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.sub_code === 'N44' && s.record_status === 'Active');
  assert.equal(Number(sale.cost_snapshot), 180);
  assert.equal(sale.notes, '2050 VP special');
  assert.deepEqual(errors, []);
});

test('Customer note is saved from the customer sheet', async () => {
  const { page, errors, rows } = await open();
  await openCustomer(page, 'farid');
  await page.locator('#custNote').click();
  await page.locator('#cnNotes').fill('prefers evenings');
  await page.locator('#save').click();
  await toastOf(page, 'Changes saved').waitFor();
  assert.ok(rows('Customers').some(c => c.name === 'farid' && c.notes === 'prefers evenings'));
  assert.deepEqual(errors, []);
});

test('Merge two customers: payments move, the duplicate is removed', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  const base = st.customers.find(c => c.Name === 'Kabir');
  st.customers.push(Object.assign({}, base, { Customer_ID: 'C9001', Name: 'Zed dup', Handle: '', Channel: '' }));
  st.payments.push({ Payment_ID: 'PM-09005', Date: '2026-10-10', Customer_ID: 'C9001', Sale_ID: '', Amount: 50, Method: 'bKash', Source: 'App' });
  const { page, errors, rows } = await open({ state: st });
  await openCustomer(page, 'Zed dup');
  await page.locator('#custMerge').click();
  await page.locator('#mgTarget').fill('Kabir');
  await page.getByRole('option', { name: /^Kabir/ }).first().click();
  assert.match(await page.locator('#mgText').innerText(), /Zed dup/);
  await page.locator('#save').click();
  await toastOf(page, 'Customers merged').waitFor();
  assert.equal(rows('Customers').filter(c => c.customer_id === 'C9001').length, 0);
  assert.equal(rows('Payments').find(p => p.payment_id === 'PM-09005').customer_id, base.Customer_ID);
  assert.match(rows('Customers').find(c => c.customer_id === base.Customer_ID).notes, /Merged from Zed dup/);
  assert.deepEqual(errors, []);
});

// ── Phase 1 editing: product form, account delete, Book entry detail, supplier form ──
test('Product form: a code product with its own category, then a variant nested under it', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="newProduct"]').click();
  await page.locator('#pName').fill('Valorant');
  await page.locator('#pCat').fill('Game top-up');
  await page.locator('#pDelivers').selectOption('code');
  await page.locator('#pLetter').fill('V');
  await page.locator('#pCodeCost').fill('90');
  await page.locator('#pPrice').fill('100');
  await page.locator('#save').click();
  await toastOf(page, 'Valorant added').waitFor();
  const v = rows('Product_Catalog').find(p => p.product_name === 'Valorant');
  assert.equal(v.category, 'Game top-up');
  assert.equal(v.delivers_as, 'code');
  assert.equal(v.parent_id || '', '');

  await page.locator('[data-more="newProduct"]').click();
  await page.locator('#pName').fill('VP 2050');
  await page.locator('#pCat').fill('Game top-up');
  await page.locator('#pDelivers').selectOption('code');
  await page.locator('#pLetter').fill('VP');
  await page.locator('#pParent').selectOption({ label: 'Valorant' });
  await page.locator('#pCodeCost').fill('900');
  await page.locator('#pPrice').fill('1000');
  await page.locator('#save').click();
  await toastOf(page, 'VP 2050 added').waitFor();
  assert.equal(rows('Product_Catalog').find(p => p.product_name === 'VP 2050').parent_id, 'VALORANT');

  await nav(page, 'Today');
  await quick(page, 'New sale');
  const tree = page.getByTestId('product-tree');
  await tree.getByRole('button', { name: 'Valorant', exact: true }).waitFor();
  const nested = await tree.getByRole('button', { name: 'VP 2050', exact: true }).evaluate(b => !!b.closest('ul.border-l'));
  assert.ok(nested, 'the variant sits inside its parent');
  assert.deepEqual(errors, []);
});

test('Product form: a taken letter is refused inside the sheet; letters in use are listed', async () => {
  const { page, errors } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="newProduct"]').click();
  await page.getByText(/Letters in use:.*N/).waitFor();
  await page.locator('#pName').fill('Another');
  await page.locator('#pLetter').fill('N');
  await page.locator('#pCost').fill('100');
  await page.locator('#pPrice').fill('50');
  await page.locator('#save').click();
  await page.getByRole('alert').filter({ hasText: 'already used' }).waitFor();
  assert.ok(await page.locator('#pName').isVisible(), 'sheet stays open');
  assert.deepEqual(errors, []);
});

test('Edit product: rename and move a product from the Accounts sheet', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="accounts"]').click();
  await page.getByRole('button', { name: 'Edit Netflix Premium profile', exact: true }).click();
  await page.locator('#pName').fill('Netflix Plus');
  await page.locator('#pCat').fill('Streaming');
  await page.locator('#pPrice').fill('310');
  await page.locator('#save').click();
  await toastOf(page, 'Product updated').waitFor();
  const n = rows('Product_Catalog').find(p => p.product_id === 'NETFLIX');
  assert.equal(n.product_name, 'Netflix Plus');
  assert.equal(n.category, 'Streaming');
  assert.equal(Number(n.default_price), 310);
  await page.getByTestId('product-tree').getByText('Netflix Plus').waitFor();
  assert.deepEqual(errors, []);
});

test('Delete an unused account: it vanishes, the money totals stay', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  const totals = async () => {
    await nav(page, 'Money');
    await page.getByRole('tab', { name: 'Profit' }).click();
    await page.getByText('Net profit').waitFor();
    await page.getByTestId('rate-line').waitFor();
    const profit = await page.locator('#screen').innerText();
    await page.getByRole('tab', { name: 'Book' }).click();
    await page.getByText('Net this month').waitFor();
    const text = await page.locator('#screen').innerText();
    // The figures only, up to the entries list. Both markers must be there, so a missing one cannot cut the text short.
    const from = text.search(/net this month/i), to = text.search(/entries/i);
    assert.ok(from >= 0 && to > from, 'the Book figures and entries are on screen');
    return { profit, book: text.slice(from, to) };
  };
  const before = await totals();
  await nav(page, 'Accounts');
  const card = page.getByTestId('acct-ICL-01');
  await card.getByRole('button', { name: 'Edit account' }).click();
  await page.locator('#deleteKeep').click();
  const dlg = page.getByRole('alertdialog');
  assert.match(await dlg.innerText(), /sales, purchases and profit stay/i);
  await confirmIn(page, 'Delete account');
  await toastOf(page, 'ICL-01 deleted').waitFor();
  assert.equal(rows('Accounts').find(a => a.account_id === 'ICL-01').account_status, 'Deleted');
  await card.waitFor({ state: 'detached' });
  const after = await totals();
  assert.equal(after.profit, before.profit, 'Profit unchanged');
  assert.equal(after.book, before.book, 'Book unchanged');
  // The purchase kept its account: its row still shows the id, though the account is no longer listed.
  const purchase = bookRow(page, 'ICL-01 renewal');
  await purchase.waitFor();
  assert.match(await purchase.getByRole('button', { name: /^Edit Account for purchase / }).getAttribute('aria-label'), /ICL-01/);
  assert.deepEqual(errors, []);
});

test('Delete an account with a live seat: the server message shows in the sheet', async () => {
  const { page, errors, rows } = await open({ viewport: { width: 1280, height: 800 } });
  await nav(page, 'Accounts');
  await page.getByTestId('acct-NFX-01').getByRole('button', { name: 'Edit account' }).click();
  await page.locator('#deleteKeep').click();
  await confirmIn(page, 'Delete account');
  await page.getByRole('alert').filter({ hasText: /NFX-01 still has 4 customers using a seat/ }).waitFor();
  assert.ok(await page.locator('#acLabel').isVisible(), 'sheet stays open');
  assert.equal(rows('Accounts').find(a => a.account_id === 'NFX-01').account_status, 'Active');
  assert.deepEqual(errors, []);
});

function withEntries() {
  const { makeUiState } = require('../support/seed');
  const { cid } = require('../fixtures');
  const st = makeUiState();
  st.payments.push({ Payment_ID: 'PM-09100', Date: '2026-10-18', Customer_ID: cid(st, 'farid'), Sale_ID: '', Amount: 500, Method: 'bKash', Transaction_ID: 'TRXDETAIL1', Source: 'App' });
  st.inbox.push({ Received: '2026-10-18 10:00', Type: 'Received', Method: 'bKash', Sender: '+8801700000000', Amount: 500,
    Transaction_ID: 'TRXDETAIL1', Reference: '', Status: 'Matched', Matched_Sale_ID: '', Raw_SMS: 'You have received Tk 500.00 from 01700000000. TrxID TRXDETAIL1' });
  return st;
}
// A Book row is found by its text; its Details button opens the entry sheet (the row's cells are edited in place).
const bookRow = (page, text) => page.locator('[data-testid^="entry-"]').filter({ hasText: text });
const bookDetails = (page, text) => bookRow(page, text).getByRole('button', { name: 'Details', exact: true });

test('Book: tap a payment to see its transaction id and SMS, then delete it', async () => {
  const { page, errors, rows } = await open({ state: withEntries() });
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await bookDetails(page, /farid.*500/).click();
  const sheet = page.getByRole('dialog', { name: 'Payment PM-09100' });
  await sheet.getByText('TRXDETAIL1', { exact: true }).waitFor();
  await sheet.getByText('farid').first().waitFor();
  await sheet.getByText('Raw message').click();
  await sheet.getByText(/You have received Tk 500/).waitFor();
  await sheet.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmIn(page, 'Delete');
  await toastOf(page, 'Payment deleted').waitFor();
  assert.equal(rows('Payments').filter(p => p.payment_id === 'PM-09100').length, 0);
  await page.waitForFunction(() => !document.querySelector('#screen').innerText.includes('farid'));
  assert.deepEqual(errors, []);
});

test('Book: a payment entry opens the payment editor and shows its audit trail after a change', async () => {
  const { page, errors, rows } = await open({ state: withEntries() });
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await bookDetails(page, /farid.*500/).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#pAmount').fill('450');
  await page.locator('#save').click();
  await toastOf(page, 'Payment saved').waitFor();
  const sheet = page.getByRole('dialog', { name: 'Payment PM-09100' });
  await sheet.getByRole('list', { name: 'Audit trail' }).getByText(/Amount/).first().waitFor();
  assert.equal(Number(rows('Payments').find(p => p.payment_id === 'PM-09100').amount), 450);
  assert.deepEqual(errors, []);
});

test('Book: an expense can be opened, edited and deleted', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.locator('#addExpense').click();
  await page.locator('#xAmt').fill('120');
  await page.locator('#xNote').fill('office tea');
  await page.locator('#save').click();
  await toastOf(page, 'Expense saved').waitFor();
  await bookDetails(page, /office tea/).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#xAmt').fill('150');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.body.innerText.includes('Expense saved'));
  assert.equal(Number(rows('Expenses')[0].amount), 150);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmIn(page, 'Delete');
  await toastOf(page, 'Expense deleted').waitFor();
  assert.equal(rows('Expenses').length, 0);
  assert.deepEqual(errors, []);
});

test('Book: a purchase entry can be opened and edited', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await bookDetails(page, /EXL-01 renewal/).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#uAmt').fill('2900');
  await page.locator('#save').click();
  await toastOf(page, 'Purchase saved').waitFor();
  assert.equal(Number(rows('Purchases').find(p => p.purchase_id === 'P-0001').amount), 2900);
  assert.deepEqual(errors, []);
});

test('Book: money amounts show a sign and a colour (income +, expense and purchase -), and say which in the accessible name', async () => {
  const st = withEntries();
  st.expenses = [{ Expense_ID: 'EX-SIGN1', Date: '2026-10-18', Category: 'VPN', Amount: 150, Paid_With: 'UNKNOWN', Note: '' }];
  const { page, errors } = await open({ state: st });
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.getByText('Net this month').waitFor();
  const income = page.getByRole('button', { name: /^Edit Amount for payment PM-09100: \+৳500 \(income\)\. / });
  await income.waitFor();
  assert.match(await income.locator('span').first().getAttribute('class'), /text-ok/);
  const expense = page.getByRole('button', { name: /^Edit Amount for expense EX-SIGN1: −৳150 \(expense\)\. / });
  await expense.waitFor();
  assert.match(await expense.locator('span').first().getAttribute('class'), /text-bad/);
  const purchase = page.getByRole('button', { name: /^Edit Amount for purchase P-[^:]+: −৳[\d,]+ \(expense\)\. / }).first();
  await purchase.waitFor();
  assert.match(await purchase.locator('span').first().getAttribute('class'), /text-bad/);
  assert.deepEqual(errors, []);
});

function withSupplier() {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  st.suppliers = [{ Supplier_ID: 'SUP-01', Name: 'Bybit Vendor', Contact: '@bybitvendor', Currency: 'USDT', Markup_Percent: 3, Notes: '', Contact_Channel: 'Telegram' }];
  st.products.find(p => p.Product_ID === 'HONE').Supplier_ID = 'SUP-01';
  return st;
}

test('Suppliers: the list shows channel and what each supplies; the form edits the channel', async () => {
  const { page, errors, rows } = await open({ state: withSupplier() });
  await nav(page, 'More');
  await page.locator('[data-more="suppliers"]').click();
  const list = page.getByRole('dialog', { name: 'Suppliers' });
  await list.getByText(/Telegram/).first().waitFor();
  await list.getByText(/Supplies: Hone key/).waitFor();
  await page.locator('[data-sup-edit="SUP-01"]').click();
  assert.equal(await page.locator('#sChannel').inputValue(), 'Telegram');
  assert.equal(await page.locator('#sContact').inputValue(), '@bybitvendor');
  assert.deepEqual(await page.locator('#sChannel option').allTextContents(), ['Not set', 'Telegram', 'WhatsApp', 'Facebook', 'Email', 'Other']);
  await page.getByRole('dialog', { name: 'Edit supplier' }).getByText('Supplies: Hone key').waitFor();
  await page.locator('#sChannel').selectOption('WhatsApp');
  await page.locator('#sContact').fill('01711000000');
  await page.locator('#save').click();
  await toastOf(page, 'Supplier updated').waitFor();
  const s = rows('Suppliers').find(x => x.supplier_id === 'SUP-01');
  assert.equal(s.contact_channel, 'WhatsApp');
  assert.equal(s.contact, '01711000000');
  assert.deepEqual(errors, []);
});

test('Suppliers: a new supplier is saved with its channel and handle', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'More');
  await page.locator('[data-more="suppliers"]').click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.locator('#sName').fill('Chan Sup');
  assert.equal(await page.locator('#sContact').count(), 0, 'no handle field until a channel is chosen');
  await page.locator('#sChannel').selectOption('Telegram');
  await page.locator('#sContact').fill('@chansup');
  await page.locator('#save').click();
  await toastOf(page, 'Supplier added').waitFor();
  const s = rows('Suppliers').find(x => x.name === 'Chan Sup');
  assert.equal(s.contact_channel, 'Telegram');
  assert.equal(s.contact, '@chansup');
  assert.deepEqual(errors, []);
});

test('Pay page: a custom link is paid, confirmed by Got paid, and then shows the code, the terms and the review links', async () => {
  const { makeUiState } = require('../support/seed');
  const state = makeUiState();
  state.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  state.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-UI-1234', Status: 'Available' });
  Object.assign(state.settings, { bkash_number: '01711223344', tos_text: 'No refunds after delivery.', review_discord_url: 'https://discord.gg/abc', review_facebook_url: 'javascript:alert(1)' });
  const { page, errors, api } = await open({ state, viewport: { width: 375, height: 800 } });
  const made = await api('createPayRequest', { requestId: 'ui-pay-1', title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Rafi' });
  assert.equal(made.ok, true, made.error);
  await page.goto(PAGE + 'pay/' + made.data.token);
  await page.getByRole('heading', { name: 'Gift card' }).waitFor();
  assert.ok(!(await page.content()).includes('SECRET-UI-1234'), 'no code before payment');
  await page.getByRole('button', { name: 'bKash' }).click();
  await page.locator('#num').fill('01911223344');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Put this in the reference box').waitFor();
  await page.getByRole('button', { name: 'I have paid' }).click();
  await page.getByText('Reported. We will confirm it shortly.').waitFor();
  // Bangla toggle re-labels the page without a reload.
  await page.locator('#lang-bn').click();
  await page.getByText('জানানো হয়েছে।').waitFor();
  await page.locator('#lang-en').click();
  // The owner confirms; the page learns of it on its next poll (made immediate here by the visibility handler).
  const got = await api('gotPaidRequest', { requestId: 'ui-pay-2', id: 'R1', trx: 'UITRX0001', method: 'bKash', amount: 500 });
  assert.equal(got.ok, true, got.error);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByText('SECRET-UI-1234').waitFor();
  await page.getByText('No refunds after delivery.').waitFor();
  await page.getByRole('heading', { name: 'Receipt' }).waitFor();
  const link = page.getByRole('link', { name: 'Review on Discord' });
  assert.equal(await link.getAttribute('href'), 'https://discord.gg/abc');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.getByRole('link', { name: 'Review on Facebook' }).count(), 0, 'a non-https review url is dropped');
  assert.equal(await page.getByRole('button', { name: 'Print' }).count(), 1);
  assert.deepEqual(errors, []);
});

// Delivery tab. A pay link is made and paid through the real edge router, then the tab is read.
function deliveryState() {
  const state = codeState();
  state.products.push({ Product_ID: 'NS', Product_Name: 'Seat show', Category: 'Streaming', Delivers_As: 'account', Letter: 'S', Default_Price: 300, Billing_Cycle_Days: 30, Active: 'Yes' });
  state.accounts.push({ Account_ID: 'NS-01', Product_ID: 'NS', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100 });
  Object.assign(state.settings, { tos_text: 'No refunds after delivery.', review_discord_url: 'https://discord.gg/abc' });
  return state;
}
async function paidLink(api, n, fields) {
  const made = await api('createPayRequest', { requestId: 'dl-make-' + n, customerName: 'Buyer ' + n, amount: 500, ...fields });
  assert.equal(made.ok, true, made.error);
  const got = await api('gotPaidRequest', { requestId: 'dl-paid-' + n, id: made.data.id || 'R' + n, trx: 'DLTRX000' + n, method: 'bKash', amount: fields.amount || 500 });
  assert.equal(got.ok, true, got.error);
  return made.data;
}
const deliveryTab = page => page.getByRole('button', { name: /^Delivery/ });

// The number keys follow the sidebar groups (Operate, Money, System). Inbox (uplift 4.1), Reminders (4.2) and Calendar (4.4) sit after Dues,
// so Reminders is 7, Calendar 8 and Money 9. Insights is the tenth entry now, so it has no number key. Pay links has no number key, and
// neither does More (only the first nine entries do); all of them open from the sidebar.
test('Delivery: nav sits between Accounts and Dues, 4 opens it, 5 opens Dues, More says 1-9 and L, More is last', async () => {
  const { page, errors } = await open(WIDE);
  const names = await page.locator('nav[aria-label="Sections"]').first().locator('button').allInnerTexts();
  assert.deepEqual(names.map(t => t.replace(/\d|\s|pending/g, '')), ['Today', 'Customers', 'Accounts', 'Delivery', 'Dues', 'Inbox', 'Reminders', 'Calendar', 'Money', 'Insights', 'Paylinks', 'Activity', 'Settings', 'More']);
  await page.keyboard.press('4');
  await page.getByTestId('delivery-list').waitFor();
  assert.match(await page.evaluate(() => location.hash), /delivery/);
  assert.match(await page.locator('#screen').innerText(), /Nothing to deliver/);
  await page.keyboard.press('5');
  await page.getByTestId('dues-list').waitFor();
  await nav(page, 'More');
  await page.locator('[data-more="delivery"]').waitFor();
  assert.match(await page.locator('#screen').innerText(), /1.9 screens/);
  assert.match(await page.locator('#screen').innerText(), /L new link/);
  assert.deepEqual(errors, []);
});

test('Delivery: a paid key link is Delivered, a paid seat link is Pending until Mark delivered, and the badge follows', async () => {
  const { page, errors, rows, api } = await open({ ...WIDE, state: deliveryState() });
  await paidLink(api, 1, { title: 'Gift card', productId: 'GC' });
  await paidLink(api, 2, { title: 'Seat show', productId: 'NS', amount: 300 });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await deliveryTab(page).getByTestId('delivery-badge').waitFor();
  assert.equal(await deliveryTab(page).getByTestId('delivery-badge').innerText(), '1');
  await deliveryTab(page).click();
  await page.getByTestId('delivery-list').waitFor();
  const chip = name => page.getByRole('button', { name: new RegExp('^' + name + ' ') });
  assert.match(await chip('All').innerText(), /2$/);
  await chip('Delivered').click();
  const done = page.getByTestId('delivery-list').locator('[data-testid^="delivery-"]');
  assert.equal(await done.count(), 1);
  assert.match(await done.first().innerText(), /Buyer 1/);
  assert.match(await done.first().innerText(), /Delivered/);
  await chip('Pending').click();
  const row = page.getByTestId('delivery-list').locator('[data-testid^="delivery-"]').first();
  assert.match(await row.innerText(), /Buyer 2/);
  assert.match(await row.innerText(), /Pending/);
  await row.getByRole('button', { name: 'Mark delivered' }).click();
  await page.getByTestId('delivery-list').getByText('Nothing here', { exact: false }).waitFor();
  await deliveryTab(page).getByTestId('delivery-badge').waitFor({ state: 'detached' });
  assert.equal(rows('Deliveries').filter(d => d.status === 'Delivered').length, 2);
  await chip('Delivered').click();
  assert.equal(await page.getByTestId('delivery-list').locator('[data-testid^="delivery-"]').count(), 2);
  assert.deepEqual(errors, []);
});

test('Delivery: Mark failed and Mark ready move a row between filters', async () => {
  const { page, errors, api } = await open({ ...WIDE, state: deliveryState() });
  await paidLink(api, 1, { title: 'Seat show', productId: 'NS', amount: 300 });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await deliveryTab(page).click();
  const chip = name => page.getByRole('button', { name: new RegExp('^' + name + ' ') });
  const row = () => page.getByTestId('delivery-list').locator('[data-testid^="delivery-"]').first();
  await row().getByRole('button', { name: 'Mark ready' }).click();
  await chip('Ready').click();
  await row().getByText('Ready').first().waitFor();
  await row().getByRole('button', { name: 'Mark failed' }).click();
  await chip('Failed').click();
  await row().getByText('Failed').first().waitFor();
  assert.equal(await chip('Failed').innerText(), 'Failed · 1');
  assert.deepEqual(errors, []);
});

test('Delivery: Resend copies a message with the order link, the terms and the review link, never the code', async () => {
  const { page, errors, api } = await open({ ...WIDE, state: deliveryState() });
  await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); });
  const made = await paidLink(api, 1, { title: 'Gift card', productId: 'GC' });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); });
  await deliveryTab(page).click();
  const row = page.getByTestId('delivery-list').locator('[data-testid^="delivery-"]').first();
  assert.equal(await page.getByTestId('delivery-list').innerText().then(t => t.includes('SECRET-UI-1234')), false, 'code is not on the tab');
  await row.getByRole('button', { name: 'Resend' }).click();
  await toastOf(page, 'Copied').waitFor();
  const copied = await page.evaluate(() => window.__copied);
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes('/pay/' + made.token), 'order link');
  assert.ok(copied[0].includes('No refunds after delivery.'), 'terms');
  assert.ok(copied[0].includes('https://discord.gg/abc'), 'review link');
  assert.ok(!copied[0].includes('SECRET-UI-1234'), 'never the code');
  assert.match(await row.getByRole('link', { name: /Open order/ }).getAttribute('href'), new RegExp('/pay/' + made.token + '$'));
  assert.deepEqual(errors, []);
});

test('Delivery: on a phone it is reached from More, which shows the Pending count, and nothing scrolls sideways', async () => {
  const { page, errors, api } = await open({ state: deliveryState() });
  await paidLink(api, 1, { title: 'Seat show', productId: 'NS', amount: 300 });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Delivery/ }).count(), 0, 'not in the bottom dock');
  await nav(page, 'More');
  assert.match(await page.locator('[data-more="delivery"]').innerText(), /1 pending/);
  await page.locator('[data-more="delivery"]').click();
  await page.getByTestId('delivery-list').waitFor();
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth) <= 360);
  assert.deepEqual(errors, []);
});

// ── Widget menu, goals and budgets ────────────────────────────────────
const widgetOrder = page => page.locator('[data-testid^="widget-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid').replace('widget-', '')));
const withLayout = layout => st => { st.settings = Object.assign({}, st.settings, { money_layout: layout }); };

test('Add Goals from the + menu, create a goal, see its title at 0%', async () => {
  const { page, errors, tables } = await openOverview();
  await page.getByTestId('widget-net').waitFor();
  assert.equal(await page.getByTestId('widget-goals').count(), 0);
  await page.locator('#addWidget').click();
  await page.getByRole('button', { name: 'Add Goals' }).click();
  await page.locator('#goalTitle').waitFor();
  await page.locator('#goalTitle').fill('Winter push');
  await page.locator('#goalMetric').selectOption('revenue');
  await page.locator('#goalTarget').fill('50000');
  await page.locator('#goalStart').fill('2026-12-01');
  await page.locator('#goalEnd').fill('2026-12-31');
  await page.locator('#save').click();
  const w = page.getByTestId('widget-goals');
  await w.getByText('Winter push', { exact: true }).waitFor();
  assert.match(await w.innerText(), /0%/);
  assert.equal(tables.goals.size, 1);
  assert.deepEqual(errors, []);
});

test('A goal ring updates after a payment is recorded', async () => {
  const goal = { Goal_ID: 'GOL-001', Title: 'Collect October', Metric: 'collected', Target: 1000, Start: '2026-10-18', End: '2026-10-31', Note: '', Status: 'Active' };
  const { page, errors } = await openOverview(st => { st.goals = [goal]; withLayout('net,goals')(st); });
  const w = page.getByTestId('widget-goals');
  await w.getByText('Collect October', { exact: true }).waitFor();
  assert.match(await w.innerText(), /0%/);
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  await page.reload(); // the URL hash keeps the Money tab
  await page.getByTestId('widget-goals').getByText('30%').first().waitFor();
  assert.deepEqual(errors, []);
});

test('Removing a widget returns it to the + menu', async () => {
  const { page, errors } = await openOverview();
  await page.getByTestId('widget-cash').waitFor();
  await page.getByRole('button', { name: 'Options for Cash by method' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="widget-cash"]'));
  await page.locator('#addWidget').click();
  await page.getByRole('button', { name: 'Add Cash by method' }).waitFor();
  assert.deepEqual(errors, []);
});

// The debounce is driven by the page clock, so nothing here depends on how fast the machine is.
async function openOverviewOnClock() {
  const { makeUiState } = require('../support/seed');
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.install();
  await startUiHost(page, { state: makeUiState() });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Money');
  await page.getByTestId('widget-net').waitFor();
  await page.clock.pauseAt(new Date(Date.now() + 60000));
  const saves = [];
  page.on('request', r => { const d = r.postData() || ''; if (r.method() === 'POST' && /"saveLayout"/.test(d)) saves.push(JSON.parse(d).payload.widgets); });
  return { page, errors, saves };
}
const moveDown = async (page, title) => {
  await page.getByRole('button', { name: 'Options for ' + title }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
};

test('Reordering a widget saves once, with the final order, and persists after reload', async () => {
  const { page, errors, saves } = await openOverviewOnClock();
  await moveDown(page, 'Net this month');
  await moveDown(page, 'Net this month');
  assert.deepEqual((await widgetOrder(page)).slice(0, 3), ['trend', 'cash', 'net']);
  assert.match(await page.getByRole('status').innerText(), /Net this month moved to position 3 of 6/);
  assert.equal(saves.length, 0, 'nothing is sent before the delay');
  await page.clock.runFor(500);
  await page.waitForFunction(() => document.querySelector('[data-testid="widget-net"]'));
  await page.clock.resume();
  await page.waitForTimeout(100);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].slice(0, 3), ['trend', 'cash', 'net']);
  await page.reload();
  await page.getByTestId('widget-net').waitFor();
  assert.deepEqual((await widgetOrder(page)).slice(0, 3), ['trend', 'cash', 'net']);
  assert.deepEqual(errors, []);
});

test('Leaving the Overview inside the delay still saves the last move', async () => {
  const { page, errors, saves } = await openOverviewOnClock();
  await moveDown(page, 'Net this month');
  assert.equal(saves.length, 0);
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.clock.resume();
  await page.waitForTimeout(200);
  assert.equal(saves.length, 1);
  await page.reload();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByTestId('widget-net').waitFor();
  assert.deepEqual((await widgetOrder(page)).slice(0, 2), ['trend', 'net']);
  assert.deepEqual(errors, []);
});

test('Removing a card announces it and moves focus to the next card menu', async () => {
  const { page, errors } = await openOverview();
  await page.getByTestId('widget-cash').waitFor();
  await page.getByRole('button', { name: 'Options for Cash by method' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="widget-cash"]'));
  assert.match(await page.getByRole('status').innerText(), /Cash by method removed/);
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'Options for Dues by age');
  assert.deepEqual(errors, []);
});

test('Moving a card keeps focus on its menu button', async () => {
  const { page } = await openOverview();
  await page.getByTestId('widget-net').waitFor();
  await moveDown(page, 'Net this month');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'Options for Net this month');
});

test('A budget past its limit says so in words, not only colour', async () => {
  const budget = { Budget_ID: 'BUD-001', Category: 'Other', Monthly_Limit: 100, Alert_Pct: 80, Active: 'Yes' };
  const { page, errors } = await openOverview(st => {
    st.budgets = [budget];
    st.expenses = [{ Expense_ID: 'EXP-OV', Date: '2026-10-03', Category: 'Other', Amount: 777, Method: 'bKash', Note: '' }];
    withLayout('budgets')(st);
  });
  const w = page.getByTestId('widget-budgets');
  await w.getByText('Other').waitFor();
  assert.match(await w.innerText(), /Over by ৳677/);
  assert.match(await w.innerText(), /777%/);
  assert.deepEqual(errors, []);
});

test('Adding Budgets with none defined opens the budget sheet', async () => {
  const { page, errors } = await openOverview();
  await page.getByTestId('widget-net').waitFor();
  await page.locator('#addWidget').click();
  await page.getByRole('button', { name: 'Add Budgets' }).click();
  await page.locator('#budCategory').selectOption('Account purchases');
  await page.locator('#budLimit').fill('5000');
  await page.locator('#save').click();
  await page.getByTestId('widget-budgets').getByText('Account purchases').waitFor();
  assert.deepEqual(errors, []);
});

test('A failed layout save reverts the order and shows an inline error', async () => {
  const { page, errors } = await openOverview();
  await page.getByTestId('widget-net').waitFor();
  await page.route('**/functions/v1/api', route => {
    if (/"saveLayout"/.test(route.request().postData() || '')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Layout is locked.' }) });
    }
    return route.fallback();
  });
  await page.getByRole('button', { name: 'Options for Net this month' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await page.getByTestId('layout-error').getByText('Layout is locked.').waitFor();
  assert.deepEqual((await widgetOrder(page)).slice(0, 2), ['net', 'trend']);
  assert.deepEqual(errors, []);
});

// ---- Cash tab and CSV export ----
const readDownload = async d => (await require('fs').promises.readFile(await d.path(), 'utf8'));

test('Cash tab lists each method with the right balance and its last 5 movements', async () => {
  const { makeUiState } = require('../support/seed');
  const st = makeUiState();
  const ins = [1000, 250, 300, 400, 500, 600, 700];
  ins.forEach((amount, i) => st.payments.push({ Payment_ID: 'PM-CASH' + i, Date: '2026-10-' + String(10 + i).padStart(2, '0'), Customer_ID: st.customers[0].Customer_ID,
    Sale_ID: '', Amount: amount, Transaction_ID: '', Method: 'bKash', Source: 'Manual', Note: '' }));
  st.expenses.push({ Expense_ID: 'EXP-CASH', Date: '2026-10-09', Category: 'Tools', Amount: 450, Paid_With: 'bKash', Note: '' });
  const balance = ins.reduce((a, x) => a + x, 0) - 450; // 3300
  const { page, errors } = await open({ state: st });
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Cash' }).click();
  await page.getByTestId('cash-method-bKash').waitFor();
  const card = page.locator('section').filter({ has: page.getByTestId('cash-method-bKash') });
  const text = await card.innerText();
  assert.ok(text.includes('3,300'), 'balance ' + balance + ' in: ' + text);
  assert.ok(text.includes('3,750'), 'money in 3,750 in: ' + text);
  assert.ok(text.includes('450'), 'money out in: ' + text);
  const moves = card.getByTestId('cash-move');
  assert.equal(await moves.count(), 5, 'only the last 5 of 8 movements');
  assert.match(await moves.first().innerText(), /700/, 'newest first');
  assert.ok(!(await card.innerText()).includes('1,000'), 'the oldest payments are cut');
  assert.match(await page.locator('#screen').innerText(), /all time/i);
  assert.deepEqual(errors, []);
});

test('Export on Book downloads a CSV whose first line is the header row', async () => {
  const { page, errors } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.getByText('Net this month').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Book as CSV' }).click()]);
  assert.match(dl.suggestedFilename(), /^sales-tracker-book-\d{4}-\d{2}\.csv$/);
  const csv = await readDownload(dl);
  assert.equal(csv.split('\r\n')[0], 'Date,Type,Description,Method,Amount,Balance,Ref');
  assert.ok(csv.split('\r\n').length > 2);
  assert.deepEqual(errors, []);
});

test('Export works on the Overview and Cash tabs too', async () => {
  const { page } = await open();
  await nav(page, 'Money');
  const [o] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Overview as CSV' }).click()]);
  assert.equal((await readDownload(o)).split('\r\n')[0], 'Section,Item,Value');
  await page.getByRole('tab', { name: 'Cash' }).click();
  const [c] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Cash as CSV' }).click()]);
  assert.equal((await readDownload(c)).split('\r\n')[0], 'Method,In,Out,Balance');
});

// ---- first paint: one init call, stale-while-revalidate cache ----
// The seeded server thinks today is 2026-10-18, so the page clock is pinned to that day (Dhaka) unless a test moves it.
const DAY1 = new Date('2026-10-18T06:00:00Z'), DAY2 = new Date('2026-10-19T06:00:00Z');
async function swrPage(opts) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  await ctx.clock.setFixedTime(DAY1);
  if (opts && opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (r.method() === 'POST' && /functions\/v1\/api$/.test(r.url())) { try { calls.push(JSON.parse(r.postData()).action); } catch (e) {} } });
  await startUiHost(page);
  return { ctx, page, errors, calls };
}
const initKeys = page => page.evaluate(() => Object.keys(sessionStorage).filter(k => k.indexOf('st:init:') === 0));
// Answers init only after ms; `state.released` flips when the delay is over.
async function delayInit(page, ms) {
  const state = { released: false };
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || JSON.parse(req.postData() || '{}').action !== 'init') return route.fallback();
    await new Promise(r => setTimeout(r, ms));
    state.released = true;
    return route.fallback();
  });
  return state;
}

test('Cold load makes exactly one init call and no separate snapshot or rate calls', async () => {
  const { page, errors, calls } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await page.waitForTimeout(300);
  assert.equal(calls.filter(a => a === 'init').length, 1);
  assert.equal(calls.filter(a => a === 'snapshotIfDue' || a === 'refreshRate').length, 0);
  assert.deepEqual(errors, []);
});

test('A warm reload paints Today from the cache before the delayed network answers', async () => {
  const { page, errors } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  assert.equal((await initKeys(page)).length, 1);
  const net = await delayInit(page, 3000);
  await page.reload();
  await page.getByTestId('today-owed').filter({ hasText: '৳1,360' }).waitFor({ timeout: 2000 });
  assert.equal(net.released, false, 'painted before the network answered');
  await until(() => net.released, 8000);
  assert.equal(net.released, true);
  await page.getByTestId('today-owed').waitFor();
  assert.deepEqual(errors, []);
});

test('Sign-out removes the cached init, and a different secret never reads it', async () => {
  const { page } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  assert.equal((await initKeys(page)).length, 1);
  // Another secret: the cache of the first one is not used, so nothing paints before the (delayed) network.
  await page.evaluate(() => localStorage.setItem('sales_tracker_secret', 'someone-else'));
  const net = await delayInit(page, 2500);
  const sent = page.waitForRequest(r => isInit(r), { timeout: 5000 });   // listening before the reload: the init call can leave during load
  await page.reload();
  await sent;
  assert.equal(net.released, false);
  assert.equal(await page.getByTestId('today-owed').count(), 0, 'no cached figures under another secret');
  await page.getByTestId('today-owed').waitFor({ timeout: 5000 });
  // Sign out wipes every cached init.
  await nav(page, 'More');
  await page.locator('[data-more="signout"]').click();
  await page.getByTestId('signin').waitFor();
  assert.deepEqual(await initKeys(page), []);
});

test("Yesterday's cached init is ignored and removed", async () => {
  const { ctx, page } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  assert.equal((await initKeys(page)).length, 1);
  await ctx.clock.setFixedTime(DAY2);
  const net = await delayInit(page, 2500);
  const sent = page.waitForRequest(r => isInit(r), { timeout: 5000 });   // listening before the reload: the init call can leave during load
  await page.reload();
  await sent;
  assert.equal(net.released, false);
  assert.equal(await page.getByTestId('today-owed').count(), 0, "no figures from another day's cache");
  assert.deepEqual(await initKeys(page), [], 'the stale entry is removed');
});

test('The panel still loads when sessionStorage is unavailable', async () => {
  const { page, errors } = await swrPage({ init: () => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('denied'); } });
  } });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  assert.deepEqual(errors, []);
});

// Screens other than Today load on first visit. A chunk that fails to load shows an error with Retry, never a blank page.
test('A screen chunk that will not load shows an error with Retry, and Retry recovers once the network is back', async () => {
  const { page, errors } = await open();
  let blocked = true, hits = 0;
  await page.route('**/assets/Customers-*.js', route => { hits++; return blocked ? route.abort() : route.continue(); });
  await nav(page, 'Customers');
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  assert.ok(hits >= 2, 'the import was retried before giving up (' + hits + ')');
  assert.match(await page.locator('#screen').innerText(), /could not load this screen/i);
  assert.ok(await page.getByRole('button', { name: 'Retry' }).isVisible());
  blocked = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.locator('#screen').getByText(/jamilhq/i).first().waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('screen-error').count(), 0);
  assert.ok(errors.every(e => !/Customers/.test(e)), 'no uncaught error: ' + errors);
});

test('Today is not lazy: a warm load shows it without any screen chunk request', async () => {
  const { page } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  const chunks = [];
  page.on('request', r => { if (/\/assets\/(Accounts|Customers|Delivery|Dues|Money|More|PayLinks)-/.test(r.url())) chunks.push(r.url()); });
  await page.reload();
  await page.getByTestId('today-owed').waitFor({ timeout: 3000 });
  assert.deepEqual(chunks, [], 'no other screen fetched on first load');
  assert.equal(await page.getByLabel('Loading screen').count(), 0);
});

// Live refresh (inline-edit design C2): the open panel picks up changes made elsewhere, without a reload.
// The page clock runs the 25 s poll; "another device" is a direct call through the same router.
async function openLive(state, beforeLoad, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.install();
  const { api, tables, relay } = await startUiHost(page, { state: state || makeUiState() });
  if (beforeLoad) await beforeLoad(page);
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  return { page, errors, api, tables, relay };
}
const isInit = r => r.method() === 'POST' && /"action":"init"/.test(r.postData() || '');
const jamilhqId = () => require('../support/seed').makeUiState().customers.find(c => c.Name === 'jamilhq').Customer_ID;

test('An edit made elsewhere shows on the open page within the poll interval, without a reload', async () => {
  const { page, errors, api } = await openLive();
  await nav(page, 'Customers');
  await page.locator('#screen').getByText('jamilhq').first().waitFor();
  await api('edit', { requestId: 'elsewhere-1', kind: 'customer', id: jamilhqId(), values: { Name: 'renamed-live' } });
  await page.clock.runFor(30000);
  await page.locator('#screen').getByText('renamed-live').first().waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
});

test('Focus on the window refetches the app data at once', async () => {
  const { page } = await openLive();
  await page.clock.runFor(6000);   // past the 5 s floor between two refreshes
  const seen = page.waitForRequest(isInit);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await seen;
});

test('A hidden tab does not poll, and polls again once it is visible', async () => {
  const { page } = await openLive();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  let polls = 0;
  page.on('request', r => { if (isInit(r)) polls++; });
  await page.clock.runFor(180000);
  assert.equal(polls, 0, 'no init request while hidden');
  const seen = page.waitForRequest(isInit);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await seen;
});

// React reports every commit (a re-render that changed something) to a devtools hook when one is present. Counting them
// shows whether a poll that found nothing new re-rendered anything.
const COUNT_COMMITS = () => {
  window.__commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, onCommitFiberRoot() { window.__commits++; }, onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {}, checkDCE() {}, on() {}, off() {}, emit() {}
  };
};
test('A quiet poll (notModified) does not re-render the screen', async () => {
  const { page } = await openLive(undefined, p => p.addInitScript(COUNT_COMMITS));
  await page.clock.runFor(6000);
  await page.getByTestId('today-owed').waitFor();
  const answer = page.waitForResponse(res => res.request().method() === 'POST' && /"action":"init"/.test(res.request().postData() || ''));
  const before = await page.evaluate(() => window.__commits);
  assert.ok(before > 0, 'the devtools hook sees React commits (the first paint)');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const body = await (await answer).json();
  assert.equal(body.data.notModified, true, 'the server answered notModified');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__commits) - before, 0, 'no React commit on a quiet poll');
});

test('A failed background read keeps the screen already on it, with the error', async () => {
  const { page, errors, api } = await openLive();
  await nav(page, 'Dues');
  await page.getByTestId('due-pay').first().waitFor();
  await page.route('**/functions/v1/api', route => {
    if (/"action":"dues"/.test(route.request().postData() || '')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Network down' }) });
    }
    return route.fallback();
  });
  await api('edit', { requestId: 'elsewhere-2', kind: 'customer', id: jamilhqId(), values: { Name: 'renamed-dues' } });
  await page.clock.runFor(6000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({ hasText: 'Network down' }).waitFor();
  assert.ok(await page.getByTestId('due-pay').count() > 0, 'the rows stay on screen');
  assert.deepEqual(errors, []);
});

// Stage 1b (review fix wave): stale answers, sign-out races, hold/poll gating, backoff and read ordering.
const CORS_OK = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-app-secret', 'access-control-allow-methods': 'POST, OPTIONS' };
const kabirId = () => require('../support/seed').makeUiState().customers.find(c => c.Name === 'Kabir').Customer_ID;
// Polls a condition in real time (the page clock is fake, so waitFor on it would never time out).
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('condition not met within ' + ms + ' ms');
}
// Holds the first matching POST (by action) and lets the test answer it later. Other requests go on to the real router.
async function holdFirst(page, action) {
  const held = { route: null };
  await page.route('**/functions/v1/api', route => {
    const req = route.request();
    if (req.method() === 'POST' && !held.route && new RegExp('"action":"' + action + '"').test(req.postData() || '')) { held.route = route; return; }
    return route.fallback();
  });
  return held;
}

test('An init answer that arrives after a newer one is ignored', async () => {
  const { page, errors, api } = await openLive();
  await page.locator('#screen').getByText('jamilhq').first().waitFor();
  const old = await api('init', {});                      // the answer as it was before the edit
  const held = await holdFirst(page, 'init');
  await page.clock.runFor(6000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // this poll is held
  await until(() => held.route);
  // A save finishes while the poll is out: its reload is a newer init, and it is answered first.
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  await page.getByTestId('today-owed').filter({ hasText: '৳1,060' }).waitFor();
  await held.route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(old) });
  await page.waitForTimeout(400);
  assert.equal(await page.getByTestId('today-owed').filter({ hasText: '৳1,060' }).count(), 1, 'the older answer (owed ৳1,360) did not come back');
  assert.deepEqual(errors, []);
});

test('A poll in flight at sign-out does not sign the panel back in or refill the first-paint cache', async () => {
  const { page, errors, api } = await openLive();
  await page.clock.runFor(6000);
  const old = await api('init', {});
  const held = await holdFirst(page, 'init');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => held.route);
  await nav(page, 'More');
  await page.locator('[data-more="signout"]').click();
  await page.getByTestId('signin').waitFor();
  await held.route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(old) });
  await page.waitForTimeout(400);
  assert.equal(await page.getByTestId('signin').count(), 1, 'still signed out');
  assert.equal(await page.getByTestId('today-owed').count(), 0, 'the old answer did not repopulate the screen');
  const cached = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.indexOf('st:init:') === 0).length);
  assert.equal(cached, 0, 'no first-paint cache was written after sign-out');
  assert.deepEqual(errors, []);
});

test('Live refresh is held while an edit sheet is open and runs once it closes', async () => {
  const { page, errors } = await openLive();
  let inits = 0;
  page.on('request', r => { if (isInit(r)) inits++; });
  await openCustomer(page, 'farid');
  await page.clock.runFor(60000);
  assert.equal(inits, 0, 'no poll while the sheet is open');
  const seen = page.waitForRequest(isInit, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await seen;
  assert.ok(inits >= 1, 'the refresh ran when the sheet closed');
  assert.deepEqual(errors, []);
});

// Stage 1c: the Undo toast names the batch of its own save; a refused Undo says why and leaves the data alone.
async function savePaymentForTariq(page) {
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('tariq');
  await page.getByRole('option', { name: /^tariq/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
}

test('Undo from the toast sends the batchId of its own save', async () => {
  const { page, errors, rows } = await open();
  const undoBodies = [];
  await page.route('**/functions/v1/api', route => {
    const req = route.request();
    if (req.method() === 'POST' && /"action":"undo"/.test(req.postData() || '')) undoBodies.push(JSON.parse(req.postData()).payload || {});
    return route.fallback();
  });
  await savePaymentForTariq(page);
  await toastOf(page, 'Payment saved').getByRole('button', { name: 'Undo' }).click();
  await toastOf(page, 'Undone').waitFor();
  assert.equal(undoBodies.length, 1, 'one Undo was sent');
  assert.ok(typeof undoBodies[0].batchId === 'string' && undoBodies[0].batchId.length > 0, 'the Undo names the batch it reverts');
  assert.equal(rows('Payments').filter(r => r.payment_id === 'PM-00091').length, 0, 'the payment is gone after undo');
  assert.deepEqual(errors, []);
});

test('Undo after another change is refused with the reason, and the payment stays', async () => {
  const { page, errors, rows, api } = await open();
  await savePaymentForTariq(page);
  const tariq = rows('Customers').find(c => c.name === 'tariq');
  const other = await api('edit', { requestId: 'other-device-1', kind: 'customer', id: tariq.customer_id, values: { Notes: 'changed on another device' } });
  assert.equal(other.ok, true, other.error);
  await toastOf(page, 'Payment saved').getByRole('button', { name: 'Undo' }).click();
  await toastOf(page, 'Something else changed since. Open the history to undo it.').waitFor();
  assert.equal(rows('Payments').filter(r => r.payment_id === 'PM-00091').length, 1, 'the payment is kept: nothing was reverted');
  assert.deepEqual(errors, []);
});

test('A save that changed nothing offers no Undo', async () => {
  const { page, errors, api } = await open();
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !/"action":"edit"/.test(req.postData() || '')) return route.fallback();
    const body = JSON.parse(req.postData());
    const res = await api(body.action, body.payload || {});
    res.data = Object.assign({}, res.data, { changed: false });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  });
  await openCustomer(page, 'farid');
  await page.locator('#custNote').click();
  await page.locator('#cnNotes').fill('no real change');
  await page.locator('#save').click();
  await toastOf(page, 'Changes saved').waitFor();
  assert.equal(await toastOf(page, 'Changes saved').getByRole('button', { name: 'Undo' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('Live refresh waits while a write is in flight (an Undo, sent with no sheet open), then reloads once it is answered', async () => {
  const { page, errors, api } = await openLive();
  await openCustomer(page, 'farid');
  await page.locator('#custNote').click();
  await page.locator('#cnNotes').fill('undo me');
  await page.locator('#save').click();
  await toastOf(page, 'Changes saved').getByRole('button', { name: 'Undo' }).waitFor();
  const held = await holdFirst(page, 'undo');
  // The toast is still animating in on the page clock, so the click is sent as a DOM click (a mouse click lands on the wrong spot).
  await toastOf(page, 'Changes saved').getByRole('button', { name: 'Undo' }).dispatchEvent('click');
  await until(() => held.route);
  let inits = 0;
  page.on('request', r => { if (isInit(r)) inits++; });
  await page.clock.runFor(60000);
  assert.equal(inits, 0, 'no poll while the write is unanswered');
  const body = JSON.parse(held.route.request().postData());
  const res = await api(body.action, body.payload || {});
  const seen = page.waitForRequest(isInit, { timeout: 5000 });
  await held.route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  await seen;   // the Undo reloads the app data once it is answered
  assert.deepEqual(errors, []);
});

test('Polls back off to about 60 s after five quiet answers', async () => {
  const { page, errors } = await openLive();
  const polls = [];
  let t = 0;   // simulated seconds, one step per second of page-clock time
  page.on('request', r => { if (isInit(r)) polls.push(t); });
  for (; t < 420; t++) await page.clock.runFor(1000);
  await page.waitForTimeout(300);
  assert.ok(polls.length >= 8, 'enough polls to see the backoff: ' + polls.length);
  const gaps = polls.slice(1).map((p, i) => p - polls[i]);
  assert.ok(Math.max(...gaps.slice(0, 3)) <= 40, 'early polls about every 25 s: ' + gaps.join(','));
  assert.ok(Math.min(...gaps.slice(-2)) >= 50, 'late polls about every 60 s: ' + gaps.join(','));
  assert.deepEqual(errors, []);
});

test('A slow read that answers after a newer one is ignored', async () => {
  const { page, errors, api } = await openLive();
  const old = await api('dues', {});   // the Dues answer as it was before the rename
  const held = await holdFirst(page, 'dues');
  await nav(page, 'Dues');
  await until(() => held.route);
  // Kabir pays while the first read is out: the save's read is newer, and it is answered first (Kabir is no longer due).
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="dues-list"]').innerText.includes('Kabir'));
  await held.route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(old) });
  await page.waitForTimeout(400);
  assert.equal((await page.getByTestId('dues-list').innerText()).includes('Kabir'), false, 'the older answer (Kabir due) did not come back');
  assert.deepEqual(errors, []);
});

test('A save makes an open screen read once more, not twice', async () => {
  const { page, errors } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').waitFor();
  let reads = 0;
  page.on('request', r => { if (r.method() === 'POST' && /"action":"dues"/.test(r.postData() || '')) reads++; });
  await quick(page, 'Got paid');
  await page.getByLabel('Customer', { exact: true }).fill('Kabir');
  await page.getByRole('option', { name: /Kabir/ }).first().click();
  await page.locator('#dueBox').getByText('owes ৳300').waitFor();
  const reread = page.waitForRequest(r => r.method() === 'POST' && /"action":"dues"/.test(r.postData() || ''), { timeout: 5000 });   // listening before the save: the read can leave right after it
  await page.getByRole('button', { name: 'Save payment' }).click();
  await toastOf(page, 'Payment saved').waitFor();
  await reread;
  await page.waitForLoadState('networkidle');
  assert.equal(reads, 1, 'one extra read after the save');
  assert.deepEqual(errors, []);
});

test('A failed read is retried on focus, even when no data changed', async () => {
  const { page, errors } = await openLive();
  let failing = true;
  await page.route('**/functions/v1/api', route => {
    const req = route.request();
    if (failing && req.method() === 'POST' && /"action":"dues"/.test(req.postData() || '')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'Network down' }) });
    }
    return route.fallback();
  });
  await nav(page, 'Dues');
  await page.getByRole('alert').filter({ hasText: 'Network down' }).waitFor();
  failing = false;
  await page.clock.runFor(6000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByTestId('dues-list').getByText('Kabir').waitFor();
  assert.deepEqual(errors, []);
});

test('A failed reload after a save keeps the screen that is on', async () => {
  const { page, errors } = await open();
  await openCustomer(page, 'farid');
  await page.route('**/functions/v1/api', route => {
    const req = route.request();
    if (req.method() === 'POST' && /"action":"init"/.test(req.postData() || '')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'Network down' }) });
    }
    return route.fallback();
  });
  await page.locator('#custNote').click();
  await page.locator('#cnNotes').fill('reload fails');
  await page.locator('#save').click();
  await toastOf(page, 'Changes saved').waitFor();
  await page.waitForLoadState('networkidle');   // the reload after the save has been attempted and refused
  assert.match(await page.locator('#screen').innerText(), /farid/, 'the screen stays');
  assert.equal(await page.getByTestId('today-owed').count(), 0);
  assert.deepEqual(errors, []);
});

// Stage 2: customer name, channel, handle and notes are edited in place on the customer sheet (components/inline.jsx).
const editRequests = page => { const seen = []; page.on('request', r => { if (r.method() === 'POST' && /"action":"edit"/.test(r.postData() || '')) seen.push(r.postData()); }); return seen; };
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The display button is named "Edit <field> for <target>: <value>. Press Enter to edit": match the prefix, not the value.
const cellBtn = (page, field, target) => page.getByRole('button', { name: new RegExp('^' + escRe('Edit ' + field + ' for ' + target) + ': ') });
const cellBox = (page, field, target) => page.getByRole('textbox', { name: 'Edit ' + field + ' for ' + target, exact: true });
const customerRows = tables => Array.from(tables[Adapter.SPEC.Customers.table].values());
const faridId = tables => customerRows(tables).find(c => c.name === 'farid').customer_id;

test('Inline: a customer name is saved on Enter, shows at once, and is stored', async () => {
  const { page, errors, tables } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Farid Renamed');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Farid Renamed (was farid)').waitFor();
  assert.ok(customerRows(tables).some(c => c.name === 'Farid Renamed'));
  assert.deepEqual(errors, []);
});

test('Inline: a saved name is still there after a reload', async () => {
  const { page, tables } = await open();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Farid Kept');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Farid Kept').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Customers', exact: true }).waitFor();   // the URL hash keeps the screen
  await openCustomer(page, 'Farid Kept');
  await cellBtn(page, 'Name', 'Farid Kept').getByText('Farid Kept').waitFor();
  assert.ok(customerRows(tables).some(c => c.name === 'Farid Kept'));
});

test('Inline: Esc cancels a name edit and sends nothing', async () => {
  const { page, errors } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Never saved');
  await page.keyboard.press('Escape');
  await cellBtn(page, 'Name', 'farid').waitFor();
  assert.equal(await cellBtn(page, 'Name', 'farid').innerText(), 'farid');
  assert.equal(sent.length, 0);
  assert.equal(await page.getByRole('dialog').count(), 1, 'Esc closed the cell, not the sheet');
  assert.deepEqual(errors, []);
});

test('Inline: Esc then blur saves nothing', async () => {
  const { page, errors } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Esc then blur');
  await page.keyboard.press('Escape');
  await cellBtn(page, 'Name', 'farid').waitFor();
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  assert.equal(sent.length, 0, 'the cancelled draft was not saved on blur');
  assert.equal(await cellBtn(page, 'Name', 'farid').innerText(), 'farid');
  assert.deepEqual(errors, []);
});

test('Inline: Enter pressed twice sends one save', async () => {
  const { page, errors, tables } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Double Sent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Double Sent').waitFor();
  assert.equal(sent.length, 1, 'one POST for two Enters');
  assert.ok(customerRows(tables).some(c => c.name === 'Double Sent'));
  assert.deepEqual(errors, []);
});

test('Inline: an empty name is refused in the cell and nothing is sent', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('   ');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Name cannot be empty.' }).waitFor();
  assert.equal(sent.length, 0);
  await page.keyboard.press('Escape');
});

test('Inline: a Channel picked with the mouse saves at once, and its label is what is shown', async () => {
  const { page, tables, errors } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Channel', 'farid').click();
  const sel = page.getByRole('combobox', { name: 'Edit Channel for farid', exact: true });
  await sel.waitFor();
  const cur = await sel.inputValue();
  const opts = await sel.locator('option').evaluateAll(os => os.map(o => [o.value, o.innerText]));
  const [value, label] = opts.find(([v]) => v && v !== cur);
  await sel.selectOption(value);
  await toastOf(page, 'Channel: ' + label).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(await cellBtn(page, 'Channel', 'farid').innerText(), label);
  assert.ok(customerRows(tables).some(c => c.name === 'farid' && c.channel === value));
  assert.deepEqual(errors, []);
});

test('Inline: a Channel chosen with the keyboard waits for Enter before it saves', async () => {
  const { page, errors, tables } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Channel', 'farid').click();
  const sel = page.getByRole('combobox', { name: 'Edit Channel for farid', exact: true });
  await sel.waitFor();
  const before = await sel.inputValue();
  await sel.focus();
  await page.keyboard.press('ArrowDown');
  const moved = await sel.inputValue();
  assert.notEqual(moved, before, 'the arrow key changed the choice');
  assert.equal(sent.length, 0, 'the arrow key alone saves nothing');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Channel: ').waitFor();
  assert.equal(sent.length, 1, 'Enter saves the keyboard choice once');
  assert.ok(customerRows(tables).some(c => c.name === 'farid' && c.channel === moved));
  assert.deepEqual(errors, []);
});

test('Inline: Notes saves with Ctrl+Enter and is still there after a reload', async () => {
  const { page, errors } = await open();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Notes', 'farid').click();
  await page.getByRole('textbox', { name: 'Edit Notes for farid', exact: true }).fill('Calls on Fridays');
  await page.keyboard.press('Control+Enter');
  await toastOf(page, 'Notes: Calls on Fridays').waitFor();
  assert.equal(sent.length, 1);
  await page.reload();
  await page.getByRole('button', { name: 'Customers', exact: true }).waitFor();   // the URL hash keeps the screen
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Notes', 'farid').getByText('Calls on Fridays').waitFor();
  assert.deepEqual(errors, []);
});

test('Inline: the display button names the field, the target and the current value', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  await page.getByRole('button', { name: 'Edit Name for farid: farid. Press Enter to edit', exact: true }).waitFor();
});

test('Inline: a double click on Undo sends one request id and shows no refusal', async () => {
  const { page, errors } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Twice Undone');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Twice Undone').waitFor();
  const undos = [];
  page.on('request', r => { if (r.method() === 'POST' && /"action":"undo"/.test(r.postData() || '')) undos.push(JSON.parse(r.postData())); });
  await toastOf(page, 'Name: Twice Undone').getByRole('button', { name: 'Undo' }).dblclick();
  await page.locator('[data-sonner-toast]').filter({ hasText: /^Undone/ }).waitFor();
  assert.ok(undos.length >= 1, 'an Undo was sent');
  assert.ok(undos.every(u => u.requestId === undos[0].requestId), 'every click carries the same requestId');
  assert.equal(await page.locator('[data-sonner-toast]').filter({ hasText: 'Something else changed' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('Inline: an unchanged value sends no request and no toast', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  const sent = editRequests(page);
  await cellBtn(page, 'Name', 'farid').click();
  await page.keyboard.press('Enter');
  await cellBtn(page, 'Name', 'farid').waitFor();
  assert.equal(sent.length, 0);
  assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
});

test('Inline: Tab saves the name and opens the Channel cell', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Farid Tabbed');
  await page.keyboard.press('Tab');
  await page.getByRole('combobox', { name: 'Edit Channel for Farid Tabbed', exact: true }).waitFor();
  await toastOf(page, 'Name: Farid Tabbed').waitFor();
});

test('Inline: F2 opens a cell from the keyboard and Enter saves it', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Handle', 'farid').focus();
  await page.keyboard.press('F2');
  await cellBox(page, 'Handle', 'farid').fill('@keyboard');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Handle: @keyboard').waitFor();
});

test('Inline: a refused save rolls the name back and says why', async () => {
  const { page } = await openLive();
  await openCustomer(page, 'farid');
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !/"action":"edit"/.test(req.postData() || '')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'Could not save. Nothing was changed. Try again.' }) });
  });
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Refused');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Nothing was changed' }).waitFor();
  assert.equal(await cellBtn(page, 'Name', 'farid').innerText(), 'farid');
});

test('Inline: Undo in the save toast puts the old name back', async () => {
  const { page, tables } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Farid Undone');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Farid Undone').getByRole('button', { name: 'Undo' }).click();
  await page.locator('[data-sonner-toast]').filter({ hasText: /^Undone/ }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1, 'the Undo click in the toast did not close the sheet');
  await cellBtn(page, 'Name', 'farid').getByText('farid', { exact: true }).waitFor();
  assert.ok(customerRows(tables).some(c => c.name === 'farid'));
});

test('Inline: a value changed on another device shows in the open sheet within the poll interval', async () => {
  const { page, api, tables } = await openLive();
  await openCustomer(page, 'farid');
  await api('edit', { requestId: 'elsewhere-inline-1', kind: 'customer', id: faridId(tables), values: { Handle: '@elsewhere' } });
  await page.clock.runFor(30000);
  await cellBtn(page, 'Handle', 'farid').getByText('@elsewhere').waitFor({ timeout: 5000 });
});

test('Inline: a draft is not replaced while the cell is open, and the change shows once it closes', async () => {
  const { page, api, tables } = await openLive();
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Handle', 'farid').click();
  await cellBox(page, 'Handle', 'farid').fill('my draft');
  await api('edit', { requestId: 'elsewhere-inline-2', kind: 'customer', id: faridId(tables), values: { Handle: '@theirs' } });
  await page.clock.runFor(60000);
  assert.equal(await cellBox(page, 'Handle', 'farid').inputValue(), 'my draft');
  await page.keyboard.press('Escape');
  await cellBtn(page, 'Handle', 'farid').getByText('@theirs').waitFor({ timeout: 5000 });
});

test('Inline: on a phone (375x812) a name is edited and saved, with no horizontal scroll', async () => {
  const { page, errors, tables } = await openLive(undefined, undefined, { width: 375, height: 812 });
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Name', 'farid').click();
  await cellBox(page, 'Name', 'farid').fill('Farid Phone');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Name: Farid Phone').waitFor();
  assert.ok(customerRows(tables).some(c => c.name === 'Farid Phone'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'no horizontal scroll at 375px');
  assert.deepEqual(errors, []);
});

// Stage 2: a due's Paid till and Price are edited in place on the Dues list (one save each, own Undo).
const dueOf = async (api, name) => (await api('dues', {})).data.rows.find(r => r.name === name);
const saleOf = (tables, saleId) => Array.from(tables[Adapter.SPEC.Sales_Log.table].values()).find(s => Number(s.sale_id) === Number(saleId));
const dueTarget = due => 'Kabir, ref ' + due.subCode;

test('Inline dues: Paid till saves on Enter at phone size, shows at once, and is stored', async () => {
  const { page, errors, api, tables } = await open({ viewport: { width: 375, height: 812 } });
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await cellBtn(page, 'Paid till', dueTarget(due)).click();
  await page.getByLabel('Edit Paid till for ' + dueTarget(due), { exact: true }).fill('2026-11-04');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Paid till: 2026-11-04').waitFor();
  assert.equal(String(saleOf(tables, due.saleId).paid_till).slice(0, 10), '2026-11-04');
  await page.reload();
  await page.getByTestId('dues-list').waitFor();
  await nav(page, 'Dues');
  await cellBtn(page, 'Paid till', dueTarget(due)).getByText('2026-11-04').waitFor();
  assert.deepEqual(errors, []);
});

test('Inline dues: a Paid till cannot be cleared; the cell says so and sends nothing', async () => {
  const { page, api } = await openLive();
  const due = await dueOf(api, 'Kabir');
  const sent = editRequests(page);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await cellBtn(page, 'Paid till', dueTarget(due)).click();
  await page.getByRole('textbox', { name: 'Edit Paid till for ' + dueTarget(due), exact: true }).fill('');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Paid till cannot be empty.' }).waitFor();
  assert.equal(sent.length, 0);
  await page.keyboard.press('Escape');
});

test('Inline dues: the price cell says it is per month, shows the months, and the editor says what it changes', async () => {
  const { page, api } = await openLive();
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await page.getByText('Price per month', { exact: true }).first().waitFor();
  if (due.months > 1) await page.getByText(new RegExp(' for ' + due.months + ' mo$')).first().waitFor();
  await cellBtn(page, 'Price per month', dueTarget(due)).click();
  await page.getByText('Changes what is owed.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
});

test('Inline dues: a price per month saves as a number, is shown at once, and the amount due follows it', async () => {
  const { page, errors, api, tables } = await openLive();
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await cellBtn(page, 'Price per month', dueTarget(due)).click();
  await page.getByRole('spinbutton', { name: 'Edit Price per month for ' + dueTarget(due), exact: true }).fill('350');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Price per month: ৳350').waitFor();
  assert.match(await cellBtn(page, 'Price per month', dueTarget(due)).innerText(), /৳350/, 'the price cell shows the saved amount');
  assert.equal(Number(saleOf(tables, due.saleId).unit_price), 350);
  const after = await dueOf(api, 'Kabir');
  const owed = '৳' + Math.round(after.amount).toLocaleString('en-US');
  await page.getByTestId('dues-list').getByText(owed, { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
});

test('Inline dues: Tab inside a Paid till date keeps the browser date segments, so no Price cell opens', async () => {
  const { page, api } = await openLive();
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await cellBtn(page, 'Paid till', dueTarget(due)).click();
  await page.getByRole('textbox', { name: 'Edit Paid till for ' + dueTarget(due), exact: true }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('spinbutton', { name: 'Edit Price per month for ' + dueTarget(due), exact: true }).count(), 0);
  await page.keyboard.press('Escape');
});

test('Inline dues: Undo in the Paid till toast restores the old date', async () => {
  const { page, api, tables } = await openLive();
  const due = await dueOf(api, 'Kabir');
  const before = String(saleOf(tables, due.saleId).paid_till).slice(0, 10);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await cellBtn(page, 'Paid till', dueTarget(due)).click();
  await page.getByLabel('Edit Paid till for ' + dueTarget(due), { exact: true }).fill('2026-11-09');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Paid till: 2026-11-09').getByRole('button', { name: 'Undo' }).click();
  await page.locator('[data-sonner-toast]').filter({ hasText: /^Undone/ }).waitFor();
  assert.equal(String(saleOf(tables, due.saleId).paid_till).slice(0, 10), before);
});

test('Inline dues: a Paid till changed on another device shows on the open Dues list without a reload', async () => {
  const { page, api, tables } = await openLive();
  const due = await dueOf(api, 'Kabir');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').getByText('Kabir').first().waitFor();
  await api('edit', { requestId: 'elsewhere-dues-1', kind: 'sale', id: due.saleId, values: { Paid_Till: '2026-12-01' } });
  await page.clock.runFor(30000);
  await cellBtn(page, 'Paid till', dueTarget(due)).getByText('2026-12-01').waitFor({ timeout: 5000 });
  assert.ok(saleOf(tables, due.saleId));
});

// ── Stage 3: payments on the customer sheet and in the Book are edited in place (one field per save, own Undo) ──
const payTarget = id => 'payment ' + id;
const payAmountBox = (page, id) => page.getByRole('spinbutton', { name: 'Edit Amount for ' + payTarget(id), exact: true });
const payBox = (page, field, id) => page.getByRole('textbox', { name: 'Edit ' + field + ' for ' + payTarget(id), exact: true });
const payRowOf = (rows, id) => rows('Payments').find(p => p.payment_id === id);
const sentPayEdits = page => { const seen = []; page.on('request', r => { if (r.method() === 'POST' && /"action":"editPayment"/.test(r.postData() || '')) seen.push(r.postData()); }); return seen; };
const shownAmount = (page, id, text) => page.getByRole('button', { name: new RegExp('^' + escRe('Edit Amount for ' + payTarget(id) + ': ' + text) + '\\.') });

test('Payments: amount, date, method and note are edited in place and kept after a reload', async () => {
  const id = 'PM-09100';
  const { page, errors, rows } = await open({ state: withEntries() });
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('450');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳450').waitFor();
  await cellBtn(page, 'Date', payTarget(id)).click();
  await payBox(page, 'Date', id).fill('2026-10-19');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Date: 2026-10-19').waitFor();
  await cellBtn(page, 'Method', payTarget(id)).click();
  await page.getByRole('combobox', { name: 'Edit Method for ' + payTarget(id), exact: true }).selectOption('Nagad');
  await toastOf(page, 'Method: Nagad').waitFor();
  await cellBtn(page, 'Note', payTarget(id)).click();
  await payBox(page, 'Note', id).fill('paid by cousin');
  await page.keyboard.press('Control+Enter');
  await toastOf(page, 'Note: paid by cousin').waitFor();
  const r = payRowOf(rows, id);
  assert.equal(Number(r.amount), 450);
  assert.equal(r.date, '2026-10-19');
  assert.equal(r.method, 'Nagad');
  assert.equal(r.note, 'paid by cousin');
  await page.reload();
  await openCustomer(page, 'farid');
  await shownAmount(page, id, '৳450').waitFor();
  assert.deepEqual(errors, []);
});

test('Payments: Undo puts the old amount back on the row', async () => {
  const id = 'PM-09100';
  const { page, errors, rows } = await open({ state: withEntries() });
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('300');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳300').getByRole('button', { name: 'Undo' }).click();
  await toastOf(page, 'Undone').waitFor();
  await shownAmount(page, id, '৳500').waitFor();
  assert.equal(Number(payRowOf(rows, id).amount), 500);
  assert.deepEqual(errors, []);
});

test('Payments: lowering a partly-used credit row past what is left shows the alert in the cell, and the value is the stored one after a reload', async () => {
  const { cid } = require('../fixtures');
  const id = 'PM-09100';   // a 500 credit; 300 of the customer's credit is used (the -300 credit-used row), so 200 is left
  const st = withEntries();
  st.payments.push({ Payment_ID: 'PM-09103', Date: '2026-10-12', Customer_ID: cid(st, 'farid'), Sale_ID: '', Amount: -300, Method: '', Transaction_ID: '', Source: 'Credit', Note: '' });
  const { page, errors, rows } = await open({ state: st });
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('100');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: '৳200 of this credit is already used' }).waitFor();
  assert.equal(Number(payRowOf(rows, id).amount), 500, 'nothing was saved');
  assert.equal(await page.getByRole('spinbutton', { name: 'Edit Amount for ' + payTarget(id), exact: true }).count(), 0, 'the cell is closed, showing the old value');
  await shownAmount(page, id, '৳500').waitFor();
  await page.reload();
  await openCustomer(page, 'farid');
  await shownAmount(page, id, '৳500').waitFor();
  assert.equal(Number(payRowOf(rows, id).amount), 500);
  assert.deepEqual(errors, []);
});

test('Payments: a credit-used row shows its locks and reason, and a click sends nothing', async () => {
  const { cid } = require('../fixtures');
  const st = withEntries();
  st.payments.push({ Payment_ID: 'PM-09101', Date: '2026-10-12', Customer_ID: cid(st, 'farid'), Sale_ID: '', Amount: -100, Method: '', Transaction_ID: '', Source: 'App', Note: '' });
  const { page, errors } = await open({ state: st });
  await openCustomer(page, 'farid');
  const amount = page.getByRole('button', { name: /^Edit Amount for payment PM-09101: / });
  await amount.waitFor();
  assert.equal(await amount.getAttribute('aria-disabled'), 'true');
  await page.getByText('Credit-used entries cannot be edited', { exact: false }).first().waitFor();
  const sent = sentPayEdits(page);
  await amount.evaluate(el => el.click());   // aria-disabled: Playwright would wait for it, so the DOM click is sent directly
  await page.waitForTimeout(300);   // a negative check: nothing should open or send
  assert.equal(await page.getByRole('spinbutton', { name: 'Edit Amount for payment PM-09101', exact: true }).count(), 0);
  assert.equal(sent.length, 0, 'no editPayment was sent');
  assert.deepEqual(errors, []);
});

test('Payments: a payment that confirmed a pay link keeps its amount locked, and its date stays editable', async () => {
  const { makeUiState } = require('../support/seed');
  const state = makeUiState();
  state.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  state.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-CELL-1', Status: 'Available' });
  const { page, errors, api, rows } = await open({ state });
  const made = await api('createPayRequest', { requestId: 'cell-pay-1', title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Rafi' });
  assert.equal(made.ok, true, made.error);
  const got = await api('gotPaidRequest', { requestId: 'cell-pay-2', id: 'R1', trx: 'CELLTRX0001', method: 'bKash', amount: 500 });
  assert.equal(got.ok, true, got.error);
  const pay = rows('Payments').find(p => p.transaction_id === 'CELLTRX0001');
  assert.ok(pay, 'the confirming payment is recorded');
  const target = payTarget(pay.payment_id);
  await openCustomer(page, 'Rafi');
  const amount = page.getByRole('button', { name: new RegExp('^' + escRe('Edit Amount for ' + target) + ': ') });
  await amount.waitFor();
  assert.equal(await amount.getAttribute('aria-disabled'), 'true');
  await page.getByText('Confirmed pay link R1 fixed this amount', { exact: false }).first().waitFor();
  await cellBtn(page, 'Date', target).click();
  await payBox(page, 'Date', pay.payment_id).fill('2026-10-21');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Date: 2026-10-21').waitFor();
  assert.equal(payRowOf(rows, pay.payment_id).date, '2026-10-21');
  assert.equal(Number(payRowOf(rows, pay.payment_id).amount), 500, 'the amount did not move');
  assert.deepEqual(errors, []);
});

test('Book: editing a payment amount changes the running balance and the closing figure', async () => {
  const id = 'PM-09100';
  const { page, errors } = await open({ state: withEntries() });
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.getByText('Net this month').waitFor();
  const closing = async () => {
    const t = await page.locator('#screen').innerText();
    const m = /Closing balance (−?)৳([\d,]+(?:\.\d+)?)/.exec(t);
    return Number(m[2].replace(/,/g, '')) * (m[1] ? -1 : 1);
  };
  const before = await closing();
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('450');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳450').waitFor();
  for (let i = 0; i < 50 && (await closing()) !== before - 50; i++) await page.waitForTimeout(100);
  assert.equal(await closing(), before - 50, 'the closing balance follows the new amount');
  assert.deepEqual(errors, []);
});

test('Book: an expense and an account purchase are edited in place', async () => {
  const { page, errors, rows } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await page.locator('#addExpense').click();
  await page.locator('#xAmt').fill('120');
  await page.locator('#xNote').fill('office tea');
  await page.locator('#save').click();
  await toastOf(page, 'Expense saved').waitFor();
  const expense = bookRow(page, /office tea/);
  await expense.getByRole('button', { name: /^Edit Amount for expense / }).click();
  await expense.getByRole('spinbutton', { name: /^Edit Amount for expense / }).fill('150');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳150').waitFor();
  await expense.getByRole('button', { name: /^Edit Category for expense / }).click();
  await expense.getByRole('combobox', { name: /^Edit Category for expense / }).selectOption('Ads');
  await toastOf(page, 'Category: Ads').waitFor();
  assert.equal(Number(rows('Expenses')[0].amount), 150);
  assert.equal(rows('Expenses')[0].category, 'Ads');
  const purchase = bookRow(page, /EXL-01 renewal/).first();
  await purchase.getByRole('button', { name: /^Edit Amount for purchase / }).click();
  await purchase.getByRole('spinbutton', { name: /^Edit Amount for purchase / }).fill('2900');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳2,900').waitFor();
  assert.equal(Number(rows('Purchases').find(p => p.purchase_id === 'P-0001').amount), 2900);
  assert.deepEqual(errors, []);
});

test('Payments: the keyboard path saves an amount with Enter, Tab opens Date, Escape there sends nothing more', async () => {
  const id = 'PM-09100';
  const { page, errors, rows } = await open({ state: withEntries() });
  await openCustomer(page, 'farid');
  const sent = sentPayEdits(page);
  await cellBtn(page, 'Amount', payTarget(id)).focus();
  await page.keyboard.press('Enter');
  await payAmountBox(page, id).waitFor();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('400');
  await page.keyboard.press('Tab');
  await payBox(page, 'Date', id).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Edit Date for payment PM-09100');
  await page.keyboard.press('Escape');
  await cellBtn(page, 'Date', payTarget(id)).waitFor();
  assert.equal(sent.length, 1, 'only the amount was sent');
  assert.equal(Number(payRowOf(rows, id).amount), 400);
  assert.deepEqual(errors, []);
});

test('Payments: a change made on another device shows in the open sheet, and an open draft is kept', async () => {
  const id = 'PM-09100';
  const { page, api, errors } = await openLive(withEntries());
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('600');
  await api('editPayment', { requestId: 'other-pay-1', paymentId: id, amount: 480 });
  await page.clock.runFor(60000);
  assert.equal(await payAmountBox(page, id).inputValue(), '600', 'the draft is not replaced while the cell is open');
  await page.keyboard.press('Escape');
  await shownAmount(page, id, '৳480').waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
});

test('Payments and the Book cells fit a 375px phone with no horizontal scroll', async () => {
  const { page, errors } = await openLive(withEntries(), undefined, { width: 375, height: 812 });
  await openCustomer(page, 'farid');
  await cellBtn(page, 'Amount', payTarget('PM-09100')).waitFor();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok((await overflow()) <= 0, 'customer sheet: no horizontal scroll at 375px');
  await page.keyboard.press('Escape');   // close the customer sheet: the dock is under it
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await cellBtn(page, 'Amount', payTarget('PM-09100')).waitFor();
  assert.ok((await overflow()) <= 0, 'Book: no horizontal scroll at 375px');
  assert.deepEqual(errors, []);
});

// ---- QOL batch 1 -------------------------------------------------------------------------------------------------------

const IBANKING_SMS = 'You have received deposit from iBanking of Tk 50.00 from Prime Bank. Fee Tk 0.00. Balance Tk 567.07. TrxID TOPUPUI1 at 25/10/2026 09:00';

test('Wallet top-up: an iBanking deposit sits in its own group, not in payments to match, and one tap sets it aside', async () => {
  const st = makeUiState();
  st.inbox.push({ Received: '2026-10-25 09:00', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 50, Transaction_ID: 'TOPUPUI1',
    Reference: '', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: IBANKING_SMS });
  const { page, errors, rows } = await open({ state: st });
  assert.equal(await page.getByTestId('unm-TOPUPUI1').count(), 0, 'not offered as a payment to match');
  await page.getByText('Wallet top-ups', { exact: true }).click();
  await page.getByTestId('topup-TOPUPUI1').getByRole('button', { name: 'Mark as top-up' }).click();
  await toastOf(page, /marked as wallet top-up/i).waitFor();
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'TOPUPUI1').status, 'Ignored');
  assert.deepEqual(errors, []);
});

test('Needs attention: the strip counts the owner\'s work, and a quiet state says nothing needs attention', async () => {
  const { page } = await open();
  await page.getByTestId('attention-strip').waitFor();
  assert.match(await page.getByTestId('attention-strip').innerText(), /payment to match/);

  const quiet = noStockAlerts(makeUiState());
  quiet.inbox = []; quiet.payRequests = []; quiet.deliveries = []; quiet.budgets = [];
  const q = await open({ state: quiet });
  await q.page.getByTestId('attention-clear').waitFor();
  assert.match(await q.page.getByTestId('attention-clear').innerText(), /Nothing needs attention/);
  assert.equal(await q.page.getByTestId('attention-strip').count(), 0);
});

test('Offline: cached figures stay on screen with a note, and the note clears when a refresh succeeds', async () => {
  // swrPage fixes the clock to the seed's day, so the first-paint cache written by the first load is the one a reload reads.
  const { page, errors } = await swrPage();
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  // The Edge Function route fails while `down` is set; the page itself still loads.
  let down = true;
  await page.route('**/functions/v1/api', route => (down ? route.abort() : route.fallback()));
  await page.reload();
  await page.getByTestId('offline-note').waitFor();
  assert.match(await page.getByTestId('offline-note').innerText(), /Saved figures, offline/);
  assert.match(await page.locator('#screen').innerText(), /jamilhq/, 'the saved figures are still shown');
  down = false;
  await page.reload();
  await page.getByTestId('offline-note').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('Command palette: three typed characters find a transaction, and Enter opens it to match', async () => {
  const { page, errors } = await open();
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Search customers, or type an action');
  await input.fill('TESTTR');
  await page.getByRole('option', { name: /TESTTRX1/ }).waitFor();
  await page.getByText('Transactions', { exact: true }).waitFor();
  await input.fill('zzzq');
  await page.getByText('No results for "zzzq".').waitFor();
  await input.fill('TESTTRX1');
  await page.getByRole('option', { name: /TESTTRX1/ }).click();
  await page.locator('#mCustomer').waitFor();
  assert.deepEqual(errors, []);
});

test('Shortcut sheet: ? opens the real shortcut list', async () => {
  const { page } = await open();
  await page.keyboard.type('?');
  await page.getByTestId('shortcut-list').waitFor();
  const text = await page.getByTestId('shortcut-list').innerText();
  for (const word of ['New sale', 'Got paid', 'Renew', 'New pay link', 'Search', 'Collapse or expand the sidebar']) assert.match(text, new RegExp(word));
  await page.keyboard.press('Escape');
});

test('Copy an id: the transaction id copies itself and says so, from the keyboard too', async () => {
  const { page } = await open(CLIP);
  const id = page.getByRole('button', { name: 'Copy transaction ID TESTTRX1' });
  await id.focus();
  await page.keyboard.press('Enter');
  await toastOf(page, 'Copied').waitFor();
});

// Task 13 acceptance: the owner's real case. One 1,200 Tk bKash payment (DJP2JBSWHA) covers Netflix 2 months
// (sale 44, 2 x 300, end date set by the owner to 2026-11-09) and a Tinder custom sale (600, cost 450).
// Then the 50 Tk payment (DJP8J7IPEK) pays one day of ExitLag rent on a random free ExitLag account.
function acceptanceState() {
  const st = splitState();
  st.products.push({ Product_ID: 'EXLRENT1D', Product_Name: 'ExitLag rent 1D', Category: 'Subscription', Billing_Cycle_Days: 1,
    Default_Price: 50, Unit_Cost: 0, Letter: 'ER', Parent_ID: 'EXITLAG', Delivers_As: 'account', Active: 'Yes' });
  st.inbox.push({ Received: '2026-10-25 21:20', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 50,
    Transaction_ID: 'DJP8J7IPEK', Reference: '', Status: 'Pending', Matched_Sale_ID: '',
    Raw_SMS: 'Cash In Tk 50.00 from 01XXXXXXXXX successful TrxID DJP8J7IPEK' });
  return st;
}

async function saveAcceptanceSplit(page) {
  await todayMatch(page, 'DJP2JBSWHA');
  await page.locator('#mCustomer').fill('farid');
  await page.getByRole('option', { name: /^farid/ }).first().click();
  await page.locator('#splitToggle').click();
  await page.locator('#sLine-0').selectOption('N44');
  await page.locator('#sMonths-0').fill('2');
  await page.locator('#sTill-0').fill('2026-11-09');
  await page.locator('#splitAdd').click();
  await page.locator('#sKind-1').selectOption('custom');
  await page.locator('#sTitle-1').fill('Tinder Premium');
  await page.locator('#sAmt-1').fill('600');
  await page.locator('#sCost-1').fill('450');
  assert.match(await page.getByTestId('split-left').innerText(), /৳0/);
  await page.locator('#save').click();
  await toastOf(page, /farid/i).waitFor();
}

test('Acceptance: one 1,200 Tk payment split into Netflix 2 months and a Tinder custom sale, then Undo restores everything', async () => {
  const { page, errors, rows } = await open({ state: acceptanceState() });
  const salesBefore = rows('Sales_Log').length;
  const accountsBefore = JSON.stringify(rows('Accounts'));
  const deliveriesBefore = rows('Deliveries').length;
  const requestsBefore = rows('Pay_Requests').length;
  await saveAcceptanceSplit(page);

  // Inbox matched, both payments, the owner's arithmetic.
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'DJP2JBSWHA').status, 'Matched');
  assert.equal(rows('Sales_Log').find(s => String(s.sale_id) === '44').record_status, 'Renewed');
  const renewal = rows('Sales_Log').find(s => s.sub_code === 'N44' && s.record_status === 'Active');
  assert.equal(Number(renewal.months), 2);
  assert.equal(Number(renewal.unit_price), 300, 'revenue 600');
  assert.equal(renewal.paid_till, '2026-11-09', 'the owner-set end date, not the computed 2026-12-09');
  const custom = rows('Sales_Log').find(s => s.product_id === 'CUSTOM');
  assert.equal(custom.notes, 'Tinder Premium');
  assert.equal(Number(custom.unit_price), 600);
  assert.equal(Number(custom.cost_snapshot), 450, 'profit 150');
  assert.equal(custom.paid_till, '');
  assert.equal(custom.account_id, '');
  assert.equal(custom.code_id, '');
  assert.equal(custom.sub_code, '');
  assert.equal(custom.pay_token, '');
  const pays = rows('Payments').filter(p => p.transaction_id === 'DJP2JBSWHA');
  assert.deepEqual(pays.map(p => Number(p.amount)).sort((a, b) => a - b), [600, 600]);
  assert.ok(pays.every(p => p.date === '2026-10-25'));
  assert.equal(rows('Sales_Log').length, salesBefore + 2, 'one renewal and one custom sale');
  assert.equal(rows('Deliveries').length, deliveriesBefore, 'no deliveries');
  assert.equal(rows('Pay_Requests').length, requestsBefore, 'no pay requests');
  assert.equal(JSON.stringify(rows('Accounts')), accountsBefore, 'no account changed');

  // Undo from the toast reverts every table written by the split.
  await toastOf(page, /farid/i).getByRole('button', { name: 'Undo' }).click();
  await toastOf(page, 'Undone').waitFor();
  assert.equal(rows('Sales_Log').find(s => String(s.sale_id) === '44').record_status, 'Active');
  assert.equal(rows('Sales_Log').length, salesBefore, 'renewal and custom rows gone');
  assert.equal(rows('Sales_Log').filter(s => s.product_id === 'CUSTOM').length, 0);
  assert.equal(rows('Payments').filter(p => p.transaction_id === 'DJP2JBSWHA').length, 0, 'both payments gone');
  assert.equal(rows('Payment_Inbox').find(r => r.transaction_id === 'DJP2JBSWHA').status, 'Pending');
  assert.deepEqual(errors, []);
});

test('Acceptance: after the split, the customer shows Custom sales and Money > Profit shows the Custom category', async () => {
  const { page, errors, rows } = await open({ state: acceptanceState() });
  await saveAcceptanceSplit(page);
  const custom = rows('Sales_Log').find(s => s.product_id === 'CUSTOM');
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByRole('heading', { name: 'By category' }).waitFor({ timeout: 10000 });
  const text = await page.locator('#screen').innerText();
  assert.match(text, /Custom/);
  assert.match(text, /600/);
  assert.match(text, /150/);
  await openCustomer(page, 'farid');
  await assert.doesNotReject(page.getByTestId('custom-' + custom.sale_id).waitFor());
  assert.deepEqual(errors, []);
});

test('Acceptance: the 50 Tk payment buys one ExitLag rent day on a random free account and matches its inbox row', async () => {
  const { page, errors, rows } = await open({ state: acceptanceState() });
  const accountsBefore = rows('Accounts').length;
  await quick(page, 'New sale');
  await page.getByRole('button', { name: 'ExitLag rent 1D', exact: true }).click();
  assert.equal(await page.getByTestId('account-random').getAttribute('aria-pressed'), 'true', 'random account is the default');
  await page.locator('#inboxPick').selectOption('DJP8J7IPEK');
  const input = page.getByRole('combobox', { name: 'Customer' });
  await input.fill('farid');
  await page.getByRole('listbox').getByRole('option', { name: /farid/ }).first().click();
  await page.getByLabel('Buy cost (optional)').fill('30');
  await page.getByRole('button', { name: 'Save sale' }).click();
  await toastOf(page, 'Sale saved').waitFor();
  const sale = rows('Sales_Log').find(s => s.product_id === 'EXLRENT1D');
  assert.ok(sale, 'the rent sale is saved');
  assert.match(sale.account_id, /^EXL-/);
  assert.equal(sale.paid_till, '2026-10-19', 'today plus one day');
  assert.equal(Number(sale.cost_snapshot), 30);
  assert.equal(Number(sale.unit_price), 50);
  const pay = rows('Payments').find(p => p.transaction_id === 'DJP8J7IPEK');
  assert.ok(pay, 'the 50 Tk payment is recorded with its transaction id');
  assert.equal(Number(pay.amount), 50);
  assert.equal(pay.sale_id, sale.sale_id);
  assert.equal(rows('Accounts').length, accountsBefore, 'no new account row');
  assert.deepEqual(errors, []);
});

test('API keys and webhooks: a key and a webhook are made under More, each secret is shown once, and neither is listed again', async () => {
  const { page, errors, tables } = await open({ viewport: { width: 1280, height: 800 } });
  await nav(page, 'More');
  await page.locator('[data-more="apikeys"]').click();
  await page.getByRole('button', { name: 'New key' }).click();
  await page.locator('#apiKeyName').fill('Main website');
  await page.locator('#apiKeyOrigins').fill('https://shop.example');
  await page.locator('#saveApiKey').click();
  const shown = page.getByTestId('shown-secret');
  await shown.waitFor();
  const raw = (await shown.innerText()).trim();
  assert.match(raw, /^st_live_[0-9A-Za-z]{32}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('[data-api-key]').filter({ hasText: 'Main website' }).waitFor();
  assert.ok(!(await page.innerText('body')).includes(raw), 'the raw key is not listed again');
  const keys = Array.from(tables.api_keys.values());
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0].hash, raw);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-more="webhooks"]').click();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.locator('#webhookUrl').fill('https://hooks.shop.example/tracker');
  await page.locator('#saveWebhook').click();
  const secret = (await page.getByTestId('shown-secret').innerText()).trim();
  assert.match(secret, /^whsec_[0-9A-Za-z]{40}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('[data-webhook]').filter({ hasText: 'hooks.shop.example' }).waitFor();
  assert.ok(!(await page.innerText('body')).includes(secret), 'the signing secret is not listed again');
  assert.equal(tables.webhook_endpoints.size, 1);
  assert.deepEqual(errors, []);
});

test('Notifications under More: counts, channel switches save, Send now reports, and a channel without its secret says so', async () => {
  const { page, errors, tables } = await open({ viewport: { width: 1280, height: 800 } });
  await nav(page, 'More');
  const card = page.getByTestId('notifications-card');
  await card.waitFor();
  assert.match(await card.innerText(), /Not configured: add WHATSAPP_TOKEN and WHATSAPP_PHONE_ID/);
  assert.equal(await card.locator('[data-count="failed"]').innerText(), '0');
  await page.locator('#notify-whatsapp').click();
  await toastOf(page, 'WhatsApp on').waitFor();
  assert.equal(tables.settings.get('notify_whatsapp_enabled'), 'true');
  await page.getByRole('button', { name: 'Send now' }).click();
  await toastOf(page, 'Queued 0').waitFor();
  assert.deepEqual(errors, []);
});

// ---- uplift 2.4: the gray "collected" profit figure ----
test('Profit shows a gray collected figure while something is unpaid, and drops it once everything is paid', async () => {
  const { page, api, errors } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  const gray = page.getByTestId('profit-collected');
  await gray.first().waitFor({ timeout: 10000 });
  assert.match(await gray.first().innerText(), /collected/);
  assert.match(await page.getByTestId('profit-big').innerText(), /৳/);
  assert.match(await gray.first().evaluate(el => el.className), /text-muted-foreground|text-bad/, 'gray comes from a token class');
  assert.match(await gray.first().locator('.sr-only').innerText(), /of which collected .*unpaid/);
  // pay every open balance, then read again
  const dues = (await api('dues', {})).data.rows;
  assert.ok(dues.length > 0);
  for (const r of dues) {
    const res = await api('pay', { requestId: 'ui-gray-' + r.saleId, customerId: r.customerId, saleId: r.saleId, amount: r.amount, method: 'bKash' });
    assert.equal(res.ok, true, res.error);
  }
  await page.reload();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByTestId('profit-big').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('profit-collected').count(), 0, 'no gray line when nothing is unpaid');
  assert.deepEqual(errors, []);
});

// ---- uplift 2.3: Insights screen ----
// The seeded sheet rows carry no dates, so give some sales and payments dates in the last months.
function insightsState() {
  const st = makeUiState();
  st.sales.slice(0, 40).forEach((x, i) => { x.Sale_Date = '2026-' + (i < 12 ? '10' : i < 24 ? '09' : i < 32 ? '08' : '06') + '-' + String(1 + (i % 17)).padStart(2, '0'); });
  st.payments.slice(0, 45).forEach((x, i) => { x.Date = '2026-' + (i < 14 ? '10' : i < 28 ? '09' : '08') + '-' + String(2 + (i % 16)).padStart(2, '0'); });
  return st;
}
const takaText = n => '৳' + Math.round(Math.abs(n)).toLocaleString('en-US');
const insightsReads = page => {
  const seen = [];
  page.on('request', r => {
    if (r.method() !== 'POST') return;
    try { const b = JSON.parse(r.postData() || '{}'); if (b.action === 'insights') seen.push(b.payload); } catch (e) { /* not ours */ }
  });
  return seen;
};

test('Insights shows KPIs whose revenue matches the server for the same range', async () => {
  const { page, errors, api } = await open({ state: insightsState(), viewport: { width: 1280, height: 800 } });
  const seen = insightsReads(page);
  await nav(page, 'Insights');
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  for (const id of ['revenue', 'profit', 'arpu', 'renewal', 'collection']) await page.getByTestId('insights-kpi-' + id).waitFor();
  assert.ok(seen.length >= 1 && seen[0].from && seen[0].to, 'the read carries an explicit range');
  const server = await api('insights', { from: seen[0].from, to: seen[0].to });
  assert.equal(server.ok, true, server.error);
  assert.ok(server.data.kpis.revenue > 0, 'seed has revenue in range');
  const shown = (await page.getByTestId('insights-kpi-revenue-value').innerText()).replace(/\s/g, '');
  assert.equal(shown, takaText(server.data.kpis.revenue));
  assert.match(await page.getByTestId('insights-kpi-profit').innerText(), /% margin/);
  await page.getByTestId('insights-revenue-chart').waitFor();
  assert.match(await page.locator('#screen').innerText(), /payments have no date/);
  assert.match(await page.evaluate(() => location.hash), /^#\/insights/);
  assert.deepEqual(errors, []);
});

test('Insights: a preset changes the request and the hash, and reload and Back keep the range', async () => {
  const { page, errors } = await open({ state: insightsState(), viewport: { width: 1280, height: 800 } });
  const seen = insightsReads(page);
  await nav(page, 'Insights');
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  const first = seen[seen.length - 1];
  assert.equal(await page.getByTestId('insights-preset-last12').getAttribute('aria-pressed'), 'true', 'default is Last 12 months');
  await page.getByTestId('insights-preset-last3').click();
  await page.waitForFunction(() => /from=/.test(location.hash));
  await page.getByTestId('insights-kpi-revenue').waitFor();
  const next = seen[seen.length - 1];
  assert.notEqual(next.from, first.from, 'from moved');
  assert.equal(next.to, first.to);
  assert.equal(next.from.slice(8), '01');
  assert.equal(await page.getByTestId('insights-preset-last3').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => location.hash), '#/insights?from=' + next.from + '&to=' + next.to);
  await page.reload();
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('insights-preset-last3').getAttribute('aria-pressed'), 'true', 'reload keeps the range');
  await page.getByTestId('insights-preset-ytd').click();
  await page.waitForFunction(() => /from=\d{4}-01-01/.test(location.hash));
  await page.goBack();
  await page.waitForFunction(() => /from=\d{4}-\d\d-01&/.test(location.hash) && !/from=\d{4}-01-01/.test(location.hash));
  assert.equal(await page.getByTestId('insights-preset-last3').getAttribute('aria-pressed'), 'true', 'Back returns to the previous range');
  assert.deepEqual(errors, []);
});

test('Insights: a custom range from the calendar is applied and kept in the URL', async () => {
  const { page, errors } = await open({ state: insightsState(), viewport: { width: 1280, height: 800 } });
  const seen = insightsReads(page);
  await nav(page, 'Insights');
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  await page.getByTestId('insights-custom').click();
  const grid = page.getByRole('grid');
  await grid.waitFor();
  await grid.getByRole('button', { name: /^\w+, \w+ 5th, \d{4}$/ }).click();
  await grid.getByRole('button', { name: /^\w+, \w+ 9th, \d{4}$/ }).click();
  await page.waitForFunction(() => /from=.*&to=/.test(location.hash));
  const last = seen[seen.length - 1];
  assert.deepEqual(last, { from: '2026-10-05', to: '2026-10-09' }, 'two clicks make a range of first and last day');
  assert.equal(await page.evaluate(() => location.hash), '#/insights?from=2026-10-05&to=2026-10-09');
  assert.equal(await page.getByTestId('insights-custom').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('Insights: a failed read shows an error with Retry, and Retry recovers', async () => {
  const { page, errors } = await open({ state: insightsState(), viewport: { width: 1280, height: 800 } });
  let fail = true;
  await page.route('**/functions/v1/api', route => {
    if (fail && /"insights"/.test(route.request().postData() || '')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Insights are down.' }) });
    }
    return route.fallback();
  });
  await nav(page, 'Insights');
  const box = page.getByTestId('insights-error');
  await box.getByText('Insights are down.').waitFor({ timeout: 10000 });
  fail = false;
  await box.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('insights-error').count(), 0);
  assert.deepEqual(errors, []);
});

test('Insights: a range with nothing in it says there is not enough data', async () => {
  const { page, errors } = await open({ state: insightsState(), viewport: { width: 1280, height: 800 } });
  await page.evaluate(() => { location.hash = '#/insights?from=2024-01-01&to=2024-01-31'; });
  await page.reload();
  await page.getByText('Not enough data yet').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('insights-kpi-revenue').count(), 0);
  assert.deepEqual(errors, []);
});

test('Insights on a phone: reached through More, no sideways scroll, single column', async () => {
  const { page, errors } = await open({ state: insightsState() });
  await nav(page, 'More');
  await page.locator('[data-more="insights"]').click();
  await page.getByTestId('insights-kpi-revenue').waitFor({ timeout: 10000 });
  await page.getByTestId('insights-retention').waitFor();
  await page.waitForTimeout(700);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(m.sw <= m.iw, 'scrollWidth ' + m.sw + ' > innerWidth ' + m.iw);
  const xs = await page.evaluate(() => ['insights-kpi-revenue', 'insights-revenue-chart', 'insights-top'].map(id => document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect().left));
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 2, 'blocks share one left edge: ' + xs.join(', '));
  const rowH = await page.getByTestId('insights-top').locator('[role="button"]').first().evaluate(el => el.getBoundingClientRect().height);
  assert.ok(rowH >= 64, 'touch rows are 64px or taller');
  assert.deepEqual(errors, []);
});

test('Insights: the sidebar, the palette and the ? list reach it on a wide screen, and key 9 is Money now', async () => {
  const { page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  await page.keyboard.press('9');
  await page.waitForFunction(() => document.getElementById('pageTitle').textContent === 'Money');
  assert.match(await page.evaluate(() => location.hash), /money/);
  await nav(page, 'Insights');
  await page.getByTestId('insights-preset-last12').waitFor({ timeout: 10000 });
  assert.match(await page.evaluate(() => location.hash), /insights/);
  await nav(page, 'Today');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('insights');
  await page.getByRole('option', { name: /Insights/ }).first().click();
  await page.getByTestId('insights-preset-last12').waitFor();
  await page.keyboard.type('?');
  assert.match(await page.getByTestId('shortcut-list').innerText(), /Insights/);
  assert.deepEqual(errors, []);
});

// ---- uplift 1.1: animated figures (web/src/components/Figure.jsx, NumberFlow) ----
// The digits roll inside NumberFlow's shadow root, so the figure keeps the full number as plain light-DOM text
// (textContent, search, tests) and as its aria-label; the rolling digits are hidden from assistive tech.
test('Figure keeps the full formatted number in the DOM at rest, with the same sentence as its accessible name', async () => {
  const { page, errors } = await open();
  const owed = page.getByTestId('today-owed');
  assert.equal(await owed.evaluate(el => el.textContent), '৳1,360');
  assert.equal(await owed.getAttribute('role'), 'img');
  assert.equal(await owed.getAttribute('aria-label'), '৳1,360');
  assert.equal(await owed.evaluate(el => !!el.querySelector('number-flow-react')?.shadowRoot), true, 'NumberFlow is mounted');
  assert.deepEqual(errors, []);
});

test('Figure under reduced motion: the number is correct at rest and after a change made elsewhere', async () => {
  const { page, errors, api } = await openLive();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const owed = page.getByTestId('today-owed');
  await owed.filter({ hasText: '৳1,360' }).waitFor();
  const before = (await api('home', {})).data.owed;
  assert.equal(takaText(before), '৳1,360');
  const due = (await api('dues', {})).data.rows[0];
  const res = await api('pay', { requestId: 'ui-figure-reduced', customerId: due.customerId, saleId: due.saleId, amount: due.amount, method: 'bKash' });
  assert.equal(res.ok, true, res.error);
  const want = takaText((await api('home', {})).data.owed);
  assert.notEqual(want, '৳1,360', 'the payment changed the owed figure');
  await page.clock.runFor(30000);   // the 25 s poll picks the payment up
  await owed.filter({ hasText: want }).waitFor({ timeout: 5000 });
  assert.equal(await owed.evaluate(el => el.textContent), want);
  assert.equal(await owed.getAttribute('aria-label'), want);
  assert.deepEqual(errors, []);
});

// ---- uplift 1.2: Today as a bento (web/src/components/ui/bento.jsx) ----
// Phones keep one column with no sideways scroll. From xl (1280px) the owed hero and the renewal runway share a top edge, runway to the right.
test('Today bento: no sideways scroll at 360px, and the owed hero sits beside the renewal runway at 1280px', async () => {
  const phone = await open({ viewport: { width: 360, height: 800 } });
  await phone.page.waitForTimeout(1000);   // let the staggered rise finish
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at 360px');
  assert.deepEqual(phone.errors, []);

  const wide = await open({ viewport: { width: 1280, height: 800 } });
  await wide.page.waitForTimeout(1000);
  const [hero, runway] = await wide.page.evaluate(() => {
    const box = label => { const r = document.querySelector('[aria-label="' + label + '"]').getBoundingClientRect(); return { left: r.left, top: r.top }; };
    return [box('Today at a glance'), box('Renewals in the next 14 days')];
  });
  assert.ok(runway.left > hero.left, 'runway is to the right of the hero: ' + runway.left + ' vs ' + hero.left);
  assert.ok(Math.abs(runway.top - hero.top) <= 4, 'tops within 4px: ' + runway.top + ' vs ' + hero.top);
  assert.deepEqual(wide.errors, []);
});

// ---- uplift 1.3: one hero effect per screen (web/src/components/fx/) ----
// The Today hero carries the pointer spotlight (.spotlight; Spotlight.jsx sets --mx and --my) and a shine border (ShineBorder.jsx)
// while money is owed. Money's Net card has the spotlight only.
const TODAY_HERO = '[aria-label="Today at a glance"]';

test('Today hero has the spotlight class and a shine border while owed is above zero', async () => {
  const { page, errors } = await open();
  const hero = page.locator(TODAY_HERO);
  assert.match(await hero.getAttribute('class'), /\bspotlight\b/);
  assert.equal(await hero.getByTestId('shine-border').count(), 1);
  assert.equal(await hero.getByTestId('shine-border').getAttribute('data-paused'), 'false');
  assert.deepEqual(errors, []);
});

test('Moving the pointer over the Today hero sets --mx and --my on the hero', async () => {
  const { page, errors } = await open();
  const hero = page.locator(TODAY_HERO);
  await hero.scrollIntoViewIfNeeded();
  const box = await hero.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.waitForFunction(sel => { const el = document.querySelector(sel); return !!el && el.style.getPropertyValue('--mx') !== ''; }, TODAY_HERO);
  const vars = await hero.evaluate(el => ({ mx: el.style.getPropertyValue('--mx'), my: el.style.getPropertyValue('--my') }));
  assert.match(vars.mx, /^-?\d+(\.\d+)?px$/, 'mx: ' + vars.mx);
  assert.match(vars.my, /^-?\d+(\.\d+)?px$/, 'my: ' + vars.my);
  assert.deepEqual(errors, []);
});

test('Under reduced motion the shine border is absent, and the spotlight class stays', async () => {
  const reduced = await open({ reducedMotion: 'reduce' });
  assert.equal(await reduced.page.getByTestId('shine-border').count(), 0);
  assert.match(await reduced.page.locator(TODAY_HERO).getAttribute('class'), /\bspotlight\b/);
  assert.deepEqual(reduced.errors, []);

  const { page, errors } = await open();
  assert.equal(await page.getByTestId('shine-border').count(), 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="shine-border"]'));
  assert.deepEqual(errors, []);
});

test('The shine border pauses while the tab is hidden and runs again when it is visible', async () => {
  const { page, errors } = await open();
  const shine = page.getByTestId('shine-border');
  const setHidden = hidden => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  assert.equal(await shine.getAttribute('data-paused'), 'true');
  await setHidden(false);
  assert.equal(await shine.getAttribute('data-paused'), 'false');
  assert.deepEqual(errors, []);
});

test('Money Overview Net card has the spotlight and no shine border', async () => {
  const { page, errors } = await open();
  await nav(page, 'Money');
  const net = page.getByTestId('widget-net');
  await net.waitFor();
  assert.equal(await net.locator('.spotlight').count(), 1);
  assert.equal(await page.getByTestId('shine-border').count(), 0);
  assert.deepEqual(errors, []);
});

// Live arrivals (uplift 1.4): a payment that reaches the inbox between two refreshes slides in as the top row of "Payments not
// matched" and gets one toast. The first load announces nothing, and a refresh that finds the same ids does nothing.
test('New payment: a payment that arrives between two refreshes is the top row and gets one toast; the first load gets none', async () => {
  const { page, errors, relay } = await openLive();
  await page.getByTestId('unm-TESTTRX1').waitFor();
  assert.equal(await toastOf(page, 'New payment').count(), 0, 'no toast on the first load');

  const sent = await relay('bkash', { sender: '16247', text: 'You have received Tk 2,290.00 from 01756999992. TrxID LIVEARRIVE1 at 28/10/2026 10:00' });
  assert.equal(sent.body.result, 'stored', 'the SMS was stored in the inbox');

  await page.clock.runFor(6000);   // past the 5 s floor between two refreshes
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByTestId('unm-LIVEARRIVE1').waitFor({ timeout: 5000 });
  const order = await page.locator('#payments-to-match [data-testid^="unm-"]').evaluateAll(els => els.map(e => e.dataset.testid));
  assert.deepEqual(order, ['unm-LIVEARRIVE1', 'unm-TESTTRX1'], 'the new payment is the top row');
  await toastOf(page, 'New payment: Tk 2,290').waitFor();
  assert.equal(await toastOf(page, 'New payment').count(), 1, 'one toast for the one arrival');

  // A refresh that finds the same ids changes nothing. The arrival toast's 4 s timer runs out on the fake clock during this
  // advance, so no "New payment" toast should be on screen once the refresh has answered.
  const answered = page.waitForResponse(r => isInit(r.request()));
  await page.clock.runFor(6000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await answered;
  await page.waitForTimeout(200);
  assert.equal(await toastOf(page, 'New payment').count(), 0, 'an unchanged refresh adds no toast');
  assert.deepEqual(errors, []);
});

// ---- uplift 1.6: empty states ----
// Pay every open due, then Dues shows the empty state with its line art. The art is decorative, so it is hidden from assistive tech.
test('Dues with nobody owing shows the empty state with hidden line art', async () => {
  const { page, api, errors } = await open();
  const dues = (await api('dues', {})).data.rows;
  assert.ok(dues.length > 0);
  for (const r of dues) {
    const res = await api('pay', { requestId: 'ui-empty-' + r.saleId, customerId: r.customerId, saleId: r.saleId, amount: r.amount, method: 'bKash' });
    assert.equal(res.ok, true, res.error);
  }
  await page.reload();
  await nav(page, 'Dues');
  const list = page.getByTestId('dues-list');
  await list.getByText('Nobody owes you anything.').waitFor({ timeout: 10000 });
  const art = list.locator('svg[aria-hidden="true"]');
  assert.equal(await art.count(), 1, 'one line-art picture in the empty state');
  assert.equal(await art.getAttribute('aria-hidden'), 'true');
  assert.equal(await art.evaluate(el => el.getBoundingClientRect().width), 96, 'drawn at 96px');
  assert.equal(await page.getByTestId('due-pay').count(), 0, 'no due rows left');
  assert.deepEqual(errors, []);
});

// ---- uplift 1.5: page transitions and focus ----
// After a nav click, focus moves to the page title (not on the first load). The title is a heading, so it has no outline.
test('nav: focus moves to the page title after a nav click, and not on the first load', async () => {
  const { page, errors } = await open();
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'pageTitle', 'not on the first load');
  await nav(page, 'Customers');
  await page.waitForFunction(() => document.getElementById('pageTitle').textContent === 'Customers');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pageTitle');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  assert.deepEqual(errors, []);
});

// The progress line is absent at rest. While a screen's chunk is still loading it shows, and the screen before it stays up.
test('nav: the route progress line is absent at rest, and shows while a screen chunk loads with the previous screen kept', async () => {
  const { page, errors } = await open();
  assert.equal(await page.getByTestId('route-progress').count(), 0, 'absent at rest');
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/assets/Accounts-*.js', async route => { await gate; await route.continue(); });
  await nav(page, 'Accounts');
  await page.getByTestId('route-progress').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#pageTitle').innerText(), 'Today', 'the previous screen is still the page');
  assert.ok(await page.getByTestId('today-owed').isVisible());
  release();
  await page.waitForFunction(() => document.getElementById('pageTitle').textContent === 'Accounts');
  assert.equal(await page.getByTestId('route-progress').count(), 0, 'gone once the screen is in');
  assert.deepEqual(errors, []);
});

// ---- uplift 1.7: wordmark and sidebar polish ----
// The sidebar nav reads in three groups. The number keys follow that order (see 5.1 in the plan).
test('sidebar: the nav reads in three groups, Operate, Money and System, at 1280px', async () => {
  const { page, errors } = await open(WIDE);
  assert.deepEqual(await page.locator('aside [role="group"] > p.eyebrow').allTextContents(), ['Operate', 'Money', 'System']);
  for (const g of ['Operate', 'Money', 'System']) assert.ok(await page.getByRole('group', { name: g }).isVisible(), g + ' is visible');
  const inGroup = async g => (await page.getByRole('group', { name: g }).locator('button').allInnerTexts()).map(t => t.replace(/\d|\s|pending/g, ''));
  assert.deepEqual(await inGroup('Operate'), ['Today', 'Customers', 'Accounts', 'Delivery', 'Dues', 'Inbox', 'Reminders', 'Calendar'], 'Inbox (4.1), Reminders (4.2) and Calendar (4.4) follow Dues');
  assert.deepEqual(await inGroup('Money'), ['Money', 'Insights', 'Paylinks']);
  assert.deepEqual(await inGroup('System'), ['Activity', 'Settings', 'More'], 'Activity (plan 4.3) and Settings sit before More (plan 5.1)');
  assert.deepEqual(errors, []);
});

// [ collapses the rail to 64px and the choice is kept. A collapsed nav button keeps its name through aria-label.
test('sidebar: [ collapses to a 64px rail with names kept, the choice survives a reload, and typing [ in a field does not toggle it', async () => {
  const { page, errors } = await open(WIDE);
  const settled = w => page.waitForFunction(want => Math.round(document.querySelector('aside').getBoundingClientRect().width) === want, w);
  assert.equal(await page.locator('aside').evaluate(a => Math.round(a.getBoundingClientRect().width)), 240, 'starts at 240px');
  await page.keyboard.press('[');
  await settled(64);
  assert.equal(await page.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-pressed'), 'true');
  assert.ok(await page.getByRole('button', { name: 'Customers', exact: true }).isVisible(), 'the icon keeps its name');
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await settled(64);
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_sidebar')), 'collapsed');
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').click();
  await page.keyboard.type('[');
  assert.equal(await page.getByLabel('Search customers').inputValue(), '[');
  await settled(64);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await settled(240);
  assert.equal(await page.evaluate(() => localStorage.getItem('sales_tracker_sidebar')), 'expanded');
  assert.deepEqual(errors, []);
});

// The rail is a per-viewer convenience: with localStorage throwing, the app loads and [ still works for the visit.
test('sidebar: the app still loads when localStorage throws, and [ still collapses the rail', async () => {
  const ctx = await browser.newContext(WIDE);
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await startUiHost(page);
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await page.keyboard.press('[');
  await page.waitForFunction(() => Math.round(document.querySelector('aside').getBoundingClientRect().width) === 64);
  assert.ok(await page.getByRole('button', { name: 'Customers', exact: true }).isVisible());
  assert.deepEqual(errors, []);
});

// ---- uplift 3.2: Customers table (md and up; phones keep the card list) ----
const TABLE_VIEW = { viewport: { width: 1280, height: 800 } };
const custTable = page => page.getByRole('table', { name: 'Customers', exact: true });
const custRows = page => page.locator('[data-testid="cust-list"] tbody tr[data-row-index]');
const seedNames = () => require('../support/seed').makeUiState().customers.map(c => c.Name);
// Scrolls the table's own scroller (the nearest ancestor with overflow auto or scroll) by dy px, or to its bottom when dy is null.
async function scrollTable(page, dy) {
  await page.evaluate(d => {
    let el = document.querySelector('[data-testid="cust-list"] table');
    while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    el.scrollTop = d === null ? el.scrollHeight : el.scrollTop + d;
  }, dy);
  await page.waitForTimeout(60);
}

test('Customers table: all seeded customers are listed, the count matches, and the 64-row body virtualises down to the last row', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  const names = seedNames();
  const total = names.length;
  await custTable(page).waitFor();
  assert.equal(await page.getByTestId('cust-count').innerText(), String(total), 'the section count is the seed customer count');
  assert.ok(total > 60, 'the seed is above the virtualisation threshold');
  const byName = names.slice().sort((a, b) => a.localeCompare(b));
  assert.equal(await custRows(page).first().locator('span.truncate').first().innerText(), byName[0], 'first row');
  assert.ok(await custRows(page).count() < total, 'only part of the body is in the DOM at the top');
  const seen = new Set();
  for (let i = 0; i < 40 && seen.size < total; i++) {
    for (const n of await custRows(page).evaluateAll(rs => rs.map(r => Number(r.getAttribute('data-row-index'))))) seen.add(n);
    if (seen.size < total) await scrollTable(page, 240);
  }
  assert.equal(seen.size, total, 'every customer row was rendered at some scroll position');
  await scrollTable(page, null);
  const lastRow = page.locator('[data-testid="cust-list"] tr[data-row-index="' + (total - 1) + '"]');
  await lastRow.waitFor();
  assert.equal(await lastRow.locator('span.truncate').first().innerText(), byName[total - 1], 'last row after scrolling to the bottom');
  assert.deepEqual(errors, []);
});

test('Customers table: a search that leaves 60 or fewer rows renders one DOM row per customer, and the count matches', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('a');
  const expected = seedNames().filter(n => n.toLowerCase().indexOf('a') >= 0).length;
  assert.ok(expected > 0 && expected <= 60, 'the search is in the plain (not virtualised) range: ' + expected);
  await page.getByTestId('cust-count').filter({ hasText: String(expected) }).waitFor();
  assert.equal(await custRows(page).count(), expected, 'one row per match');
  assert.equal(await page.getByTestId('cust-count').innerText(), String(expected));
  assert.deepEqual(errors, []);
});

test('Customers table: clicking the Name header sorts it, aria-sort follows, and the first row changes', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  const head = custTable(page).getByRole('columnheader', { name: 'Name', exact: true });
  const firstName = () => custRows(page).first().locator('span.truncate').first().innerText();
  assert.equal(await head.getAttribute('aria-sort'), 'none');
  const before = await firstName();
  await head.getByRole('button').click();
  assert.equal(await head.getAttribute('aria-sort'), 'ascending');
  await head.getByRole('button').click();
  assert.equal(await head.getAttribute('aria-sort'), 'descending');
  assert.notEqual(await firstName(), before, 'descending puts another customer first');
  assert.deepEqual(errors, []);
});

test('Customers table: hiding Credit through the Columns menu removes the column', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  const credit = custTable(page).getByRole('columnheader', { name: 'Credit', exact: true });
  assert.equal(await credit.count(), 1, 'Credit shows at first');
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Credit', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.equal(await credit.count(), 0, 'Credit is gone');
  assert.equal(await custTable(page).getByRole('columnheader', { name: 'Owes', exact: true }).count(), 1, 'Owes stays');
  assert.deepEqual(errors, []);
});

test('Customers table: selecting two rows updates the selection, and the header checkbox shows mixed', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  assert.equal(await page.getByTestId('cust-list').getAttribute('data-selected'), '0');
  await page.getByRole('checkbox', { name: 'Select row' }).nth(0).click();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(1).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="cust-list"]').dataset.selected === '2');
  assert.equal(await page.locator('[data-testid="cust-list"] tbody tr[data-state="selected"]').count(), 2, 'two rows are selected');
  assert.equal(await custTable(page).getByRole('checkbox', { name: 'Select all' }).getAttribute('aria-checked'), 'mixed');
  assert.deepEqual(errors, []);
});

test('Customers table: ArrowDown moves focus from one row to the next', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.locator('[data-testid="cust-list"] tr[data-row-index="0"]').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-row-index')), '1');
  assert.deepEqual(errors, []);
});

// uplift 4.5: a row click on the wide table now goes to the customer workspace (#/customers/<id>), not to the sheet.
test('Customers table: clicking a row opens the customer workspace at #/customers/<id>, not the sheet', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('farid');
  await custTable(page).getByText('farid', { exact: true }).click();
  await page.getByTestId('cust-workspace').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers/' + require('../support/seed').makeUiState().customers.find(c => c.Name === 'farid').Customer_ID);
  assert.equal(await page.getByRole('dialog').count(), 0, 'no sheet');
  assert.deepEqual(errors, []);
});

test('Customers table: at 360px the card list is unchanged, no table renders, and rows stay 64px tall', async () => {
  const { page, errors } = await open();
  await nav(page, 'Customers');
  await page.getByTestId('cust-list').getByRole('button').first().waitFor();
  assert.equal(await page.getByRole('table').count(), 0, 'no table on a phone');
  assert.equal(await page.getByTestId('cust-list').getByRole('button').count(), seedNames().length, 'every customer is a card row');
  const h = await page.getByTestId('cust-list').getByRole('button').first().evaluate(el => el.getBoundingClientRect().height);
  assert.ok(h >= 64, 'touch rows are 64px or taller');
  assert.deepEqual(errors, []);
});

test('Customers table: chip counts match on both paths, and a resize switches between the table and the card list', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  const chips = () => page.getByRole('group', { name: 'Filter customers' }).innerText();
  const wideChips = await chips();
  await page.setViewportSize({ width: 360, height: 740 });
  await custTable(page).waitFor({ state: 'detached' });
  assert.equal(await chips(), wideChips, 'same chip counts on the card list');
  const owes = Number((wideChips.match(/Owes · (\d+)/) || [])[1]);
  await page.getByRole('button', { name: /^Owes · / }).click();
  assert.equal(await page.getByTestId('cust-list').getByRole('button').count(), owes, 'card list shows the Owes count');
  await page.setViewportSize({ width: 1280, height: 800 });
  await custTable(page).waitFor();
  assert.equal(await page.getByTestId('cust-count').innerText(), String(owes), 'table shows the same Owes count');
  assert.equal(await custRows(page).count(), owes, 'one row per owing customer');
  assert.deepEqual(errors, []);
});

// ---- uplift 3.3: Book ledger table (md and up; phones keep the entry cards) ----
const bookTable = page => page.getByRole('table', { name: 'Book entries', exact: true });
const bookRowIds = page => page.locator('[data-testid="book-list"] tbody tr[data-row-index]').evaluateAll(rs => rs.map(r => r.getAttribute('data-testid')));
const bookRowTexts = page => page.locator('[data-testid="book-list"] tbody tr[data-row-index]').evaluateAll(rs => rs.map(r => r.innerText.toLowerCase()));
const isPaymentRow = testid => testid.indexOf('entry-PM-') === 0;   // a payment is the In side; expenses and purchases are Out
async function openBookTable(page) {
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Book' }).click();
  await bookTable(page).waitFor();
}

test('Book table: at 1280px it lists the same entries as the card list for the month, in the same order', async () => {
  const { page, errors } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  const tableIds = await bookRowIds(page);
  assert.ok(tableIds.length > 10, 'the seed month has entries: ' + tableIds.length);
  assert.equal(tableIds.length, new Set(tableIds).size, 'one row per entry');
  await page.setViewportSize({ width: 360, height: 740 });
  await bookTable(page).waitFor({ state: 'detached' });
  const cardIds = await page.locator('[data-testid^="entry-"]').evaluateAll(els => els.map(el => el.getAttribute('data-testid')));
  assert.deepEqual(tableIds, cardIds, 'same entries, same order as the cards');
  assert.deepEqual(errors, []);
});

test('Book table: the Out chip hides the In rows, All brings them back, and the count follows', async () => {
  const { page, errors } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  const all = await bookRowIds(page);
  assert.ok(all.some(isPaymentRow), 'an In row is shown at first');
  await page.getByRole('button', { name: /^Out · / }).click();
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="book-list"] tbody tr[data-row-index]').length < n, all.length);
  const outIds = await bookRowIds(page);
  assert.ok(outIds.length > 0 && outIds.length < all.length, 'Out narrows the rows');
  assert.equal(outIds.filter(isPaymentRow).length, 0, 'no payment (In) row is left');
  assert.equal(await page.getByTestId('book-count').innerText(), String(outIds.length), 'the count is the Out row count');
  assert.equal(await page.getByRole('button', { name: /^Out · / }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: /^All · / }).click();
  assert.deepEqual(await bookRowIds(page), all, 'All shows every entry again');
  assert.deepEqual(errors, []);
});

test('Book table: search matches the label, the method and the amount', async () => {
  const { page, errors } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  const search = page.getByRole('searchbox', { name: 'Search entries', exact: true });
  await search.fill('farid');
  const byName = await bookRowTexts(page);
  assert.ok(byName.length > 0 && byName.every(t => t.includes('farid')), 'every row is a farid row: ' + byName.length);
  assert.ok((await bookRowIds(page)).includes('entry-PM-09100'), 'the farid payment is in the result');
  await search.fill('bkash');
  assert.ok((await bookRowIds(page)).length > 0 && (await bookRowTexts(page)).every(t => t.includes('bkash')), 'method search');
  await search.fill('500');
  assert.equal(await page.getByTestId('entry-PM-09100').count(), 1, 'an amount search finds the 500 payment');
  await search.fill('nothing like this');
  await page.getByText('No entries match.').waitFor();
  assert.equal(await page.getByTestId('book-count').innerText(), '0');
  assert.deepEqual(errors, []);
});

test('Book table: an amount and a note are edited in place, and the row shows the saved values', async () => {
  const id = 'PM-09100';
  const { page, errors, rows } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  const row = page.getByTestId('entry-' + id);
  await cellBtn(page, 'Amount', payTarget(id)).click();
  await payAmountBox(page, id).fill('450');
  await page.keyboard.press('Enter');
  await toastOf(page, 'Amount: ৳450').waitFor();
  await row.getByRole('button', { name: new RegExp(escRe('Edit Amount for ' + payTarget(id) + ': +৳450')) }).waitFor();
  assert.equal(Number(payRowOf(rows, id).amount), 450, 'the amount is saved');
  await cellBtn(page, 'Note', payTarget(id)).click();
  await payBox(page, 'Note', id).fill('paid in the table');
  await page.keyboard.press('Control+Enter');
  await toastOf(page, 'Note: paid in the table').waitFor();
  await row.getByText('paid in the table', { exact: true }).waitFor();
  assert.equal(payRowOf(rows, id).note, 'paid in the table', 'the note is saved');
  assert.deepEqual(errors, []);
});

test('Book table: clicking the label opens the entry sheet', async () => {
  const id = 'PM-09100';
  const { page, errors } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  await page.getByTestId('entry-' + id).getByText('farid', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Payment ' + id, exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

// ---- uplift 3.4: bulk selection and action bar (BulkBar, Customers table, Dues rows) ----
const bulkBar = page => page.getByRole('region', { name: 'Bulk actions' });
const dueBoxes = page => page.getByRole('checkbox', { name: /^Select due for / });

test('Bulk bar: two customers selected show "2 selected" in a labelled live region, and Esc clears them', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  assert.equal(await bulkBar(page).count(), 0, 'no bar while nothing is selected');
  await page.getByRole('checkbox', { name: 'Select row' }).nth(0).click();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(1).click();
  await bulkBar(page).waitFor();
  assert.equal(await page.getByTestId('bulk-count').innerText(), '2 selected');
  assert.equal(await page.getByTestId('bulk-count').getAttribute('aria-live'), 'polite');
  assert.ok(await bulkBar(page).getByRole('button', { name: 'Export selected CSV' }).isVisible());
  assert.ok(await bulkBar(page).getByRole('button', { name: 'Copy phone/handle list' }).isVisible());
  await page.keyboard.press('Escape');
  await bulkBar(page).waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('cust-list').getAttribute('data-selected'), '0', 'the table selection is cleared too');
  assert.equal(await page.locator('[data-testid="cust-list"] tr[data-state="selected"]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Bulk bar: Clear empties the selection, and Esc does nothing while a field has focus', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(0).click();
  await bulkBar(page).waitFor();
  await page.getByLabel('Search customers').focus();
  await page.keyboard.press('Escape');
  assert.equal(await bulkBar(page).count(), 1, 'Esc in a field keeps the selection');
  await bulkBar(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await bulkBar(page).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('Bulk: Export selected CSV downloads only the selected customers, and neutralises a name that starts with =', async () => {
  // Two customers whose names both contain "jamilhq": the search narrows the table to them, so both rows are on screen.
  const st = makeUiState();
  const other = st.customers.find(c => c.Name !== 'jamilhq');
  other.Name = '=jamilhq twin';
  const { page, errors } = await open(Object.assign({ state: st }, TABLE_VIEW));
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.getByLabel('Search customers').fill('jamilhq');
  await custTable(page).getByText('=jamilhq twin', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(0).click();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(1).click();
  await page.getByTestId('bulk-count').filter({ hasText: '2 selected' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export selected CSV' }).click()]);
  assert.match(dl.suggestedFilename(), /^customers-selected-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = (await readDownload(dl)).split('\r\n');
  assert.equal(lines[0], '"Customer","Channel","Handle","Owes","Credit"');
  assert.equal(lines.length, 3, 'header plus the two selected customers, nothing else');
  const firstCells = lines.slice(1).map(l => l.split('",')[0] + '"').sort();
  assert.deepEqual(firstCells, ['"\'=jamilhq twin"', '"jamilhq"'].sort());
  assert.match(lines.find(l => l.includes('twin')), /^"'=jamilhq twin"/, 'the = name gets an apostrophe');
  assert.deepEqual(errors, []);
});

test('Bulk: Copy phone/handle list puts one handle per line on the clipboard', async () => {
  const st = makeUiState();
  const other = st.customers.find(c => c.Name !== 'jamilhq');
  other.Name = 'jamilhq twin'; other.Channel = 'Messenger'; other.Handle = 'tester-two';
  const { page, errors } = await open(Object.assign({ state: st }, TABLE_VIEW, CLIP));
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.getByLabel('Search customers').fill('jamilhq');
  await custTable(page).getByText('jamilhq twin', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(0).click();
  await page.getByRole('checkbox', { name: 'Select row' }).nth(1).click();
  await page.getByTestId('bulk-count').filter({ hasText: '2 selected' }).waitFor();
  await bulkBar(page).getByRole('button', { name: 'Copy phone/handle list' }).click();
  await toastOf(page, 'Copied 2 handles').waitFor();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  // Windows puts CRLF on the clipboard, so split on either line ending.
  assert.deepEqual(text.split(/\r?\n/).sort(), ['01711111111', 'tester-two']);
  assert.deepEqual(errors, []);
});

test('Bulk: Dues rows have a checkbox, and Copy reminder messages puts both customers under their headers on the clipboard', async () => {
  const { page, errors } = await open(CLIP);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  assert.ok((await dueBoxes(page).count()) >= 3, 'the seed has several dues');
  const names = [await dueBoxes(page).nth(0).getAttribute('aria-label'), await dueBoxes(page).nth(1).getAttribute('aria-label')]
    .map(l => l.replace(/^Select due for /, ''));
  await dueBoxes(page).nth(0).click();
  await dueBoxes(page).nth(1).click();
  await page.getByTestId('bulk-count').filter({ hasText: '2 selected' }).waitFor();
  await bulkBar(page).getByRole('button', { name: 'Copy reminder messages' }).click();
  await toastOf(page, 'Copied 2 reminder messages').waitFor();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  for (const n of names) assert.ok(text.includes('--- ' + n + ' ---'), 'header for ' + n + ' in: ' + text.slice(0, 200));
  assert.equal(await bulkBar(page).getByRole('button', { name: 'Mark all sent' }).count(), 1, 'Mark all sent is offered once the messages are copied');
  assert.deepEqual(errors, []);
});

test('Bulk: Mark all sent writes one Reminders_Log row per selected due, and the bar clears', async () => {
  const { page, errors, rows } = await open(CLIP);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await dueBoxes(page).nth(0).click();
  await dueBoxes(page).nth(1).click();
  await page.getByTestId('bulk-count').filter({ hasText: '2 selected' }).waitFor();
  await bulkBar(page).getByRole('button', { name: 'Copy reminder messages' }).click();
  await toastOf(page, 'Copied 2 reminder messages').waitFor();
  const before = rows('Reminders_Log').length;
  await bulkBar(page).getByRole('button', { name: 'Mark all sent' }).click();
  await toastOf(page, 'Marked 2 of 2 as sent').waitFor();
  const added = rows('Reminders_Log').slice(before);
  assert.equal(added.length, 2, 'two reminder rows were written');
  assert.ok(added.every(r => r.status === 'sent' && r.kind === 'due'), JSON.stringify(added));
  assert.equal(new Set(added.map(r => r.sale_id)).size, 2, 'one row per due');
  assert.equal(await bulkBar(page).count(), 0, 'the selection is cleared after a full run');
  assert.deepEqual(errors, []);
});

test('Bulk: Mark all sent stops at the first failure and toasts how many were marked of N', async () => {
  const { page, errors, rows } = await open(CLIP);
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await dueBoxes(page).nth(0).click();
  await dueBoxes(page).nth(1).click();
  await dueBoxes(page).nth(2).click();
  await page.getByTestId('bulk-count').filter({ hasText: '3 selected' }).waitFor();
  await bulkBar(page).getByRole('button', { name: 'Copy reminder messages' }).click();
  await toastOf(page, 'Copied 3 reminder messages').waitFor();
  let sent = 0;
  await page.route('**/functions/v1/api', route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'remindSent' && ++sent === 2) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Sheet is busy' }) });
    }
    return route.fallback();
  });
  const before = rows('Reminders_Log').length;
  await bulkBar(page).getByRole('button', { name: 'Mark all sent' }).click();
  await toastOf(page, 'Marked 1 of 3 as sent').waitFor();
  assert.match(await toastOf(page, 'Marked 1 of 3').innerText(), /Sheet is busy/);
  assert.equal(sent, 2, 'the third reminder was never sent');
  assert.equal(rows('Reminders_Log').length - before, 1, 'one row written before the failure');
  assert.equal(await page.getByTestId('bulk-count').innerText(), '2 selected', 'the two not marked stay selected');
  assert.deepEqual(errors, []);
});

test('Bulk bar on a phone sits above the dock, with no sideways scroll', async () => {
  const { page, errors } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await dueBoxes(page).nth(0).click();
  await bulkBar(page).waitFor();
  const [bar, dock] = await Promise.all([
    bulkBar(page).boundingBox(),
    page.locator('nav[aria-label="Sections"]').last().boundingBox()
  ]);
  assert.ok(bar.y + bar.height <= dock.y, 'the bar ends above the top of the dock');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  await page.keyboard.press('Escape');
  await bulkBar(page).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

// ---- uplift 3.5: saved views (Customers, Dues, Book; a per-viewer convenience kept in localStorage) ----
const viewSelect = page => page.getByRole('combobox', { name: 'View', exact: true });
const viewOptions = page => viewSelect(page).locator('option').allInnerTexts();
const viewName = page => page.getByRole('textbox', { name: 'View name', exact: true });
const saveViewBtn = page => page.getByRole('button', { name: 'Save current view as...', exact: true });
const owesChip = /^Owes · /;
const chipPressed = (page, re) => page.getByRole('button', { name: re }).getAttribute('aria-pressed');

test('Saved views on Customers: "Owes first" keeps the filter and sort, comes back after a reload, and Delete removes it', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.getByRole('button', { name: owesChip }).click();
  await page.getByLabel('Sort customers').selectOption('owes');
  const owes = Number((await page.getByRole('button', { name: owesChip }).innerText()).match(/(\d+)\s*$/)[1]);
  await saveViewBtn(page).click();
  await viewName(page).fill('Owes first');
  await page.keyboard.press('Enter');
  await toastOf(page, 'View saved: Owes first').waitFor();
  assert.equal(await viewSelect(page).inputValue(), 'Owes first', 'the new view is selected');
  await page.reload();
  await custTable(page).waitFor();
  assert.equal(await chipPressed(page, owesChip), 'false', 'a reload starts on Default');
  await viewSelect(page).selectOption('Owes first');
  assert.equal(await chipPressed(page, owesChip), 'true', 'the Owes chip comes back');
  assert.equal(await page.getByLabel('Sort customers').inputValue(), 'owes', 'the sort comes back');
  await page.getByTestId('cust-count').filter({ hasText: String(owes) }).waitFor();
  const owesCol = await custTable(page).getByRole('columnheader').evaluateAll(hs => hs.findIndex(h => h.innerText.trim() === 'Owes'));
  const amounts = await custRows(page).evaluateAll((rs, i) => rs.map(r => Number(r.children[i].innerText.replace(/\D/g, '') || 0)), owesCol);
  assert.ok(amounts.length > 0 && amounts.every(a => a > 0), 'only owing customers are listed');
  assert.deepEqual(amounts, amounts.slice().sort((a, b) => b - a), 'most owed first, as the sort says');
  await page.getByRole('button', { name: 'Delete view', exact: true }).click();
  await toastOf(page, 'View deleted').waitFor();
  assert.equal(await viewSelect(page).inputValue(), '', 'back on Default');
  assert.equal(await page.getByRole('button', { name: 'Delete view', exact: true }).count(), 0, 'Delete hides with no view selected');
  await page.reload();
  await custTable(page).waitFor();
  assert.deepEqual(await viewOptions(page), ['Default'], 'the deleted view is gone after a reload');
  assert.deepEqual(errors, []);
});

test('Saved views: an empty or 41-character name is refused, Esc cancels, and the same name in another case replaces the view', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await saveViewBtn(page).click();
  await viewName(page).press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Type a name for the view.' }).waitFor();
  await viewName(page).fill('x'.repeat(41));
  await viewName(page).press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Use 40 characters or fewer.' }).waitFor();
  await viewName(page).press('Escape');
  await viewName(page).waitFor({ state: 'detached' });
  assert.equal(await saveViewBtn(page).evaluate(el => el === document.activeElement), true, 'Esc returns focus to the button');
  assert.deepEqual(await viewOptions(page), ['Default'], 'nothing was saved');
  await saveViewBtn(page).click();
  await viewName(page).fill('  Mine  ');
  await viewName(page).press('Enter');
  await toastOf(page, 'View saved: Mine').waitFor();
  assert.deepEqual(await viewOptions(page), ['Default', 'Mine'], 'the name is trimmed');
  await page.getByRole('button', { name: owesChip }).click();
  await saveViewBtn(page).click();
  await viewName(page).fill('mine');
  await viewName(page).press('Enter');
  await page.locator('[data-sonner-toast]').filter({ hasText: /View saved: mine$/ }).waitFor();   // case-sensitive: the earlier toast says "Mine"
  assert.deepEqual(await viewOptions(page), ['Default', 'mine'], 'the same name in another case replaces the view');
  await viewSelect(page).selectOption('Default');
  assert.equal(await chipPressed(page, owesChip), 'false');
  await viewSelect(page).selectOption('mine');
  assert.equal(await chipPressed(page, owesChip), 'true', 'the replaced view has the new filter');
  assert.deepEqual(errors, []);
});

test('Saved views: a name with HTML shows as plain text in the select and the toast', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await saveViewBtn(page).click();
  await viewName(page).fill('<b>x</b>');
  await page.keyboard.press('Enter');
  await toastOf(page, '<b>x</b>').waitFor();
  assert.deepEqual(await viewOptions(page), ['Default', '<b>x</b>']);
  assert.ok((await viewSelect(page).innerHTML()).includes('&lt;b&gt;x&lt;/b&gt;'), 'the name is escaped, not parsed');
  assert.equal(await page.locator('[data-testid="saved-views"] b, [data-sonner-toast] b').count(), 0, 'no bold element was made');
  assert.deepEqual(errors, []);
});

test('Saved views: with localStorage throwing, a view still saves and applies for this session, and nothing crashes', async () => {
  const ctx = await browser.newContext(TABLE_VIEW);
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    const denied = () => { throw new Error('storage denied'); };
    Storage.prototype.getItem = denied;
    Storage.prototype.setItem = denied;
    Storage.prototype.removeItem = denied;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await startUiHost(page);
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  await page.getByRole('button', { name: owesChip }).click();
  await saveViewBtn(page).click();
  await viewName(page).fill('Owes first');
  await page.keyboard.press('Enter');
  await toastOf(page, 'View saved: Owes first').waitFor();
  assert.deepEqual(await viewOptions(page), ['Default', 'Owes first'], 'the view is listed for this session');
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  assert.deepEqual(await viewOptions(page), ['Default', 'Owes first'], 'still listed after leaving and coming back');
  await viewSelect(page).selectOption('Default');
  assert.equal(await chipPressed(page, owesChip), 'false');
  await viewSelect(page).selectOption('Owes first');
  assert.equal(await chipPressed(page, owesChip), 'true', 'the in-memory view applies');
  assert.deepEqual(errors, []);
});

test('Saved views at 360px: the controls wrap with no sideways scroll, and each one is 44px or taller', async () => {
  const { page, errors } = await open();
  await nav(page, 'Customers');
  await page.getByTestId('saved-views').waitFor();
  await saveViewBtn(page).click();
  await viewName(page).waitFor();
  const heights = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="saved-views"] button, [data-testid="saved-views"] select, [data-testid="saved-views"] input'))
    .map(el => Math.round(el.getBoundingClientRect().height)));
  assert.ok(heights.length >= 4, 'select, save, cancel and the name field: ' + heights.length);
  assert.ok(heights.every(h => h >= 44), 'every control is 44px or taller: ' + JSON.stringify(heights));
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  assert.deepEqual(errors, []);
});

test('Saved views on Dues: a search and a sort come back from a view after a reload', async () => {
  const { page, errors } = await open();
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await page.getByLabel('Search dues').fill('tariq');
  await page.getByLabel('Sort dues').selectOption('name');
  await saveViewBtn(page).click();
  await viewName(page).fill('Tariq');
  await page.keyboard.press('Enter');
  await toastOf(page, 'View saved: Tariq').waitFor();
  await page.reload();
  await page.getByTestId('dues-list').waitFor();
  await viewSelect(page).selectOption('Tariq');
  assert.equal(await page.getByLabel('Search dues').inputValue(), 'tariq', 'the search comes back');
  assert.equal(await page.getByLabel('Sort dues').inputValue(), 'name', 'the sort comes back');
  await page.getByTestId('dues-list').getByText('tariq').waitFor();
  await page.getByTestId('dues-list').getByText('Kabir').waitFor({ state: 'detached', timeout: 2000 });
  assert.deepEqual(errors, []);
});

test('Saved views on Book (1280px): the Out filter and an Out sort come back from a view after a reload', async () => {
  const { page, errors } = await open({ state: withEntries(), viewport: { width: 1280, height: 800 } });
  await openBookTable(page);
  await page.getByRole('button', { name: /^Out · / }).click();
  const outHead = bookTable(page).getByRole('columnheader', { name: 'Out', exact: true });
  await outHead.getByRole('button').click();
  const sortedAs = await outHead.getAttribute('aria-sort');
  assert.match(sortedAs, /ascending|descending/, 'the Out column is sorted');
  await saveViewBtn(page).click();
  await viewName(page).fill('Outgoing');
  await page.keyboard.press('Enter');
  await toastOf(page, 'View saved: Outgoing').waitFor();
  await page.reload();
  await openBookTable(page);
  assert.equal(await chipPressed(page, /^Out · /), 'false', 'a reload starts on All');
  await viewSelect(page).selectOption('Outgoing');
  assert.equal(await chipPressed(page, /^Out · /), 'true', 'the Out filter comes back');
  assert.equal(await bookTable(page).getByRole('columnheader', { name: 'Out', exact: true }).getAttribute('aria-sort'), sortedAs, 'the Out sort comes back');
  assert.equal(await page.locator('[data-testid="book-list"] tbody tr[data-testid^="entry-PM-"]').count(), 0, 'no In row is shown');
  assert.deepEqual(errors, []);
});

test('Saved views: a damaged saved list shows only Default, and a 21st view is refused with the reason', async () => {
  const { page, errors } = await open(TABLE_VIEW);
  await page.evaluate(() => localStorage.setItem('sales_tracker_views_customers', '{not json'));
  await nav(page, 'Customers');
  await custTable(page).waitFor();
  assert.deepEqual(await viewOptions(page), ['Default'], 'the damaged text is ignored');
  await page.evaluate(() => {
    const full = Array.from({ length: 20 }, (_, i) => ({ name: 'View ' + i, state: { q: '', sort: 'name', filter: 'all' } }));
    localStorage.setItem('sales_tracker_views_customers', JSON.stringify(full));
  });
  await page.reload();
  await custTable(page).waitFor();
  assert.equal((await viewOptions(page)).length, 21, 'Default plus 20 saved');
  await saveViewBtn(page).click();
  await viewName(page).fill('One too many');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'You have 20 saved views.' }).waitFor();
  assert.equal(await viewName(page).count(), 1, 'the name row stays open so the owner can delete one');
  assert.deepEqual(errors, []);
});

// ---- uplift 4.1: Inbox (web/src/screens/Inbox.jsx) ----
// The seeded messages, one of each kind, all dated inside the 90-day window. TESTTRX1 and REVIEW01 are open and matchable;
// TOPUP001 is an iBanking deposit (a wallet top-up, read only); AUTOM001 is Matched on an Auto payment.
function inboxState() {
  const s = makeUiState();
  const base = s.inbox[0];
  const msg = (trx, o) => Object.assign({}, base, { Transaction_ID: trx, Raw_SMS: 'SMS for ' + trx }, o);
  s.inbox = [
    msg('TESTTRX1', { Status: 'Pending', Amount: 290, Sender: '+8801756999991', Reference: '' }),
    msg('REVIEW01', { Status: 'Review', Type: 'Unrecognised', Amount: 75, Sender: '16247', Reference: '', Received: '2026-10-17 09:30' }),
    msg('MATCHD01', { Status: 'Matched', Amount: 500, Sender: '+8801711000222', Received: '2026-10-16 12:00' }),
    msg('AUTOM001', { Status: 'Matched', Amount: 120, Sender: '+8801711000333', Received: '2026-10-15 12:00' }),
    msg('IGNORE01', { Status: 'Ignored', Amount: 33, Sender: '+8801711000444', Received: '2026-10-14 12:00' }),
    msg('TOPUP001', { Status: 'Pending', Amount: 2000, Sender: 'iBanking', Type: 'Received', Raw_SMS: 'You have received deposit from iBanking.', Received: '2026-10-13 12:00' })
  ];
  s.payments.push(Object.assign({}, s.payments[0], { Payment_ID: 'PM-AUTO01', Transaction_ID: 'AUTOM001', Source: 'Auto', Date: '2026-10-15' }));
  return s;
}

// The phone reaches Inbox from More; a wide screen has it in the sidebar (and on the number key 6).
async function goInbox(page) {
  if ((await page.viewportSize()).width < 768) {
    await nav(page, 'More');
    await page.locator('[data-more="inbox"]').click();
  } else {
    await page.keyboard.press('6');
  }
  // The chips show once the read has an answer; a failed first read shows the error box instead.
  await page.locator('[data-testid="inbox-chip-all"], [data-testid="inbox-error"]').first().waitFor();
}
// The trx of every row in the main list, in order (phone cards or wide table rows).
const listedTrx = page => page.getByTestId('inbox-list').locator('[data-trx]').evaluateAll(els => els.map(e => e.dataset.trx));
// Waits until the main list shows exactly these transaction ids (a search or chip change refetches).
async function waitForTrx(page, want) {
  await page.waitForFunction(w => {
    const els = document.querySelectorAll('[data-testid="inbox-list"] [data-trx]');
    return JSON.stringify(Array.from(els, e => e.dataset.trx)) === JSON.stringify(w);
  }, want, { timeout: 5000 });
}

test('Inbox: lists the messages newest first with counts, and the wallet top-ups stay collapsed', async () => {
  const { page, errors } = await open({ state: inboxState() });
  await goInbox(page);
  assert.equal(await page.getByTestId('inbox-open').innerText(), '3', 'two pending and one in review');
  assert.equal(await page.getByTestId('inbox-chip-all').innerText(), 'All · 6');
  assert.equal(await page.getByTestId('inbox-chip-Pending').innerText(), 'Pending · 2');
  assert.equal(await page.getByTestId('inbox-chip-Auto-matched').innerText(), 'Auto-matched · 1');
  assert.deepEqual(await listedTrx(page), ['TESTTRX1', 'REVIEW01', 'MATCHD01', 'AUTOM001', 'IGNORE01']);
  const toggle = page.getByTestId('inbox-topups-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.equal(await page.getByTestId('inbox-topups').count(), 0);
  await toggle.click();
  await page.locator('[data-trx="TOPUP001"]').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
});

test('Inbox: a status chip narrows the list and reports itself as pressed', async () => {
  const { page, errors } = await open({ state: inboxState() });
  await goInbox(page);
  await page.getByTestId('inbox-chip-Matched').click();
  await waitForTrx(page, ['MATCHD01']);
  assert.equal(await page.getByTestId('inbox-chip-Matched').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('inbox-chip-all').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.getByTestId('inbox-chip-Matched').innerText(), 'Matched · 1', 'the count is the window, not the filter');
  await page.getByTestId('inbox-chip-Ignored').click();
  await waitForTrx(page, ['IGNORE01']);
  await page.getByTestId('inbox-chip-all').click();
  await waitForTrx(page, ['TESTTRX1', 'REVIEW01', 'MATCHD01', 'AUTOM001', 'IGNORE01']);
  assert.deepEqual(errors, []);
});

test('Inbox: search finds a message by transaction ID, sender digits and amount, and clearing it restores the list', async () => {
  const { page, errors } = await open({ state: inboxState() });
  await goInbox(page);
  const search = page.getByLabel('Search inbox');
  await search.fill('autom');
  await waitForTrx(page, ['AUTOM001']);
  await search.fill('+880171100');
  await waitForTrx(page, ['MATCHD01', 'AUTOM001', 'IGNORE01']);
  await search.fill('500');
  await waitForTrx(page, ['MATCHD01']);
  await search.fill('nobody-here');
  await page.getByText('No messages match.').waitFor();
  await search.fill('');
  await waitForTrx(page, ['TESTTRX1', 'REVIEW01', 'MATCHD01', 'AUTOM001', 'IGNORE01']);
  assert.deepEqual(errors, []);
});

test('Inbox: a pending message opens the Match sheet; a matched one opens nothing', async () => {
  const { page, errors } = await open({ state: inboxState() });
  await goInbox(page);
  await page.locator('[data-trx="MATCHD01"]').click();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('dialog').count(), 0, 'a matched message opens no sheet');
  await page.locator('[data-trx="TESTTRX1"]').click();
  await page.getByRole('dialog').getByText('Match payment').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /TESTTRX1/);
  assert.deepEqual(errors, []);
});

test('Inbox on a wide screen: a table row opens the Match sheet, and the key 6 reaches the screen', async () => {
  const { page, errors } = await open({ ...WIDE, state: inboxState() });
  await goInbox(page);
  const table = page.getByRole('table', { name: 'Payment messages' });
  await table.waitFor();
  await table.locator('tbody tr[data-trx="TESTTRX1"]').click();
  await page.getByRole('dialog').getByText('Match payment').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await table.locator('tbody tr[data-trx="MATCHD01"]').click();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
});

test('Inbox: a failed read shows the error with Retry, and Retry loads the list', async () => {
  const { page, errors, api } = await open({ state: inboxState() });
  let failing = true;
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_OK });
    const body = JSON.parse(req.postData() || '{}');
    if (body.action === 'inbox' && failing) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'The inbox did not load.' }) });
    }
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  });
  await goInbox(page);
  const box = page.getByTestId('inbox-error');
  await box.waitFor();
  assert.match(await box.innerText(), /The inbox did not load\./);
  failing = false;
  await box.getByRole('button', { name: 'Retry' }).click();
  await page.locator('[data-trx="TESTTRX1"]').waitFor();
  assert.equal(await page.getByTestId('inbox-error').count(), 0);
  assert.deepEqual(errors, []);
});

test('Inbox: an empty inbox says so', async () => {
  const s = makeUiState();
  s.inbox = [];
  const { page, errors } = await open({ state: s });
  await goInbox(page);
  await page.getByText('No payment messages yet.').waitFor();
  assert.equal(await page.getByTestId('inbox-chip-all').innerText(), 'All · 0');
  assert.deepEqual(errors, []);
});

test('Inbox: fits a 360px phone in light and dark without sideways scrolling, and the palette reaches it', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors, ctx } = await open({ state: inboxState(), colorScheme: scheme });
    await goInbox(page);
    await page.waitForTimeout(350);
    const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w <= 360, 'Inbox (' + scheme + ') scrollWidth ' + w);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { page, errors } = await open({ state: inboxState(), ...WIDE });
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('inbox');
  await page.getByRole('option', { name: /Inbox/ }).first().click();
  await page.getByTestId('inbox-chip-all').waitFor();
  assert.match(await page.evaluate(() => location.hash), /inbox/);
  assert.deepEqual(errors, []);
});

// ---- uplift 4.2: the Reminders queue (web/src/screens/Reminders.jsx) ----
// These tests build their own sales from the server's "today", which test/support/edge-host.js pins to 2026-10-18 for the UI host: one sale
// per reminder kind, each on its own customer, and no other payments. Sale ids 9101 to 9105 are not in the seed.
const pinnedToday = () => '2026-10-18';
function plusDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function queueState({ custom } = {}) {
  const s = makeUiState();
  const today = pinnedToday();
  const base = s.sales.find(x => x.Product_ID === 'NETFLIX' && x.Record_Status === 'Active');
  const custId = name => s.customers.find(c => c.Name === name).Customer_ID;
  const sale = (id, name, paidTill) => Object.assign({}, base, { Sale_ID: id, Customer_ID: custId(name), Customer: name, Paid_Till: paidTill, Sub_Code: 'Q' + id,
    Pay_Token: '', Unit_Price: 290, Record_Status: 'Active', Notes: '', Months: 1, Sale_Date: plusDays(today, -90) });
  const template = s.payments[0];
  const paid = (id, name) => Object.assign({}, template, { Payment_ID: 'PM-Q' + id, Sale_ID: id, Customer_ID: custId(name), Amount: 290, Transaction_ID: '', Source: 'Manual', Date: plusDays(today, -5) });
  s.sales = [sale(9101, 'jamilhq', plusDays(today, 2)), sale(9102, 'Kabir', plusDays(today, -1)), sale(9103, 'cust40', today), sale(9104, 'Anik', plusDays(today, 30))];
  s.payments = [paid(9101, 'jamilhq'), paid(9102, 'Kabir'), paid(9103, 'cust40')];
  const messenger = s.customers.find(c => c.Name === 'cust40');
  messenger.Channel = 'Messenger';
  messenger.Handle = 'https://m.me/cust40';
  if (custom) {
    s.sales.push(Object.assign({}, base, { Sale_ID: 9105, Customer_ID: custId('imran'), Customer: 'imran', Product_ID: 'CUSTOM', Notes: 'Tinder Premium',
      Unit_Price: 600, Paid_Till: '', Sub_Code: '', Pay_Token: '', Record_Status: 'Active', Months: 1, Sale_Date: plusDays(today, -3) }));
  }
  return s;
}
async function goReminders(page) {
  if ((await page.viewportSize()).width < 768) {
    await nav(page, 'More');
    await page.locator('[data-more="reminders"]').click();
  } else {
    await page.keyboard.press('7');
  }
  await page.getByTestId('reminders-open').waitFor();
}
const queueRow = (page, saleId, kind) => page.getByTestId('queue-' + saleId + '-' + kind);
const groupRows = (page, kind) => page.getByTestId('reminders-group-' + kind).locator('[data-testid^="queue-"]');

test('Reminders: To send groups the queue by kind, and the key 7 opens it on a wide screen', async () => {
  const { page, errors } = await open(Object.assign({ state: queueState() }, WIDE));
  await goReminders(page);
  assert.equal(await page.getByTestId('reminders-open').innerText(), '4');
  assert.equal(await page.getByTestId('reminders-tab-to-send').innerText(), 'To send · 4');
  assert.equal(await groupRows(page, 'on_day').count(), 1, 'ends today');
  assert.equal(await groupRows(page, 'after').count(), 1, 'ended');
  assert.equal(await groupRows(page, 'due').count(), 1, 'overdue');
  assert.equal(await groupRows(page, 'before').count(), 1, 'upcoming');
  const heading = kind => page.locator('section', { has: page.getByTestId('reminders-group-' + kind) }).locator('h2').innerText();
  assert.deepEqual([await heading('on_day'), await heading('after'), await heading('due'), await heading('before')], ['Ends today', 'Ended', 'Overdue', 'Upcoming']);
  assert.match(await queueRow(page, 9101, 'before').innerText(), /WhatsApp/, 'the channel is written out');
  assert.match(await queueRow(page, 9103, 'on_day').innerText(), /Messenger/);
  assert.match(await queueRow(page, 9102, 'after').innerText(), /No contact/);
  assert.match(await queueRow(page, 9101, 'before').innerText(), /ends soon/, 'the row label is REMINDER_LABEL');
  assert.deepEqual(errors, []);
});

test('Reminders: Skip moves an item to the Skipped tab, and the counts follow', async () => {
  const { page, errors } = await open(Object.assign({ state: queueState() }, WIDE));
  await goReminders(page);
  await queueRow(page, 9101, 'before').getByTestId('skip-reminder').click();
  await toastOf(page, 'Skipped').waitFor();
  await queueRow(page, 9101, 'before').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('reminders-open').innerText(), '3');
  await page.getByTestId('reminders-tab-skipped').click();
  const logged = page.locator('[data-testid^="logged-9101-before-"]');
  await logged.waitFor();
  assert.match(await logged.innerText(), /Skipped/);
  assert.equal(await page.getByTestId('reminders-tab-skipped').innerText(), 'Skipped · 1');
  assert.equal(await page.getByTestId('reminders-tab-sent').innerText(), 'Sent · 0');
  assert.deepEqual(errors, []);
});

test('Reminders: Copy message copies the text, and Mark sent moves the reminder to Sent', async () => {
  const { page, errors } = await open(Object.assign({ state: queueState() }, WIDE, CLIP));
  await goReminders(page);
  await queueRow(page, 9101, 'before').getByTestId('copy-message').click();
  await toastOf(page, 'Copied message').waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Hi jamilhq/);
  await queueRow(page, 9101, 'before').getByTestId('mark-sent').click();
  await toastOf(page, 'Marked as sent').waitFor();
  await queueRow(page, 9101, 'before').waitFor({ state: 'detached' });
  await page.getByTestId('reminders-tab-sent').click();
  await page.locator('[data-testid^="logged-9101-before-"]').waitFor();
  assert.match(await page.locator('[data-testid^="logged-9101-before-"]').innerText(), /Sent/);
  assert.equal(await page.getByTestId('reminders-tab-sent').innerText(), 'Sent · 1');
  assert.deepEqual(errors, []);
});

test('Reminders: bulk copy puts two customers under their headers, and Mark all sent clears both', async () => {
  const { page, errors } = await open(Object.assign({ state: queueState() }, WIDE, CLIP));
  await goReminders(page);
  const box = (saleId, kind) => queueRow(page, saleId, kind).getByRole('checkbox');
  await box(9104, 'due').click();
  await box(9102, 'after').click();
  await page.getByTestId('bulk-count').filter({ hasText: '2 selected' }).waitFor();
  assert.equal(await bulkBar(page).getByRole('button', { name: 'Mark all sent' }).count(), 0, 'not offered before the copy');
  await bulkBar(page).getByRole('button', { name: 'Copy reminder messages' }).click();
  await toastOf(page, 'Copied 2 reminder messages').waitFor();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(text.includes('--- Anik ---') && text.includes('--- Kabir ---'), text.slice(0, 200));
  await bulkBar(page).getByRole('button', { name: 'Mark all sent' }).click();
  await toastOf(page, 'Marked 2 of 2 as sent').waitFor();
  await queueRow(page, 9104, 'due').waitFor({ state: 'detached' });
  await queueRow(page, 9102, 'after').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('bulk-count').count(), 0, 'the selection is cleared');
  assert.deepEqual(errors, []);
});

test('Reminders: Sent and Skipped show the logged reminders grouped by kind, and a reminder older than 60 days is left out', async () => {
  const s = queueState();
  const today = pinnedToday();
  const custOf = id => s.sales.find(x => x.Sale_ID === id).Customer_ID;
  s.remindersLog = [
    { Date: today, Sale_ID: 9101, Customer_ID: custOf(9101), Kind: 'before', Channel: 'WhatsApp', Status: 'sent' },
    { Date: plusDays(today, -10), Sale_ID: 9102, Customer_ID: custOf(9102), Kind: 'after', Channel: '', Status: 'skipped' },
    { Date: plusDays(today, -61), Sale_ID: 9103, Customer_ID: custOf(9103), Kind: 'on_day', Channel: 'Messenger', Status: 'sent' }
  ];
  const { page, errors } = await open(Object.assign({ state: s }, WIDE));
  await goReminders(page);
  await page.getByTestId('reminders-tab-sent').click();
  await page.locator('[data-testid^="logged-9101-before-"]').waitFor();
  assert.equal(await page.getByTestId('reminders-tab-sent').innerText(), 'Sent · 1', 'the 61-day-old send is outside the window');
  assert.equal(await page.locator('[data-testid^="logged-9103-"]').count(), 0);
  assert.equal(await page.getByTestId('reminders-group-before').locator('[data-testid^="logged-"]').count(), 1);
  await page.getByTestId('reminders-tab-skipped').click();
  await page.locator('[data-testid^="logged-9102-after-"]').waitFor();
  assert.equal(await page.getByTestId('reminders-tab-skipped').innerText(), 'Skipped · 1');
  assert.match(await page.locator('[data-testid^="logged-9102-after-"]').innerText(), /No contact/);
  assert.deepEqual(errors, []);
});

test('Reminders: a failed log read on the Sent tab shows the error with Retry, and Retry loads the list', async () => {
  const { page, errors, api } = await open({ state: queueState() });
  let failing = true;
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_OK });
    const body = JSON.parse(req.postData() || '{}');
    if (body.action === 'reminderLog' && failing) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'The reminder log did not load.' }) });
    }
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  });
  await goReminders(page);
  await page.getByTestId('reminders-tab-sent').click();
  const box = page.getByTestId('reminders-error');
  await box.waitFor();
  assert.match(await box.innerText(), /The reminder log did not load\./);
  failing = false;
  await box.getByRole('button', { name: 'Retry' }).click();
  await page.getByText('Nothing sent in the last 60 days.').waitFor();
  assert.equal(await page.getByTestId('reminders-error').count(), 0);
  assert.deepEqual(errors, []);
});

test('Reminders: fits a 360px phone in light and dark without sideways scrolling, and More and the palette reach it', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors, ctx } = await open({ state: queueState(), colorScheme: scheme });
    await nav(page, 'More');
    assert.match(await page.locator('[data-more="reminders"]').innerText(), /4 to send/, 'More shows the count');
    await page.locator('[data-more="reminders"]').click();
    await page.getByTestId('reminders-open').waitFor();
    await page.waitForTimeout(350);
    const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w <= 360, 'Reminders (' + scheme + ') scrollWidth ' + w);
    await page.getByTestId('reminders-tab-skipped').click();
    await page.waitForTimeout(150);
    const w2 = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w2 <= 360, 'Reminders skipped tab (' + scheme + ') scrollWidth ' + w2);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { page, errors } = await open(Object.assign({ state: queueState() }, WIDE));
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('reminders');
  await page.getByRole('option', { name: /Reminders/ }).first().click();
  await page.getByTestId('reminders-open').waitFor();
  assert.match(await page.evaluate(() => location.hash), /reminders/);
  assert.deepEqual(errors, []);
});

test('Reminders: a custom sale with a balance has no Copy, Preview or tick on Dues, and no Remind on the customer sheet', async () => {
  const { page, errors } = await open({ state: queueState({ custom: true }) });
  await nav(page, 'Dues');
  await page.getByTestId('dues-list').waitFor();
  await page.getByText('Tinder', { exact: false }).first().waitFor();
  const dues = await page.getByTestId('due-pay').count();
  assert.equal(dues, 2, 'Anik and the custom sale are both owed');
  assert.equal(await page.getByTestId('due-copy').count(), dues - 1, 'every due but the custom sale has Copy reminder message');
  assert.equal(await page.getByRole('button', { name: 'Preview reminder' }).count(), dues - 1, 'and Preview reminder');
  assert.equal(await dueBoxes(page).count(), dues - 1, 'and the bulk tick');
  assert.equal(await page.getByRole('button', { name: 'Paid', exact: true }).count(), dues, 'Paid stays on the custom sale');
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('imran');
  await page.getByText('imran', { exact: true }).first().click();
  await page.getByTestId('custom-9105').waitFor();
  assert.equal(await page.getByTestId('custom-9105').getByRole('button', { name: 'Remind' }).count(), 0, 'no Remind on the custom sale');
  assert.deepEqual(errors, []);
});

// ---- uplift 4.7: Settings as a screen (#/settings) ----
const SETTINGS_SECTIONS = ['Business', 'Reminders', 'Message templates', 'Pay methods', 'Rates', 'Appearance', 'All settings'];
// Opens Settings the way the owner does: the More row (the sidebar also has More on a wide screen).
async function goSettings(page) {
  await nav(page, 'More');
  await page.locator('[data-more="settings"]').click();
  await page.getByTestId('settings-screen').waitFor();
}

test('Settings screen: the sub-nav opens each section on a wide screen, and the palette reaches it', async () => {
  const { page, errors } = await open(WIDE);
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('settings');
  await page.getByRole('option', { name: /^Settings/ }).first().click();
  await page.getByTestId('settings-screen').waitFor();
  assert.match(await page.evaluate(() => location.hash), /settings/);
  const subnav = page.getByRole('navigation', { name: 'Settings sections' });
  const marker = {
    'Business': '#tBkash', 'Reminders': '#tBefore', 'Message templates': '#tplText', 'Pay methods': '#on-bkash',
    'Rates': '#tUsdt', 'Appearance': '[data-testid="theme-system"]', 'All settings': '#set-discord_enabled'
  };
  for (const name of SETTINGS_SECTIONS) {
    await subnav.getByRole('button', { name, exact: true }).click();
    assert.equal(await subnav.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'true', name + ' is the current section');
    await page.getByRole('heading', { name, exact: true }).waitFor();
    assert.equal(await page.locator(marker[name]).isVisible(), true, name + ' shows its fields');
  }
  assert.deepEqual(errors, []);
});

test('Settings screen: on a phone each section is an accordion, and one section is open at a time', async () => {
  const { page, errors } = await open();
  await goSettings(page);
  const head = name => page.getByRole('button', { name, exact: true });
  assert.equal(await head('Business').getAttribute('aria-expanded'), 'true', 'Business opens first');
  assert.equal(await page.locator('#tBkash').isVisible(), true);
  await head('Rates').click();
  assert.equal(await head('Rates').getAttribute('aria-expanded'), 'true');
  assert.equal(await head('Business').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#tBkash').isVisible(), false, 'Business folds away');
  assert.equal(await page.locator('#tUsdt').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Settings screen: the bKash number saves to the settings rows, and a reload shows it', async () => {
  const { page, errors, tables } = await open();
  await goSettings(page);
  assert.equal(await page.locator('#saveBusiness').isDisabled(), true, 'Save is off until something changes');
  await page.locator('#tBkash').fill('01711223344');
  await page.locator('#saveBusiness').click();
  await toastOf(page, 'Settings saved').first().waitFor();
  assert.equal(tables.settings.get('bkash_number'), '01711223344');
  await page.reload();
  await page.locator('#tBkash').waitFor();
  assert.equal(await page.locator('#tBkash').inputValue(), '01711223344');
  assert.deepEqual(errors, []);
});

test('Settings screen: Pay methods saves its own keys and leaves the bKash number alone', async () => {
  const state = makeUiState();
  state.settings.bkash_number = '01711223344';
  const { page, errors, tables } = await open({ state });
  await goSettings(page);
  await page.getByRole('button', { name: 'Pay methods', exact: true }).click();
  await page.locator('#on-nagad').click();
  await page.locator('#n-nagad').fill('01811223344');
  await page.locator('#saveMethods').click();
  await toastOf(page, 'Settings saved').first().waitFor();
  assert.equal(tables.settings.get('nagad_number'), '01811223344');
  assert.match(tables.settings.get('pay_methods'), /nagad/);
  assert.equal(tables.settings.get('bkash_number'), '01711223344', 'the Business number is not rewritten');
  assert.deepEqual(errors, []);
});

test('Settings screen: a failed save keeps the typed text and shows the reason', async () => {
  const { page, errors, tables } = await open();
  await goSettings(page);
  await page.route('**/functions/v1/api', async route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'settings') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: false, error: 'Settings are down' }) });
    }
    return route.fallback();
  });
  await page.locator('#tBkash').fill('01799887766');
  await page.locator('#saveBusiness').click();
  await page.getByRole('alert').filter({ hasText: 'Settings are down' }).waitFor();
  assert.equal(await page.locator('#tBkash').inputValue(), '01799887766', 'the typed number is kept');
  assert.equal(await page.locator('#saveBusiness').isDisabled(), false, 'Save is there to retry');
  assert.notEqual(tables.settings.get('bkash_number'), '01799887766', 'nothing was saved');
  assert.deepEqual(errors, []);
});

test('Settings screen: leaving with unsaved edits asks first; Stay keeps them, Leave goes on, and a reload warns', async () => {
  const { page, errors } = await open();
  await goSettings(page);
  await page.locator('#tBkash').fill('01711223344');
  await page.getByRole('button', { name: /Unsaved/ }).waitFor();   // the Business accordion head says so on a phone
  await nav(page, 'Today');
  const dialog = page.getByRole('alertdialog');
  await dialog.getByText('Leave without saving?').waitFor();
  assert.equal(await page.getByTestId('settings-screen').isVisible(), true, 'still on Settings while the question is open');
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#tBkash').inputValue(), '01711223344', 'Stay keeps the typed number');
  const prevented = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  assert.equal(prevented, true, 'a reload warns while edits are unsaved');
  await nav(page, 'Today');
  await dialog.getByRole('button', { name: 'Leave without saving' }).click();
  await page.getByTestId('today-owed').waitFor();
  assert.equal(await page.locator('#tBkash').count(), 0, 'Settings is gone');
  assert.deepEqual(errors, []);
});

test('Settings screen: a variable chip inserts its token at the caret and the preview follows', async () => {
  const { page, errors } = await open();
  await goSettings(page);
  await page.getByRole('button', { name: 'Message templates', exact: true }).click();
  const box = page.locator('#tplText');
  await box.fill('Pay {name} now');
  await box.focus();
  await box.evaluate(el => el.setSelectionRange(4, 4));
  await page.locator('[data-var="ref"]').click();
  assert.equal(await box.inputValue(), 'Pay {ref}{name} now');
  assert.match(await page.locator('#tplPreview').innerText(), /Pay nubnf3Fahim now/);
  assert.deepEqual(errors, []);
});

test('Settings screen: Reset to default clears the saved message and the built-in text comes back', async () => {
  const { page, errors, tables } = await open();
  await goSettings(page);
  await page.getByRole('button', { name: 'Message templates', exact: true }).click();
  const box = page.locator('#tplText');
  await box.fill('Custom note for {name}');
  await page.locator('#tplSave').click();
  await toastOf(page, 'saved').first().waitFor();
  assert.equal(tables.settings.get('msg_renew_en'), 'Custom note for {name}');
  await page.locator('#tplReset').click();
  await page.waitForFunction(() => document.querySelector('#tplText').value === '');
  await page.waitForFunction(() => document.querySelector('#tplReset').disabled);
  assert.ok(!tables.settings.get('msg_renew_en'), 'the stored message is blank');
  assert.match(await box.getAttribute('placeholder'), /^Hi \{name\}/, 'the built-in text is the placeholder');
  assert.match(await page.locator('#tplPreview').innerText(), /^Hi /, 'and the preview shows it');
  assert.equal(await page.getByText('Blank: the built-in message is used.').count(), 1);
  assert.deepEqual(errors, []);
});

test('Settings screen: All settings saves only the value that changed', async () => {
  const { page, errors, tables } = await open();
  await goSettings(page);
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  const before = tables.settings.get('money_layout');
  await page.locator('#set-discord_enabled').fill('true');
  await page.locator('#saveAll').click();
  await toastOf(page, 'Settings saved').first().waitFor();
  assert.equal(tables.settings.get('discord_enabled'), 'true');
  assert.equal(tables.settings.get('money_layout'), before, 'untouched keys are not rewritten');
  assert.deepEqual(errors, []);
});

test('Settings screen: the Appearance chips set the theme, and the sidebar toggle follows', async () => {
  const { page, errors } = await open(WIDE);
  await goSettings(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByTestId('theme-dark').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  assert.equal(await page.getByTestId('theme-dark').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.getByRole('button', { name: /^Theme: dark\./ }).first().isVisible(), 'the sidebar toggle now says dark');
  await page.getByTestId('theme-light').click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  assert.deepEqual(errors, []);
});

test('Settings screen: fits a 360px phone in light and dark, every section opened, with no sideways scrolling', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors, ctx } = await open({ colorScheme: scheme });
    await goSettings(page);
    for (const name of SETTINGS_SECTIONS) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(120);
      const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
      assert.ok(w <= 360, 'Settings ' + name + ' (' + scheme + ') scrollWidth ' + w);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

// Activity (uplift plan 4.3): the change history. Saves are made through the API so the list holds real batches, and Undo runs the
// real undo write over the fake database. Batch rows carry the batch id in their test id; the hero and error boxes have fixed ids.
const activityRows = page => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.dataset.testid)
  .filter(t => /^activity-[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)));
async function goActivity(page) {
  if ((await page.viewportSize()).width < 768) {
    await nav(page, 'More');
    await page.locator('[data-more="activity"]').click();
  } else {
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search customers, or type an action').fill('activity');
    await page.getByRole('option', { name: /^Activity/ }).first().click();
  }
  await page.getByTestId('activity-next').waitFor();
}
const tariqId = rows => rows('Customers').find(c => c.name === 'tariq').customer_id;
const tariqNotes = rows => rows('Customers').find(c => c.name === 'tariq').notes;

test('Activity: saves show newest first, only the newest reversible one has Undo this, and Undo reverses it and refreshes the list', async () => {
  const { page, errors, rows, api } = await open(WIDE);
  const id = tariqId(rows);
  assert.equal((await api('edit', { requestId: 'act-ui-1', kind: 'customer', id, values: { Notes: 'first save' } })).ok, true);
  assert.equal((await api('edit', { requestId: 'act-ui-2', kind: 'customer', id, values: { Notes: 'second save' } })).ok, true);
  await goActivity(page);
  const [newest, older] = await activityRows(page);
  assert.ok(newest && older, 'two entries are listed');
  assert.equal(await page.locator('[data-testid="' + newest + '"]').getByTestId('undo-this').count(), 1, 'the newest save can be undone');
  assert.equal(await page.locator('[data-testid="' + older + '"]').getByTestId('undo-this').count(), 0, 'an older save has no button');
  assert.match(await page.locator('[data-testid="' + older + '"]').innerText(), /Undo reverses the newest change first/);
  assert.equal(await page.getByTestId('undo-this').count(), 1, 'one Undo button on the screen');
  assert.match(await page.getByTestId('activity-next').innerText(), /^Edit/);

  await page.getByTestId('undo-this').click();
  await page.getByRole('alertdialog').getByText('Undo this change?').waitFor();
  assert.equal(tariqNotes(rows), 'second save', 'nothing changes until the owner confirms');
  await page.getByTestId('undo-confirm').click();
  await toastOf(page, 'Undone').waitFor();
  assert.equal(tariqNotes(rows), 'first save', 'the newest save is reversed in the database');
  await page.locator('[data-testid="' + newest + '"]').getByText('Undone', { exact: true }).waitFor();
  assert.equal((await activityRows(page)).length, 3, 'the Undo is listed as a batch of its own');
  assert.equal(await page.locator('[data-testid="' + older + '"]').getByTestId('undo-this').count(), 1, 'the save before it is now the one Undo reverses');
  assert.deepEqual(errors, []);
});

test('Activity: Keep it closes the confirmation and changes nothing', async () => {
  const { page, errors, rows, api } = await open(WIDE);
  const id = tariqId(rows);
  await api('edit', { requestId: 'act-keep-1', kind: 'customer', id, values: { Notes: 'kept note' } });
  await goActivity(page);
  await page.getByTestId('undo-this').click();
  await page.getByRole('alertdialog').getByText('Undo this change?').waitFor();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  assert.equal(tariqNotes(rows), 'kept note');
  assert.equal(await page.getByTestId('undo-this').count(), 1, 'the button is still there');
  assert.deepEqual(errors, []);
});

test('Activity: an empty history says nothing is saved yet, and the palette and More reach it', async () => {
  const { page, errors } = await open(WIDE);
  await goActivity(page);
  assert.match(await page.locator('#screen').innerText(), /Nothing has been saved yet\./);
  assert.equal(await page.getByTestId('undo-this').count(), 0);
  assert.match(await page.evaluate(() => location.hash), /activity/);
  assert.deepEqual(errors, []);
  const phone = await open();
  await nav(phone.page, 'More');
  assert.match(await phone.page.locator('[data-more="activity"]').innerText(), /Undo/, 'the More row names the Undo');
  await phone.page.locator('[data-more="activity"]').click();
  await phone.page.getByTestId('activity-next').waitFor();
  assert.deepEqual(phone.errors, []);
});

test('Activity: a failed read shows the error with Retry, and Retry loads the list', async () => {
  const { page, errors, api } = await open();
  let failing = true;
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_OK });
    const body = JSON.parse(req.postData() || '{}');
    if (body.action === 'activity' && failing) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'The history did not load.' }) });
    }
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  });
  await nav(page, 'More');
  await page.locator('[data-more="activity"]').click();
  const box = page.getByTestId('activity-error');
  await box.waitFor();
  assert.match(await box.innerText(), /The history did not load\./);
  failing = false;
  await box.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('activity-next').waitFor();
  assert.equal(await page.getByTestId('activity-error').count(), 0);
  assert.deepEqual(errors, []);
});

test('Activity: fits a 360px phone in light and dark with no sideways scrolling, and Undo this is tappable', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors, ctx, rows, api } = await open({ colorScheme: scheme });
    const id = tariqId(rows);
    await api('edit', { requestId: 'act-phone-' + scheme, kind: 'customer', id, values: { Notes: 'phone note ' + scheme } });
    await nav(page, 'More');
    await page.locator('[data-more="activity"]').click();
    await page.getByTestId('undo-this').waitFor();
    await page.waitForTimeout(350);
    const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w <= 360, 'Activity (' + scheme + ') scrollWidth ' + w);
    const box = await page.getByTestId('undo-this').boundingBox();
    assert.ok(box.height >= 32, 'the button is tall enough to tap');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

// ---- uplift 4.4: the renewals calendar (web/src/screens/Calendar.jsx) ----
// Built from the same pinned today as the Reminders tests (2026-10-18). Sales 9201 to 9203 are not in the seed. Two lines renew on
// 20 October and are paid; one renewed on 10 October and is still owed, so that day shows a red dot. No other sales are seeded.
function calendarState() {
  const s = makeUiState();
  const today = pinnedToday();
  const base = s.sales.find(x => x.Product_ID === 'NETFLIX' && x.Record_Status === 'Active');
  const custId = name => s.customers.find(c => c.Name === name).Customer_ID;
  const sale = (id, name, paidTill) => Object.assign({}, base, { Sale_ID: id, Customer_ID: custId(name), Customer: name, Paid_Till: paidTill, Sub_Code: 'Q' + id,
    Pay_Token: '', Unit_Price: 290, Record_Status: 'Active', Notes: '', Months: 1, Sale_Date: plusDays(today, -90) });
  const paid = (id, name) => Object.assign({}, s.payments[0], { Payment_ID: 'PM-C' + id, Sale_ID: id, Customer_ID: custId(name), Amount: 290, Transaction_ID: '', Source: 'Manual', Date: plusDays(today, -5) });
  s.sales = [sale(9201, 'jamilhq', '2026-10-20'), sale(9202, 'Kabir', '2026-10-20'), sale(9203, 'Anik', '2026-10-10')];
  s.payments = [paid(9201, 'jamilhq'), paid(9202, 'Kabir')];
  return s;
}
const dayCell = (page, iso) => page.locator('[data-day="' + iso + '"] button');
const focusedDay = page => page.evaluate(() => { const td = document.activeElement && document.activeElement.closest('[data-day]'); return td ? td.getAttribute('data-day') : null; });
const calendarHeading = page => page.locator('section', { has: page.getByTestId('calendar-day') }).locator('h2');
async function goCalendar(page) {
  if ((await page.viewportSize()).width < 768) {
    await nav(page, 'More');
    await page.locator('[data-more="calendar"]').click();
  } else {
    await page.keyboard.press('8');
  }
  await page.getByTestId('calendar').waitFor();
}

test('Calendar: key 8 opens it on a wide screen, and a day with renewals shows its count, the red dot only on the expired unpaid day', async () => {
  const { page, errors } = await open(Object.assign({ state: calendarState() }, WIDE));
  await goCalendar(page);
  assert.match(await page.evaluate(() => location.hash), /calendar/);
  assert.equal(await page.getByTestId('cal-count-2026-10-20').innerText(), '2');
  assert.equal(await page.getByTestId('cal-count-2026-10-10').innerText(), '1');
  assert.equal(await page.getByTestId('cal-count-2026-10-18').count(), 0, 'a day with nothing has no badge');
  assert.equal(await page.getByTestId('cal-expired-2026-10-10').count(), 1, 'the expired unpaid line has the dot');
  assert.equal(await page.getByTestId('cal-expired-2026-10-20').count(), 0, 'paid lines have no dot');
  assert.equal(await page.getByRole('button', { name: /October 20th, 2026, 2 renewals/ }).count(), 1, 'the day name carries the count');
  assert.equal(await page.getByRole('button', { name: /October 10th, 2026, 1 renewal, 1 line expired and unpaid/ }).count(), 1, 'and the dot');
  assert.deepEqual(errors, []);
});

test('Calendar: clicking a day lists its lines, a row opens the customer, and Renew opens the renew sheet for that sub-code', async () => {
  const { page, errors } = await open(Object.assign({ state: calendarState() }, WIDE));
  await goCalendar(page);
  await dayCell(page, '2026-10-20').click();
  await page.getByTestId('cal-line-Q9201').waitFor();
  assert.equal(await page.getByTestId('cal-line-Q9202').count(), 1);
  assert.match(await calendarHeading(page).innerText(), /20 October/);
  assert.match(await page.getByTestId('cal-line-Q9202').innerText(), /Kabir/);
  await page.getByTestId('cal-renew-Q9202').click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor();
  assert.equal(await sheet.locator('#lineSearch').inputValue(), 'Kabir · Q9202', 'the renew sheet is for that sub-code');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  await dayCell(page, '2026-10-10').click();
  await page.getByTestId('cal-line-Q9203').waitFor();
  assert.match(await page.getByTestId('cal-line-Q9203').innerText(), /owes/, 'an unpaid line says what it owes');
  await page.getByRole('button', { name: 'Anik', exact: true }).click();
  await page.getByRole('dialog', { name: 'Anik', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('Calendar: arrow keys move the focused day and Enter selects it', async () => {
  const { page, errors } = await open(Object.assign({ state: calendarState() }, WIDE));
  await goCalendar(page);
  await dayCell(page, '2026-10-18').click();
  assert.equal(await focusedDay(page), '2026-10-18');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusedDay(page), '2026-10-19', 'ArrowRight moves focus one day');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focusedDay(page), '2026-10-26', 'ArrowDown moves a week');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('section h2')].some(h => /26 October/.test(h.textContent)));
  assert.match(await calendarHeading(page).innerText(), /26 October/, 'Enter selects the focused day');
  assert.deepEqual(errors, []);
});

test('Calendar: a month with no renewals says so, and Today goes back to this month', async () => {
  const { page, errors } = await open(Object.assign({ state: calendarState() }, WIDE));
  await goCalendar(page);
  await page.getByRole('button', { name: 'Go to the Next Month' }).click();
  await page.getByText('No renewals this month').waitFor();
  assert.equal(await page.getByTestId('calendar-day').count(), 0);
  await page.getByRole('button', { name: 'Jump to today', exact: true }).click();
  await page.getByTestId('cal-count-2026-10-20').waitFor();
  assert.equal(await page.getByText('No renewals this month').count(), 0);
  assert.deepEqual(errors, []);
});

test('Calendar: fits a 360px phone in light and dark with cells 44px or more and no sideways scroll, and the palette reaches it', async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors, ctx } = await open({ state: calendarState(), colorScheme: scheme });
    await goCalendar(page);
    await dayCell(page, '2026-10-20').click();
    await page.getByTestId('cal-line-Q9201').waitFor();
    await page.waitForTimeout(350);
    const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
    assert.ok(w <= 360, 'Calendar (' + scheme + ') scrollWidth ' + w);
    const cell = await dayCell(page, '2026-10-20').boundingBox();
    assert.ok(cell.width >= 44 && cell.height >= 44, 'day cell is ' + cell.width + 'x' + cell.height);
    const renew = await page.getByTestId('cal-renew-Q9201').boundingBox();
    assert.ok(renew.height >= 44, 'the Renew button is tappable');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { page, errors } = await open(Object.assign({ state: calendarState() }, WIDE));
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search customers, or type an action').fill('calendar');
  await page.getByRole('option', { name: /Calendar/ }).first().click();
  await page.getByTestId('calendar').waitFor();
  assert.match(await page.evaluate(() => location.hash), /calendar/);
  assert.deepEqual(errors, []);
});

test('Calendar: a failed dues read shows the error with Retry, and Retry marks the expired line', async () => {
  const { page, errors, api } = await open({ state: calendarState() });
  let failing = true;
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_OK });
    const body = JSON.parse(req.postData() || '{}');
    if (body.action === 'dues' && failing) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify({ ok: false, error: 'The unpaid lines did not load.' }) });
    }
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_OK, body: JSON.stringify(res) });
  });
  await goCalendar(page);
  const box = page.getByTestId('calendar-error');
  await box.waitFor();
  assert.match(await box.innerText(), /The unpaid lines did not load\./);
  failing = false;
  await box.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('cal-expired-2026-10-10').waitFor();
  assert.equal(await page.getByTestId('calendar-error').count(), 0);
  assert.deepEqual(errors, []);
});

// ---- uplift 4.5: customer workspace (#/customers/<id>). md and up: a list and the customer side by side (lg) or stacked (md).
// A phone keeps the card list and opens the customer sheet over it. ----
const WS_VIEW = { viewport: { width: 1280, height: 800 } };
const idOfCust = name => require('../support/seed').makeUiState().customers.find(c => c.Name === name).Customer_ID;
const wsDetail = page => page.getByTestId('ws-detail');
const goHash = (page, h) => page.evaluate(x => { location.hash = x; }, h);

test('Customer workspace: a table row opens #/customers/<id> with the list and the detail side by side at 1280px', async () => {
  const { page, errors } = await open(WS_VIEW);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('farid');
  await custTable(page).getByText('farid', { exact: true }).click();
  await page.getByTestId('cust-workspace').waitFor();
  const farid = idOfCust('farid');
  assert.equal(await page.evaluate(() => location.hash), '#/customers/' + farid);
  assert.equal(await page.getByRole('dialog').count(), 0, 'no sheet');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pageTitle', 'focus moves to the page title');
  const list = await page.getByRole('region', { name: 'Customer list' }).boundingBox();
  const detail = await wsDetail(page).boundingBox();
  assert.ok(Math.abs(list.width - 320) <= 1, 'the list column is 320px wide');
  assert.ok(list.x + list.width <= detail.x + 1, 'the detail sits to the right of the list');
  assert.ok(Math.abs(list.y - detail.y) < 2, 'both start at the same top edge');
  await page.getByLabel('Search customers').fill('farid');
  assert.equal(await page.getByTestId('ws-cust-' + farid).getAttribute('aria-current'), 'true', 'the list marks the open customer');
  assert.equal(await wsDetail(page).getByRole('button', { name: 'Copy customer ID ' + farid }).count(), 1, 'the ID chip copies the customer ID');
  assert.deepEqual(errors, []);
});

test('Customer workspace: picking another customer in the list swaps the detail, keeps focus in the list, and Back returns to the table', async () => {
  const { page, errors } = await open(WS_VIEW);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('farid');
  await custTable(page).getByText('farid', { exact: true }).click();
  await page.getByTestId('cust-workspace').waitFor();
  const kabir = idOfCust('Kabir');
  await page.getByLabel('Search customers').fill('kabir');
  await page.getByTestId('ws-cust-' + kabir).click();
  await wsDetail(page).getByText('Kabir', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers/' + kabir);
  assert.equal(await page.getByTestId('ws-cust-' + kabir).getAttribute('aria-current'), 'true');
  assert.equal(await wsDetail(page).getByText('farid', { exact: true }).count(), 0, 'the detail shows Kabir, not farid');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-testid')), 'ws-cust-' + kabir, 'focus stays on the list row');
  await page.goBack();
  await custTable(page).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers', 'Back returns to the table');
  assert.deepEqual(errors, []);
});

test('Customer workspace: an unknown customer id shows an Empty with a Back to customers link, not a crash', async () => {
  const { page, errors } = await open(WS_VIEW);
  await goHash(page, '#/customers/CU-NOPE');
  await page.getByText('That customer is not on file.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('cust-workspace').count(), 1, 'the list stays up');
  await page.getByRole('button', { name: 'Back to customers', exact: true }).click();
  await custTable(page).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers');
  assert.deepEqual(errors, []);
});

test('Customer workspace: a reload on #/customers/<id> renders that customer', async () => {
  const { page, errors } = await open(WS_VIEW);
  const farid = idOfCust('farid');
  await goHash(page, '#/customers/' + farid);
  await page.getByTestId('cust-workspace').waitFor();
  await page.reload();
  await page.getByLabel('Search customers').fill('farid');
  await page.getByTestId('ws-cust-' + farid).waitFor();
  assert.equal(await page.getByTestId('ws-cust-' + farid).getAttribute('aria-current'), 'true');
  assert.match(await wsDetail(page).innerText(), /farid/);
  assert.deepEqual(errors, []);
});

test('Customer workspace: Back from the workspace returns to the table, and Forward opens the customer again', async () => {
  const { page, errors } = await open(WS_VIEW);
  await nav(page, 'Customers');
  await page.getByLabel('Search customers').fill('farid');
  await custTable(page).getByText('farid', { exact: true }).click();
  await page.getByTestId('cust-workspace').waitFor();
  await page.goBack();
  await custTable(page).waitFor();
  await page.goForward();
  await page.getByTestId('cust-workspace').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers/' + idOfCust('farid'));
  assert.deepEqual(errors, []);
});

test('Customer workspace: on a phone #/customers/<id> opens the customer sheet over the list, and a card tap still opens the sheet', async () => {
  const { page, errors } = await open();
  await goHash(page, '#/customers/' + idOfCust('farid'));
  await page.getByRole('dialog', { name: 'farid', exact: true }).waitFor();
  assert.equal(await page.getByTestId('cust-workspace').count(), 0, 'no workspace on a phone');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByTestId('cust-list').getByText('Kabir', { exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Kabir', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/customers/' + idOfCust('farid'), 'a card tap does not change the route');
  assert.deepEqual(errors, []);
});

test('Customer workspace: a customer merged away while open shows the not-on-file Empty after the next refresh, not the stale detail', async () => {
  const st = makeUiState();
  const farid = st.customers.find(c => c.Name === 'farid').Customer_ID;
  const kabir = st.customers.find(c => c.Name === 'Kabir').Customer_ID;
  const { page, errors, api } = await open({ state: st, viewport: { width: 1280, height: 800 } });
  await goHash(page, '#/customers/' + farid);
  await wsDetail(page).getByText('farid', { exact: true }).first().waitFor();
  const merged = await api('mergeCustomers', { requestId: 'ws-merge-1', fromId: farid, intoId: kabir });
  assert.ok(merged.ok, 'the merge is accepted: ' + (merged.error || ''));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('That customer is not on file.', { exact: true }).waitFor();
  assert.equal(await wsDetail(page).getByText('farid', { exact: true }).count(), 0, 'the merged customer is not kept on screen');
  assert.deepEqual(errors, []);
});

test('Customer workspace at 768px: the list stacks above the detail and nothing scrolls sideways', async () => {
  const { page, errors } = await open({ viewport: { width: 768, height: 1000 } });
  await goHash(page, '#/customers/' + idOfCust('farid'));
  await page.getByTestId('cust-workspace').waitFor();
  const list = await page.getByRole('region', { name: 'Customer list' }).boundingBox();
  const detail = await wsDetail(page).boundingBox();
  assert.ok(detail.y >= list.y + list.height - 1, 'the detail sits below the list');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0, 'no sideways scroll');
  assert.deepEqual(errors, []);
});

test('Customer workspace: the timeline is newest first, shows sales and payments, and says reminders and deliveries are not in it yet', async () => {
  const st = makeUiState();
  const f = st.customers.find(c => c.Name === 'farid').Customer_ID;
  const sale = id => st.sales.find(s => Number(s.Sale_ID) === id);
  sale(3).Sale_Date = '2026-10-02';
  sale(44).Sale_Date = '2026-10-06';
  sale(80).Sale_Date = '2026-10-09';
  st.payments.push({ Payment_ID: 'PM-09210', Date: '2026-10-04', Customer_ID: f, Sale_ID: 3, Amount: 50, Method: 'bKash', Transaction_ID: 'TLA1', Source: 'App' });
  st.payments.push({ Payment_ID: 'PM-09211', Date: '2026-10-12', Customer_ID: f, Sale_ID: '', Amount: 70, Method: 'bKash', Transaction_ID: 'TLB1', Source: 'App' });
  const { page, errors } = await open({ state: st, viewport: { width: 1280, height: 800 } });
  await goHash(page, '#/customers/' + f);
  await page.getByTestId('cust-timeline').waitFor();
  const items = await page.locator('[data-testid="timeline-item"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.equal(items.length, 8, 'three sales and five payments');
  const dated = [/TLB1/, /Sale #80 · /, /Sale #44 · /, /TLA1/, /Sale #3 · /];
  dated.forEach((re, i) => assert.match(items[i], re, 'timeline row ' + i));
  items.slice(dated.length).forEach(t => assert.match(t, /No date/, 'undated rows come last'));
  assert.equal(await page.getByText('Reminders and deliveries are not in this view yet', { exact: false }).count(), 1);
  assert.match(await page.getByTestId('cust-stat-first').locator('dd').innerText(), /2 Oct 2026/);
  const billed = st.sales.filter(s => s.Customer_ID === f && !['Void', 'Refunded'].includes(s.Record_Status))
    .reduce((a, s) => a + Number(s.Unit_Price || 0) * Number(s.Months || 1), 0);
  assert.equal(await page.getByTestId('cust-stat-revenue').locator('dd').innerText(), '৳' + billed.toLocaleString('en-US'));
  assert.equal(await page.getByTestId('cust-stat-lines').locator('dd').innerText(), String(await wsDetail(page).locator('[data-testid^="line-"]').count()), 'lines active matches the Subscriptions list');
  assert.deepEqual(errors, []);
});

// ---- uplift 4.6: notification bell ----
// The header bell lists the attention counts (the same ones Today's strip shows, plus lines expiring today). Its badge is the total of
// the unread counts; opening the list reads them all. Unread state is kept in localStorage per item, so a count that changes re-lights it.
const bellButton = page => page.getByRole('button', { name: /^Notifications/ });
const bellBadge = page => page.getByTestId('bell-badge');
const bellList = page => page.getByRole('dialog', { name: 'Notifications', exact: true });
// The seeded accounts and codes raise stock alerts (uplift 4.8). The tests here count the other items, so their state starts with none:
// a threshold of 0 (no code product is at zero) and spare seats on every account. The stock items have their own tests at the end.
function noStockAlerts(st) {
  st.settings.low_stock_threshold = '0';
  st.accounts.forEach(a => { a.Slots = 99; });
  return st;
}
// The seeded state: one payment to match (TESTTRX1), one pending delivery (a paid seat link), and sale 73 renewing today.
function bellState() {
  const st = noStockAlerts(deliveryState());
  st.sales.find(s => Number(s.Sale_ID) === 73).Paid_Till = st.today;
  return st;
}

test('Notification bell: the badge is the sum of the attention counts, and the list has one row per count', async () => {
  const { page, errors, api } = await open({ state: bellState() });
  await paidLink(api, 1, { title: 'Seat show', productId: 'NS', amount: 300 });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  const home = (await api('home', {})).data;
  const a = home.attention;
  const expiring = home.renewSoon.filter(r => r.daysLeft === 0).length;
  const sum = a.payments + a.payLinks + a.deliveries + a.budgets + expiring;
  assert.equal(a.payments, 1, 'one payment to match');
  assert.equal(a.deliveries, 1, 'one pending delivery');
  assert.equal(expiring, 1, 'one line expiring today');
  assert.equal(sum, 3);
  await bellBadge(page).waitFor();
  assert.equal(await bellBadge(page).innerText(), String(sum));
  assert.match(await bellButton(page).getAttribute('aria-label'), new RegExp('Notifications, ' + sum + ' new'));
  await bellButton(page).click();
  await bellList(page).waitFor();
  const rows = await bellList(page).locator('[data-testid^="bell-"]').evaluateAll(els => els.map(e => e.dataset.testid));
  assert.deepEqual(rows, ['bell-payments', 'bell-expiring', 'bell-deliveries']);
  assert.match(await page.getByTestId('bell-expiring').innerText(), /1 line expires today/);
  assert.deepEqual(errors, []);
});

test('Notification bell: opening lists the items, and a click moves to its screen with focus on the page title', async () => {
  const { page, errors, api } = await open({ state: deliveryState() });
  await paidLink(api, 1, { title: 'Seat show', productId: 'NS', amount: 300 });
  await page.reload();
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Dues');
  await bellButton(page).click();
  await bellList(page).waitFor();
  // offsetHeight, not boundingBox: the list is still in its open zoom, which scales the box.
  const height = await page.getByTestId('bell-deliveries').evaluate(el => el.offsetHeight);
  assert.ok(height >= 44, 'a list row is at least 44px tall on a phone: ' + height);
  await page.getByTestId('bell-deliveries').click();
  await page.getByTestId('delivery-list').waitFor();
  assert.match(await page.evaluate(() => location.hash), /#\/delivery/);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pageTitle');
  assert.equal(await bellList(page).count(), 0, 'the list closes after a pick');
  assert.deepEqual(errors, []);
});

test('Notification bell: opening the list clears the badge, and a new inbox row re-lights it with the new count', async () => {
  const { page, errors, relay } = await openLive(noStockAlerts(makeUiState()));
  await bellBadge(page).waitFor();
  assert.equal(await bellBadge(page).innerText(), '1', 'the seeded payment to match');
  await bellButton(page).click();
  await bellList(page).waitFor();
  assert.match(await page.getByTestId('bell-payments').innerText(), /New/, 'the item was unread when the list opened');
  await page.keyboard.press('Escape');
  await bellList(page).waitFor({ state: 'detached' });
  assert.equal(await bellBadge(page).count(), 0, 'the badge clears after opening');
  assert.equal(await bellButton(page).getAttribute('aria-label'), 'Notifications');

  const sent = await relay('bkash', { sender: '16247', text: 'You have received Tk 2,290.00 from 01756999992. TrxID BELLARRIVE1 at 28/10/2026 10:00' });
  assert.equal(sent.body.result, 'stored', 'the SMS was stored in the inbox');
  await page.clock.runFor(6000);   // past the 5 s floor between two refreshes
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await bellBadge(page).waitFor({ timeout: 5000 });
  assert.equal(await bellBadge(page).innerText(), '2', 'the count went from 1 to 2, so the item is unread again');
  assert.match(await bellButton(page).getAttribute('aria-label'), /Notifications, 2 new/);
  assert.deepEqual(errors, []);
});

test('Notification bell: with storage throwing the page works, the badge still shows, and every item counts as unread', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    const blocked = () => { throw new Error('storage blocked'); };
    Storage.prototype.getItem = blocked;
    Storage.prototype.setItem = blocked;
    Storage.prototype.removeItem = blocked;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await startUiHost(page, { state: noStockAlerts(makeUiState()) });
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  await bellBadge(page).waitFor();
  assert.equal(await bellBadge(page).innerText(), '1');
  await bellButton(page).click();
  await bellList(page).waitFor();
  await page.keyboard.press('Escape');
  await bellList(page).waitFor({ state: 'detached' });
  assert.equal(await bellBadge(page).innerText(), '1', 'nothing could be marked read, so the item is still unread');
  assert.deepEqual(errors, []);
});

test('Notification bell at 360px: the bell is on screen, the list fits the phone width, and nothing scrolls sideways', async () => {
  const { page, errors } = await open();
  await bellBadge(page).waitFor();
  const box = await bellButton(page).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 360, 'the bell is on screen');
  await bellButton(page).click();
  await bellList(page).waitFor();
  const pop = await bellList(page).boundingBox();
  assert.ok(pop.x >= 0 && pop.x + pop.width <= 360, 'the list fits the phone width');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no sideways scroll');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('Notification bell: Esc closes the list and focus returns to the bell', async () => {
  const { page, errors } = await open();
  await bellButton(page).click();
  await bellList(page).waitFor();
  await page.keyboard.press('Escape');
  await bellList(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Notifications');
  assert.deepEqual(errors, []);
});

test('Notification bell: with nothing needing attention the bell has no badge and the list says so', async () => {
  const st = noStockAlerts(makeUiState());
  st.inbox = [];
  const { page, errors } = await open({ state: st });
  await bellButton(page).waitFor();
  assert.equal(await bellBadge(page).count(), 0);
  await bellButton(page).click();
  await bellList(page).getByText('Nothing needs attention.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('bell-payments').count(), 0);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

// ---- uplift 4.8: stock and capacity alerts ----
// The seeded state (makeUiState) has LIUKANG with 2 codes left, which is at the default threshold of 3, and five accounts with no free
// seat (EXL-01, EXL-02, EXL-03, SPT-05, YTP-01). NFX-01 is not full and NFX-03 has open slots.
const stockChip = (page, kind) => page.locator('[data-testid="attention-stock"][data-kind="' + kind + '"]');

test('Stock alerts: Today has one chip per alert kind with its count, and a chip opens Accounts', async () => {
  const { page, errors } = await open();
  const full = stockChip(page, 'account_full');
  await full.waitFor();
  assert.match(await stockChip(page, 'code_low').innerText(), /1 product low on codes/);
  assert.match(await full.innerText(), /5 accounts with no free slot/);
  assert.equal(await stockChip(page, 'account_renewing').count(), 0, 'no account renews within 5 days in the seed');
  await full.click();
  await page.getByTestId('accounts-low-stock').waitFor();
  assert.match(await page.evaluate(() => location.hash), /#\/accounts/);
  assert.deepEqual(errors, []);
});

test('Stock alerts: an account renewing within 5 days gets its own Today chip', async () => {
  const st = makeUiState();
  st.accounts.find(a => a.Account_ID === 'NFX-01').Renewal_Date = '2026-10-21';   // three days after the seeded today, 2026-10-18
  const { page, errors } = await open({ state: st });
  await stockChip(page, 'account_renewing').waitFor();
  assert.match(await stockChip(page, 'account_renewing').innerText(), /1 account renewing within 5 days/);
  assert.deepEqual(errors, []);
});

test('Stock alerts: All settings shows low_stock_threshold at 3, and saving 1 there drops the code chip from Today', async () => {
  const { page, errors, tables } = await open();
  await stockChip(page, 'code_low').waitFor();
  await goSettings(page);
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await page.locator('#set-low_stock_threshold').waitFor();
  assert.equal(await page.locator('#set-low_stock_threshold').inputValue(), '3', 'the default shows before any row is stored');
  await page.locator('#set-low_stock_threshold').fill('1');
  await page.locator('#saveAll').click();
  await toastOf(page, 'Settings saved').first().waitFor();
  assert.equal(tables.settings.get('low_stock_threshold'), '1', 'a key with no row yet is inserted');
  await nav(page, 'Today');
  await page.getByTestId('today-owed').waitFor();
  await stockChip(page, 'account_full').waitFor();
  assert.equal(await stockChip(page, 'code_low').count(), 0, 'LIUKANG has 2 codes, which is above 1');
  assert.deepEqual(errors, []);
});

test('Stock alerts: the bell has one stock item that counts the alerts, and a pick opens Accounts', async () => {
  const { page, errors } = await open();
  await bellButton(page).click();
  await bellList(page).waitFor();
  const item = page.getByTestId('bell-stock');
  assert.match(await item.innerText(), /6 stock and capacity alerts/, 'one code product and five full accounts');
  await item.click();
  await page.getByTestId('accounts-low-stock').waitFor();
  assert.match(await page.evaluate(() => location.hash), /#\/accounts/);
  assert.equal(await bellList(page).count(), 0, 'the list closes after a pick');
  assert.deepEqual(errors, []);
});

test('Stock alerts: the Accounts Low stock chip counts the affected accounts and filters to them', async () => {
  const { page, errors } = await open();
  await nav(page, 'Accounts');
  const chip = page.getByTestId('accounts-low-stock');
  await chip.waitFor();
  assert.match(await chip.innerText(), /Low stock · 5/);
  await page.getByTestId('acct-NFX-01').waitFor();
  await chip.click();
  await page.getByTestId('acct-NFX-01').waitFor({ state: 'detached' });
  await page.getByTestId('acct-YTP-01').waitFor();
  assert.equal(await page.getByTestId('acct-EXL-01').count(), 1);
  assert.equal(await page.getByTestId('acct-NFX-03').count(), 0, 'NFX-03 has open slots, so it is not affected');
  assert.equal(await chip.getAttribute('aria-pressed'), 'true');
  await chip.click();
  await page.getByTestId('acct-NFX-01').waitFor();
  assert.equal(await chip.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
});

// ---- uplift 5.4: error boundaries and Retry ----
// The test host sets window.__TEST_CRASH__ (init script); ?crash=<tab> then makes that screen throw while it renders.
// Without the flag the query does nothing (the production path).
async function crashPage(tab, flag) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
  if (flag) await ctx.addInitScript(() => { window.__TEST_CRASH__ = true; });
  await startUiHost(page);
  await page.goto(PAGE + '?crash=' + tab);
  return { page, errors, logs };
}
const crashLogs = (logs, tab) => logs.filter(t => t.includes('Test crash in ' + tab));

test('Error boundary: a lazy screen that throws shows the generic message, not the connection one, and logs the error once', async () => {
  const { page, errors, logs } = await crashPage('customers', true);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Customers');
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  const text = await page.getByTestId('screen-error').innerText();
  assert.match(text, /Something went wrong on this screen\./);
  assert.doesNotMatch(text, /Check your connection/);
  assert.ok(await page.getByRole('button', { name: 'Retry' }).isVisible());
  assert.equal(crashLogs(logs, 'customers').length, 1, 'logged once: ' + JSON.stringify(logs));
  assert.deepEqual(errors, []);
});

test('Error boundary: Today, which is not lazy, is caught too, with the generic message and one log', async () => {
  const { page, errors, logs } = await crashPage('today', true);
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  const text = await page.getByTestId('screen-error').innerText();
  assert.match(text, /Something went wrong on this screen\./);
  assert.doesNotMatch(text, /Check your connection/);
  assert.equal(await page.getByTestId('today-owed').count(), 0, 'Today did not render');
  assert.equal(crashLogs(logs, 'today').length, 1, 'logged once: ' + JSON.stringify(logs));
  assert.deepEqual(errors, []);
});

test('Error boundary: Retry after the fault is gone remounts the screen and it renders', async () => {
  const { page, errors } = await crashPage('customers', true);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Customers');
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  await page.evaluate(() => { window.__TEST_CRASH__ = false; });
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('screen-error').waitFor({ state: 'detached' });
  await page.getByTestId('cust-list').waitFor({ timeout: 10000 });
  assert.deepEqual(errors, []);
});

test('Error boundary: Today Retry remounts Today once the fault is gone', async () => {
  const { page, errors } = await crashPage('today', true);
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  await page.evaluate(() => { window.__TEST_CRASH__ = false; });
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('today-owed').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('screen-error').count(), 0);
  assert.deepEqual(errors, []);
});

test('Error boundary: without the test flag the crash query does nothing', async () => {
  const { page, errors, logs } = await crashPage('customers', false);
  await page.getByTestId('today-owed').waitFor();
  await nav(page, 'Customers');
  await page.getByTestId('cust-list').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('screen-error').count(), 0);
  assert.equal(crashLogs(logs, 'customers').length, 0);
  assert.deepEqual(errors, []);
});

test('Error boundary: a chunk that will not load shows the connection message, not the generic one', async () => {
  const { page, errors, logs } = await crashPage('today', false);
  await page.getByTestId('today-owed').waitFor();
  await page.route('**/assets/Customers-*.js', route => route.abort());
  await nav(page, 'Customers');
  await page.getByTestId('screen-error').waitFor({ timeout: 15000 });
  const text = await page.getByTestId('screen-error').innerText();
  assert.match(text, /Check your connection and try again\./);
  assert.doesNotMatch(text, /Something went wrong/);
  assert.equal(logs.filter(t => t.includes('Test crash')).length, 0);
  assert.deepEqual(errors.filter(e => /Customers/.test(e)), [], 'no uncaught error from the chunk');
});

// ---- uplift 5.5: pull to refresh (phone) ----
// A touch context. The pull is a CDP touch sequence (Input.dispatchTouchEvent), so Chromium sends the pointer and touch events
// a finger would. Every API call the page makes is recorded by its action, so a refresh shows as one more 'init'.
async function touchPage(opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true }, opts));
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [], actions = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().includes('/functions/v1/api')) actions.push(JSON.parse(r.postData() || '{}').action);
  });
  await startUiHost(page);
  await page.goto(PAGE);
  await page.getByTestId('today-owed').waitFor();
  return { page, ctx, errors, actions, inits: () => actions.filter(a => a === 'init').length };
}
async function touchDrag(ctx, page, { x = 180, from, to, steps = 10 }) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(from + ((to - from) * i) / steps) }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const pause = page => page.waitForTimeout(800);   // long enough for a refresh that should have started to be counted

test('Pull to refresh: a 100px pull from the top runs one init read, shows the Refreshing chip under the header, and a second pull while it runs adds nothing', async () => {
  const { page, ctx, errors, inits } = await touchPage();
  const before = inits();
  let release;
  const held = new Promise(r => { release = r; });
  await page.route('**/functions/v1/api', async route => {
    if (JSON.parse(route.request().postData() || '{}').action === 'init') await held;
    return route.fallback();
  });
  await touchDrag(ctx, page, { from: 200, to: 300 });
  const live = page.locator('header.sticky [aria-live="polite"]');
  await live.getByText('Refreshing', { exact: true }).waitFor();
  assert.equal((await live.innerText()).trim(), 'Refreshing');
  const chip = await live.getByText('Refreshing', { exact: true }).boundingBox();
  const head = await page.locator('header.sticky').boundingBox();
  assert.ok(chip.y >= head.y + head.height - 1, 'the chip sits under the header');
  await touchDrag(ctx, page, { from: 200, to: 300 });
  await page.waitForTimeout(300);
  assert.equal(inits() - before, 1, 'the second pull did not start another refresh');
  release();
  await live.getByText('Refreshing', { exact: true }).waitFor({ state: 'detached' });
  await pause(page);
  assert.equal(inits() - before, 1, 'exactly one init for the pull');
  assert.deepEqual(errors, []);
});

test('Pull to refresh: a 30px pull, released short of the threshold, does nothing', async () => {
  const { page, ctx, errors, inits } = await touchPage();
  const before = inits();
  await touchDrag(ctx, page, { from: 200, to: 230 });
  await pause(page);
  assert.equal(inits() - before, 0);
  assert.equal(await page.locator('header.sticky [aria-live="polite"]').innerText(), '');
  assert.deepEqual(errors, []);
});

test('Pull to refresh: a pull while a sheet is open does nothing', async () => {
  const { page, ctx, errors, inits } = await touchPage();
  await quick(page, 'New sale');
  await page.getByRole('dialog').waitFor();
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const before = inits();
  await touchDrag(ctx, page, { from: 200, to: 300 });
  await pause(page);
  assert.equal(inits() - before, 0);
  assert.equal(await page.getByRole('dialog').count(), 1, 'the sheet is still open');
  assert.deepEqual(errors, []);
});

test('Pull to refresh: a mouse drag from the top does nothing', async () => {
  const { page, errors, inits } = await touchPage();
  const before = inits();
  await page.mouse.move(180, 200);
  await page.mouse.down();
  await page.mouse.move(180, 300, { steps: 10 });
  await page.mouse.up();
  await pause(page);
  assert.equal(inits() - before, 0);
  assert.deepEqual(errors, []);
});

test('Pull to refresh: with reduced motion on, a 100px pull does nothing', async () => {
  const { page, ctx, errors, inits } = await touchPage({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  const before = inits();
  await touchDrag(ctx, page, { from: 200, to: 300 });
  await pause(page);
  assert.equal(inits() - before, 0);
  assert.deepEqual(errors, []);
});

test('Pull to refresh: normal scrolling still works, and a downward drag after scrolling is a scroll, not a pull', async () => {
  const { page, ctx, errors, inits } = await touchPage();
  const before = inits();
  await touchDrag(ctx, page, { from: 600, to: 250, steps: 20 });   // finger up: the page scrolls down
  await page.waitForFunction(() => window.scrollY > 100);
  const down = await page.evaluate(() => window.scrollY);
  await touchDrag(ctx, page, { from: 300, to: 420 });              // finger down, but not at the top: the page scrolls back up
  await page.waitForFunction(y => window.scrollY < y, down);
  await pause(page);
  assert.equal(inits() - before, 0);
  assert.deepEqual(errors, []);
});

// ---- Data migration panel and Profit by month (synthetic names only) ----
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function stagingDoc(batch) {
  return { batch, rows: [
    { id: batch + ':acct', kind: 'account', sheet: 'Tab', ref: 'B2', data: { productHint: 'Netflix', label: 'Synthetic NFX', collected: 600, cost: 800, renewalDate: '2026-12-01', slots: 5 } },
    { id: batch + ':l1', kind: 'line', sheet: 'Tab', ref: 'C3', data: { accountRef: batch + ':acct', name: 'Zed Alpha', profile: 'P1', status: 'Paid', amount: 300, paidTill: '2026-11-15' } },
    { id: batch + ':l2', kind: 'line', sheet: 'Tab', ref: 'C4', data: { accountRef: batch + ':acct', name: 'Yara Beta', profile: 'P2', status: 'Paid', amount: 300, paidTill: '2026-11-20' } },
    { id: batch + ':l3', kind: 'line', sheet: 'Tab', ref: 'C5', data: { accountRef: batch + ':acct', name: 'Xan Gamma', profile: 'P3', status: 'Paid', amount: '220-250', paidTill: '2026-11-25' } }
  ] };
}
const stage = (api, doc) => api('importStage', Object.assign({ requestId: crypto.randomUUID() }, doc));
const openMigration = async page => {
  await nav(page, 'More');
  await page.locator('[data-more="migration"]').click();
  await page.getByRole('button', { name: 'Load staging file' }).waitFor();
};

test('Migration: More lists Data migration; a staging file loads and shows the account with its lines', async () => {
  const { page, errors } = await open();
  await openMigration(page);
  await page.getByText('No staged rows. Load a staging file.').waitFor();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'stage.json');
  fs.writeFileSync(file, JSON.stringify(stagingDoc('T1')));
  await page.locator('#mig-file').setInputFiles(file);
  await toastOf(page, '4 rows staged').waitFor();
  const card = page.getByTestId('mig-account');
  await card.waitFor();
  assert.match(await card.innerText(), /Tab!B2/);
  assert.equal(await card.locator('[data-kind="line"]').count(), 3);
  assert.match(await card.getByTestId('mig-totals').innerText(), /Matches|Staged is higher|Sheet is higher/);
  assert.match(await card.locator('[data-row="T1:l3"]').innerText(), /not a number|text, not a number/i);
  assert.deepEqual(errors, []);
});

test('Migration: editing a line amount saves it', async () => {
  const { page, errors, rows, api } = await open();
  await stage(api, stagingDoc('T2'));
  await openMigration(page);
  await page.getByTestId('mig-account').waitFor();
  await page.getByRole('button', { name: /^Edit Total paid for Tab!C3/ }).click();
  await page.getByLabel('Edit Total paid for Tab!C3').fill('350');
  await page.getByLabel('Edit Total paid for Tab!C3').press('Enter');
  await toastOf(page, 'Total paid').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-row="T2:l1"]').innerText.includes('350'));
  const row = rows('Import_Rows').find(r => r.row_id === 'T2:l1');
  assert.equal(JSON.parse(row.data).amount, 350);
  assert.deepEqual(errors, []);
});

test('Migration: Approve then Apply creates a sale and the rows show Applied', async () => {
  const { page, errors, rows, api } = await open();
  await stage(api, stagingDoc('T3'));
  await openMigration(page);
  const card = page.getByTestId('mig-account');
  await card.waitFor();
  // Fix the text amount so the line is clean, then approve everything clean.
  await page.getByRole('button', { name: /^Edit Total paid for Tab!C5/ }).click();
  await page.getByLabel('Edit Total paid for Tab!C5').fill('200');
  await page.getByLabel('Edit Total paid for Tab!C5').press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-row="T3:l3"]').innerText.includes('200'));
  const salesBefore = rows('Sales_Log').length;
  await card.getByRole('button', { name: /^Approve all clean rows/ }).click();
  await page.locator('#mig-apply').waitFor();
  await page.locator('#mig-apply').click();
  assert.match(await page.getByTestId('mig-apply-list').innerText(), /new sales/);
  await page.getByRole('button', { name: 'Apply now' }).click();
  await page.getByTestId('mig-result').waitFor();
  assert.ok(rows('Sales_Log').length > salesBefore, 'sales were created');
  await page.waitForFunction(() => document.querySelectorAll('[data-status="Applied"]').length >= 4);
  assert.match(await page.locator('[data-row="T3:l1"]').getByTestId('mig-applied').innerText(), /sales/);
  assert.deepEqual(errors, []);
});

test('Profit by month: months render and an account row expands', async () => {
  const { page, errors } = await open();
  await nav(page, 'Money');
  await page.getByRole('tab', { name: 'Profit' }).click();
  await page.getByText('Net profit').waitFor();
  await page.getByRole('button', { name: 'By month' }).click();
  await page.getByTestId('pm-table').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="pm-2026"]').length === 6);
  assert.equal(await page.getByText('Net profit').count(), 0, 'no second hero figure');
  const month = page.locator('[data-testid^="pm-2026"]', { has: page.locator('button[aria-expanded]:not([disabled])') }).first();
  await month.getByRole('button').first().click();
  await page.getByTestId('pm-account').first().waitFor();
  await page.getByRole('button', { name: 'By category' }).click();
  await page.getByText('Net profit').waitFor();
  assert.deepEqual(errors, []);
});

test('Migration screen holds at 360px with no sideways scroll', async () => {
  const { page, errors, api } = await open();
  await stage(api, stagingDoc('T5'));
  await openMigration(page);
  await page.getByTestId('mig-account').waitFor();
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth) <= 360);
  await page.getByRole('tab', { name: /^Orphans/ }).click();
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth) <= 360);
  assert.deepEqual(errors, []);
});

// ---- Migration fixes and the login details vault ----
test('Migration: every line field has a visible edit control (40px tap target, labelled), including empty Profile and Paid till', async () => {
  const { page, errors, api } = await open();
  await stage(api, { batch: 'T6', rows: [
    { id: 'T6:acct', kind: 'account', sheet: 'Tab', ref: 'B2', data: { productHint: 'Netflix', label: 'Synthetic NFX', collected: 600, cost: 800, renewalDate: '2026-12-01', slots: 5 } },
    { id: 'T6:l1', kind: 'line', sheet: 'Tab', ref: 'C3', data: { accountRef: 'T6:acct', name: 'Zed Alpha', profile: '', status: 'Paid', amount: 800, months: 6, due: '585' } } ] });
  await openMigration(page);
  const row = page.locator('[data-row="T6:l1"]');
  await row.waitFor();
  for (const f of ['Profile', 'Paid till', 'Covers from', 'Still owes', 'Months (1 to 24)', 'Status', 'Total paid']) {
    const btn = row.getByRole('button', { name: new RegExp('^Edit ' + escRe(f) + ' for Tab!C3') });
    assert.equal(await btn.count(), 1, f);
    assert.ok((await btn.boundingBox()).height >= 40, f + ' tap target');
  }
  const opacity = await row.getByRole('button', { name: /^Edit Profile for Tab!C3/ }).locator('svg').evaluate(el => getComputedStyle(el).opacity);
  assert.ok(Number(opacity) >= 0.5, 'pencil visible without hover');
  assert.match(await row.innerText(), /Still owes ৳585/);
  assert.match(await row.getByTestId('mig-summary').innerText(), /6 months · ৳1,385 total/);
  assert.deepEqual(errors, []);
});

test('Migration: a line whose account row is in Review offers Approve and include, which applies both', async () => {
  const { page, errors, rows, api } = await open();
  await stage(api, stagingDoc('T7'));
  await openMigration(page);
  await page.getByTestId('mig-account').waitFor();
  await api('importStatus', { requestId: crypto.randomUUID(), rowIds: ['T7:l1'], status: 'Approved' });
  await page.reload();
  await page.getByRole('button', { name: 'More' }).first().waitFor();
  await openMigration(page);
  await page.locator('#mig-apply').waitFor();
  await page.locator('#mig-apply').click();
  assert.match(await page.getByTestId('mig-also').innerText(), /Needs account Tab!B2/);
  await page.getByRole('button', { name: 'Approve and include' }).click();
  await page.getByTestId('mig-result').waitFor();
  assert.equal(rows('Import_Rows').find(r => r.row_id === 'T7:acct').status, 'Applied');
  assert.deepEqual(errors, []);
});

test('Vault: add a login on an account, show it with the PIN, it hides on close; viewer sees no button', async () => {
  const { page, errors, tables, api } = await open({ viewport: { width: 1280, height: 800 } });
  assert.equal((await api('vaultSetPin', { newPin: '482916' })).ok, true);
  await nav(page, 'Accounts');
  const card = page.getByTestId('acct-NFX-03');
  await card.waitFor();
  await card.getByRole('button', { name: 'Login details', exact: true }).last().click();
  const dlg = page.getByTestId('vault-dialog');
  await dlg.getByRole('button', { name: 'Add login details' }).click();
  await dlg.getByLabel('Label').fill('Main login');
  await dlg.getByLabel('Login details', { exact: true }).fill('user demo-person / pass demo-secret-9');
  const pinBox = dlg.locator('#vault-pin-add');
  assert.equal(await pinBox.getAttribute('type'), 'password');
  assert.equal(await pinBox.getAttribute('inputmode'), 'numeric');
  await pinBox.fill('482916');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.getByText('Main login').waitFor();
  const stored = JSON.stringify(Array.from(tables.account_secrets.values()));
  assert.ok(!stored.includes('demo-secret-9'));
  await dlg.getByRole('button', { name: 'Show' }).click();
  await dlg.locator('#vault-pin').fill('000000');
  await dlg.getByRole('button', { name: 'Show' }).click();
  await dlg.getByText('Wrong PIN.').waitFor();
  await dlg.locator('#vault-pin').fill('482916');
  await dlg.getByRole('button', { name: 'Show' }).click();
  assert.match(await dlg.getByTestId('vault-text').innerText(), /demo-secret-9/);
  await dlg.getByRole('button', { name: 'Copy' }).waitFor();
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).then(s => s.includes('demo-secret-9')), false);
  assert.deepEqual(errors, []);
});

test('Migration: a skipped row listed after Apply is a link that switches tab, scrolls to, highlights and focuses the row field', async () => {
  const { page, errors, api } = await open();
  const doc = stagingDoc('T9');
  delete doc.rows[2].data.paidTill;   // Yara Beta: no paid till, no renewal date
  doc.rows[3].data.amount = 200;
  await stage(api, doc);
  await api('importStatus', { requestId: crypto.randomUUID(), rowIds: doc.rows.map(r => r.id), status: 'Approved' });
  await openMigration(page);
  await page.getByTestId('mig-account').waitFor();
  assert.equal(await page.locator('[data-row="T9:l2"] [data-testid="mig-blocks"]').count(), 1);
  assert.match(await page.locator('[data-row="T9:l2"]').innerText(), /Paid till is blank/);
  await page.locator('#mig-apply').click();
  await page.getByRole('button', { name: 'Apply now' }).click();
  await page.getByTestId('mig-apply-result').waitFor();
  assert.match(await page.getByTestId('mig-apply-result').innerText(), /Applied 3, 1 needs attention/);
  await page.getByRole('tab', { name: /^Codes/ }).click();
  assert.equal(await page.getByTestId('mig-account').count(), 0);
  await page.getByTestId('mig-skipped-row').click();
  const row = page.locator('[data-testid="mig-row"][data-row="T9:l2"]');
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-row="T9:l2"]').getAttribute('data-highlight') === 'true');
  await page.waitForFunction(() => { const r = document.querySelector('[data-testid="mig-row"][data-row="T9:l2"]').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.closest('[data-row]') && document.activeElement.closest('[data-row]').getAttribute('data-row')), 'T9:l2');
  // One-click fix: the computed paid till is stored and the block goes away.
  await page.getByTestId('mig-fix-paidTill-computed').click();
  await page.waitForFunction(() => !document.querySelector('[data-row="T9:l2"] [data-testid="mig-blocks"]'));
  assert.deepEqual(errors, []);
});
