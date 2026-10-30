'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const { readXlsx, serialToIso } = require('../tools/lib/xlsx-read.js');
const { stage, parseCollected } = require('../tools/stage-tracking.js');

// ---------- synthetic xlsx (fake names only) ----------
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// files: { name: string }, deflated except names starting with 'xl/_rels' (stored) to cover both methods
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const stored = name.startsWith('xl/_rels');
    const body = stored ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildXlsx(sheets) {
  const shared = [];
  const sid = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  };
  const wbSheets = [], rels = [];
  sheets.forEach((s, i) => {
    const n = i + 1;
    wbSheets.push(`<sheet name="${esc(s.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    rels.push(`<Relationship Id="rId${n}" Type="x" Target="worksheets/sheet${n}.xml"/>`);
    const byRow = {};
    for (const [ref, val] of Object.entries(s.cells || {})) {
      const row = parseInt(/\d+/.exec(ref)[0], 10);
      (byRow[row] = byRow[row] || []).push([ref, val]);
    }
    const colNum = (ref) => [...ref.replace(/\d+/, '')].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
    const rowsXml = Object.keys(byRow).map(Number).sort((a, b) => a - b).map((r) => {
      const cs = byRow[r].sort((a, b) => colNum(a[0]) - colNum(b[0])).map(([ref, val]) => {
        const f = val && typeof val === 'object' ? val.f : '';
        const v = val && typeof val === 'object' ? val.v : val;
        const fx = f ? `<f>${esc(f)}</f>` : '';
        if (typeof v === 'number') return `<c r="${ref}">${fx}<v>${v}</v></c>`;
        if (ref === 'R9' || (val && val.inline)) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        return `<c r="${ref}" t="s">${fx}<v>${sid(String(v))}</v></c>`;
      }).join('');
      return `<row r="${r}">${cs}</row>`;
    }).join('');
    parts[`xl/worksheets/sheet${n}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  parts['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets.join('')}</sheets></workbook>`;
  parts['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`;
  return zip(parts);
}

const HDR = ['User Name', 'Payment Status', 'Amount', 'Due Amount', 'Paid Till / Ends On', 'Renewal Date'];
function header(cells, row, col0, label, last) {
  const cols = 'ABCDEFGHIJKLMNOP';
  cells[cols[col0] + row] = label;
  HDR.forEach((h, i) => { cells[cols[col0 + 1 + i] + row] = i === 5 && last ? last : h; });
}

const SECRETS = ['hunter2pw', 'login@', '4321', 'boss', 'cat@', 'secret_user', 'hunter9', '1234', 'Fakepass'];

function alphaSheet() {
  const c = {};
  c.C1 = { f: 'SUM(T1[Amount])+300', v: 1300 }; c.D1 = 400; c.E1 = { f: 'C1-D1', v: 900 };
  c.J1 = { f: 'SUM(T2[Amount])+50+240', v: 1090 }; c.K1 = 500; c.L1 = { f: 'J1-K1', v: 590 };
  c.P1 = 'hunter2pw'; c.Q1 = 'login@example.com'; // login helper columns: must never leak
  header(c, 2, 0, 'Alpha one'); header(c, 2, 7, 'boss@example.com');
  c.A3 = 'Ann Test'; c.B3 = 'ann.user'; c.C3 = 'Paid'; c.D3 = 500; c.F3 = 46319; c.G3 = 46330;
  c.A4 = 'Cat Test'; c.B4 = 'cat@example.com'; c.C4 = 'Paid'; c.D4 = 200; c.E4 = '880 or 7$';
  c.H3 = 'Bob Test'; c.I3 = 'Bob:4321'; c.J3 = 'Due'; c.K3 = '220-250';
  c.H4 = 'Dan Test'; c.J4 = 'Paid'; c.K4 = 300; c.M4 = 46319;
  c.I8 = 'HONE KEYS'; c.J8 = 'REDEMPTION STATUS'; c.K8 = 'GANKSTER KEY'; c.L8 = 'REDEMPTION STATUS';
  c.I9 = 'AAA-111'; c.J9 = 'Redeemed'; c.I10 = 'AAA-222'; c.J10 = 'N/A';
  c.K9 = 'GGG-111'; c.L9 = 'Unredeemed';
  return { name: 'Alpha', cells: c };
}
function betaSheet() {
  const c = {};
  c.D1 = { f: 'SUM(S1[Amount])', v: 460 }; c.E1 = { f: 'D1-300', v: 160 };
  header(c, 2, 0, 'secret_user:hunter9', 'Renewal Method'); c.H2 = 'Status';
  c.A3 = 'Eve Test'; c.C3 = 'Paid'; c.D3 = 460; c.F3 = 46319; c.G3 = 46340;
  c.A4 = 'Fay Test'; c.C4 = 'Paid'; c.D4 = 100; c.G4 = '******1234';
  return { name: 'Beta', cells: c };
}
const SAMPLE = () => buildXlsx([alphaSheet(), betaSheet(), { name: 'Empty', cells: {} }, { name: 'Blank2', cells: {} }]);

const INBOX_TSV = [
  'Received\tType\tMethod\tSender\tAmount\tTransaction_ID\tCounterparty\tReference\tStatus\tMatched_Sale_ID\tRaw_SMS\tLogged_As_Sale\tSource',
  '2026-10-18 21:37\tReceived\tbKash\tbKash\t৳1,250.50\tTX0001\t01700000000\t\tVerified\t\tYou have received Tk 1,250.50\tNot logged yet\tSMS',
  '2026-10-19 13:30\tUnrecognised\t\tupay\t৳339.00\tTX0002\t\t\tReview\t\tTk.339.00 has been received\tNot logged yet\tUnknown',
  '2026-10-19 13:31\tUnrecognised\t\tupay\t৳339.00\tTX0002\t\t\tReview\t\tduplicate id\tNot logged yet\tUnknown',
].join('\n');

const BATCH = 'tracking-test';
const run = () => stage({ xlsx: SAMPLE(), inboxTsv: INBOX_TSV, batch: BATCH });
const byKind = (out, kind, sheet) => out.rows.filter((r) => r.kind === kind && (!sheet || r.sheet === sheet));

// ---------- tests ----------
test('reader returns cells with value and formula, converts nothing by itself', () => {
  const wb = readXlsx(SAMPLE());
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Alpha', 'Beta', 'Empty', 'Blank2']);
  const a = wb.sheets[0].cells;
  assert.deepEqual(a.C1, { v: 1300, f: 'SUM(T1[Amount])+300' });
  assert.equal(a.A3.v, 'Ann Test');
  assert.equal(a.F3.v, 46319);
  assert.equal(Object.keys(wb.sheets[2].cells).length, 0);
  assert.equal(serialToIso(46319), '2026-10-24'.replace('24', String(new Date((46319 - 25569) * 86400000).getUTCDate()).padStart(2, '0')));
});

test('parseCollected: +N extras, minus flagged', () => {
  assert.deepEqual(parseCollected('SUM(Table5[Amount])+300').extras, [300]);
  assert.deepEqual(parseCollected('SUM(x[Amount])+50+240+450').extras, [50, 240, 450]);
  const m = parseCollected('SUM(x[Amount])-3000');
  assert.deepEqual(m.extras, []);
  assert.deepEqual(m.flags, ['collected-minus']);
});

test('two side-by-side blocks become two accounts with own seats', () => {
  const out = run();
  const acc = byKind(out, 'account', 'Alpha');
  assert.equal(acc.length, 2);
  assert.equal(acc[0].id, 'tracking-test:Alpha!A2');
  assert.equal(acc[1].id, 'tracking-test:Alpha!H2');
  assert.equal(acc[0].data.collected, 1300);
  assert.equal(acc[0].data.cost, 400);
  assert.equal(acc[0].data.slots, 2);
  assert.equal(acc[1].data.collected, 1090);
  assert.equal(acc[1].data.cost, 500);
  assert.equal(acc[1].data.slots, 2);
  assert.equal(acc[0].data.label, 'Alpha one');
  assert.equal(acc[0].data.productHint, 'Alpha');
  const lines = byKind(out, 'line', 'Alpha');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.data.accountRef), [acc[0].id, acc[0].id, acc[1].id, acc[1].id]);
  assert.equal(lines[0].id, 'tracking-test:Alpha!A3');
  assert.equal(lines[2].id, 'tracking-test:Alpha!H3');
});

test('line fields: dates converted in date columns, defaults set', () => {
  const l = byKind(run(), 'line', 'Alpha')[0].data;
  assert.equal(l.name, 'Ann Test');
  assert.equal(l.profile, 'ann.user');
  assert.equal(l.status, 'Paid');
  assert.equal(l.amount, 500);
  assert.equal(l.paidTill, serialToIso(46319));
  assert.equal(l.renewalDate, serialToIso(46330));
  assert.equal(l.coversFrom, '');
  assert.equal(l.months, 1);
  assert.deepEqual(l.flags, []);
  // numeric amount stays a number, not a date
  assert.equal(typeof l.amount, 'number');
});

test('extras: one per +N term, not the SUM part', () => {
  const ex = byKind(run(), 'extra');
  assert.deepEqual(ex.map((e) => e.data.amount), [300, 50, 240]);
  assert.deepEqual(ex.map((e) => e.id), ['tracking-test:Alpha!C1+1', 'tracking-test:Alpha!J1+1', 'tracking-test:Alpha!J1+2']);
  assert.equal(ex[0].data.label, 'Rent or custom amount');
  assert.equal(ex[0].data.accountRef, 'tracking-test:Alpha!A2');
  assert.equal(ex[1].data.accountRef, ex[2].data.accountRef);
});

test('text amounts keep raw text and set a flag', () => {
  const lines = byKind(run(), 'line', 'Alpha');
  const bob = lines[2].data;
  assert.equal(bob.amount, '220-250');
  assert.ok(bob.flags.includes('amount-text'));
  const cat = lines[1].data;
  assert.equal(cat.due, '880 or 7$');
  assert.ok(cat.flags.includes('due-text'));
});

test('profile PIN dropped and flagged; email profile hidden', () => {
  const lines = byKind(run(), 'line', 'Alpha');
  assert.equal(lines[2].data.profile, 'Bob');
  assert.ok(lines[2].data.flags.includes('pin-dropped'));
  assert.equal(lines[1].data.profile, '');
  assert.ok(lines[1].data.flags.includes('profile-hidden'));
});

test('credential labels replaced by "<sheet> account <n>"', () => {
  const out = run();
  const acc = byKind(out, 'account', 'Alpha')[1];
  assert.equal(acc.data.label, 'Alpha account 2');
  assert.deepEqual(acc.data.flags.filter((f) => f === 'label-hidden'), ['label-hidden']);
  const beta = byKind(out, 'account', 'Beta')[0];
  assert.equal(beta.data.label, 'Beta account 1');
  assert.ok(beta.data.flags.includes('label-hidden'));
  assert.equal(beta.data.collected, 460);
  assert.equal(beta.data.cost, 300);
});

test('Beta: method text hidden, date serial under Renewal Method converted', () => {
  const lines = byKind(run(), 'line', 'Beta');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].data.renewalDate, serialToIso(46340));
  assert.equal(lines[1].data.renewalDate, '');
  assert.ok(lines[1].data.flags.includes('renewalDate-hidden'));
});

