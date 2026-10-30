// Core.views.inboxRows (uplift plan 4.1): the Inbox screen's bounded rows and per-status counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

const TODAY = '2026-10-18';
const TOPUP_SMS = 'You have received deposit from iBanking. Amount: Tk 500.00';

// One Payment_Inbox row in the state's field names. Defaults: a pending, non-top-up bKash message received today.
const row = o => Object.assign({ Received: TODAY + ' 10:00', Type: 'Received', Method: 'bKash', Sender: '+8801756999991', Amount: 290,
  Transaction_ID: 'TRX0001', Reference: '', Counterparty: '', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'Received message' }, o);

// The migrated fixture with the given inbox rows and payments, and today fixed.
function stateWith(inbox, payments) {
  const m = makeMigratedState();
  m.today = TODAY;
  m.inbox = inbox;
  if (payments) m.payments = m.payments.concat(payments);
  return m;
}
const trxs = res => res.rows.map(r => r.trx);

test('inbox window: every open message, plus messages from the last 90 days, and nothing older', () => {
  const m = stateWith([
    row({ Transaction_ID: 'OLDPEND', Received: '2026-01-02 09:00', Status: 'Pending' }),
    row({ Transaction_ID: 'OLDREV', Received: '2026-01-03 09:00', Status: 'Review', Type: 'Unrecognised' }),
    row({ Transaction_ID: 'OLDMATCH', Received: '2026-01-04 09:00', Status: 'Matched' }),
    row({ Transaction_ID: 'EDGE90', Received: '2026-07-20 09:00', Status: 'Matched' }),
    row({ Transaction_ID: 'EDGE91', Received: '2026-07-19 09:00', Status: 'Matched' }),
    row({ Transaction_ID: 'RECENT', Received: '2026-10-17 09:00', Status: 'Ignored' })
  ]);
  const res = Core.views.inboxRows(m);
  assert.deepEqual(trxs(res), ['RECENT', 'EDGE90', 'OLDREV', 'OLDPEND'], 'newest first; old matched rows are out of the window');
  assert.ok(res.rows.every(r => r.trx !== 'OLDMATCH' && r.trx !== 'EDGE91'));
});

test('inbox days: a shorter or longer window moves the cut-off, and a bad value is refused', () => {
  const m = stateWith([row({ Transaction_ID: 'A', Received: '2026-09-01 09:00', Status: 'Matched' }),
    row({ Transaction_ID: 'B', Received: '2026-10-10 09:00', Status: 'Matched' })]);
  assert.deepEqual(trxs(Core.views.inboxRows(m, { days: 30 })), ['B']);
  assert.deepEqual(trxs(Core.views.inboxRows(m, { days: 60 })), ['B', 'A']);
  assert.deepEqual(trxs(Core.views.inboxRows(m, { days: 365 })), ['B', 'A']);
  assert.throws(() => Core.views.inboxRows(m, { days: 0 }), /Days must be a whole number from 1 to 365/);
  assert.throws(() => Core.views.inboxRows(m, { days: 366 }), /Days must be a whole number from 1 to 365/);
  assert.throws(() => Core.views.inboxRows(m, { days: 1.5 }), /Days must be/);
  assert.throws(() => Core.views.inboxRows(m, { status: 'Lost' }), /Unknown inbox status Lost/);
});

test('inbox rows: a blank received date sorts last, and no raw SMS is returned', () => {
  const m = stateWith([row({ Transaction_ID: 'NODATE', Received: '', Status: 'Pending' }),
    row({ Transaction_ID: 'DATED', Received: '2026-10-18 08:00', Status: 'Pending' })]);
  const res = Core.views.inboxRows(m);
  assert.deepEqual(trxs(res), ['DATED', 'NODATE']);
  for (const r of res.rows) {
    assert.equal(Object.keys(r).some(k => /sms/i.test(k)), false, 'raw SMS stays out of the list payload');
    assert.deepEqual(Object.keys(r).sort(), ['amount', 'counterparty', 'matchable', 'method', 'received', 'reference', 'sender', 'status', 'topUp', 'trx']);
  }
});

test('inbox counts: per status and total over the window, before the status and search filters', () => {
  const m = stateWith([
    row({ Transaction_ID: 'P1', Status: 'Pending' }),
    row({ Transaction_ID: 'R1', Status: 'Review', Type: 'Unrecognised' }),
    row({ Transaction_ID: 'M1', Status: 'Matched' }),
    row({ Transaction_ID: 'M2', Status: 'Matched' }),
    row({ Transaction_ID: 'AUTO1', Status: 'Matched' }),
    row({ Transaction_ID: 'I1', Status: 'Ignored' }),
    row({ Transaction_ID: 'OLD', Received: '2026-01-01 00:00', Status: 'Ignored' })
  ], [{ Payment_ID: 'PM-A1', Date: TODAY, Customer_ID: '', Sale_ID: '', Amount: 290, Method: 'bKash', Transaction_ID: 'AUTO1', Source: 'Auto', Note: '' }]);
  const all = Core.views.inboxRows(m);
  assert.deepEqual(all.counts, { total: 6, Pending: 1, Review: 1, Matched: 2, 'Auto-matched': 1, Ignored: 1 });
  assert.equal(all.rows.length, 6);
  assert.equal(all.truncated, false);
  // The status filter narrows the rows and leaves the counts alone.
  const matched = Core.views.inboxRows(m, { status: 'Matched' });
  assert.deepEqual(trxs(matched), ['M2', 'M1']);
  assert.deepEqual(matched.counts, all.counts);
  const sub = Core.views.inboxRows(m, { status: 'Auto-matched' });
  assert.deepEqual(trxs(sub), ['AUTO1'], 'a Matched message on an Auto payment reads as Auto-matched');
  assert.equal(sub.rows[0].status, 'Auto-matched');
  assert.equal(Core.views.inboxRows(m, { status: 'all' }).rows.length, 6);
});

