// The customer portal (GET /portal/<pay token>). portalHtml_(data) returns the whole document: server-rendered, no script, no
// external assets. The CSP below allows inline styles only, so nothing a page could load can run.
// Bundled ahead of edge.js (after pay-page.js), so it is a plain top-level function in the same scope.
//
// data: { lang, customerName, lines: [{ product, paidTill, daysLeft, owes, payUrl }], owes, payments: [{ date, amount, method }],
//         payUrl, receiverName, receiverLast4 }
//   lines are the customer's active subscriptions only; payUrl on a line is the pay page for that line when it owes money.
//   payments are the customer's own payment rows, newest first; the portal never shows costs, suppliers or other customers.

var PORTAL_CSP_ = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

var PORTAL_TEXT_ = {
  en: {
    title: 'Your subscriptions', lead: 'Hi {name}. Here is where your subscriptions stand.', owed: 'Amount owed', none: 'Nothing owed',
    next: 'Next renewal', noNext: 'No renewal date', pay: 'Pay now', payOpen: 'Open payment page', lines: 'Subscriptions',
    noLines: 'No active subscriptions.', paidTill: 'Paid till', st_active: 'Active', st_soon: 'Renews soon', st_expired: 'Expired',
    owesLine: 'Owes', history: 'Payment history', noHistory: 'No payments yet.', date: 'Date', amount: 'Amount', method: 'Method',
    trustTitle: 'Keep your money safe', trustPin: 'We never ask for your PIN or OTP.', trustOnly: 'Only enter your PIN inside the bKash app.',
    trustName: 'The confirm screen should show: {name}, number ending {last4}.', trustLast4: 'The confirm screen should show number ending {last4}.',
    footer: 'Read only. Use the payment link we sent you to pay.', pageTitle: 'Your subscriptions', noJs: 'This page needs no JavaScript.'
  },
  bn: {
    title: 'আপনার সাবস্ক্রিপশন', lead: 'হাই {name}। আপনার সাবস্ক্রিপশনের অবস্থা এখানে দেখুন।', owed: 'বাকি আছে', none: 'কোনো বাকি নেই',
    next: 'পরবর্তী রিনিউয়াল', noNext: 'রিনিউয়ালের তারিখ নেই', pay: 'এখন পেমেন্ট করুন', payOpen: 'পেমেন্ট পেজ খুলুন', lines: 'সাবস্ক্রিপশন',
    noLines: 'কোনো চালু সাবস্ক্রিপশন নেই।', paidTill: 'মেয়াদ', st_active: 'চালু', st_soon: 'শীঘ্রই রিনিউ', st_expired: 'মেয়াদ শেষ',
    owesLine: 'বাকি', history: 'পেমেন্টের ইতিহাস', noHistory: 'এখনও কোনো পেমেন্ট নেই।', date: 'তারিখ', amount: 'পরিমাণ', method: 'মাধ্যম',
    trustTitle: 'আপনার টাকা নিরাপদ রাখুন', trustPin: 'আমরা কখনো আপনার PIN বা OTP চাই না।', trustOnly: 'শুধু বিকাশ অ্যাপের ভেতরে PIN লিখুন।',
    trustName: 'কনফার্ম স্ক্রিনে দেখাবে: {name}, নম্বর শেষ {last4}।', trustLast4: 'কনফার্ম স্ক্রিনে দেখাবে নম্বর শেষ {last4}।',
    footer: 'শুধু দেখার জন্য। পেমেন্ট করতে আমাদের পাঠানো লিংক ব্যবহার করুন।', pageTitle: 'আপনার সাবস্ক্রিপশন', noJs: 'এই পেজে JavaScript লাগে না।'
  }
};

/** The status word and its colour class for one line. A line with no end date is shown as active. */
function portalStatus_(t, daysLeft) {
  if (daysLeft === null || daysLeft === undefined || daysLeft === '') return { word: t.st_active, cls: 'ok' };
  var d = Number(daysLeft);
  if (d < 0) return { word: t.st_expired, cls: 'bad' };
  if (d <= 3) return { word: t.st_soon, cls: 'warn' };
  return { word: t.st_active, cls: 'ok' };
}

