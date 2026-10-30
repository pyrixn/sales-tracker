import { useEffect, useState } from 'react';
import { Bell, Link2, MessageCircle, Merge, NotebookPen, Pencil, Plus, RotateCw, Wallet } from 'lucide-react';
import { call } from '@/lib/api';
import { CHANNELS, fullDate, payText, payUrl, plain, productShort, tk, whatsappLink } from '@/lib/format';
import { customerStats, customerTimeline } from '@/lib/customerStats';
import { notify, useApp, useInlineSave, useSaver } from '@/lib/store';
import { EditableNote, EditableSelect, EditableText } from '@/components/inline';
import { PaymentCells } from '@/components/money-cells';
import { CopyId } from '@/components/CopyId';
import { Avatar, ConfirmButton, DaysPill, Empty, Hint, Row, Section, Stack } from '@/components/kit';
import { Button } from '@/components/ui/button';

/** The `customer` read for one id. Keeps the last answer for the same id while a refresh is on its way (after any save);
 *  a different id shows loading at once, so the workspace never shows the previous customer under the new name.
 *  strict: a customer that is gone (merged away) is not kept on screen, the answer is the error. */
export function useCustomerData(id, { strict = false } = {}) {
  const { lookups } = useApp();
  const [state, setState] = useState({ id: null, error: '', data: null });
  useEffect(() => {
    let live = true;
    call('customer', { id }).then(r => {
      if (!live) return;
      const gone = strict && !r.ok && /^Unknown customer/.test(String(r.error || ''));
      setState(prev => (r.ok ? { id, error: '', data: r.data } : prev.id === id && prev.data && !gone ? prev : { id, error: r.error, data: null }));
    });
    return () => { live = false; };
  }, [id, lookups, strict]);
  if (state.id !== id) return { loading: true, error: '', data: null };
  return { loading: false, error: state.error, data: state.data };
}

/** Void one subscription line. Goes through useSaver, so a double tap is one request (one request id, one audit batch) and Undo comes from the toast. */
function VoidLine({ saleId, subCode }) {
  const { save, busy, error } = useSaver('edit', () => ({ kind: 'sale', id: saleId, values: { Record_Status: 'Void' } }), { stay: true });
  return (
    <>
      <ConfirmButton variant="ghost" className="h-7 gap-1 rounded-md px-2.5 text-[0.8rem] text-bad hover:text-bad" label="Void" title={'Void ' + subCode + '?'} confirmLabel="Void line"
        description="Void means it was entered by mistake. It leaves the totals and the lists; nothing is deleted. You can undo this right after from the toast."
        disabled={busy} onConfirm={save} />
      {error ? <span role="alert" className="text-xs font-semibold text-bad">{error}</span> : null}
    </>
  );
}

/** The body of a customer: header figures, the action buttons, Subscriptions, Custom sales, Payments and Older sales.
 *  Used by the customer sheet (phone and any caller) and by the customer workspace (wide: `wide` adds the ID chip, the
 *  headline stats and the timeline). `data` is the `customer` read. */
