// Small readers for planner results ({ops, result, errors}).
const opsFor = (r, tab) => r.ops.filter(o => o.tab === tab);
const appendsOf = (r, tab) => r.ops.filter(o => o.op === 'append' && o.tab === tab);
const appendOf = (r, tab) => appendsOf(r, tab)[0];
const updateOf = (r, id) => r.ops.find(o => o.op === 'update' && o.id === id);
const ok = r => { if (r.errors && r.errors.length) throw new Error('Unexpected errors: ' + r.errors.join(' | ')); return r; };
module.exports = { opsFor, appendsOf, appendOf, updateOf, ok };
