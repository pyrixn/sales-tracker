const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

test('planSettings accepts any well-formed setting key, not only the old whitelist', () => {
  const st = { settings: {} };
  const plan = Core.sales.planSettings(st, { auto_match_max_bdt: '8000', msg_en_before: 'Hi {{name}}', discord_enabled: 'true' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops.map(o => o.id).sort(), ['auto_match_max_bdt', 'discord_enabled', 'msg_en_before']);
});

test('planSettings rejects malformed setting names and oversize values', () => {
  const st = { settings: {} };
  assert.match(Core.sales.planSettings(st, { 'Bad Key': 'x' }).errors[0], /Invalid setting name/);
  assert.match(Core.sales.planSettings(st, { '1abc': 'x' }).errors[0], /Invalid setting name/);
  assert.match(Core.sales.planSettings(st, { tos_text: 'x'.repeat(5001) }).errors[0], /too long/);
});

test('planSettings keeps its specific checks for known keys', () => {
  const st = { settings: {} };
  assert.match(Core.sales.planSettings(st, { usdt_bdt_manual: '-1' }).errors[0], /rate/i);
  assert.match(Core.sales.planSettings(st, { nagad_number: '12345' }).errors[0], /Nagad/);
});