test('inbox matchable: open, non-top-up rows only (what the Match sheet can open)', () => {
  const m = stateWith([
    row({ Transaction_ID: 'PEND', Status: 'Pending' }),
    row({ Transaction_ID: 'REVW', Status: 'Review', Type: 'Unrecognised' }),
    row({ Transaction_ID: 'MATCHED', Status: 'Matched' }),
    row({ Transaction_ID: 'IGN', Status: 'Ignored' }),
    row({ Transaction_ID: 'TOPUP', Status: 'Pending', Raw_SMS: TOPUP_SMS }),
    row({ Transaction_ID: 'TOPUP2', Status: 'Matched', Type: 'TopUp' })
  ]);
  const byTrx = {};
  Core.views.inboxRows(m).rows.forEach(r => { byTrx[r.trx] = r; });
  assert.equal(byTrx.PEND.matchable, true);
  assert.equal(byTrx.REVW.matchable, true);
  assert.equal(byTrx.MATCHED.matchable, false);
  assert.equal(byTrx.IGN.matchable, false);
  assert.equal(byTrx.TOPUP.topUp, true, 'an iBanking deposit reads as a wallet top-up');
  assert.equal(byTrx.TOPUP.matchable, false, 'a pending top-up is open but not matched by hand here');
  assert.equal(byTrx.TOPUP2.topUp, true);
  const blank = stateWith([row({ Transaction_ID: '', Status: 'Pending', Raw_SMS: 'No id here' })]);
  assert.equal(Core.views.inboxRows(blank).rows[0].matchable, false, 'a message with no transaction id cannot be opened in the Match sheet');
  assert.equal(byTrx.TOPUP2.status, 'Matched');
});

test('inbox search: transaction id, sender, counterparty, reference and amount, in any case; a sender by its digits', () => {
  const m = stateWith([
    row({ Transaction_ID: 'TRXAAA111', Sender: '+8801756999991', Amount: 290, Reference: 'R12', Status: 'Pending' }),
    row({ Transaction_ID: 'TRXBBB222', Sender: '+8801711222333', Counterparty: 'Rahim Uddin', Amount: 1250, Reference: '', Status: 'Pending' }),
    row({ Transaction_ID: 'TRXCCC333', Sender: '16247', Amount: 80, Reference: 'NFX-01', Status: 'Review' })
  ]);
  const find = q => trxs(Core.views.inboxRows(m, { q: q }));
  assert.deepEqual(find('trxbbb'), ['TRXBBB222'], 'transaction id, any case');
  assert.deepEqual(find('  TRXAAA111 '), ['TRXAAA111'], 'surrounding spaces are ignored');
  assert.deepEqual(find('rahim'), ['TRXBBB222'], 'counterparty');
  assert.deepEqual(find('nfx-01'), ['TRXCCC333'], 'reference');
  assert.deepEqual(find('01756'), ['TRXAAA111'], 'part of a sender number');
  assert.deepEqual(find('8801 7569'), ['TRXAAA111'], 'a sender number typed with a space: matched on its digits');
  assert.deepEqual(find('290'), ['TRXAAA111'], 'amount');
  assert.deepEqual(find('1,250'), ['TRXBBB222'], 'amount with a thousands separator');
  assert.deepEqual(find('৳1250'), ['TRXBBB222'], 'amount with the taka sign');
  assert.deepEqual(find('zzz'), []);
  assert.deepEqual(find('29'), [], 'a part of an amount is not an amount: 29 is not 290');
});

test('inbox limit: at most 300 rows, the true match count and a truncated flag', () => {
  const many = [];
  for (let i = 0; i < 320; i++) many.push(row({ Transaction_ID: 'BULK' + String(i).padStart(4, '0'), Received: '2026-10-' + String(1 + (i % 18)).padStart(2, '0') + ' 10:00', Status: i % 2 ? 'Matched' : 'Ignored' }));
  const m = stateWith(many);
  const res = Core.views.inboxRows(m);
  assert.equal(res.rows.length, 300);
  assert.equal(res.truncated, true);
  assert.equal(res.matching, 320);
  assert.equal(res.counts.total, 320, 'counts cover the whole window, not the 300 shown');
  const pending = Core.views.inboxRows(m, { status: 'Matched' });
  assert.equal(pending.matching, 160);
  assert.equal(pending.truncated, false);
});

test('inbox is pure: it does not change the state it reads', () => {
  const m = stateWith([row({ Transaction_ID: 'X1', Status: 'Pending' })]);
  const before = JSON.stringify(m);
  Core.views.inboxRows(m, { status: 'Pending', q: 'x' });
  assert.equal(JSON.stringify(m), before);
});

test('inbox over the seeded fixture: counts add up to the rows', () => {
  const m = makeMigratedState();
  const res = Core.views.inboxRows(m, { days: 365 });
  const sum = ['Pending', 'Review', 'Matched', 'Auto-matched', 'Ignored'].reduce((a, s) => a + res.counts[s], 0);
  assert.equal(sum, res.counts.total);
  assert.equal(res.matching, res.counts.total);
});
