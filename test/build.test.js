// tools/build.js: the static Supabase-only site (dist/index.html, assets/, config.js, _headers).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite, headers, gzipSizes } = require('../tools/build.js');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-build-')); dirs.push(d); return d; };
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

// One real build shared by the read-only checks: a Vite build takes a few seconds.
let shared;
function built() {
  if (!shared) { shared = tmp(); buildSite({ outDir: shared, apiBaseUrl: 'https://abc.supabase.co/functions/v1/api' }); }
  return shared;
}
const bundle = dir => {
  const assets = fs.readdirSync(path.join(dir, 'assets')).filter(f => f.endsWith('.js'));
  return assets.map(f => fs.readFileSync(path.join(dir, 'assets', f), 'utf8')).join('\n');
};

test('writes index.html, assets, config.js, theme-init.js, the Pages _headers file and the install files', () => {
  const outDir = built();
  const expected = ['_headers', 'apple-touch-icon.png', 'assets', 'config.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon.svg', 'index.html', 'logos', 'manifest.webmanifest', 'theme-init.js'];
  assert.deepEqual(fs.readdirSync(outDir).sort(), expected.sort());
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(!html.includes('google.script'), 'no Apps Script bridge');
  assert.ok(!html.includes('@@'), 'no build markers left');
  assert.ok(html.includes('<script src="config.js"></script>'), 'loads config.js');
  assert.match(html, /<script type="module"[^>]*src="\.\/assets\/index-[^"]+\.js"/);
  assert.ok(!/<script>[^<]/.test(html), 'no inline script, so the CSP can forbid them');
});

test('response headers lock the page down and allow only the API origin', () => {
  const text = fs.readFileSync(path.join(built(), '_headers'), 'utf8');
  assert.match(text, /X-Frame-Options: DENY/);
  assert.match(text, /Content-Security-Policy: .*script-src 'self'(;|$)/m);
  assert.match(text, /connect-src 'self' https:\/\/abc\.supabase\.co(;|$)/m);
  assert.match(text, /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(headers('https://x.test/a')), 'scripts never run inline');
});

test('bundles the shared Core.util and ships the fonts itself', () => {
  const outDir = built();
  assert.ok(bundle(outDir).includes('suggestPaidTill'));
  const files = fs.readdirSync(path.join(outDir, 'assets'));
  for (const family of ['fraunces', 'bricolage-grotesque', 'jetbrains-mono']) {
    assert.ok(files.some(f => f.startsWith(family) && f.endsWith('.woff2')), family + ' woff2 shipped');
  }
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8') + bundle(outDir)), 'no third-party font host');
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

test('initial JS gzip size is within the recorded budget', () => {
  const outDir = built();
  const sizes = gzipSizes(outDir);
  assert.ok(sizes.initial.length >= 2, 'entry plus vendor chunks found from index.html');
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  for (const f of sizes.initial) assert.ok(html.includes(f.replace(/^/, './')), f + ' is referenced by index.html');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'perf.md'), 'utf8');
  const budget = Number((doc.match(/^bundle-budget-bytes: (\d+)$/m) || [])[1]);
  assert.ok(budget > 0, 'docs/perf.md records bundle-budget-bytes');
  assert.ok(sizes.initialBytes <= budget, 'initial gzip ' + sizes.initialBytes + ' exceeds budget ' + budget);
});

test('first load ships only the shell and Today: screens are separate chunks outside the initial set', () => {
  const outDir = built();
  const sizes = gzipSizes(outDir);
  const initial = sizes.initial.join(' ');
  for (const name of ['Accounts', 'Customers', 'Delivery', 'Dues', 'Money', 'More', 'PayLinks']) {
    assert.ok(Object.keys(sizes.files).some(f => f.startsWith('assets/' + name + '-')), name + ' has its own chunk');
    assert.ok(!initial.includes('/' + name + '-'), name + ' is not in the initial set');
  }
  for (const name of ['react', 'motion', 'lucide', 'radix']) assert.ok(sizes.initial.some(f => f.startsWith('assets/' + name + '-')), name + ' vendor chunk');
});

test('font preloads point only at font files in the build', () => {
  const outDir = built();
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const hrefs = (html.match(/<link[^>]*rel="preload"[^>]*>/g) || []).map(t => t.match(/href="\.\/([^"]+)"/)[1]);
  assert.ok(hrefs.length >= 2, 'fonts preloaded');
  for (const h of hrefs) assert.ok(fs.existsSync(path.join(outDir, h)), h + ' exists');
  assert.ok(/<link[^>]*as="font"[^>]*crossorigin/.test(html), 'font preload is crossorigin');
  assert.ok(!/preconnect/.test(html), 'API preconnect is added at runtime, not hardcoded');
});

// Installable app (DESIGN.md "Installable app"): a standalone manifest and PNG icons, no service worker.
const pngSize = file => {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], path.basename(file) + ' has the PNG signature');
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', path.basename(file) + ' starts with IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

test('manifest is standalone, its colours are the dark background token, and every icon is a PNG of its stated size', () => {
  const outDir = built();
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Ledger');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'index.css'), 'utf8');
  const dark = (css.match(/^\.dark \{([\s\S]*?)^\}/m) || [])[1] || '';
  const bg = ((dark.match(/--background:\s*(#[0-9a-f]{6});/i)) || [])[1];
  assert.ok(bg, 'the dark block sets --background to a hex value');
  assert.equal(manifest.background_color.toLowerCase(), bg.toLowerCase());
  assert.equal(manifest.theme_color.toLowerCase(), bg.toLowerCase());
  for (const icon of manifest.icons) {
    const { width, height } = pngSize(path.join(outDir, icon.src));
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.sizes, width + 'x' + height, icon.src + ' matches its stated size');
  }
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), '192 and 512 icons listed');
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'a maskable icon is listed');
});

test('index.html links the manifest and apple-touch-icon with relative hrefs, and the theme colour matches the manifest', () => {
  const outDir = built();
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const hrefOf = rel => {
    const tag = (html.match(new RegExp('<link[^>]*rel="' + rel + '"[^>]*>')) || [])[0];
    assert.ok(tag, rel + ' link is in index.html');
    return tag.match(/href="([^"]+)"/)[1];
  };
  for (const rel of ['manifest', 'apple-touch-icon']) {
    const href = hrefOf(rel);
    assert.ok(!href.startsWith('/') && !/^https?:/.test(href), rel + ' href is relative: ' + href);
    assert.ok(fs.existsSync(path.join(outDir, href)), rel + ' target exists in dist');
  }
  assert.equal(hrefOf('apple-touch-icon'), 'apple-touch-icon.png');
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, hrefOf('manifest')), 'utf8'));
  const theme = (html.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1];
  assert.equal(theme && theme.toLowerCase(), manifest.theme_color.toLowerCase(), 'meta theme-color matches manifest theme_color');
  assert.equal(pngSize(path.join(outDir, 'apple-touch-icon.png')).width, 180);
});

test('no service worker: no worker script ships and nothing registers one', () => {
  const outDir = built();
  const names = [...fs.readdirSync(outDir), ...fs.readdirSync(path.join(outDir, 'assets')).map(f => 'assets/' + f)];
  assert.ok(!names.some(n => /(^|\/)sw\.js$|service-?worker/i.test(n)), 'no service worker file in dist');
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(!/serviceWorker/.test(html + bundle(outDir)), 'the app never touches navigator.serviceWorker');
});

test('ships the bKash, Nagad and Upay logos', () => {
  const dir = path.join(built(), 'logos');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bkash.png', 'nagad.png', 'upay.png']);
});
