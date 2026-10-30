// Inline edit saves: plain functions, no React and no DOM, so the rules are unit-tested in test/inline.test.js.
// components/inline.jsx compares a draft with the shown value before it saves, so an unchanged value sends nothing.
// store.jsx's useInlineSave is createInlineSave wired to the real call, notify, reload and invalidate.

/** Comparable form of a value: null and undefined are empty, strings are trimmed. */
export function norm(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

/** A YYYY-MM-DD date that exists on the calendar: 2026-02-30 and 2026-13-45 match the shape but are refused (same rule as src/core/sales.js). */
export function isRealDate(v) {
  const s = norm(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

/** True when two values are the same as far as the server would store them ('' and null are the same, 1000 and '1000' too). */
export function sameValue(a, b) {
  return norm(a) === norm(b);
}

/**
 * createInlineSave(deps, action, build, opts) -> save(next, meta) -> Promise<{ ok, changed?, message?, error?, skipped? }>
 * deps: { call, rid, notify, reload, invalidate }. build(next) returns the payload without requestId; it may throw an Error
 * whose message is shown. opts (or a function returning it): { undo } (default true).
 *
 * - One save at a time: a save started while another is in flight is refused with skipped: true and sends nothing.
 * - Idempotent: the same payload keeps one requestId, so a retry after a lost reply writes once. A different payload gets a new id,
 *   and a success clears the id (the next save is a new write). A refused save keeps its id for a retry of the same payload.
 * - Undo is offered only when the server says the save changed something and names its batch (changed, batchId).
 * - After a save the caller's reads are invalidated and reloaded, so every screen shows the stored value.
 */
export function createInlineSave(deps, action, build, opts) {
  let current = null;   // { key, requestId } of the save that is open (not yet answered with ok)
  let busy = false;
  return async function save(next, meta) {
    if (busy) return { ok: false, skipped: true, error: '' };
    let payload;
    try { payload = build(next); } catch (e) { return { ok: false, error: (e && e.message) || 'Could not save.' }; }
    const key = JSON.stringify(payload);
    if (!current || current.key !== key) current = { key, requestId: deps.rid() };
    const requestId = current.requestId;
    busy = true;
    let r;
    try { r = await deps.call(action, Object.assign({}, payload, { requestId })); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    busy = false;
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not save.' };
    current = null;
    const data = r.data || {};
    const o = (typeof opts === 'function' ? opts() : opts) || {};
    const changed = data.changed === true;
    const message = (meta && meta.message) || data.message || 'Saved';
    if (changed && data.batchId) deps.notify(message, { undo: o.undo !== false, batchId: data.batchId, onUndo: deps.reload });
    else deps.notify(message);
    deps.invalidate();
    deps.reload();
    return { ok: true, changed, message };
  };
}
