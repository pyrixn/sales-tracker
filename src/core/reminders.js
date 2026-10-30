/** Core.reminders: which customers to remind today, the message text, and the one-tap link for their channel. */
var Core = Core || {};
Core.reminders = (function () {
  function renderTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(name|product|date|price|bkash|ref|link|profile|days|balance|status|nolink|months|amount)\}/g, function (_, k) { return k === 'nolink' || vars[k] === undefined ? '' : String(vars[k]); });
  }

  /** Built-in templates, used when the setting and product template are blank. A blank {profile} and a blank {link} remove their
   *  part of the text (buildMessage); the reference line is always there. Owners see these after Reset to default (see HANDOVER 15). */
  var DEFAULTS = {
    renew: {
      en: 'Hi {name}, your {product} {profile} subscription needs renewing for {months}, amount {amount}.\nYou can pay here: {link}\nOr send {amount} by bKash Send Money to {bkash} and write this payment reference: {ref}\nYour current plan ends on {date} ({status}). Thank you!',
      bn: 'হাই {name}, আপনার {product} {profile} সাবস্ক্রিপশন {months} রিনিউ করতে হবে, পরিমাণ {amount}।\nএখানে পেমেন্ট করুন: {link}\nঅথবা {bkash} নম্বরে বিকাশ সেন্ড মানি করে {amount} পাঠান এবং রেফারেন্সে লিখুন: {ref}\nবর্তমান মেয়াদ {date} তারিখে শেষ হবে ({status})। ধন্যবাদ!'
    },
    due: {
      en: 'Hi {name}, {balance} is still due for your {product} {profile} subscription.\nYou can pay here: {link}\nOr send {balance} by bKash Send Money to {bkash} and write this payment reference: {ref}\nThank you!',
      bn: 'হাই {name}, আপনার {product} {profile} সাবস্ক্রিপশনের {balance} এখনও বাকি আছে।\nএখানে পেমেন্ট করুন: {link}\nঅথবা {bkash} নম্বরে বিকাশ সেন্ড মানি করে পাঠান এবং রেফারেন্সে লিখুন: {ref}\nধন্যবাদ!'
    }
  };
  var PAY_LABEL = { en: 'Pay: ', bn: 'পেমেন্ট: ' };
  /** A product renewing every 1 to 3 days (rent) gets no "before" reminder: it would fire the day before every short line ends. */
  var SHORT_CYCLE_DAYS = 3;

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

  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /** One reminder message for a sale. kind: before|on_day|after|due. opts: {lang, template, amount, paid}. Never exposes account logins. */
  function buildMessage(state, sale, kind, opts) {
    opts = opts || {};
    var st = state.settings || {};
    var lang = opts.lang ? (opts.lang === 'bn' ? 'bn' : 'en') : (st.language === 'bn' ? 'bn' : 'en');
    var c = null, p = null;
    (state.customers || []).forEach(function (x) { if (x.Customer_ID === sale.Customer_ID) c = x; });
    (state.products || []).forEach(function (x) { if (x.Product_ID === sale.Product_ID) p = x; });
    c = c || { Name: sale.Customer }; p = p || {};
    var paid = opts.paid || Core.ledger.paidMap(state);
    var balance = Core.ledger.saleBalance(sale, state, paid);
    var isDue = kind === 'due', tType = isDue ? 'due' : 'renew';
    var amount = opts.amount !== undefined ? opts.amount : (isDue ? balance : Core.ledger.salePrice(sale, state.products));
    var tpl = opts.template;
    var isDefault = false;
    if (tpl === undefined || tpl === null) {
      tpl = (sale.Product_ID && st['msg_' + tType + '_' + sale.Product_ID + '_' + lang]) ||
            (sale.Product_ID && p['Template_' + (isDue ? 'Due' : 'Renew')]) ||
            st['msg_' + tType + '_' + lang] || '';
      if (!tpl) { tpl = DEFAULTS[tType][lang]; isDefault = true; }
    }
    var profile = String(sale.Contact || '').trim();
    var days = '', status = '';
    if (sale.Paid_Till) {
      var d = Core.util.daysBetween(state.today, sale.Paid_Till);
      days = String(Math.abs(d));
      status = d > 0 ? 'expires in ' + plural(d, 'day') : d === 0 ? 'expires today' : 'expired ' + plural(-d, 'day') + ' ago';
    }
    if (isDue) status = 'owes ' + money(balance);
    var base = String(st.pay_base_url || '').replace(/\/+$/, '');
    var link = base && sale.Pay_Token ? base + '/pay/' + encodeURIComponent(sale.Pay_Token) : '';
    // {months}: renew uses the months being renewed (1 unless given); due uses the months the line was sold for.
    var count = isDue ? (Number(sale.Months) || 1) : (Number(opts.months) || 1);
    var cyc = Number(p.Billing_Cycle_Days) || 30;
    var unit = cyc >= 1 && cyc <= SHORT_CYCLE_DAYS ? 'day' : 'month';
    var periodText = lang === 'bn' ? count + ' ' + (unit === 'day' ? 'দিন' : 'মাস') : plural(count, unit);
    var vars = { name: c.Name, product: p.Product_Name || sale.Product_ID, date: sale.Paid_Till || '', price: money(amount),
      amount: money(amount), months: periodText,
      bkash: st.bkash_number || '', ref: sale.Sub_Code || '', link: link, profile: profile, days: days,
      balance: money(balance), status: status };
    if (isDefault) {
      if (!profile) tpl = tpl.replace(/\s*\(\{profile\}\)/g, '').replace(/\s*\{profile\}/g, '');
      if (!link) tpl = tpl.split('\n').filter(function (line) { return line.indexOf('{link}') < 0; }).join('\n');
    }
    var noLink = tpl.indexOf('{nolink}') >= 0;
    var message = renderTemplate(tpl, vars);
    if (noLink) message = message.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
    else if (link && tpl.indexOf('{link}') < 0) message = message.replace(/\s+$/, '') + '\n' + PAY_LABEL[lang] + link;
    var ch = c.Channel || '';
    var url = ch === 'WhatsApp' ? waLink(c.Handle, message) : ch === 'Messenger' ? messengerLink(c.Handle) : '';
    return { message: message, link: url, channel: ch, lang: lang, template: tpl, vars: vars };
  }

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
    var gone = {};
    (state.accounts || []).forEach(function (a) { if (a.Account_Status === 'Deleted') gone[a.Account_ID] = true; });
    var paid = Core.ledger.paidMap(state), out = [];

    function item(s, kind, amount) {
      var c = cust[s.Customer_ID] || { Name: s.Customer }, p = prod[s.Product_ID] || {};
      var r = buildMessage(state, s, kind, { amount: amount, paid: paid, lang: lang });
      out.push({ saleId: s.Sale_ID, customerId: s.Customer_ID, name: c.Name, kind: kind, channel: r.channel, handle: c.Handle || '',
                 productName: p.Product_Name || s.Product_ID, subCode: s.Sub_Code || '', amount: amount, message: r.message, link: r.link,
                 lang: r.lang, template: r.template });
    }

    (state.sales || []).forEach(function (s) {
      var c = cust[s.Customer_ID];
      if (!c || /^Unlogged payment/.test(c.Name)) return;
      if (Core.ledger.isCustom(s)) return;
      var balance = Core.ledger.saleBalance(s, state, paid);
      if (s.Record_Status === 'Active' && s.Paid_Till && !gone[s.Account_ID] && Core.sales.deliversAs(prod[s.Product_ID]) !== 'code') {
        var d = Core.util.daysBetween(state.today, s.Paid_Till);
        var cyc = Number((prod[s.Product_ID] || {}).Billing_Cycle_Days) || 0;
        var shortCycle = cyc >= 1 && cyc <= SHORT_CYCLE_DAYS;
        var kind = d >= 1 && d <= before ? (shortCycle ? null : 'before') : d === 0 ? 'on_day' : (d <= -1 && d >= -after ? 'after' : null);
        if (kind && !done[s.Sale_ID + '|' + kind]) item(s, kind, Core.ledger.salePrice(s, state.products));
      }
      if (balance > 0 && !Core.ledger.isVoided(s)) {
        var last = lastDue[s.Sale_ID];
        if (!last || Core.util.daysBetween(last, state.today) >= every) item(s, 'due', balance);
      }
    });
    var rank = { on_day: 0, after: 1, before: 2, due: 3 };
    out.sort(function (a, b) { return rank[a.kind] - rank[b.kind] || a.saleId - b.saleId; });
    return out;
  }

  return { renderTemplate: renderTemplate, waLink: waLink, messengerLink: messengerLink, planReminders: planReminders, buildMessage: buildMessage, DEFAULTS: DEFAULTS, money: money };
})();
if (typeof module !== 'undefined') module.exports = Core.reminders;
