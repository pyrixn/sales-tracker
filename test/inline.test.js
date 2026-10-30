// web/src/lib/inline.js: the rules behind inline edit cells (no-op, idempotent saves, one at a time, undo gating).
const test = require('node:test');
const assert = require('node:assert/strict');

async function lib() { return import('../web/src/lib/inline.js'); }

function fakeDeps(replies) {
  const sent = [];
  let n = 0;
  const deps = {
    rid: () => 'id-' + (++n),
    call: async (action, payload) => {
      sent.push({ action, payload });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    notify: (msg, opts) => { deps.toasts.push({ msg, opts }); },
    reload: () => { deps.reloads++; },
    invalidate: () => { deps.invalidates++; },
    toasts: [], reloads: 0, invalidates: 0
  };
  return { deps, sent };
}

test('sameValue treats empty and null alike, trims text, and compares numbers as the server stores them', async () => {
  const { sameValue } = await lib();
  assert.equal(sameValue('', null), true);
  assert.equal(sameValue(undefined, ''), true);
  assert.equal(sameValue(' Rafi ', 'Rafi'), true);
  assert.equal(sameValue(1000, '1000'), true);
  assert.equal(sameValue('2026-10-18', '2026-10-19'), false);
  assert.equal(sameValue(0, ''), false);
});

test('a successful save sends one edit, offers Undo for its own batch, and reloads', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([{ ok: true, data: { changed: true, batchId: 'b1', message: 'Changes saved' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ kind: 'sale', id: 7, values: { Paid_Till: v } }));
  const r = await save('2026-11-04', { message: 'Paid till: 2026-11-04 (was 2026-10-04)' });
  assert.deepEqual(r, { ok: true, changed: true, message: 'Paid till: 2026-11-04 (was 2026-10-04)' });
  assert.deepEqual(sent, [{ action: 'edit', payload: { kind: 'sale', id: 7, values: { Paid_Till: '2026-11-04' }, requestId: 'id-1' } }]);
  assert.equal(deps.toasts[0].opts.batchId, 'b1');
  assert.equal(deps.toasts[0].opts.undo, true);
  assert.equal(deps.toasts[0].opts.onUndo, deps.reload);
  assert.equal(deps.reloads, 1);
  assert.equal(deps.invalidates, 1);
});

test('a save that changed nothing shows a plain toast with no Undo', async () => {
  const { createInlineSave } = await lib();
  const { deps } = fakeDeps([{ ok: true, data: { changed: false, message: 'Changes saved' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ kind: 'customer', id: 'C1', values: { Name: v } }));
  await save('Rafi');
  assert.equal(deps.toasts[0].opts, undefined);
});

test('opts.undo false keeps Undo off even when the save changed something', async () => {
  const { createInlineSave } = await lib();
  const { deps } = fakeDeps([{ ok: true, data: { changed: true, batchId: 'b2' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ v }), { undo: false });
  await save('x');
  assert.equal(deps.toasts[0].opts.undo, false);
});

test('a refused save returns its error and does not reload', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([{ ok: false, error: 'Date must be like 2026-10-18.' }]);
  const save = createInlineSave(deps, 'edit', v => ({ v }));
  const r = await save('2026-13-40');
  assert.deepEqual(r, { ok: false, error: 'Date must be like 2026-10-18.' });
  assert.equal(sent.length, 1);
  assert.equal(deps.reloads, 0);
});

test('a retry of the same payload after a lost reply reuses the requestId', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([new Error('network down'), { ok: true, data: { changed: true, batchId: 'b3' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ v: Number(v) }));
  assert.equal((await save('300')).ok, false);
  assert.equal((await save('300')).ok, true);
  assert.equal(sent[0].payload.requestId, sent[1].payload.requestId);
});

test('a changed value after a refusal gets a new requestId', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([{ ok: false, error: 'Price must be 0 or more.' }, { ok: true, data: { changed: true, batchId: 'b4' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ v: Number(v) }));
  await save('-1');
  await save('250');
  assert.notEqual(sent[0].payload.requestId, sent[1].payload.requestId);
});

test('after a success the next save is a new write, even with the same payload', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([{ ok: true, data: { changed: true, batchId: 'b5' } }, { ok: true, data: { changed: true, batchId: 'b6' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ v }));
  await save('a');
  await save('a');
  assert.notEqual(sent[0].payload.requestId, sent[1].payload.requestId);
});

test('a second save while one is in flight is refused and sends nothing', async () => {
  const { createInlineSave } = await lib();
  let release;
  const sent = [];
  const deps = {
    rid: () => 'r', notify() {}, reload() {}, invalidate() {},
    call: (action, payload) => { sent.push(payload); return new Promise(res => { release = () => res({ ok: true, data: { changed: true, batchId: 'b' } }); }); }
  };
  const save = createInlineSave(deps, 'edit', v => ({ v }));
  const first = save('one');
  const second = await save('two');
  assert.equal(second.skipped, true);
  assert.equal(sent.length, 1);
  release();
  assert.equal((await first).ok, true);
});

test('a build error is returned as the error and nothing is sent', async () => {
  const { createInlineSave } = await lib();
  const { deps, sent } = fakeDeps([]);
  const save = createInlineSave(deps, 'edit', () => { throw new Error('Name cannot be empty.'); });
  assert.deepEqual(await save(''), { ok: false, error: 'Name cannot be empty.' });
  assert.equal(sent.length, 0);
});

test('opts given as a function that returns nothing still offers Undo by default', async () => {
  const { createInlineSave } = await lib();
  const { deps } = fakeDeps([{ ok: true, data: { changed: true, batchId: 'b7' } }]);
  const save = createInlineSave(deps, 'edit', v => ({ v }), () => undefined);
  await save('x');
  assert.equal(deps.toasts[0].opts.undo, true);
});

test('isRealDate accepts days that exist and refuses 2026-02-30 and 2026-13-45 (the server applies the same rule)', async () => {
  const { isRealDate } = await lib();
  assert.equal(isRealDate('2026-10-18'), true);
  assert.equal(isRealDate('2028-02-29'), true);
  assert.equal(isRealDate('2026-02-30'), false);
  assert.equal(isRealDate('2026-13-45'), false);
  assert.equal(isRealDate('18/10/2026'), false);
  assert.equal(isRealDate(''), false);
});
