import { useMemo, useState } from 'react';
import { Check, ExternalLink, Hourglass, PackageCheck, RotateCw, Send, X } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { exactTime, relTime } from '@/lib/format';
import { notify, useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { Avatar, Chip, Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_TONE = { Pending: 'warn', Ready: 'warn', Delivered: 'ok', Failed: 'bad' };
const KIND = { code: 'Key', seat: 'Seat' };
const FILTERS = [['all', 'All'], ['Pending', 'Pending'], ['Ready', 'Ready'], ['Delivered', 'Delivered'], ['Failed', 'Failed']];
// Move to any other status; the label names where the row goes.
const MOVES = [['Ready', 'Mark ready', RotateCw], ['Delivered', 'Mark delivered', Check], ['Failed', 'Mark failed', X]];

const httpsOnly = v => (/^https:\/\/[^\s"'<>`\\]+$/i.test(String(v || '').trim()) ? String(v).trim() : '');

/** The message the owner pastes to the customer. It points at the order page, where the receipt shows the key; it never contains the key. */
export function deliveryMessage(row, settings) {
  const s = settings || {};
  const lines = ['Hi ' + (row.customerName || 'there') + ', thanks for your order (' + row.productName + ').'];
  if (row.orderUrl) lines.push('Your order and receipt: ' + row.orderUrl);
  if (String(s.tos_text || '').trim()) lines.push('', String(s.tos_text).trim());
  const reviews = [['Discord', s.review_discord_url], ['Facebook', s.review_facebook_url]].map(([n, u]) => [n, httpsOnly(u)]).filter(x => x[1]);
  if (reviews.length) lines.push('', 'Please leave a review:', ...reviews.map(([n, u]) => n + ': ' + u));
  return lines.join('\n');
}

export function Delivery() {
  const { lookups, reload, invalidate } = useApp();
  const read = useRead('deliveries');
  const allRows = useMemo(() => (read.data ? read.data.rows : []), [read.data]);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState('');

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? allRows.length : allRows.filter(r => r.Status === k).length])), [allRows]);
  const rows = useMemo(() => allRows.filter(r => filter === 'all' || r.Status === filter), [allRows, filter]);

  if (read.loading) return <div className="mx-auto grid max-w-3xl gap-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (!read.data) return <div className="mx-auto max-w-3xl"><ErrorBox>{read.error}</ErrorBox></div>;

  async function move(r, status) {
    setBusy(r.Delivery_ID);
    try {
      const res = await call('setDelivery', { id: r.Delivery_ID, status, requestId: rid() });
      notify(res.ok ? res.data.message : res.error);
      if (res.ok) { invalidate(); reload(); }
    } catch (e) {
      notify(String((e && e.message) || e));
    } finally {
      setBusy('');
    }
  }
  async function resend(r) {
    const text = deliveryMessage(r, lookups && lookups.settings);
    try { await navigator.clipboard.writeText(text); notify('Copied the delivery message for ' + r.customerName); } catch (e) { notify(text); }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      {read.error ? <ErrorBox>{read.error}</ErrorBox> : null}
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Delivery status">
        {FILTERS.map(([k, label]) => <Chip key={k} pressed={filter === k} onClick={() => setFilter(k)} className="shrink-0">{label + ' · ' + counts[k]}</Chip>)}
      </div>
      <Section title="Deliveries" icon={PackageCheck} count={rows.length} testId="delivery-list">
        {rows.length ? rows.map(r => (
          <Row key={r.Delivery_ID} wrap stack testId={'delivery-' + r.Delivery_ID} lead={<Avatar name={r.customerName || '?'} />}
            title={r.customerName || 'No name'}
            detail={(<>{r.productName + ' · ' + (KIND[r.kind] || r.kind)}
              {r.Delivered_At ? <>{' · '}<time title={exactTime(r.Delivered_At)}>{relTime(r.Delivered_At)}</time></> : null}{r.Note ? ' · ' + r.Note : ''}</>)}
            trail={(
              <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                <Pill tone={STATUS_TONE[r.Status] || 'muted'}>{r.Status}</Pill>
                {MOVES.filter(([s]) => s !== r.Status).map(([s, label, Icon]) => (
                  <Button key={s} type="button" size="sm" variant={s === 'Delivered' ? 'default' : 'outline'} disabled={busy === r.Delivery_ID} onClick={() => move(r, s)}><Icon />{label}</Button>
                ))}
                <Button type="button" size="sm" variant="outline" onClick={() => resend(r)}><Send />Resend</Button>
                {r.orderUrl ? <Button asChild size="sm" variant="ghost"><a href={r.orderUrl} target="_blank" rel="noopener"><ExternalLink />Open order</a></Button> : null}
              </div>
            )} />
        )) : <Empty art={filter === 'all' ? 'receipt' : undefined}>{filter === 'all' ? 'Nothing to deliver. Paid links show up here.' : 'Nothing here.'}</Empty>}
      </Section>
      {allRows.some(r => r.Status === 'Pending') ? (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Hourglass className="size-3.5" aria-hidden="true" />Pending means paid but not handed over yet. Resend copies the order link, not the key.</p>
      ) : null}
    </div>
  );
}
