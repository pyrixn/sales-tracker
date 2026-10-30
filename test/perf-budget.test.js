// Performance budgets: every action listed under "Budgets" in docs/perf.md must stay within its numbers.
// Numbers come from tools/measure.js over a seeded fake db. ms is reported but never gated (too noisy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PERF = path.join(__dirname, '..', 'docs', 'perf.md');

function readBudgets() {
  assert.ok(fs.existsSync(PERF), 'docs/perf.md is missing. Run: node tools/measure.js');
  const text = fs.readFileSync(PERF, 'utf8');
  const at = text.indexOf('## Budgets');
  assert.ok(at >= 0, 'docs/perf.md has no "## Budgets" section');
  const out = {};
  text.slice(at).split('\n').slice(1).forEach(line => {
    const c = line.split('|').map(s => s.trim());
    if (c.length < 5 || !/^[a-zA-Z]+$/.test(c[1]) || c[1] === 'action') return;
    out[c[1]] = { queries: Number(c[2]), rows: Number(c[3]), bytes: Number(c[4]), roundTrips: Number(c[5]) };
  });
  return out;
}

test('perf budgets file exists and every action in it is within budget', async () => {
  const budgets = readBudgets();
  const names = Object.keys(budgets);
  assert.ok(names.length > 0, 'Budgets table is empty');
  const { measureAction } = require('../tools/measure');
  for (const name of names) {
    const m = await measureAction(name, { runs: 1 });
    assert.equal(m.error, undefined, name + ' errored: ' + m.error);
    for (const k of ['queries', 'rows', 'bytes', 'roundTrips']) {
      assert.ok(m[k] <= budgets[name][k], name + ' ' + k + ' ' + m[k] + ' exceeds budget ' + budgets[name][k]);
    }
  }
});
