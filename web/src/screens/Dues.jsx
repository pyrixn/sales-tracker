import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Eye, Search, Wallet } from 'lucide-react';
import { call } from '@/lib/api';
import U from '@/lib/util';
import { saveText } from '@/lib/download';
import { plain, productShort, tk, toCsv } from '@/lib/format';
import { copyText, markReminders, reminderBlocks } from '@/lib/reminders';
import { notify, useApp, useInlineSave } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { useOpeners } from '@/sheets/openers';
import { Avatar, Chip, Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { BulkBar } from '@/components/BulkBar';
import { EditableDate, EditableNumber } from '@/components/inline';
import { SavedViews } from '@/components/SavedViews';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { oneOf } from '@/lib/savedViews';

const SORTS = ['late', 'amount', 'name'];
const BUCKETS = [
  ['all', 'All', () => true],
  ['current', 'Not late', x => !(x.daysLate > 0)],
  ['week', '1–7 days', x => x.daysLate >= 1 && x.daysLate <= 7],
  ['month', '8–30 days', x => x.daysLate >= 8 && x.daysLate <= 30],
  ['old', '30+ days', x => x.daysLate > 30]
];

// Paid till and price per month of one due, edited in place. Each saves on its own, so each has its own Undo.
// onOpenChange(key, open) tells the list which cells are open, so it holds the row order while one is.
function DueFields({ x, onOpenChange }) {
  const savePaidTill = useInlineSave('edit', v => ({ kind: 'sale', id: x.saleId, values: { Paid_Till: v } }));
  const savePrice = useInlineSave('edit', v => ({ kind: 'sale', id: x.saleId, values: { Unit_Price: v } }));
  // A total for all the months: the server turns it into the price per month (Total / (Months x Qty)).
  const saveTotal = useInlineSave('edit', v => ({ kind: 'sale', id: x.saleId, values: { Total: v } }));
  const target = x.name + (x.subCode ? ', ref ' + x.subCode : '');
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="inline-flex min-w-0 items-center gap-1">
        <span>Till</span>
        <EditableDate field="Paid till" target={target} value={x.paidTill} onSave={savePaidTill} placeholder="No end date" allowBlank={false}
          onEditingChange={open => onOpenChange(x.saleId + ':till', open)} />
      </span>
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
        <span>Price per month</span>
        <EditableNumber field="Price per month" target={target} value={x.unitPrice} onSave={savePrice} editHint="Changes what is owed."
          onEditingChange={open => onOpenChange(x.saleId + ':price', open)} />
        {x.months > 1 ? <span className="text-muted-foreground">{tk(U.round2(x.unitPrice * x.months)) + ' for ' + x.months + ' mo'}</span> : null}
      </span>
      {x.months > 1 && !x.custom ? (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
          <span>Total price</span>
          <EditableNumber field="Total price" target={target} value={U.round2(x.unitPrice * x.months)} onSave={saveTotal} editHint={'For all ' + x.months + ' months. Changes what is owed.'}
            onEditingChange={open => onOpenChange(x.saleId + ':total', open)} />
        </span>
      ) : null}
    </span>
  );
}