export function CustomerDetail({ data: d, openers, wide = false }) {
  const { lookups } = useApp();
  const c = d.customer;
  const paidTotal = d.payments.reduce((a, p) => a + Number(p.amount || 0), 0);
  const base = String((lookups.settings && lookups.settings.pay_base_url) || window.location.origin).replace(/\/+$/, '');
  const lang = (lookups.settings && lookups.settings.language) || 'en';
  const linkLine = d.lines.find(l => l.payToken && l.owes) || d.lines.find(l => l.payToken);
  const link = linkLine ? payUrl(base, linkLine.payToken) : '';
  const message = linkLine ? payText(lang, c.Name, productShort(linkLine.productName), link) : '';
  const wa = whatsappLink(c.Channel, c.Handle);
  const waHref = wa && message ? wa + '?text=' + encodeURIComponent(message) : wa;

  async function copyLink() {
    try { await navigator.clipboard.writeText(link); notify('Copied the pay link for ' + c.Name); } catch (e) { notify(link); }
  }

  return (
    <Stack>
      <div className="rounded-xl border border-border bg-card/80 p-4">
        <div className="flex items-start gap-3">
          <Avatar name={c.Name} className="size-12 text-sm" />
          <CustomerInline c={c} />
          <Button id="editCust" type="button" variant="outline" size="sm" onClick={() => openers.editCustomer(c)}><Pencil />Edit</Button>
        </div>
        {wide ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="eyebrow">ID</span>
            <CopyId value={c.Customer_ID} label="customer ID" className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" />
          </div>
        ) : null}
        <div className="mt-5 grid grid-cols-[1fr_auto] items-end gap-x-4">
          <div>
            <div className="eyebrow">Owes</div>
            <div className={'hero-figure mt-1 text-6xl ' + (d.owes ? 'text-bad' : 'text-ok')}><span className="mr-1 align-top text-[0.4em] text-muted-foreground">৳</span>{plain(d.owes)}</div>
          </div>
          <div className="text-right">
            <div className="eyebrow">Paid to date</div>
            <div className="money mt-1 text-sm font-semibold">{tk(paidTotal)}</div>
            {d.credit > 0 ? <div className="money mt-1 text-xs font-semibold text-ok">{'credit ' + tk(d.credit)}</div> : null}
          </div>
        </div>
        <CustomerNotes c={c} />
      </div>

      {wide ? <CustomerStats d={d} /> : null}

      <div className="grid grid-cols-2 gap-2">
        <Button id="custPay" type="button" size="lg" className="font-extrabold" onClick={() => openers.pay(c.Customer_ID)}><Wallet />Got paid</Button>
        <Button id="custNew" type="button" size="lg" variant="outline" className="font-bold" onClick={() => openers.newSale({ customerId: c.Customer_ID })}><Plus />New sale</Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button id="custNote" type="button" variant="outline" size="sm" className="font-bold" onClick={() => openers.customerNote(c)}><NotebookPen />Note</Button>
        <Button id="custMerge" type="button" variant="outline" size="sm" className="font-bold"
          onClick={() => openers.mergeCustomer({ Customer_ID: c.Customer_ID, Name: c.Name, sales: d.history.length, payments: d.payments.length })}><Merge />Merge</Button>
        <Button id="custLink" type="button" variant="outline" size="sm" className="font-bold" disabled={!link} onClick={copyLink}><Link2 />Pay link</Button>
      </div>
      {waHref ? (
        <Button asChild variant="outline" className="font-bold">
          <a href={waHref} target="_blank" rel="noopener"><MessageCircle />{message ? 'Send pay link on WhatsApp' : 'Message on WhatsApp'}</a>
        </Button>
      ) : null}

      <Section title="Subscriptions" count={d.lines.length}>
        {d.lines.length ? d.lines.map(l => {
          const sale = d.history.find(h => h.saleId === l.saleId);
          return (
            <Row key={l.saleId} testId={'line-' + l.subCode} wrap stack
              title={l.productName}
              detail={(l.accountId || '') + ' · ref ' + l.subCode + ' · ' + (l.paidTill ? 'till ' + l.paidTill : 'no end') + (l.owes ? ' · owes ' + tk(l.owes) : '')}
              trail={(
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  <DaysPill days={l.daysLeft} />
                  {l.paidTill ? <Button type="button" size="sm" onClick={() => openers.renew(l.subCode)}><RotateCw />Renew</Button> : null}
                  {l.paidTill || l.owes ? <Button type="button" size="sm" variant="ghost" onClick={() => openers.reminder({ saleId: l.saleId, kind: l.kind, customerId: c.Customer_ID })}><Bell />Remind</Button> : null}
                  <Button type="button" size="sm" variant="ghost" onClick={() => openers.editSale(sale)}>Edit</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => openers.endLine(sale)}>End line</Button>
                  <VoidLine saleId={l.saleId} subCode={l.subCode} />
                </div>
              )} />
          );
        }) : <Empty>No active subscriptions.</Empty>}
      </Section>

      {d.customSales.length ? (
        <Section title="Custom sales" count={d.customSales.length}>
          {d.customSales.map(x => {
            const sale = d.history.find(h => h.saleId === x.saleId);
            return (
              <Row key={x.saleId} testId={'custom-' + x.saleId} wrap stack
                title={x.productName}
                detail={(x.saleDate ? x.saleDate + ' · ' : '') + tk(x.price) + (x.owes ? ' · owes ' + tk(x.owes) : '')}
                trail={(
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => openers.editSale(sale)}>Edit</Button>
                    <VoidLine saleId={x.saleId} subCode={x.productName} />
                  </div>
                )} />
            );
          })}
        </Section>
      ) : null}

      <Section title="Payments" count={d.payments.length}>
        {d.payments.length ? (
          <div data-cell-group="" className="divide-y divide-border">
            {d.payments.slice(0, 30).map(p => (
              <div key={p.paymentId} data-testid={'pay-' + p.paymentId} className="grid gap-2 px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{p.saleId === '' ? 'Credit' : 'Sale #' + p.saleId}</div>
                    {p.trx ? <div className="truncate font-mono text-xs text-muted-foreground">{p.trx}</div> : null}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => openers.editPayment({ ...p, lines: d.history })}>Edit</Button>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
                  <PaymentCells id={p.paymentId} target={'payment ' + p.paymentId} amount={p.amount} date={p.date} method={p.method}
                    note={p.note} locked={p.locked} />
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>No payments yet.</Empty>}
      </Section>

      {d.history.length ? (
        <details className="rounded-xl border border-border bg-card/80">
          <summary className="cursor-pointer px-4 py-3 text-sm font-extrabold">{'Older sales (' + d.history.length + ')'}</summary>
          <div className="divide-y divide-border border-t border-border">
            {d.history.map(h => (
              <Row key={h.saleId} title={'#' + h.saleId + ' ' + productShort(h.productName)}
                detail={h.status + ' · ' + (h.paidTill || '—') + ' · ' + tk(h.price) + ' × ' + h.months}
                trail={<Button type="button" size="sm" variant="ghost" onClick={() => openers.editSale(h)}>Edit</Button>} />
            ))}
          </div>
        </details>
      ) : null}

      {wide ? <CustomerTimeline d={d} /> : null}
    </Stack>
  );
}

// Headline figures for the workspace. Four tiles, each a label and a value; the value is text, so colour is never the only signal.
function CustomerStats({ d }) {
  const s = customerStats(d);
  const tiles = [
    ['Lifetime revenue', tk(s.lifetime), 'cust-stat-revenue', 'Billed price x months, Void and Refunded left out'],
    ['Lines active', String(s.lines), 'cust-stat-lines', 'Active subscriptions'],
    ['Avg days late', s.avgLate === null ? '—' : s.avgLate + ' days', 'cust-stat-late', 'Average days past Paid till over the lines that still owe money'],
    ['First sale', s.firstSale ? fullDate(s.firstSale) : '—', 'cust-stat-first', 'Earliest Sale date']
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {tiles.map(([label, value, testId, title]) => (
        <div key={testId} data-testid={testId} title={title} className="rounded-xl border border-border bg-card/80 px-4 py-3">
          <dt className="eyebrow">{label}</dt>
          <dd className="money mt-1 text-lg font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Newest first: each row has its date, a text kind label (Sale or Payment) and what happened.
function CustomerTimeline({ d }) {
  const items = customerTimeline(d);
  return (
    <>
      <Section title="Timeline" count={items.length} testId="cust-timeline">
        {items.length ? items.map(it => (
          <div key={it.key} data-testid="timeline-item" data-kind={it.kind} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-3 px-4 py-3">
            <span className="text-xs text-muted-foreground">{it.date ? fullDate(it.date) : 'No date'}</span>
            <div className="min-w-0">
              <div className="eyebrow">{it.kind === 'sale' ? 'Sale' : 'Payment'}</div>
              <div className="truncate text-sm font-bold">{it.title}</div>
              <div className="money truncate text-xs text-muted-foreground">{it.detail}</div>
            </div>
          </div>
        )) : <Empty>No sales or payments yet.</Empty>}
      </Section>
      <Hint>Reminders and deliveries are not in this view yet, so the timeline shows sales and payments only.</Hint>
    </>
  );
}

// Name, channel and handle, edited in place. Each cell saves on its own (its own save and Undo).
function CustomerInline({ c }) {
  const saveName = useInlineSave('edit', v => ({ kind: 'customer', id: c.Customer_ID, values: { Name: v } }));
  const saveChannel = useInlineSave('edit', v => ({ kind: 'customer', id: c.Customer_ID, values: { Channel: v } }));
  const saveHandle = useInlineSave('edit', v => ({ kind: 'customer', id: c.Customer_ID, values: { Handle: v } }));
  const channels = [{ value: '', label: 'Not set' }, ...CHANNELS.map(x => ({ value: x, label: x }))];
  return (
    <div className="grid min-w-0 flex-1 gap-3">
      <div className="min-w-0">
        <div className="eyebrow">Name</div>
        <EditableText field="Name" target={c.Name} value={c.Name} onSave={saveName} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="eyebrow">Channel</div>
          <EditableSelect field="Channel" target={c.Name} value={c.Channel || ''} options={channels} onSave={saveChannel} allowBlank />
        </div>
        <div className="min-w-0">
          <div className="eyebrow">Handle</div>
          <EditableText field="Handle" target={c.Name} value={c.Handle || ''} onSave={saveHandle} allowBlank placeholder="Not added" />
        </div>
      </div>
    </div>
  );
}

function CustomerNotes({ c }) {
  const saveNotes = useInlineSave('edit', v => ({ kind: 'customer', id: c.Customer_ID, values: { Notes: v } }));
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="eyebrow">Notes</div>
      <EditableNote field="Notes" target={c.Name} value={c.Notes || ''} onSave={saveNotes} placeholder="Add a note" />
    </div>
  );
}
