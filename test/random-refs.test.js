const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { appendOf, ok } = require('./helpers');

const R = () => Core.refs;
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

// A rand source that returns the scripted values in order (one per call).
function scripted(values) {
  let i = 0;
  return function (n) {
    const v = values[i++];
    if (v === undefined) throw new Error('script exhausted');
    if (v >= n) throw new Error('scripted value ' + v + ' out of range ' + n);
    return v;
  };
}
// Alphabet indexes for a string, so scripted() can spell it out.
const idx = s => Array.from(s).map(c => ALPHA.indexOf(c));

test('isRandomRef: six letters and digits with both kinds, never a legacy code', () => {
  for (const s of ['nubnf3', 'NUBNF3', 'a1b2c3']) assert.equal(R().isRandomRef(s), true, s);
  for (const s of ['abcdef', '123456', 'n54', 'ab1234', 'r12345', 'nubnf', 'nubnf33', 'nub-f3', '']) {
    assert.equal(R().isRandomRef(s), false, s);
  }
});

test('newRef builds six characters from the alphabet, lowercase', () => {
  assert.equal(R().newRef({}, scripted(idx('nubnf3'))), 'nubnf3');
});

test('newRef retries a value that is not a random ref (all letters), then takes the next', () => {
  const rand = scripted(idx('abcdef').concat(idx('nubnf3')));
  assert.equal(R().newRef({}, rand), 'nubnf3');
});

test('newRef never returns a taken value and never mutates taken', () => {
  const taken = { NUBNF3: true };
  const rand = scripted(idx('nubnf3').concat(idx('nubnf4')));
  assert.equal(R().newRef(taken, rand), 'nubnf4');
  assert.deepEqual(taken, { NUBNF3: true });
});

test('newRef gives up after 50 tries with the exact message', () => {
  const digitsOnly = () => 30; // always "5555..." style digits, never a letter
  assert.throws(() => R().newRef({}, digitsOnly), { message: 'Could not make a unique reference. Try again.' });
});

test('IdGen.ref: 2000 refs from randomInt are distinct and all random refs', () => {
  const gen = Core.ids.IdGen({ sales: [], payRequests: [] });
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const r = gen.ref(n => Core.util.randomInt(n));
    assert.ok(R().isRandomRef(r), r);
    assert.ok(!seen.has(r.toUpperCase()), 'duplicate ' + r);
    seen.add(r.toUpperCase());
  }
});

test('usedRefs holds upper-case sub codes, request ids and pay request refs', () => {
  const state = { sales: [{ Sub_Code: 'N54' }, { Sub_Code: 'nubnf3' }, { Sub_Code: '' }],
    payRequests: [{ Request_ID: 'R3', Ref: 'abc123' }, { Request_ID: 'R4', Ref: '' }] };
  const used = R().usedRefs(state);
  assert.deepEqual(Object.keys(used).sort(), ['ABC123', 'NUBNF3', 'N54', 'R3', 'R4'].sort());
});

test('subCodeLine matches case-insensitively, random refs included', () => {
  const m = makeMigratedState();
  const line = m.sales.find(s => s.Sub_Code === 'N44');
  line.Sub_Code = 'nubnf3';
  assert.equal(R().subCodeLine(m, 'NUBNF3').latest.Sale_ID, line.Sale_ID);
  assert.equal(R().subCodeLine(m, 'nubnf3').latest.Sale_ID, line.Sale_ID);
  assert.equal(R().subCodeLine(m, 'n44').latest, null);
  assert.equal(R().subCodeLine(makeMigratedState(), 'n44').latest.Sub_Code, 'N44');
});

test('planNewSale: random style gives a random Sub_Code, legacy keeps the letter code', () => {
  const m = makeMigratedState();
  m.settings.ref_style = 'random';
  const r = ok(Core.sales.planNewSale(m, { productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'farid'), price: 290,
    _rand: scripted(idx('nubnf3')) }));
  assert.equal(r.result.subCode, 'nubnf3');
  assert.equal(appendOf(r, 'Sales_Log').values.Sub_Code, 'nubnf3');

  const legacy = makeMigratedState();
  legacy.settings.ref_style = 'legacy';
  const old = ok(Core.sales.planNewSale(legacy, { productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(legacy, 'farid') }));
  assert.match(old.result.subCode, /^N\d+$/);
  const absent = makeMigratedState();
  delete absent.settings.ref_style;
  assert.match(ok(Core.sales.planNewSale(absent, { productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(absent, 'farid') })).result.subCode, /^N\d+$/);
});

