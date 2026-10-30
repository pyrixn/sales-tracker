// Vendored UI hygiene (uplift plan 0.6): copied components use token colours only and no inline styles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DIRS = ['web/src/components/ui', 'web/src/components/fx'];
// Files allowed to break a rule, with the reason. Keep this list short.
const ALLOW = {
  'web/src/components/ui/progress.jsx': ['inline-style'],      // numeric translateX of the bar, shadcn original
  'web/src/components/ui/toggle-group.jsx': ['inline-style'],  // numeric spacing variable, shadcn original
  'web/src/components/ui/chart.jsx': ['inline-style', 'raw-hex'],  // series colour passed as a CSS variable value, and recharts' own default #ccc/#fff attribute selectors, shadcn original
};
const RULES = [
  ['raw-hex', /#[0-9a-fA-F]{3,8}\b/],
  ['inline-style', /style=\{\{/],
  ['palette', /\b(?:purple|violet|indigo|blue)-\d/],
  ['remote-url', /\b(?:src|href)=["']https?:\/\//]
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('vendored components use token colours, no inline styles, no remote assets', () => {
  const problems = [];
  for (const d of DIRS) for (const f of walk(path.join(root, d), [])) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    if (/\.tsx?$/.test(f)) problems.push(rel + ': TypeScript file, rename to JSX');
    for (const [name, re] of RULES) if (re.test(text) && !(ALLOW[rel] || []).includes(name)) problems.push(rel + ': ' + name);
  }
  assert.deepEqual(problems, []);
});
