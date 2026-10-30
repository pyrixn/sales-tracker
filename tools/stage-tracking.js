'use strict';
// Stage the owner's Tracking.xlsx (and an optional inbox TSV) into import rows.
// Local only: reads files, prints counts, optionally writes JSON. No network, no --send yet.
//
//   node tools/stage-tracking.js <file.xlsx> [--inbox <file.tsv>] [--batch tracking-2026-10-28] [--out staging.json]
//
// Credentials are never staged in plain data: cells with '@', 'pass', the word 'pin', or a user:secret pair are dropped.
// With --keep-logins they go into the row field `secret` instead (text, one `field: value` per line). The server encrypts that at
// importStage and never stores it as plaintext. Without the flag nothing changes.

const fs = require('fs');
const { readXlsx, serialToIso, numToCol, colToNum } = require('./lib/xlsx-read.js');

const EXTRA_LABEL = 'Rent or custom amount';
const INBOX_FIELDS = ['Received', 'Type', 'Method', 'Sender', 'Amount', 'Transaction_ID', 'Counterparty',
  'Reference', 'Status', 'Matched_Sale_ID', 'Raw_SMS', 'Logged_As_Sale', 'Source'];

// ---------- credential rules ----------
function isCredentialText(s) {
  if (typeof s !== 'string') return false;
  return s.includes('@') || /pass/i.test(s) || /\bpin\b/i.test(s);
}
function isSecretPair(s) { return typeof s === 'string' && /\S:\S/.test(s); }

// Name or profile cell: 'Faraz:6767' keeps 'Faraz' and flags pin-dropped.
// Login text kept by --keep-logins is collected on the flags array of the row (flags.kept), then moved to data.secret.
let KEEP_LOGINS = false;
function keep(flags, field, text) { if (KEEP_LOGINS) (flags.kept = flags.kept || []).push(field + ': ' + text); }
function secretOf(flags) { return flags.kept && flags.kept.length ? { secret: flags.kept.join('\n') } : {}; }
function dropPin(s, flags, field) {
  const m = /^([^:]*?)\s*:\s*([\s\S]*)$/.exec(s);
  if (!m || m[2].startsWith('//')) return s;
  if (m[2].trim()) { flags.push('pin-dropped'); keep(flags, field, s); }
  return m[1].trim();
}

// Free text field: returns '' and a '<field>-hidden' flag when it looks like a credential.
function scrubText(v, field, flags, opts = {}) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v.trim() : String(v);
  if (opts.pin) s = dropPin(s, flags, field);
  if (isCredentialText(s)) { flags.push(field + '-hidden'); keep(flags, field, s); return ''; }
  return s;
}

// ---------- grid helpers ----------
const isBlank = (c) => !c || c.v === null || c.v === undefined || (typeof c.v === 'string' && c.v.trim() === '');
const cellAt = (sheet, r, c) => sheet.cells[numToCol(c) + r];
const textAt = (sheet, r, c) => { const x = cellAt(sheet, r, c); return x && typeof x.v === 'string' ? x.v.trim() : ''; };

function findBlocks(sheet) {
  const blocks = [];
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    if (typeof cell.v !== 'string' || !/^user name$/i.test(cell.v.trim())) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const col = colToNum(m[1]);
    const row = parseInt(m[2], 10);
    if (col < 2) continue;
    if (!/^payment status$/i.test(textAt(sheet, row, col + 1))) continue;
    blocks.push({ row, c0: col - 1, renewalHeader: textAt(sheet, row, col + 5) });
  }
  blocks.sort((a, b) => a.row - b.row || a.c0 - b.c0);
  return blocks;
}

function numOrRaw(cell, field, flags) {
  if (isBlank(cell)) return '';
  if (typeof cell.v === 'number') return cell.v;
  const s = scrubText(cell.v, field, flags);
  if (s !== '') flags.push(field + '-text');
  return s;
}

