const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

// Now is fixed so the 6-hour window is deterministic.
const NOW = Date.parse('2026-10-25T10:00:00Z');
const at = (h) => new Date(NOW + h * 3600000).toISOString();
const pending = (trx, extra) => Object.assign({ Received: '2026-10-25 09:00', Type: 'Received', Sender: '16247', Amount: 300, Transaction_ID: trx,
  Reference: '', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'You have received Tk 300.00 from 01756999991. TrxID ' + trx }, extra || {});

test('attention counts: inbox payments exclude top-ups, pay links expire within 6 hours, deliveries Pending or Failed, budgets warn or over', () => {
  const m = makeMigratedState();
  m.nowMs = NOW;
  m.today = '2026-10-25';
  m.inbox = [pending('CUSTA'), pending('CUSTB', { Status: 'Review' }), pending('TOPUP1', { Raw_SMS: 'You have received deposit from iBanking of Tk 50.00 from Prime Bank. TrxID TOPUP1' })];
  m.payRequests = [
    { Request_ID: 'R1', Status: 'Open', Expires: at(2) },       // expires in 2h: counts
    { Request_ID: 'R2', Status: 'Open', Expires: at(7) },       // 7h: not yet
    { Request_ID: 'R3', Status: 'Open', Expires: at(-1) },      // already past: not "expiring", the sweep expires it
    { Request_ID: 'R4', Status: 'Paid', Expires: at(1) }        // not open
  ];
  m.deliveries = [{ Delivery_ID: 'D1', Status: 'Pending' }, { Delivery_ID: 'D2', Status: 'Failed' }, { Delivery_ID: 'D3', Status: 'Delivered' }];
  m.budgets = [
    { Budget_ID: 'B1', Category: 'Tools', Monthly_Limit: 1000, Alert_Pct: 80, Active: 'Yes' },
    { Budget_ID: 'B2', Category: 'Ads', Monthly_Limit: 100, Alert_Pct: 80, Active: 'No' }
  ];
  m.expenses = [{ Expense_ID: 'E1', Date: '2026-10-05', Category: 'Tools', Amount: 850, Paid_With: 'W1' }];
  const a = Core.views.homeData(m).attention;
  assert.deepEqual(a, { payments: 2, payLinks: 1, deliveries: 2, budgets: 1 });
});

test('attention counts are zero on a quiet state, so the strip can hide', () => {
  const m = makeMigratedState();
  m.nowMs = NOW; m.today = '2026-10-25'; m.inbox = []; m.payRequests = []; m.deliveries = []; m.budgets = [];
  assert.deepEqual(Core.views.homeData(m).attention, { payments: 0, payLinks: 0, deliveries: 0, budgets: 0 });
});
