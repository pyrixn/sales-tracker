import { num } from '@/lib/format';

// Pure form logic shared by the Settings screen (screens/Settings.jsx) and the Settings and Payment methods sheets (sheets/misc.jsx).
// A draft is the text the owner has typed; the *Values functions turn it into the payload of the 'settings' action and throw an
// Error with a readable message when it is not valid. Nothing here is domain logic: the server still validates every key.

// Settings with their own labelled fields in Business, Reminders and Rates. Every other key is listed under "All settings".
export const SETTINGS_FIELDS = ['bkash_number', 'pay_base_url', 'usdt_bdt_manual', 'language', 'reminder_days_before', 'reminder_days_after', 'due_reminder_every_days', 'grace_days'];
// Settings edited on Pay methods or Message templates, so they are not repeated under All settings.
export const PAY_METHOD_FIELDS = ['nagad_number', 'upay_number', 'pay_methods', 'pay_auto_verify', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_branch', 'bank_note', 'bank_routing', 'msg_renew_en', 'msg_renew_bn', 'msg_due_en', 'msg_due_bn',
  'tos_text', 'review_discord_url', 'review_facebook_url', 'pay_link_expiry_hours', 'delivery_note'];

export const METHOD_ROWS = [
  { id: 'bkash', label: 'bKash', key: 'bkash_number', hint: 'Send Money number' },
  { id: 'nagad', label: 'Nagad', key: 'nagad_number', hint: 'Send Money number' },
  { id: 'upay', label: 'Upay', key: 'upay_number', hint: 'Send Money number' }
];

export function businessDraft(s) {
  return { bkash: s.bkash_number || '', payBase: s.pay_base_url || '', lang: s.language === 'bn' ? 'bn' : 'en' };
}
export function businessValues(v) {
  const b = v.bkash.replace(/\D/g, '');
  if (b && !/^01\d{9}$/.test(b)) throw new Error('bKash number must look like 01XXXXXXXXX.');
  return { bkash_number: b, pay_base_url: v.payBase.trim().replace(/\/+$/, ''), language: v.lang };
}

export function remindersDraft(s) {
  return { before: String(s.reminder_days_before ?? ''), after: String(s.reminder_days_after ?? ''), due: String(s.due_reminder_every_days ?? ''), grace: String(s.grace_days ?? '') };
}
export function remindersValues(v) {
  return { reminder_days_before: num(v.before, 'Days before'), reminder_days_after: num(v.after, 'Days after'), due_reminder_every_days: num(v.due, 'Due days'), grace_days: num(v.grace, 'Grace days') };
}

export function ratesDraft(s) { return { usdt: s.usdt_bdt_manual || '' }; }
export function ratesValues(v) { return { usdt_bdt_manual: v.usdt.trim() }; }

/** Every stored setting that has no field of its own, as text, by name. */
export function extraDraft(s) {
  return Object.fromEntries(Object.keys(s)
    .filter(k => !SETTINGS_FIELDS.includes(k) && !PAY_METHOD_FIELDS.includes(k)).sort().map(k => [k, String(s[k] ?? '')]));
}
/** Only the values that changed, so untouched keys are never rewritten. */
export function extraValues(extra, s) {
  const values = {};
  Object.keys(extra).forEach(k => { if (extra[k] !== String(s[k] ?? '')) values[k] = extra[k]; });
  return values;
}

/**
 * Pay methods. withBkash is false on the Settings screen, where the bKash number is edited under Business instead
 * (one key, one editor). The sheet keeps the bKash field, so its payload is unchanged.
 */
export function payMethodsDraft(s, withBkash) {
  const enabled = String(s.pay_methods === undefined ? 'bkash' : s.pay_methods).split(',').map(x => x.trim()).filter(Boolean);
  const auto = String(s.pay_auto_verify === undefined ? 'bkash' : s.pay_auto_verify).split(',').map(x => x.trim());
  const v = {
    nagad_number: s.nagad_number || '', upay_number: s.upay_number || '',
    bank_name: s.bank_name || '', bank_account_name: s.bank_account_name || '', bank_account_number: s.bank_account_number || '',
    bank_branch: s.bank_branch || '', bank_routing: s.bank_routing || '', bank_note: s.bank_note || '',
    tos_text: s.tos_text || '', review_discord_url: s.review_discord_url || '', review_facebook_url: s.review_facebook_url || '',
    pay_link_expiry_hours: String(s.pay_link_expiry_hours || 24), delivery_note: s.delivery_note || ''
  };
  if (withBkash) v.bkash_number = s.bkash_number || '';
  return {
    on: { bkash: enabled.includes('bkash'), nagad: enabled.includes('nagad'), upay: enabled.includes('upay'), bank: enabled.includes('bank') },
    auto: { bkash: auto.includes('bkash'), nagad: auto.includes('nagad'), upay: auto.includes('upay') },
    v
  };
}
export function payMethodsValues(d, s) {
  const { on, auto, v } = d;
  const values = {
    pay_methods: ['bkash', 'nagad', 'upay', 'bank'].filter(id => on[id]).join(','),
    pay_auto_verify: ['bkash', 'nagad', 'upay'].filter(id => auto[id]).join(',')
  };
  METHOD_ROWS.forEach(m => {
    if (v[m.key] === undefined) return;   // not in this form
    const n = v[m.key].replace(/\D/g, '');
    if (n && !/^01\d{9}$/.test(n)) throw new Error('The ' + m.label + ' number must look like 01XXXXXXXXX.');
    values[m.key] = n;
  });
  ['bank_name', 'bank_account_name', 'bank_account_number', 'bank_branch', 'bank_routing', 'bank_note'].forEach(k => { values[k] = v[k].trim(); });
  ['tos_text', 'review_discord_url', 'review_facebook_url', 'delivery_note'].forEach(k => { values[k] = v[k].trim(); });
  ['review_discord_url', 'review_facebook_url'].forEach(k => { if (values[k] && !/^https:\/\/[^\s/]+\S*$/.test(values[k])) throw new Error('The ' + (k === 'review_discord_url' ? 'Discord' : 'Facebook') + ' link must start with https://.'); });
  const hrs = v.pay_link_expiry_hours.trim();
  if (!/^\d+$/.test(hrs) || Number(hrs) < 1 || Number(hrs) > 720) throw new Error('Link expiry must be a whole number of hours from 1 to 720.');
  values.pay_link_expiry_hours = hrs;
  if (on.bank && !values.bank_account_number) throw new Error('Add the bank account number, or turn Bank transfer off.');
  // A method that is on needs its number. A number that is not in this form is the one already saved.
  METHOD_ROWS.forEach(m => {
    const number = v[m.key] !== undefined ? values[m.key] : (s[m.key] || '');
    if (on[m.id] && !number) throw new Error('Add your ' + m.label + ' number, or turn ' + m.label + ' off.');
  });
  return values;
}

/**
 * True when saving this draft would change something compared with the draft built from the stored settings.
 * An invalid draft counts as unsaved. If the stored settings cannot be built (an old value the rules now refuse),
 * the raw drafts are compared instead, so the warning still follows what the owner typed.
 */
export function differs(build, draft, base) {
  let next;
  try { next = JSON.stringify(build(draft)); } catch (e) { return true; }
  try { return next !== JSON.stringify(build(base)); } catch (e) { return JSON.stringify(draft) !== JSON.stringify(base); }
}