function dateCell(cell, field, flags) {
  if (isBlank(cell)) return '';
  if (typeof cell.v === 'number') {
    const iso = serialToIso(cell.v);
    if (iso) return iso;
    flags.push(field + '-text');
    return String(cell.v);
  }
  let s = scrubText(cell.v, field, flags);
  if (s === '') return '';
  // payment-method text (masked card tails, long digit runs) is not a date and not staged
  if (s.includes('*') || /\d{4}/.test(s)) { flags.push(field + '-hidden'); return ''; }
  flags.push(field + '-text');
  return s;
}

function commonDate(dates) {
  const count = {};
  for (const d of dates) if (/^\d{4}-\d\d-\d\d$/.test(d)) count[d] = (count[d] || 0) + 1;
  let best = '', n = 0;
  for (const d of Object.keys(count).sort()) if (count[d] > n) { best = d; n = count[d]; }
  return best;
}

// Parse the collected formula: +N terms become extras; other terms are flagged.
function parseCollected(f) {
  const out = { extras: [], flags: [] };
  if (!f) return out;
  const rest = f.replace(/SUM\([^)]*\)/i, '');
  const re = /([+-])\s*(\d+(?:\.\d+)?)/g;
  let m, used = '';
  while ((m = re.exec(rest))) {
    used += m[0];
    if (m[1] === '+') out.extras.push(Number(m[2]));
    else out.flags.push('collected-minus');
  }
  if (rest.replace(/\s+/g, '').length > used.replace(/\s+/g, '').length) out.flags.push('collected-unparsed');
  return out;
}

