// web/src/lib/format.js csvSafe and toCsv (uplift plan 3.4): the client copy of the server's formula guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

const load = () => import('../web/src/lib/format.js?t=' + Date.now());
// Samples that cover each rule: the four characters, leading blanks, TAB and CR first, numbers, empty and plain text.
const SAMPLES = ['=HYPERLINK("x")', '+1', '-evil', '@x', ' =x', '\t=tab', '\r=cr', '  -5', 'plain', 'Kabir', '', 'a=b', '01711111111', 'Rahim (ref 4)'];

test('csvSafe puts an apostrophe before = + - @ and before a leading TAB or CR, blanks included', async () => {
  const { csvSafe } = await load();
  assert.equal(csvSafe('=1+1'), "'=1+1");
  assert.equal(csvSafe('+1'), "'+1");
  assert.equal(csvSafe('-evil'), "'-evil");
  assert.equal(csvSafe('@x'), "'@x");
  assert.equal(csvSafe(' =x'), "' =x");
  assert.equal(csvSafe('\t=tab'), "'\t=tab");
  assert.equal(csvSafe('\r=cr'), "'\r=cr");
});

test('csvSafe leaves numbers, null, plain text and text with a formula character inside it alone', async () => {
  const { csvSafe } = await load();
  assert.equal(csvSafe(-5), -5);
  assert.equal(csvSafe(290), 290);
  assert.equal(csvSafe(null), null);
  assert.equal(csvSafe('Kabir'), 'Kabir');
  assert.equal(csvSafe('a=b'), 'a=b');
  assert.equal(csvSafe(''), '');
});

test('csvSafe matches the server rule (Core.exporter.safeCell) on every sample', async () => {
  const { csvSafe } = await load();
  for (const s of SAMPLES.concat([-5, 290, null, undefined])) {
    assert.equal(csvSafe(s), Core.exporter.safeCell(s), 'sample ' + JSON.stringify(s));
  }
});

test('toCsv neutralises formula cells, doubles quotes and keeps the header row', async () => {
  const { toCsv } = await load();
  const csv = toCsv(['Customer', 'Amount'], [['=HYPERLINK("x")', 290], ['Kabir "K"', -3], [null, '']]);
  assert.equal(csv, '"Customer","Amount"\r\n"\'=HYPERLINK(""x"")","290"\r\n"Kabir ""K""","-3"\r\n"",""');
});
