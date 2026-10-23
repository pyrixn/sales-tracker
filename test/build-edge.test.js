const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('generated edge bundle contains no carriage returns', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build-edge.js')], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(root, 'supabase', 'functions', 'api', 'index.ts'), 'utf8');
  assert.ok(!text.includes('\r'), 'bundle has a carriage return');
});