function accountTotals(sheet, block) {
  const r = block.row - 1;
  const res = { collected: '', cost: '', extras: [], flags: [], ref: '' };
  if (r < 1) return res;
  for (let c = block.c0; c < block.c0 + 7; c++) {
    const cell = cellAt(sheet, r, c);
    if (!cell || !/SUM\(/i.test(cell.f || '')) continue;
    res.ref = numToCol(c) + r;
    res.collected = typeof cell.v === 'number' ? cell.v : '';
    const p = parseCollected(cell.f);
    res.extras = p.extras;
    res.flags.push(...p.flags);
    const next = cellAt(sheet, r, c + 1);
    if (next && typeof next.v === 'number' && !next.f) res.cost = next.v;
    else if (next && next.f) {
      const cm = /^[A-Z]+\d+\s*-\s*(\d+(?:\.\d+)?)$/.exec(next.f.trim());
      if (cm) res.cost = Number(cm[1]);
    }
    break;
  }
  return res;
}

function stageSheet(sheet, batch, rows) {
  const blocks = findBlocks(sheet);
  const isHeader = (r, c0) => blocks.some((b) => b.row === r && b.c0 === c0);
  const isTotals = (r, c0) => blocks.some((b) => b.row - 1 === r && b.c0 === c0);
  let n = 0;
  for (const block of blocks) {
    n++;
    const { c0 } = block;
    const flags = [];
    const labelRef = numToCol(c0) + block.row;
    const accId = `${batch}:${sheet.name}!${labelRef}`;
    const labelCell = cellAt(sheet, block.row, c0);
    let label = labelCell && typeof labelCell.v === 'string' ? labelCell.v.trim() : '';
    const label0 = label;
    if (label === '' || isCredentialText(label) || isSecretPair(label)) {
      label = `${sheet.name} account ${n}`;
      flags.push('label-hidden');
      keep(flags, 'label', label0);
    }
    const tot = accountTotals(sheet, block);
    flags.push(...tot.flags);

    // seats
    const lines = [];
    for (let r = block.row + 1; r <= sheet.maxRow; r++) {
      let any = false;
      for (let c = c0; c < c0 + 7; c++) if (!isBlank(cellAt(sheet, r, c))) { any = true; break; }
      if (!any || isTotals(r, c0) || isHeader(r, c0)) break;
      const lf = [];
      const nameCell = cellAt(sheet, r, c0);
      const name = isBlank(nameCell) ? '' : scrubText(nameCell.v, 'name', lf, { pin: true });
      const profCell = cellAt(sheet, r, c0 + 1);
      const profile = isBlank(profCell) ? '' : scrubText(profCell.v, 'profile', lf, { pin: true });
      const statusCell = cellAt(sheet, r, c0 + 2);
      const status = isBlank(statusCell) ? '' : scrubText(statusCell.v, 'status', lf);
      const amount = numOrRaw(cellAt(sheet, r, c0 + 3), 'amount', lf);
      // A number in the Due column is an amount still owed (dueAmount), not a date.
      const dueRaw = numOrRaw(cellAt(sheet, r, c0 + 4), 'due', lf);
      const dueNum = typeof dueRaw === 'number' ? dueRaw : (/^\d+(\.\d+)?$/.test(String(dueRaw).replace(/,/g, '').trim()) && dueRaw !== '' ? Number(String(dueRaw).replace(/,/g, '')) : null);
      if (dueNum !== null && typeof dueRaw === 'string') { const i = lf.indexOf('due-text'); if (i >= 0) lf.splice(i, 1); }
      const due = dueNum === null ? dueRaw : '';
      const dueAmount = dueNum === null ? '' : dueNum;
      const paidTill = dateCell(cellAt(sheet, r, c0 + 5), 'paidTill', lf);
      const renewalDate = dateCell(cellAt(sheet, r, c0 + 6), 'renewalDate', lf);
      if (isBlank(nameCell) && amount === '') lf.push('empty-seat');
      lines.push({
        id: `${batch}:${sheet.name}!${numToCol(c0)}${r}`,
        kind: 'line', sheet: sheet.name, ref: numToCol(c0) + r,
        data: { accountRef: accId, name, profile, status, amount, due, dueAmount, paidTill, renewalDate, coversFrom: '', months: 1, flags: lf, ...secretOf(lf) },
      });
    }

    rows.push({
      id: accId, kind: 'account', sheet: sheet.name, ref: labelRef,
      data: {
        productHint: sheet.name, label, collected: tot.collected, cost: tot.cost,
        renewalDate: commonDate(lines.map((l) => l.data.renewalDate)), slots: lines.length, flags, ...secretOf(flags),
      },
    });
    tot.extras.forEach((amount, i) => {
      rows.push({
        id: `${batch}:${sheet.name}!${tot.ref}+${i + 1}`, kind: 'extra', sheet: sheet.name, ref: tot.ref,
        data: { accountRef: accId, amount, label: EXTRA_LABEL, coversFrom: '', paidTill: '' },
      });
    });
    rows.push(...lines);
  }

  stageKeys(sheet, batch, rows);
}

// Key table: header row 'HONE KEYS | REDEMPTION STATUS | GANKSTER KEY | ...'
function stageKeys(sheet, batch, rows) {
  let hdr = null;
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    if (typeof cell.v === 'string' && /^hone keys$/i.test(cell.v.trim())) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      hdr = { c: colToNum(m[1]), r: parseInt(m[2], 10) };
      break;
    }
  }
  if (!hdr) return;
  const cols = [];
  for (let c = hdr.c; ; c++) {
    const t = textAt(sheet, hdr.r, c);
    if (!t) break;
    if (/^(redemption status|stat)$/i.test(t)) continue;
    const next = textAt(sheet, hdr.r, c + 1);
    cols.push({ c, family: t.replace(/\s+keys?$/i, '').trim(), statusCol: /^(redemption status|stat)$/i.test(next) ? c + 1 : 0 });
  }
  for (const col of cols) {
    for (let r = hdr.r + 1; r <= sheet.maxRow; r++) {
      const cell = cellAt(sheet, r, col.c);
      if (isBlank(cell)) continue;
      const code = String(cell.v).trim();
      if (isCredentialText(code) || /\s/.test(code)) continue;
      const st = col.statusCol ? textAt(sheet, r, col.statusCol) : '';
      const ref = numToCol(col.c) + r;
      rows.push({
        id: `${batch}:${sheet.name}!${ref}`, kind: 'code', sheet: sheet.name, ref,
        data: { productHint: sheet.name, code, family: col.family, redeemed: /^redeemed$/i.test(st) },
      });
    }
  }
}

