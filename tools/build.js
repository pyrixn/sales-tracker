// Builds the static admin site into dist/ (or opts.outDir):
//   index.html + assets/   the React panel in web/, bundled by Vite (vite.config.mjs)
//   config.js              window.API_BASE_URL = "<Edge Function URL>"; loaded by index.html before the app
//   theme-init.js          copied from web/public: sets the theme class before first paint
//   _headers               Cloudflare Pages response headers, including the CSP
// The URL is opts.apiBaseUrl, else $API_BASE_URL, else the project's Edge Function.
// Run as `node tools/build.js`, or require it and call buildSite().
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_API_BASE_URL = 'https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api';
// Output of the old builds. Matched case-sensitively against the directory listing, so on a
// case-insensitive filesystem a stale `Index.html` goes before `index.html` is written.
const STALE = ['Code.gs', 'Index.html', 'appsscript.json', 'harness.html'];

/** The origin of a URL, or '' when it does not parse. */
function originOf(u) {
  try { return new URL(u).origin; } catch (e) { return ''; }
}

function headers(apiUrl, authUrl) {
  // connect-src names the API origin, and the Supabase Auth origin when it differs (staff email sign-in).
  const origins = [originOf(apiUrl), originOf(authUrl)].filter((o, i, a) => o && a.indexOf(o) === i);
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'" + origins.map(o => ' ' + o).join(''),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
  return '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n' +
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: ' + csp + '\n';
}

/** buildSite({ apiBaseUrl?, outDir? }) -> { files }: runs the Vite build, writes config.js and _headers, removes stale output. */
function buildSite(opts) {
  opts = opts || {};
  const outDir = opts.outDir || path.join(ROOT, 'dist');
  const url = opts.apiBaseUrl || process.env.API_BASE_URL || DEFAULT_API_BASE_URL;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (STALE.includes(name) || name === 'assets') fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const run = spawnSync(process.execPath, [vite, 'build', '--config', path.join(ROOT, 'vite.config.mjs'), '--outDir', outDir, '--logLevel', 'warn'], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error('vite build failed:\n' + (run.stdout || '') + (run.stderr || ''));
  // Staff email sign-in uses the Supabase Auth endpoints only. SUPABASE_ANON_KEY is needed for that; without it the panel shows
  // the password form alone. The anon key is never used for data (see web/src/lib/api.js).
  const supabaseUrl = opts.supabaseUrl || process.env.SUPABASE_URL || originOf(url);
  const anonKey = opts.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || '';
  fs.writeFileSync(path.join(outDir, 'config.js'),
    'window.API_BASE_URL = ' + JSON.stringify(url) + ';\n' +
    'window.SUPABASE_URL = ' + JSON.stringify(supabaseUrl) + ';\n' +
    'window.SUPABASE_ANON_KEY = ' + JSON.stringify(anonKey) + ';\n');
  fs.writeFileSync(path.join(outDir, '_headers'), headers(url, supabaseUrl));
  return { files: ['index.html', 'config.js'].map(f => path.join(outDir, f)) };
}

/** The JS the first load fetches: scripts and modulepreloads that index.html references, as paths relative to dir. */
function initialScripts(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const found = new Set();
  for (const tag of html.match(/<(script|link)[^>]*>/g) || []) {
    if (/^<script/.test(tag) && !/type="module"/.test(tag)) continue;
    if (/^<link/.test(tag) && !/rel="modulepreload"/.test(tag)) continue;
    const m = tag.match(/(?:src|href)="([^"]+\.js)"/);
    if (m) found.add(path.posix.normalize(m[1].replace(/^\.\//, '')));
  }
  return [...found];
}

/** gzipSizes(dir) -> { files: {assets/x.js: bytes}, initial: [paths], initialBytes }: gzip size of every dist/assets/*.js. */
function gzipSizes(dir) {
  const files = {};
  const assets = path.join(dir, 'assets');
  for (const f of fs.readdirSync(assets).filter(f => f.endsWith('.js'))) files['assets/' + f] = zlib.gzipSync(fs.readFileSync(path.join(assets, f))).length;
  const initial = initialScripts(dir).filter(f => f in files);
  return { files, initial, initialBytes: initial.reduce((n, f) => n + files[f], 0) };
}

module.exports = { buildSite, headers, gzipSizes, initialScripts };

if (require.main === module) {
  const { files } = buildSite();
  console.log('Built ' + files.map(f => path.relative(ROOT, f)).join(', ') + ' and assets/');
  const sizes = gzipSizes(path.join(ROOT, 'dist'));
  for (const f of Object.keys(sizes.files).sort()) console.log('  ' + (sizes.initial.includes(f) ? '*' : ' ') + ' ' + f + '  ' + (sizes.files[f] / 1024).toFixed(1) + ' KB gzip');
  console.log('  initial load (*): ' + (sizes.initialBytes / 1024).toFixed(1) + ' KB gzip');
}
