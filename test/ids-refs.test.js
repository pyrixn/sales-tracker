const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

test('IdGen hands out consecutive ids after the current maximum', () => {
  const g = Core.ids.IdGen(makeState());
  assert.equal(g.sale(), 103);
  assert.equal(g.sale(), 104);
  assert.equal(g.customer(), 'CU-0001');
  assert.equal(g.customer(), 'CU-0002');
  assert.equal(g.payment(), 'PM-00001');
  assert.equal(g.expense(), 'EX-0001');
  assert.equal(g.purchase(), 'P-0018');
  assert.equal(g.code(), 'C-0031');
});

test('IdGen sub codes use one global number across letters', () => {
  const s = makeState();
  s.sales[0].Sub_Code = 'E7'; s.sales[1].Sub_Code = 'N12';
  const g = Core.ids.IdGen(s);
  assert.equal(g.subCode('S'), 'S13');
  assert.equal(g.subCode('N'), 'N14');
});

test('normalizeRef accepts loose spellings and rejects non-codes', () => {
  const { normalizeRef } = Core.refs;
  assert.equal(normalizeRef('N44'), 'N44');
  assert.equal(normalizeRef('n44 netflix'), 'N44');
  assert.equal(normalizeRef('N-44'), 'N44');
  assert.equal(normalizeRef('ref N 44'), 'N44');
  assert.equal(normalizeRef('netflix'), null);
  assert.equal(normalizeRef('Tk 500'), null);
  assert.equal(normalizeRef(''), null);
  assert.equal(normalizeRef(undefined), null);
});

test('findRef reads the Reference column, then the raw SMS', () => {
  const { findRef } = Core.refs;
  assert.equal(findRef({ Reference: 'n44', Raw_SMS: '' }), 'N44');
  assert.equal(findRef({ Reference: '', Raw_SMS: 'You have received Tk 290.00 from 01711111111. Ref N44. Fee Tk 0.00. TrxID X1' }), 'N44');
  assert.equal(findRef({ Reference: '', Raw_SMS: 'You have received Tk 290.00 from 01711111111. Fee Tk 0.00. TrxID X1' }), null);
});

test('subCodeLine returns the newest Active row of a line', () => {
  const s = makeState();
  s.sales[43].Sub_Code = 'N44'; s.sales[43].Record_Status = 'Renewed';      // Sale 44
  s.sales.push(Object.assign({}, s.sales[43], { Sale_ID: 103, Record_Status: 'Active' }));
  const line = Core.refs.subCodeLine(s, 'N44');
  assert.equal(line.latest.Sale_ID, 103);
  assert.equal(line.rows.length, 2);
  s.sales[102].Record_Status = 'Void';
  assert.equal(Core.refs.subCodeLine(s, 'N44').latest, null);
});