function portalHtml_(data) {
  var lang = data.lang === 'bn' ? 'bn' : 'en', t = PORTAL_TEXT_[lang];
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // Raw on purpose: every caller escapes the whole line once, after filling it.
  var fill = function (s, vars) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return vars[k] === undefined ? '' : String(vars[k]); }); };
  var money = function (n) { return Core.reminders.money(Number(n) || 0); };
  var lines = data.lines || [], payments = data.payments || [];
  var owed = Math.round((Number(data.owes) || 0) * 100) / 100;
  var nextRenewal = lines.map(function (l) { return l.paidTill; }).filter(Boolean).sort()[0] || '';
  var name = data.customerName ? String(data.customerName) : '';
  var lineHtml = lines.length ? lines.map(function (l) {
    var st = portalStatus_(t, l.daysLeft);
    return '<li><div class="ln"><b>' + esc(l.product) + '</b><span class="st ' + st.cls + '">' + esc(st.word) + '</span></div>' +
      '<div class="meta">' + esc(t.paidTill) + ' ' + esc(l.paidTill || '-') + (Number(l.owes) > 0 ? ' · <span class="owe">' + esc(t.owesLine) + ' ' + esc(money(l.owes)) + '</span>' : '') +
      (Number(l.owes) > 0 && l.payUrl ? '<a class="mini" href="' + esc(l.payUrl) + '">' + esc(t.pay) + '</a>' : '') + '</div></li>';
  }).join('') : '<li class="empty">' + esc(t.noLines) + '</li>';
  var payHtml = payments.length ? '<table><thead><tr><th>' + esc(t.date) + '</th><th>' + esc(t.amount) + '</th><th>' + esc(t.method) + '</th></tr></thead><tbody>' +
    payments.map(function (p) { return '<tr><td>' + esc(p.date || '-') + '</td><td>' + esc(money(p.amount)) + '</td><td>' + esc(p.method || '-') + '</td></tr>'; }).join('') +
    '</tbody></table>' : '<p class="hint">' + esc(t.noHistory) + '</p>';
  var trust = '<p>' + esc(t.trustPin) + '</p><p>' + esc(t.trustOnly) + '</p>' +
    (data.receiverLast4 ? '<p>' + esc(data.receiverName ? fill(t.trustName, { name: data.receiverName, last4: data.receiverLast4 }) : fill(t.trustLast4, { last4: data.receiverLast4 })) + '</p>' : '');
  var payBtn = data.payUrl ? '<a class="btn" href="' + esc(data.payUrl) + '">' + esc(owed > 0 ? t.pay : t.payOpen) + '</a>' : '';
  var css =
    ':root{color-scheme:light dark;--bg:#f3f1ec;--card:#fff;--ink:#16171c;--mut:#5c6070;--line:#e4e2dc;--ok:#0f7b4a;--okbg:#e2f5ea;--warn:#8a5a06;--warnbg:#fff3d6;--bad:#b3261e;--badbg:#fdeceb;--b:#16171c;--bi:#fff;--soft:#f6f5f1;' +
    '--fd:"Iowan Old Style",Georgia,"Noto Serif Bengali",serif;--fb:-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif}' +
    '@media(prefers-color-scheme:dark){:root{--bg:#0d0e12;--card:#16181f;--ink:#f1f1f4;--mut:#a0a4b2;--line:#2a2d38;--ok:#5ee0a0;--okbg:#0f2f21;--warn:#f5bd45;--warnbg:#33260a;--bad:#ff8a80;--badbg:#3a1614;--b:#f1f1f4;--bi:#16171c;--soft:#1d2029}}' +
    '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--fb);line-height:1.45;padding:14px 14px 28px;display:flex;justify-content:center}' +
    'main{width:100%;max-width:440px;display:grid;gap:12px;align-content:start}' +
    '.card{background:var(--card);border-radius:20px;box-shadow:0 1px 2px rgba(20,22,30,.06),0 14px 36px rgba(20,22,30,.1);overflow:hidden;padding:18px 18px 20px}' +
    'h1{margin:0;font-family:var(--fd);font-size:22px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}h2{margin:0 0 8px;font-family:var(--fd);font-size:18px;font-weight:600}' +
    '.lead{margin:4px 0 0;font-size:14px;color:var(--mut);overflow-wrap:anywhere}.sum{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}' +
    '.sum div{background:var(--soft);border-radius:14px;padding:12px}.sum span{display:block;font-size:12px;color:var(--mut)}.sum b{display:block;font-size:20px;margin-top:2px;overflow-wrap:anywhere}' +
    'ul{list-style:none;margin:0;padding:0}li{padding:12px 0;border-top:1px solid var(--line)}li:first-child{border-top:0;padding-top:0}li.empty{color:var(--mut)}' +
    '.ln{display:flex;justify-content:space-between;gap:10px;align-items:center}.ln b{overflow-wrap:anywhere}.meta{margin-top:4px;font-size:13px;color:var(--mut);display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.st{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}.st.ok{background:var(--okbg);color:var(--ok)}.st.warn{background:var(--warnbg);color:var(--warn)}.st.bad{background:var(--badbg);color:var(--bad)}' +
    '.owe{color:var(--bad);font-weight:700}.mini{margin-left:auto;font-size:13px;font-weight:700;color:var(--b);text-decoration:underline;text-underline-offset:3px}' +
    '.btn{display:block;text-align:center;margin-top:14px;padding:14px 16px;border-radius:12px;background:var(--b);color:var(--bi);font-size:16px;font-weight:800;text-decoration:none;min-height:48px}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 4px;border-top:1px solid var(--line)}th{font-size:12px;color:var(--mut);font-weight:600;border-top:0}' +
    '.hint{font-size:14px;color:var(--mut);margin:0}.trust{background:var(--soft);font-size:14px}.trust p{margin:0 0 6px}.trust p:last-child{margin:0}.trust h2{font-size:16px}' +
    '.foot{font-size:12px;color:var(--mut);text-align:center;padding:0 8px}' +
    '@media(prefers-reduced-motion:reduce){*{transition:none!important}}';
  return '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>' + esc(t.pageTitle) + '</title><style>' + css + '</style></head><body>' +
    '<main>' +
    '<section class="card"><h1>' + esc(t.title) + '</h1>' + (name ? '<p class="lead">' + esc(fill(t.lead, { name: name })) + '</p>' : '') +
    '<div class="sum"><div><span>' + esc(t.owed) + '</span><b>' + esc(owed > 0 ? money(owed) : t.none) + '</b></div>' +
    '<div><span>' + esc(t.next) + '</span><b>' + esc(nextRenewal || t.noNext) + '</b></div></div>' + payBtn + '</section>' +
    '<section class="card"><h2>' + esc(t.lines) + '</h2><ul>' + lineHtml + '</ul></section>' +
    '<section class="card"><h2>' + esc(t.history) + '</h2>' + payHtml + '</section>' +
    '<section class="card trust"><h2>' + esc(t.trustTitle) + '</h2>' + trust + '</section>' +
    '<p class="foot">' + esc(t.footer) + '</p>' +
    '</main></body></html>';
}
