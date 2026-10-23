/** Core.reminders: which customers to remind today, the message text, and the one-tap link for their channel. */
var Core = Core || {};
Core.reminders = (function () {
  function renderTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(name|product|date|price|bkash|ref|link)\}/g, function (_, k) { return vars[k] === undefined ? '' : String(vars[k]); });
  }

  function waLink(phone, text) {
    var d = String(phone || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 11 && d.indexOf('01') === 0) d = '880' + d.slice(1);
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
  }

  function messengerLink(handle) {
    var h = String(handle || '').trim().replace(/^https?:\/\/(www\.|m\.)?(facebook\.com|fb\.com|m\.me)\//i, '').replace(/\/$/, '');
    return h ? 'https://m.me/' + h : '';
  }

  function money(n) { var v = Math.round(Number(n) * 100) / 100; return '৳' + (v % 1 ? v.toFixed(2) : String(v)); }

  function planReminders(state) {
    var st = state.settings || {}, lang = st.language === 'bn' ? 'bn' : 'en';
    var before = Number(st.reminder_days_before) || 3, after = Number(st.reminder_days_after) || 2, every = Number(st.due_reminder_every_days) || 5;
    var done = {}, lastDue = {};
    (state.remindersLog || []).forEach(function (l) {
      if (l.Status !== 'sent' && l.Status !== 'skipped') return;
      done[l.Sale_ID + '|' + l.Kind] = true;
      if (l.Kind === 'due' && (!lastDue[l.Sale_ID] || l.Date > lastDue[l.Sale_ID])) lastDue[l.Sale_ID] = l.Date;
    });
    var cust = {}, prod = {};
    (state.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    (state.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    var paid = Core.ledger.paidMap(state), out = [];

    function item(s, kind, amount) {
      var c = cust[s.Customer_ID] || { Name: s.Customer }, p = prod[s.Product_ID] || {};
      var tType = kind === 'due' ? 'due' : 'renew';
      var tpl = (s.Product_ID && st['msg_' + tType + '_' + s.Product_ID + '_' + lang]) ||
                (s.Product_ID && p['Template_' + (kind === 'due' ? 'Due' : 'Renew')]) ||
                st['msg_' + tType + '_' + lang] || '';
      var base = String(st.pay_base_url || '').replace(/\/+$/, '');
      var message = renderTemplate(tpl, { name: c.Name, product: p.Product_Name || s.Product_ID, date: s.Paid_Till || '',
        price: money(amount), bkash: st.bkash_number || '', ref: s.Sub_Code || '',
        link: base && s.Pay_Token ? base + '/pay/' + encodeURIComponent(s.Pay_Token) : '' });
      var ch = c.Channel || '';
      var link = ch === 'WhatsApp' ? waLink(c.Handle, message) : ch === 'Messenger' ? messengerLink(c.Handle) : '';
      out.push({ saleId: s.Sale_ID, customerId: s.Customer_ID, name: c.Name, kind: kind, channel: ch, handle: c.Handle || '',
                 productName: p.Product_Name || s.Product_ID, subCode: s.Sub_Code || '', amount: amount, message: message, link: link });
    }

    (state.sales || []).forEach(function (s) {
      var c = cust[s.Customer_ID];
      if (!c || /^Unlogged payment/.test(c.Name)) return;
      var balance = Core.util.round2(Core.ledger.saleRevenue(s, state.products) - (paid[s.Sale_ID] || 0));
      if (s.Record_Status === 'Active' && s.Paid_Till && (prod[s.Product_ID] || {}).Category !== 'Game Code') {
        var d = Core.util.daysBetween(state.today, s.Paid_Till);
        var kind = d >= 1 && d <= before ? 'before' : d === 0 ? 'on_day' : (d <= -1 && d >= -after ? 'after' : null);
        if (kind && !done[s.Sale_ID + '|' + kind]) item(s, kind, Core.ledger.salePrice(s, state.products));
      }
      if (balance > 0 && s.Record_Status !== 'Void' && s.Record_Status !== 'Refunded') {
        var last = lastDue[s.Sale_ID];
        if (!last || Core.util.daysBetween(last, state.today) >= every) item(s, 'due', balance);
      }
    });
    var rank = { on_day: 0, after: 1, before: 2, due: 3 };
    out.sort(function (a, b) { return rank[a.kind] - rank[b.kind] || a.saleId - b.saleId; });
    return out;
  }

  return { renderTemplate: renderTemplate, waLink: waLink, messengerLink: messengerLink, planReminders: planReminders, money: money };
})();
if (typeof module !== 'undefined') module.exports = Core.reminders;