test('key table becomes code rows with family and redeemed', () => {
  const codes = byKind(run(), 'code');
  assert.equal(codes.length, 3);
  const by = Object.fromEntries(codes.map((c) => [c.data.code, c.data]));
  assert.equal(by['AAA-111'].family, 'HONE');
  assert.equal(by['AAA-111'].redeemed, true);
  assert.equal(by['AAA-222'].redeemed, false);
  assert.equal(by['GGG-111'].family, 'GANKSTER');
  assert.equal(by['GGG-111'].redeemed, false);
  assert.equal(by['AAA-111'].productHint, 'Alpha');
  assert.equal(codes.find((c) => c.data.code === 'AAA-111').id, 'tracking-test:Alpha!I9');
});

test('empty tabs produce no rows', () => {
  const out = run();
  assert.equal(out.rows.filter((r) => r.sheet === 'Empty' || r.sheet === 'Blank2').length, 0);
});

test('inbox TSV: numeric amounts, deterministic ids, duplicates skipped', () => {
  const ib = byKind(run(), 'inbox');
  assert.equal(ib.length, 2);
  assert.equal(ib[0].id, 'tracking-test:inbox!TX0001');
  assert.equal(ib[0].data.Amount, 1250.5);
  assert.equal(ib[1].data.Amount, 339);
  assert.equal(ib[0].data.Method, 'bKash');
  assert.deepEqual(Object.keys(ib[0].data), ['Received', 'Type', 'Method', 'Sender', 'Amount', 'Transaction_ID', 'Counterparty', 'Reference', 'Status', 'Matched_Sale_ID', 'Raw_SMS', 'Logged_As_Sale', 'Source']);
});