export function Dues() {
  const { today, reload } = useApp();
  const open = useOpeners();
  const read = useRead('dues');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('late');
  const [bucket, setBucket] = useState('all');
  const [openCells, setOpenCells] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set());   // saleIds ticked for a bulk action (string keys)
  const [copiedFor, setCopiedFor] = useState('');          // the selection key the reminder messages were copied for
  const [busy, setBusy] = useState(false);
  const frozenOrder = useRef(null);   // the saleIds in the order last shown while no cell was open
  const dq = useDeferredValue(q);

  // Saved views (uplift 3.5): applyView(null) is the Default view.
  const viewState = () => ({ q, sort, bucket });
  function applyView(s) {
    const v = s || {};
    setQ(typeof v.q === 'string' ? v.q : '');
    setSort(oneOf(v.sort, SORTS, 'late'));
    setBucket(oneOf(v.bucket, BUCKETS.map(b => b[0]), 'all'));
  }
  const onOpenChange = useCallback((key, open) => {
    setOpenCells(prev => { const n = new Set(prev); if (open) n.add(key); else n.delete(key); return n; });
  }, []);

  const d = read.data;
  const sorted = useMemo(() => {
    if (!d) return [];
    const s = dq.trim().toLowerCase();
    const test = BUCKETS.find(b => b[0] === bucket)[2];
    const rows = d.rows.filter(x => test(x) && (!s || x.name.toLowerCase().indexOf(s) >= 0 || String(x.subCode).toLowerCase().indexOf(s) >= 0 || String(x.productName).toLowerCase().indexOf(s) >= 0));
    rows.sort((a, b) => {
      if (sort === 'amount') return b.amount - a.amount;
      if (sort === 'name') return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
      if (a.daysLate === null && b.daysLate !== null) return 1;
      if (b.daysLate === null && a.daysLate !== null) return -1;
      return (b.daysLate || 0) - (a.daysLate || 0) || b.amount - a.amount;
    });
    return rows;
  }, [d, dq, sort, bucket]);
  // A row being edited must not move under the owner: while any cell is open, the order shown before it opened is kept.
  let filtered = sorted;
  if (openCells.size && frozenOrder.current) {
    const pos = new Map(frozenOrder.current.map((id, i) => [id, i]));
    const at = id => (pos.has(id) ? pos.get(id) : 1e12);
    filtered = sorted.slice().sort((a, b) => at(a.saleId) - at(b.saleId));
  } else {
    frozenOrder.current = sorted.map(x => x.saleId);
  }
  // The ticked dues that are on screen. A filter that hides a ticked due takes it out of the selection.
  const selected = filtered.filter(x => picked.has(String(x.saleId)));
  const selKey = selected.map(x => String(x.saleId)).join(',');

  if (read.loading) return <div className="mx-auto grid max-w-3xl gap-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (!d) return <div className="mx-auto max-w-3xl"><ErrorBox>{read.error}</ErrorBox></div>;

  async function copyReminder(x) {
    const r = await call('reminderMessage', { saleId: x.saleId, kind: x.kind || 'due' });
    if (!r.ok) { notify(r.error || 'Could not build the message'); return; }
    notify(await copyText(r.data.message) ? 'Copied reminder message' : r.data.message);
  }
  function exportCsv() {
    saveText('dues-' + today + '.csv', toCsv(['Customer', 'Product', 'Ref', 'Amount', 'Days late'],
      filtered.map(x => [x.name, x.productName, x.subCode, x.amount, x.daysLate === null ? '' : x.daysLate])));
    notify('Exported ' + filtered.length + ' dues');
  }

  function togglePick(id, on) {
    setCopiedFor('');   // a changed selection must be copied again before it can be marked
    setPicked(prev => { const n = new Set(prev); if (on) n.add(String(id)); else n.delete(String(id)); return n; });
  }
  function clearPicked() {
    setCopiedFor('');
    setPicked(new Set());
  }

  // One block per customer: a "--- Name ---" line, then that customer's messages, a blank line between messages and between customers.
  async function copyReminders() {
    const items = selected.slice();
    const key = selKey;
    setBusy(true);
    const built = await Promise.all(items.map(x => call('reminderMessage', { saleId: x.saleId, kind: x.kind || 'due' })));
    const rows = [];
    let failed = 0, firstError = '';
    built.forEach((r, i) => {
      if (!r.ok) { failed++; firstError = firstError || r.error; return; }
      rows.push({ customerId: items[i].customerId, name: items[i].name, message: r.data.message });
    });
    const made = items.length - failed;
    if (!made) { setBusy(false); notify(firstError || 'Could not build the messages'); return; }
    const text = reminderBlocks(rows);
    const ok = await copyText(text);
    setBusy(false);
    if (!ok) { open.message(text); notify('The browser blocked the clipboard. Copy the text from the sheet'); return; }
    setCopiedFor(key);
    notify('Copied ' + made + (made === 1 ? ' reminder message' : ' reminder messages') + (failed ? '. ' + failed + ' could not be built' : ''));
  }

  // Records each selected reminder as sent, one request at a time, each with its own request id. Stops at the first failure.
  async function markAllSent() {
    const items = selected.slice();
    setBusy(true);
    setCopiedFor('');
    const { marked, error } = await markReminders(items, 'sent');
    setBusy(false);
    setPicked(prev => new Set(Array.from(prev).filter(id => !marked.some(x => String(x.saleId) === id))));
    notify('Marked ' + marked.length + ' of ' + items.length + ' as sent' + (error ? '. Stopped: ' + error : ''));
    reload();
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      {read.error ? <ErrorBox>{read.error}</ErrorBox> : null}
      <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="eyebrow">Owed to you</div>
        <div className="hero-figure mt-2 text-[clamp(3.5rem,18vw,6.5rem)]"><span className="mr-1 align-top text-[0.38em] text-muted-foreground">৳</span>{plain(d.total)}</div>
        <div className="mt-3 text-sm text-muted-foreground">{d.rows.length + ' unpaid'}{d.credits.length ? ' · ' + d.credits.length + ' holding credit' : ''}</div>
      </section>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input id="dueSearch" type="search" placeholder="Search dues" aria-label="Search dues" autoComplete="off" className="h-11 pl-9" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="w-36 shrink-0">
          <NativeSelect id="dueSort" aria-label="Sort dues" className="h-11" value={sort} onChange={e => setSort(e.target.value)}>
            <NativeSelectOption value="late">Oldest first</NativeSelectOption>
            <NativeSelectOption value="amount">Largest first</NativeSelectOption>
            <NativeSelectOption value="name">Name A–Z</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      <SavedViews screenKey="dues" getState={viewState} applyState={applyView} />

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="How late">
        {BUCKETS.map(([k, label, test]) => <Chip key={k} pressed={bucket === k} onClick={() => setBucket(k)} className="shrink-0">{label + ' · ' + d.rows.filter(test).length}</Chip>)}
      </div>

      <Section title="Owed to you" icon={Wallet} count={tk(filtered.reduce((a, x) => a + x.amount, 0))} testId="dues-list"
        action={<Button type="button" variant="ghost" size="icon-sm" onClick={exportCsv} aria-label="Export these dues as CSV"><Download /></Button>}>
        {filtered.length ? filtered.map(x => {
          const late = x.daysLate === null ? 'no date' : x.daysLate > 0 ? x.daysLate + 'd late' : 'not due yet';
          return (
            <Row key={x.saleId} wrap lead={<Avatar name={x.name} />}
              title={<button type="button" className="max-w-full truncate text-left hover:underline" onClick={() => open.customer(x.customerId)}>{x.name}</button>}
              detail={(
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{productShort(x.productName) + (x.subCode ? ' · ref ' + x.subCode : '')}<Pill tone={x.daysLate > 0 ? 'bad' : 'muted'}>{late}</Pill></span>
                  <span data-cell-group="" className="block"><DueFields x={x} onOpenChange={onOpenChange} /></span>
                </span>
              )}
              trail={(
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {/* The tick sits beside the amount: its 40px hit area takes no extra width, so the row keeps its room on a phone.
                      A custom sale is never reminded (owner decision 2026-10-26), so it has no tick, Preview or Copy. */}
                  <span className="flex items-center gap-2">
                    {x.custom ? null : <span className="-m-3 grid place-items-center p-3"><Checkbox aria-label={'Select due for ' + x.name} checked={picked.has(String(x.saleId))} onCheckedChange={v => togglePick(x.saleId, !!v)} /></span>}
                    <span className="money text-sm font-bold">{tk(x.amount)}</span>
                  </span>
                  <div className="flex items-center gap-1">
                    {x.custom ? null : (
                      <>
                        <Button type="button" size="icon-sm" variant="ghost" onClick={() => open.reminder({ saleId: x.saleId, kind: x.kind || 'due', customerId: x.customerId })} aria-label="Preview reminder" title="Preview reminder"><Eye /></Button>
                        <Button type="button" size="icon-sm" variant="outline" data-testid="due-copy" onClick={() => copyReminder(x)} aria-label="Copy reminder message" title="Copy reminder message"><Copy /></Button>
                      </>
                    )}
                    <Button type="button" size="sm" data-testid="due-pay" onClick={() => open.pay({ customerId: x.customerId, saleId: x.saleId, amount: x.amount })}><Check />Paid</Button>
                  </div>
                </div>
              )} />
          );
        }) : <Empty art={dq || bucket !== 'all' ? undefined : 'receipt'}>{dq || bucket !== 'all' ? 'No dues match.' : 'Nobody owes you anything.'}</Empty>}
      </Section>

      {d.credits.length ? (
        <Section title="Credit you hold" count={d.credits.length}>
          {d.credits.map(c => (
            <Row key={c.customerId} onClick={() => open.customer(c.customerId)} lead={<Avatar name={c.name} />} title={c.name} detail="used on next renewal"
              trail={<span className="money text-sm font-semibold text-ok">{tk(c.amount)}</span>} />
          ))}
        </Section>
      ) : null}
      <BulkBar count={selected.length} onClear={clearPicked}>
        <Button type="button" variant="outline" size="sm" data-testid="bulk-copy-reminders" onClick={copyReminders} disabled={busy}><Copy />Copy reminder messages</Button>
        {selected.length && copiedFor === selKey ? (
          <Button type="button" size="sm" data-testid="bulk-mark-sent" onClick={markAllSent} disabled={busy}><Check />Mark all sent</Button>
        ) : null}
      </BulkBar>
    </div>
  );
}
