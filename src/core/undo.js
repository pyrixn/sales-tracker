/** Core.undo: turns the newest Change_Log batch into the ops that reverse it, refusing if anything changed since. */
var Core = Core || {};
Core.undo = (function () {
  var KEYS = { Customers: 'Customer_ID', Sales_Log: 'Sale_ID', Payments: 'Payment_ID', Expenses: 'Expense_ID', Purchases: 'Purchase_ID',
               Accounts: 'Account_ID', Wallets: 'Wallet_ID', Product_Catalog: 'Product_ID', Code_Inventory: 'Code_ID',
               Payment_Inbox: 'Transaction_ID', Settings: 'Key', Reminders_Log: 'Sale_ID', Suppliers: 'Supplier_ID',
               Pay_Requests: 'Request_ID', Deliveries: 'Delivery_ID',
               Orders: 'Order_ID', Goals: 'Goal_ID', Budgets: 'Budget_ID', Import_Rows: 'Row_ID' };
  function same(a, b) {
    var x = a === null || a === undefined ? '' : a, y = b === null || b === undefined ? '' : b;
    if (x === '' || y === '') return x === y;
    return String(x) === String(y) || (isFinite(Number(x)) && isFinite(Number(y)) && Number(x) === Number(y));
  }

  /** getCurrent(tab, rowKey, field) -> the cell's value now (dates as ISO strings). */
  function planUndo(batch, getCurrent) {
    if (!batch || !batch.lines || !batch.lines.length) return { ops: [], errors: ['Nothing to undo.'], result: null };
    var updates = {}, order = [], ops = [], deleted = {};
    for (var m = 0; m < batch.lines.length; m++) {
      if (batch.lines[m].Field === '(deleted row)') deleted[batch.lines[m].Tab + '|' + batch.lines[m].Row_Key] = true;
    }
    for (var i = 0; i < batch.lines.length; i++) {
      var l = batch.lines[i];
      var dk = l.Tab + '|' + l.Row_Key;
      if (deleted[dk]) {
        // Deleted row: rebuild it from the Old values, but only if nothing took its key since.
        if (!updates[dk]) {
          var now = getCurrent(l.Tab, l.Row_Key, KEYS[l.Tab]);
          if (now !== undefined && now !== null && now !== '') {
            return { ops: [], errors: ["Can't undo: " + l.Tab + ' ' + l.Row_Key + ' was changed after that action.'], result: null };
          }
          var vals = {}; vals[KEYS[l.Tab]] = l.Row_Key;
          updates[dk] = { op: 'append', tab: l.Tab, values: vals }; order.push({ ref: dk });
        }
        if (l.Field !== '(deleted row)') updates[dk].values[l.Field] = l.Old === null || l.Old === undefined ? '' : l.Old;
        continue;
      }
      if (l.Field === '(new row)') { order.push({ clear: true, tab: l.Tab, id: l.Row_Key }); continue; }
      if (!same(getCurrent(l.Tab, l.Row_Key, l.Field), l.New)) {
        return { ops: [], errors: ["Can't undo: " + l.Tab + ' ' + l.Row_Key + ' was changed after that action.'], result: null };
      }
      var k = l.Tab + '|' + l.Row_Key;
      if (!updates[k]) { updates[k] = { op: 'update', tab: l.Tab, key: KEYS[l.Tab], id: l.Row_Key, values: {} }; order.push({ ref: k }); }
      updates[k].values[l.Field] = l.Old === null || l.Old === undefined ? '' : l.Old;
    }
    for (var j = order.length - 1; j >= 0; j--) {
      var o = order[j];
      ops.push(o.clear ? { op: 'clear', tab: o.tab, key: KEYS[o.tab], id: o.id } : updates[o.ref]);
    }
    return { ops: ops, errors: [], result: { batchId: batch.batchId, action: batch.lines[0].Action } };
  }

  return { planUndo: planUndo, KEYS: KEYS };
})();
if (typeof module !== 'undefined') module.exports = Core.undo;
