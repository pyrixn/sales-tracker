const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('secret files are ignored', () => {
  for (const f of ['.env', '.mcp.json', 'settings.json', 'supabase/.temp/x',
    '.claude/settings.local.json', '.claude/settings.json', '.codex/hooks.json']) {
    const r = spawnSync('git', ['check-ignore', '-q', f], { cwd: root });
    assert.strictEqual(r.status, 0, f + ' is not git-ignored');
  }
});

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('no hardcoded token in tools or src', () => {
  const skip = path.join(root, 'tools', 'migrate-output.json');
  const patterns = [
    /sbp_[A-Za-z0-9]{10,}/,
    /eyJ[A-Za-z0-9_-]{20,}/,
    /postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/,
  ];
  const files = [];
  for (const d of ['tools', 'src']) {
    const full = path.join(root, d);
    if (fs.existsSync(full)) walk(full, files);
  }
  for (const f of files) {
    if (f === skip) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const re of patterns) {
      assert.ok(!re.test(text), 'secret-like pattern ' + re + ' in ' + path.relative(root, f));
    }
  }
});

test('docs name only real scripts and files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const banned = ['appsscript', 'Code.gs', 'apply-schema', 'ensure-schema', 'migrate-data', 'sheets.js', 'main.js', 'Apps Script'];
  const problems = [];
  for (const doc of ['README.md', 'README_CF_PAGES.md', 'CLAUDE.md']) {
    const lines = fs.readFileSync(path.join(root, doc), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = doc + ':' + (i + 1);
      for (const m of line.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        if (!pkg.scripts[m[1]]) problems.push(where + ' unknown npm script ' + m[1]);
      }
      for (const m of line.matchAll(/\btools\/([A-Za-z0-9_.\/-]+)/g)) {
        const rel = 'tools/' + m[1].replace(/[.,:;)]+$/, '');
        if (!fs.existsSync(path.join(root, rel))) problems.push(where + ' missing file ' + rel);
      }
      for (const m of line.matchAll(/\bsrc\/[A-Za-z0-9_.\/-]*\.(?:js|html)\b/gi)) {
        if (!fs.existsSync(path.join(root, m[0]))) problems.push(where + ' missing file ' + m[0]);
      }
      if (!line.includes('reference_PaymentRelay')) {
        for (const b of banned) {
          if (line.includes(b)) problems.push(where + ' banned token ' + b);
        }
      }
    });
  }
  assert.deepStrictEqual(problems, []);
});

test('docs have no bullet glued to the end of a sentence', () => {
  const glued = [];
  for (const doc of ['README.md', 'README_CF_PAGES.md', 'CLAUDE.md', 'PRODUCT.md']) {
    fs.readFileSync(path.join(root, doc), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/[.)`]- `/.test(line)) glued.push(doc + ':' + (i + 1));
    });
  }
  assert.deepStrictEqual(glued, []);
});

test('no token-like secret in tracked files', () => {
  const r = spawnSync('git', ['grep', '-nIE', ['sbp_[A-Za-z0-9]{10,}', 'oma' + '_live_', 'sk-[a-f0-9]{8,}'].join('|')], { cwd: root });
  assert.strictEqual(r.status, 1, 'secret-like token is tracked in git');
});
