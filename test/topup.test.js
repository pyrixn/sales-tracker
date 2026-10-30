const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

// The exact SMS shapes the owner sees for his own wallet top-ups (bKash).
const CASH_IN = 'Cash In Tk 500.00 from 01XXXXXXXXX successful. Fee Tk 0.00. Balance Tk 517.07. TrxID 8F3K2L9Q1A at 20/10/2026 10:15';
const IBANKING = 'You have received deposit from iBanking of Tk 50.00 from Prime Bank. Fee Tk 0.00. Balance Tk 567.07. TrxID 9G4H7J2M5N at 21/10/2026 11:20';
const CUSTOMER = 'You have received Tk 50.00 from 01756999991. Ref N44. TrxID CUST000001 at 21/10/2026 12:00';

const row = (o) => Object.assign({ Received: '2026-10-20 10:15', Type: 'Received', Sender: '16247', Counterparty: '', Amount: 500,
  Transaction_ID: 'TX', Reference: '', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: '' }, o);

test('isTopUpSms recognises the two wallet top-up shapes and nothing else', () => {
  assert.equal(Core.matching.isTopUpSms(IBANKING), true);
  assert.equal(Core.matching.isTopUpSms(CASH_IN), false, 'a bKash cash-in can be a customer paying in cash');
  assert.equal(Core.matching.isTopUpSms(CUSTOMER), false, 'a customer payment is not a top-up');
  assert.equal(Core.matching.isTopUpSms('Cash In Received.\nAmount: Tk 500.00\nUddokta: 01898765432\nTxnID: NGD8P9Q0R1'), false, 'a Nagad cash-in from a customer stays a payment');
  assert.equal(Core.matching.isTopUpSms(''), false);
});

test('rowType reads a stored top-up as TopUp and leaves customer payments as Received', () => {
  assert.equal(Core.matching.rowType(row({ Raw_SMS: CASH_IN })), 'Received', 'a cash-in stays a customer payment');
  assert.equal(Core.matching.rowType(row({ Raw_SMS: IBANKING })), 'TopUp');
  assert.equal(Core.matching.rowType(row({ Type: 'TopUp', Raw_SMS: '' })), 'TopUp');
  assert.equal(Core.matching.rowType(row({ Raw_SMS: CUSTOMER })), 'Received');
  assert.equal(Core.matching.rowType(row({ Type: 'Unrecognised', Raw_SMS: CASH_IN })), 'Unrecognised');
});

test('a top-up is never matched, automatically or by hand', () => {
  const m = makeMigratedState();
  const auto = Core.matching.planInboxMatch(m, row({ Raw_SMS: IBANKING, Reference: 'N44', Transaction_ID: 'TXA' }));
  assert.equal(auto.status, 'pending'); assert.equal(auto.ops.length, 0);
  assert.match(auto.result.note, /Wallet top-up/);
  const manual = Core.matching.planInboxMatch(m, row({ Raw_SMS: IBANKING, Transaction_ID: 'TXB' }), { customerId: 'C-1' });
  assert.equal(manual.ops.length, 0);
  assert.ok(manual.errors.length === 1 && /top-up/.test(manual.errors[0]));
});

test('a normal received payment is still a customer payment', () => {
  const m = makeMigratedState();
  const x = Core.matching.planInboxMatch(m, row({ Raw_SMS: CUSTOMER, Reference: 'N44', Sender: '16247', Transaction_ID: 'CUST000001', Amount: 580 }));
  assert.equal(x.status, 'auto');
  const cashIn = Core.matching.planInboxMatch(m, row({ Raw_SMS: CASH_IN, Reference: 'N44', Transaction_ID: '8F3K2L9Q1A', Amount: 500 }));
  assert.notEqual(cashIn.result && cashIn.result.note, 'Wallet top-up. Not a customer payment.', 'a cash-in is never read as a top-up');
});

test('home lists top-ups apart from payments not matched', () => {
  const m = makeMigratedState();
  m.inbox = [row({ Transaction_ID: '9G4H7J2M5N', Raw_SMS: IBANKING, Amount: 50 }), row({ Transaction_ID: 'CUST000001', Raw_SMS: CUSTOMER, Received: '2026-10-21 12:00', Amount: 50 }),
    row({ Transaction_ID: '8F3K2L9Q1A', Raw_SMS: CASH_IN, Amount: 500 })];
  const h = Core.views.homeData(m);
  assert.deepEqual(h.unmatched.map(u => u.trx).sort(), ['8F3K2L9Q1A', 'CUST000001'], 'a cash-in is a pending customer payment');
  assert.deepEqual(h.topUps.map(u => [u.trx, u.amount]), [['9G4H7J2M5N', 50]]);
});

test('ignoring a top-up with topUp marks it Ignored and reports the wallet top-up note', () => {
  const m = makeMigratedState();
  m.inbox = [row({ Transaction_ID: '9G4H7J2M5N', Raw_SMS: IBANKING })];
  const x = Core.sales.planIgnoreInbox(m, { trx: '9G4H7J2M5N', topUp: true });
  assert.deepEqual(x.errors, []);
  assert.deepEqual(x.ops, [{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: '9G4H7J2M5N', values: { Status: 'Ignored' } }]);
  assert.equal(x.result.note, 'Wallet top-up');
});

test('the topUp flag is refused for a row that is not a wallet top-up', () => {
  const m = makeMigratedState();
  m.inbox = [row({ Transaction_ID: 'CUST000001', Raw_SMS: CUSTOMER })];
  const x = Core.sales.planIgnoreInbox(m, { trx: 'CUST000001', topUp: true });
  assert.ok(x.errors.length === 1);
  assert.equal(x.ops.length, 0);
});

test('paylinks do not count a top-up as a payment from the payer', () => {
  const intent = { Payer_Number: '01756999991', Created: '2026-10-01' };
  const topUp = row({ Transaction_ID: 'TOP', Raw_SMS: IBANKING, Counterparty: '01756999991', Amount: 500, Received: '2026-10-20 10:15' });
  const cust = row({ Transaction_ID: 'CUST', Raw_SMS: CUSTOMER, Counterparty: '01756999991', Amount: 500, Received: '2026-10-20 10:15' });
  assert.deepEqual(Core.paylinks.paymentsFor([topUp], '', 500, intent), []);
  assert.deepEqual(Core.paylinks.paymentsFor([cust], '', 500, intent).map(r => r.Transaction_ID), ['CUST']);
});

test('relay stores a top-up as type TopUp and never auto-matches it (bKash SMS shapes)', async () => {
  const { db, tables } = makeFakeDb();
  const state = makeUiState();
  await seedDb(db, tables, state);
  const edge = loadEdge(db, { env: {} });
  const r1 = await edge.relayIngest({ sender: '16247', text: IBANKING }, 'bkash');
  assert.equal(r1.result, 'stored');
  assert.equal(r1.type, 'TopUp');
  assert.equal(r1.matched, false);
  assert.equal(tables.payment_inbox.get('9G4H7J2M5N').status, 'Pending');
  assert.equal(tables.payment_inbox.get('9G4H7J2M5N').type, 'TopUp');
  const r2 = await edge.relayIngest({ sender: '16247', text: CASH_IN }, 'bkash');
  assert.equal(r2.type, 'Received', 'a bKash cash-in is a customer payment');
  assert.equal(tables.payment_inbox.get('8F3K2L9Q1A').type, 'Received');
});