test('planRenew keeps the Sub_Code of a random-ref line', () => {
  const m = makeMigratedState();
  m.sales.find(s => s.Sub_Code === 'N44').Sub_Code = 'nubnf3';
  const r = ok(Core.sales.planRenew(m, { subCode: 'nubnf3', applyCredit: false }));
  assert.equal(appendOf(r, 'Sales_Log').values.Sub_Code, 'nubnf3');
  assert.equal(r.result.subCode, 'nubnf3');
});

test('planSettings: ref_style accepts random or legacy, rejects anything else', () => {
  const m = makeMigratedState();
  ok(Core.sales.planSettings(m, { ref_style: 'legacy' }));
  assert.deepEqual(Core.sales.planSettings(m, { ref_style: 'x' }).errors, ['Reference style must be random or legacy.']);
});

// Task 10: recognise random refs in inbox rows, suggestions and order payments.
function withNubnf3() {
  const m = makeMigratedState();
  m.sales.find(s => s.Sub_Code === 'N44').Sub_Code = 'nubnf3';
  return m;
}

test('findKnownRef: a known random ref in the reference column or the SMS, in any case or with words around it', () => {
  const m = withNubnf3();
  const known = (row) => R().findKnownRef(row, m);
  assert.equal(known({ Reference: 'nubnf3' }), 'nubnf3');
  assert.equal(known({ Reference: 'NUBNF3' }), 'nubnf3');
  assert.equal(known({ Reference: 'netflix nubnf3 thanks' }), 'nubnf3');
  assert.equal(known({ Reference: '', Raw_SMS: 'Cash In Tk 600.00 from 017... Ref: nubnf3. Fee Tk 0.00 TrxID AB12CD34EF' }), 'nubnf3');
});

test('findKnownRef: ordinary words, unknown codes and partial tokens never match', () => {
  const m = withNubnf3();
  const known = (row) => R().findKnownRef(row, m);
  for (const row of [{ Reference: 'bkash' }, { Reference: 'netflix' }, { Reference: 'abcdef' }, { Reference: 'nubnf4' },
    { Reference: 'nubnf34' }, { Reference: 'xnubnf3' }, { Reference: '', Raw_SMS: 'TrxID NUBNF3XYZ1' }]) {
    assert.equal(known(row), null, JSON.stringify(row));
  }
});

test('findKnownRef: legacy references are not random refs', () => {
  const m = withNubnf3();
  assert.equal(R().findKnownRef({ Reference: 'N44' }, m), null);
  assert.equal(R().findKnownRef({ Reference: 'R5' }, m), null);
  assert.equal(R().findRef({ Reference: 'N44' }, ['N']), 'N44');
});

test('hasToken is whole-token and case-insensitive', () => {
  assert.equal(R().hasToken('nubnf3 netflix', 'NUBNF3'), true);
  assert.equal(R().hasToken('xnubnf3', 'nubnf3'), false);
  assert.equal(R().hasToken('', 'nubnf3'), false);
});

test('an automatic bKash match with a random ref renews that line and keeps its Sub_Code', () => {
  const m = withNubnf3();
  const row = { Received: '2026-10-18', Sender: '16247', Type: 'Received', Amount: 580, Transaction_ID: 'T9', Reference: 'nubnf3', Raw_SMS: '', Status: 'Pending' };
  const x = Core.matching.planInboxMatch(m, row);
  assert.equal(x.status, 'auto');
  assert.equal(appendOf(x, 'Sales_Log').values.Sub_Code, 'nubnf3');
});

test('suggest offers the owner of a random ref', () => {
  const m = withNubnf3();
  const owner = m.sales.find(s => s.Sub_Code === 'nubnf3').Customer_ID;
  const s = Core.matching.suggest(m, { Reference: 'nubnf3', Counterparty: '', Raw_SMS: '' });
  assert.ok(s.some(x => x.customerId === owner && x.why === 'Owns nubnf3'), JSON.stringify(s));
});

test('paymentsFor: a random ref in the reference counts for the order, a longer token does not', () => {
  const rows = [{ Reference: 'nubnf3 netflix', Amount: 290, Status: 'Pending', Received: '2026-10-18' },
    { Reference: 'xnubnf3', Amount: 290, Status: 'Pending', Received: '2026-10-18' }];
  const got = Core.paylinks.paymentsFor(rows, 'nubnf3', 290, null);
  assert.deepEqual(got.map(r => r.Reference), ['nubnf3 netflix']);
});
