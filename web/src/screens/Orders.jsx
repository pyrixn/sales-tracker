import { useMemo, useState } from 'react';
import { Copy, Plus, ShoppingBag } from 'lucide-react';
import { notify, useApp } from '@/lib/store';
import { tk } from '@/lib/format';
import { useRead } from '@/lib/useRead';
import { useOpeners } from '@/sheets/openers';
import { moveOrder } from '@/sheets/orders';
import { ConfirmButton, Chip, Empty, ErrorBox, Pill } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const LABEL = { New: 'New', AwaitingPayment: 'Awaiting payment', Paid: 'Paid', Fulfilled: 'Fulfilled', Cancelled: 'Cancelled' };
const TONE = { New: 'warn', AwaitingPayment: 'warn', Paid: 'ok', Fulfilled: 'ok', Cancelled: 'muted' };
const FILTERS = [['all', 'All'], ['New', 'New'], ['AwaitingPayment', 'Awaiting'], ['Paid', 'Paid'], ['Fulfilled', 'Fulfilled'], ['Cancelled', 'Cancelled']];

async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); notify('Pay link copied'); } catch (e) { notify(url); }
}

/** The buttons a status allows. Paid is set once the pay link is paid; fulfilling creates the sale. */
function Actions({ o, onMove, onFulfil, onConfirm }) {
  const open = o.status === 'New' || o.status === 'AwaitingPayment';
  return (
    <div className="flex flex-wrap items-center gap-2">
      {o.payUrl && open ? <Button type="button" variant="outline" size="sm" onClick={() => copyLink(o.payUrl)}><Copy />Copy pay link</Button> : null}
      {o.status === 'New' ? <Button type="button" variant="outline" size="sm" onClick={() => onMove(o, 'AwaitingPayment')}>Link sent</Button> : null}
      {open && o.payRequestStatus === 'Open' ? <Button type="button" variant="outline" size="sm" onClick={() => onConfirm(o)}>Confirm payment</Button> : null}
      {open && o.payRequestStatus === 'Paid' ? <Button type="button" size="sm" onClick={() => onMove(o, 'Paid')}>Mark paid</Button> : null}
      {o.status === 'Paid' ? <Button type="button" size="sm" onClick={() => onFulfil(o)}>Fulfil</Button> : null}
      {open ? (
        <ConfirmButton id={'cancel-' + o.id} label="Cancel order" title={'Cancel ' + o.id + '?'}
          description="The order is cancelled and its open pay link stops working. Paid orders cannot be cancelled here."
          confirmLabel="Cancel order" onConfirm={() => onMove(o, 'Cancelled')} />
      ) : null}
    </div>
  );
}

export function Orders() {
  const { invalidate, reload } = useApp();
  const open = useOpeners();
  const read = useRead('orders');
  const [filter, setFilter] = useState('all');
  const all = useMemo(() => (read.data ? read.data.orders : []), [read.data]);
  const rows = useMemo(() => all.filter(o => filter === 'all' || o.status === filter), [all, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? all.length : all.filter(o => o.status === k).length])), [all]);

  if (read.loading) return <div className="mx-auto grid max-w-3xl gap-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (!read.data) return <div className="mx-auto max-w-3xl"><ErrorBox>{read.error}</ErrorBox></div>;

  async function move(o, status) {
    await moveOrder(o, status, () => { invalidate(); reload(); });
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4" data-testid="orders">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Orders become a pay link, then a sale when you fulfil them.</p>
        <Button type="button" onClick={() => open.newOrder()}><Plus />New order</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter orders">
        {FILTERS.map(([k, label]) => (
          <Chip key={k} pressed={filter === k} onClick={() => setFilter(k)} testId={'order-filter-' + k}>{label + ' ' + counts[k]}</Chip>
        ))}
      </div>
      {!rows.length ? <Empty>{all.length ? 'No orders with this status.' : 'No orders yet. Create one for a customer, and its pay link is copied for you.'}</Empty> : null}
      <ul className="grid gap-3">
        {rows.map(o => (
          <li key={o.id} data-order={o.id} className="grid gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><ShoppingBag className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate font-semibold">{o.customerName || 'Customer'}</span></div>
                <div className="text-sm text-muted-foreground">{o.productName + ' · ' + o.months + (o.months > 1 ? ' months' : ' month') + ' · ' + o.id}</div>
                {o.contact ? <div className="text-xs text-muted-foreground">{o.contact + (o.contactChannel ? ' (' + o.contactChannel + ')' : '')}</div> : null}
              </div>
              <div className="grid justify-items-end gap-1">
                <Pill tone={TONE[o.status] || 'muted'}>{LABEL[o.status] || o.status}</Pill>
                <span className="money text-base font-semibold">{tk(o.total)}</span>
              </div>
            </div>
            {o.status === 'Fulfilled' && o.saleId !== '' ? <p className="text-xs text-muted-foreground">{'Sale ' + o.saleId + ' created'}</p> : null}
            <Actions o={o} onMove={move} onFulfil={x => open.fulfilOrder(x)}
              onConfirm={x => open.gotPaidRequest({ id: x.payRequestId, title: x.productName, amount: x.total })} />
          </li>
        ))}
      </ul>
    </div>
  );
}
