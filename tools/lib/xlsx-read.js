'use strict';
// Minimal XLSX reader: zip (central directory + zlib.inflateRawSync) and regex XML parsing.
// No dependencies. Returns { sheets: [{ name, cells: { A1: { v, f } }, maxRow, maxCol }] }.
// v is a string or number (number only for numeric cells), f is the formula text or ''.

const fs = require('fs');
const zlib = require('zlib');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    files[name] = { method, raw };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => Object.prototype.hasOwnProperty.call(files, name),
    names: () => Object.keys(files),
    text(name) {
      const f = files[name];
      if (!f) return null;
      if (f.method === 0) return f.raw.toString('utf8');
      if (f.method === 8) return zlib.inflateRawSync(f.raw).toString('utf8');
      throw new Error('unsupported zip method ' + f.method);
    },
  };
}

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

// Text of a <si> / <is> element: all <t> not inside <rPh> (phonetic).
function siText(xml) {
  const clean = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
  let m;
  while ((m = re.exec(clean))) out += m[1] === undefined ? '' : unescapeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] === undefined ? '' : siText(m[1]));
  return out;
}

function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return m ? { col: colToNum(m[1]), row: parseInt(m[2], 10) } : null;
}

function parseSheet(xml, shared) {
  const cells = {};
  let maxRow = 0, maxCol = 0;
  const re = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const head = m[1];
    const body = m[2] || '';
    const ref = attr(' ' + head, 'r');
    if (!ref) continue;
    const t = attr(' ' + head, 't');
    const fm = /<f(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
    const f = fm && fm[1] ? unescapeXml(fm[1]) : '';
    let v = null;
    if (t === 'inlineStr') {
      const im = /<is>([\s\S]*?)<\/is>/.exec(body);
      v = im ? siText(im[1]) : '';
    } else {
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (vm) {
        const raw = unescapeXml(vm[1]);
        if (t === 's') v = shared[parseInt(raw, 10)] ?? '';
        else if (t === 'str' || t === 'e') v = raw;
        else if (t === 'b') v = raw === '1';
        else { const num = Number(raw); v = Number.isFinite(num) ? num : raw; }
      }
    }
    if (v === null && !f) continue;
    cells[ref] = { v: v === null ? '' : v, f };
    const rc = splitRef(ref);
    if (rc) { if (rc.row > maxRow) maxRow = rc.row; if (rc.col > maxCol) maxCol = rc.col; }
  }
  return { cells, maxRow, maxCol };
}

function readXlsx(file) {
  const zip = readZip(Buffer.isBuffer(file) ? file : fs.readFileSync(file));
  const wb = zip.text('xl/workbook.xml');
  if (!wb) throw new Error('xl/workbook.xml missing');
  const rels = zip.text('xl/_rels/workbook.xml.rels') || '';
  const relMap = {};
  const rre = /<Relationship\s([^>]*?)\/?>/g;
  let m;
  while ((m = rre.exec(rels))) {
    const id = attr(' ' + m[1], 'Id');
    const target = attr(' ' + m[1], 'Target');
    if (id && target) relMap[id] = target;
  }
  const shared = parseSharedStrings(zip.text('xl/sharedStrings.xml'));
  const sheets = [];
  const sre = /<sheet\s([^>]*?)\/?>/g;
  while ((m = sre.exec(wb))) {
    const name = attr(' ' + m[1], 'name');
    const rid = attr(' ' + m[1], 'r:id');
    let target = relMap[rid];
    if (!target) continue;
    target = target.replace(/^\/+/, '');
    const path = target.startsWith('xl/') ? target : 'xl/' + target;
    const xml = zip.text(path);
    if (!xml) continue;
    const s = parseSheet(xml, shared);
    sheets.push({ name, cells: s.cells, maxRow: s.maxRow, maxCol: s.maxCol });
  }
  return { sheets };
}

// Excel serial day number (1900 system) to YYYY-MM-DD. Returns '' when out of plausible range.
function serialToIso(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 20000 || n > 80000) return '';
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

module.exports = { readXlsx, readZip, serialToIso, colToNum, numToCol, splitRef };
