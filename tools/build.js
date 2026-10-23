// Builds the static admin site into dist/ (or opts.outDir):
//   index.html   src/ui/Index.html with src/core/util.js inlined, whole-line comments stripped
//   config.js    window.API_BASE_URL = "<Edge Function URL>"; loaded by index.html before the app script
// The URL is opts.apiBaseUrl, else $API_BASE_URL, else the project's Edge Function.
// Run as `node tools/build.js`, or require it and call buildSite().
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DEFAULT_API_BASE_URL = 'https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api';
// Output of the old Apps Script build. Matched case-sensitively against the directory listing, so
// on a case-insensitive filesystem a stale `Index.html` goes before `index.html` is written.
const STALE = ['Code.gs', 'Index.html', 'appsscript.json', 'harness.html'];

// Drops whole-line comments and repeated blank lines from the built page. Only lines that START
// with a comment go: a line of code keeps any trailing comment. Safe here because no string or
// regex in the source starts a line with // and there are no template literals. The UI tests run
// this stripped output in Chromium.
function strip(src) {
  const out = [];
  let inBlock = false, blanks = 0;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//')) continue;
    if (t === '') { if (blanks++ > 0) continue; } else blanks = 0;
    out.push(line);
  }
  return out.join('\n');
}

function buildIndex() {
  const html = read('src/ui/Index.html');
  const util = read('src/core/util.js');
  if (!html.includes('/*@@CORE_UTIL@@*/')) throw new Error('Index.html is missing the /*@@CORE_UTIL@@*/ marker');
  if (!html.includes('<script src="config.js"></script>')) throw new Error('Index.html does not load config.js');
  return html.replace('/*@@CORE_UTIL@@*/', () => util);
}

/** buildSite({ apiBaseUrl?, outDir? }) -> { files }: writes index.html and config.js, removes stale Apps Script output. */
function buildSite(opts) {
  opts = opts || {};
  const outDir = opts.outDir || path.join(ROOT, 'dist');
  const url = opts.apiBaseUrl || process.env.API_BASE_URL || DEFAULT_API_BASE_URL;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (STALE.includes(name)) fs.unlinkSync(path.join(outDir, name));
  }
  const page = strip(buildIndex());
  fs.writeFileSync(path.join(outDir, 'index.html'), page);
  fs.writeFileSync(path.join(outDir, 'config.js'), 'window.API_BASE_URL = ' + JSON.stringify(url) + ';\n');
  return { files: ['index.html', 'config.js'].map(f => path.join(outDir, f)) };
}

module.exports = { buildSite, strip };

if (require.main === module) {
  const { files } = buildSite();
  console.log('Built ' + files.map(f => path.relative(ROOT, f).replace(/\\/g, '/')).join(', '));
}