function stageWorkbook(wb, batch) {
  const rows = [];
  for (const sheet of wb.sheets) {
    if (!Object.keys(sheet.cells).length) continue;
    stageSheet(sheet, batch, rows);
  }
  return rows;
}

// ---------- inbox ----------
function parseInbox(tsv, batch) {
  const lines = String(tsv).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const head = lines[0].split('\t').map((h) => h.trim());
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  const seen = new Set();
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    const data = {};
    for (const f of INBOX_FIELDS) {
      let v = idx[f] === undefined ? '' : (parts[idx[f]] || '').trim();
      if (f === 'Amount') {
        const num = Number(v.replace(/[৳,\s]/g, ''));
        v = v !== '' && Number.isFinite(num) ? num : v;
      } else if (v.includes('@')) v = '';
      data[f] = v;
    }
    const tx = data.Transaction_ID || `row${i}`;
    if (seen.has(tx)) continue;
    seen.add(tx);
    rows.push({ id: `${batch}:inbox!${tx}`, kind: 'inbox', sheet: 'inbox', ref: tx, data });
  }
  return rows;
}

// ---------- build + summary ----------
function stage({ xlsx, inboxTsv, batch, keepLogins }) {
  KEEP_LOGINS = !!keepLogins;
  let rows;
  try { rows = stageWorkbook(readXlsx(xlsx), batch); } finally { KEEP_LOGINS = false; }
  if (inboxTsv) rows.push(...parseInbox(inboxTsv, batch));
  const out = { batch, source: 'Tracking.xlsx', rows };
  // Everything except the kept `secret` text must be free of '@'.
  const json = JSON.stringify(rows.map((r) => { const { secret, ...rest } = r.data; return { ...r, data: rest }; }));
  if (json.includes('@')) throw new Error('staging output contains "@"; refusing');
  return out;
}

function summarize(out) {
  const bySheet = {};
  const flags = {};
  for (const r of out.rows) {
    const s = (bySheet[r.sheet] = bySheet[r.sheet] || {});
    s[r.kind] = (s[r.kind] || 0) + 1;
    for (const f of (r.data && r.data.flags) || []) flags[f] = (flags[f] || 0) + 1;
  }
  return { bySheet, flags };
}

function parseArgs(argv) {
  const a = { keepLogins: false, file: '', inbox: '', batch: 'tracking-' + new Date().toISOString().slice(0, 10), out: '' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--inbox') a.inbox = argv[++i];
    else if (t === '--batch') a.batch = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--send') a.send = true;
    else if (t === '--keep-logins') a.keepLogins = true;
    else if (!a.file) a.file = t;
  }
  return a;
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.send) { console.error('--send is not implemented yet'); return 2; }
  if (!a.file) { console.error('usage: node tools/stage-tracking.js <file.xlsx> [--inbox <file.tsv>] [--batch id] [--out staging.json] [--keep-logins]'); return 1; }
  const out = stage({
    xlsx: fs.readFileSync(a.file),
    inboxTsv: a.inbox ? fs.readFileSync(a.inbox, 'utf8') : '',
    batch: a.batch,
    keepLogins: a.keepLogins,
  });
  const { bySheet, flags } = summarize(out);
  console.log(`batch ${out.batch}: ${out.rows.length} rows`);
  for (const [sheet, kinds] of Object.entries(bySheet)) {
    console.log(`  ${sheet}: ` + Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' '));
  }
  const nSecret = out.rows.filter((r) => r.data && r.data.secret).length;
  if (nSecret) console.log(`  ${nSecret} rows carry login details in \`secret\` (plaintext in this file: encrypted by the server when staged; delete the file after)`);
  const fl = Object.entries(flags).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log('  flags: ' + (fl || 'none'));
  if (a.out) {
    fs.writeFileSync(a.out, JSON.stringify(out, null, 2) + '\n');
    console.log('wrote ' + out.rows.length + ' rows');
  } else {
    console.log('dry run (no --out): nothing written');
  }
  return 0;
}

module.exports = { stage, stageWorkbook, parseInbox, parseCollected, isCredentialText, summarize };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