test('no "@" and no removed secret in any output string', () => {
  const text = JSON.stringify(run());
  assert.ok(!text.includes('@'));
  for (const s of SECRETS) assert.ok(!text.includes(s), 'leaked: ' + s);
});

test('output is deterministic', () => {
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
  const ids = run().rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('cli dry run prints counts only; --out writes json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const x = path.join(dir, 'T.xlsx'), t = path.join(dir, 'i.tsv'), o = path.join(dir, 'out.json');
  fs.writeFileSync(x, SAMPLE()); fs.writeFileSync(t, INBOX_TSV);
  const script = path.join(__dirname, '..', 'tools', 'stage-tracking.js');
  const dry = execFileSync(process.execPath, [script, x, '--inbox', t, '--batch', BATCH], { encoding: 'utf8' });
  assert.match(dry, /Alpha: account=2 extra=3 line=4 code=3/);
  assert.match(dry, /inbox: inbox=2/);
  assert.ok(!/Ann|Bob|Cat|AAA-|TX000|1250/.test(dry));
  assert.ok(!fs.existsSync(o));
  execFileSync(process.execPath, [script, x, '--inbox', t, '--batch', BATCH, '--out', o], { encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(o, 'utf8'));
  assert.equal(j.batch, BATCH);
  assert.equal(j.source, 'Tracking.xlsx');
  assert.ok(!fs.readFileSync(o, 'utf8').includes('@'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--keep-logins moves credential cells into data.secret instead of dropping them; default is unchanged', () => {
  const plain = run();
  assert.ok(plain.rows.every((r) => !('secret' in r.data)));
  const kept = stage({ xlsx: SAMPLE(), inboxTsv: INBOX_TSV, batch: BATCH, keepLogins: true });
  const withSecret = kept.rows.filter((r) => r.data.secret);
  assert.ok(withSecret.length >= 2);
  const text = withSecret.map((r) => r.data.secret).join('\n');
  assert.ok(text.includes('profile: cat@example.com'));
  assert.ok(text.includes('label: secret_user:hunter9'));
  // The visible fields are still blank, and nothing outside `secret` carries a login.
  const cat = kept.rows.find((r) => r.kind === 'line' && r.data.name === 'Cat Test');
  assert.equal(cat.data.profile, '');
  const outside = JSON.stringify(kept.rows.map((r) => { const { secret, ...rest } = r.data; return rest; }));
  assert.ok(!outside.includes('@') && !outside.includes('hunter9'));
});

test('a number in the Due column becomes dueAmount, not a date or text', () => {
  const c = {};
  c.D1 = { f: 'SUM(T1[Amount])', v: 600 }; c.E1 = 100;
  header(c, 2, 0, 'Gamma one');
  c.A3 = 'Gus Test'; c.C3 = 'Paid'; c.D3 = 300; c.E3 = 585;
  c.A4 = 'Hal Test'; c.C4 = 'Paid'; c.D4 = 300; c.E4 = '405'; c.F4 = 46319;
  c.A5 = 'Ivy Test'; c.C5 = 'Paid'; c.D5 = 300; c.E5 = 'next week';
  const out = stage({ xlsx: buildXlsx([{ name: 'Gamma', cells: c }]), inboxTsv: '', batch: BATCH });
  const line = n => out.rows.find((r) => r.kind === 'line' && r.data.name === n).data;
  assert.equal(line('Gus Test').dueAmount, 585);
  assert.equal(line('Gus Test').due, '');
  assert.equal(line('Hal Test').dueAmount, 405);
  assert.ok(!line('Hal Test').flags.includes('due-text'));
  assert.equal(line('Ivy Test').dueAmount, '');
  assert.equal(line('Ivy Test').due, 'next week');
});
