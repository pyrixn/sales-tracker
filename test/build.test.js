// tools/build.js: the static Supabase-only site (dist/index.html + dist/config.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite } = require('../tools/build.js');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-build-')); dirs.push(d); return d; };
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

test('writes index.html, config.js and the Pages _headers file only', () => {
  const outDir = tmp();
  buildSite({ outDir });
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['_headers', 'config.js', 'index.html']);
  assert.match(fs.readFileSync(path.join(outDir, '_headers'), 'utf8'), /X-Frame-Options: DENY/);
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(!html.includes('google.script'), 'no Apps Script bridge');
  assert.ok(!html.includes('@@'), 'no build markers left');
  assert.ok(html.includes('<script src="config.js"></script>'), 'loads config.js');
});

test('inlines Core.util', () => {
  const outDir = tmp();
  buildSite({ outDir });
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(html.includes('Core.util = (function () {'));
});

test('api url is JSON-encoded', () => {
  const outDir = tmp();
  const url = 'https://x.test/a"b</script>';
  buildSite({ outDir, apiBaseUrl: url });
  const text = fs.readFileSync(path.join(outDir, 'config.js'), 'utf8');
  const win = {};
  assert.doesNotThrow(() => new Function('window', text)(win));
  assert.equal(win.API_BASE_URL, url);
  assert.ok(!fs.readFileSync(path.join(outDir, 'index.html'), 'utf8').includes('a"b'));
});
