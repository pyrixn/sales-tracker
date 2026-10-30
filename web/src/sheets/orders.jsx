import { useState } from 'react';
import { call, rid } from '@/lib/api';
import { tk } from '@/lib/format';
import { notify, useApp, useSaver } from '@/lib/store';
import { CustomerPicker, ErrorBox, Field, Hint, SaveButton, SheetShell, Stack, Two, Stepper } from '@/components/kit';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

// Same list the server accepts (Core.orders / Core.sales contact channels).
const CHANNELS = ['', 'WhatsApp', 'Telegram', 'Facebook', 'Email', 'Other'];

/** What one month of a product costs on the catalog: the public price when set, else the usual price. */
export function catalogPriceOf(p) {
  if (!p) return 0;
  return p.publicPrice !== '' && p.publicPrice !== undefined && p.publicPrice !== null ? Number(p.publicPrice) : Number(p.price) || 0;
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); notify(done); } catch (e) { notify(text); }
}

/** New order for a customer: a product, months and the customer. The price is the catalog price, checked again on the server. */
export function NewOrderSheet() {
  const { lookups: L } = useApp();
  const products = (L.products || []).filter(p => p.deliversAs !== 'custom');
  const [productId, setProductId] = useState(products[0] ? products[0].id : '');
  const [months, setMonths] = useState('1');
  const [who, setWho] = useState({ id: '', name: '' });
  const [contact, setContact] = useState('');
  const [channel, setChannel] = useState('');
  const [note, setNote] = useState('');
  const product = products.find(p => p.id === productId) || null;
  const unit = catalogPriceOf(product);
  const total = unit * (Number(months) || 0);

  const { save, busy, error } = useSaver('createOrder', () => {
    if (!productId) throw new Error('Pick a product.');
    const m = Number(months);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('Months must be a whole number from 1 to 12.');
    if (!who.id && !who.name) throw new Error('Pick a customer or type a new name.');
    const v = { productId, months: m, contact: contact.trim(), contactChannel: channel, note: note.trim() };
    if (who.id) v.customerId = who.id; else v.customerName = who.name;
    return v;
  }, {
    keepParent: true,
    after: d => { if (d && d.url) copyText(d.url, 'Order ' + d.orderId + ' created. Pay link copied.'); }
  });

  return (
    <SheetShell title="New order" description="The pay link is copied when the order is saved."
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Create order</SaveButton></Stack>}>
      <Stack>
        <Field label="Product" id="noProduct">
          <NativeSelect id="noProduct" value={productId} onChange={e => setProductId(e.target.value)}>
            {products.map(p => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Two>
          <Field label="Months" id="noMonths"><Stepper id="noMonths" value={months} onChange={setMonths} /></Field>
          <div className="grid content-end gap-1">
            <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Total</span>
            <span className="money text-xl font-semibold" data-testid="order-total">{tk(total)}</span>
          </div>
        </Two>
        <Hint>{product ? tk(unit) + ' a month, from the catalog.' : 'No product to order.'}</Hint>
        <CustomerPicker id="noCustomer" label="Customer" placeholder="Type a name"
          onPick={c => setWho({ id: c.id, name: c.name })}
          onClear={() => setWho({ id: '', name: '' })}
          onNew={name => setWho({ id: '', name })} />
        <Two>
          <Field label="Contact (optional)" id="noContact"><Input id="noContact" autoComplete="off" value={contact} onChange={e => setContact(e.target.value)} /></Field>
          <Field label="Channel" id="noChannel">
            <NativeSelect id="noChannel" value={channel} onChange={e => setChannel(e.target.value)}>
              {CHANNELS.map(c => <NativeSelectOption key={c} value={c}>{c || 'None'}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </Two>
        <Field label="Note (optional)" id="noNote"><Textarea id="noNote" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

/**
 * Fulfil a paid order: creates the sale, picks the seat or code it uses, and links the payment. Only the seat or code is chosen here;
 * the server checks that it is free.
 */
export function FulfilOrderSheet({ order }) {
  const { lookups: L } = useApp();
  const product = (L.products || []).find(p => p.id === order.productId) || null;
  const isCode = !!product && product.deliversAs === 'code';
  // Account products draw seats from their pool (a rent product shares its parent's accounts).
  const pool = product ? product.poolId || product.id : order.productId;
  const seats = (L.accounts || []).filter(a => a.productId === pool && a.free > 0 && a.status === 'Active');
  const codes = (L.codes || []).filter(c => c.productId === order.productId);
  const options = isCode ? codes.map(c => ({ value: c.id, label: c.id })) : seats.map(a => ({ value: a.id, label: a.id + (a.label ? ' · ' + a.label : '') + ' · ' + a.free + ' free' }));
  const [pick, setPick] = useState(options[0] ? options[0].value : '');

  const { save, busy, error } = useSaver('fulfilOrder', () => {
    if (!pick) throw new Error(isCode ? 'Pick a code. Add codes to stock first if none are left.' : 'Pick an account with a free seat.');
    return isCode ? { orderId: order.id, codeId: pick } : { orderId: order.id, accountId: pick };
  }, { keepParent: true });

  return (
    <SheetShell title="Fulfil order" description={order.id + ' · ' + order.customerName}
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save} disabled={!options.length}>Create sale</SaveButton></Stack>}>
      <Stack>
        <Hint>{'Creates the sale for ' + order.customerName + ' (' + order.productName + ', ' + order.months + (order.months > 1 ? ' months' : ' month') +
          ') and records the payment against it.'}</Hint>
        {options.length ? (
          <Field label={isCode ? 'Code' : 'Account'} id="foPick">
            <NativeSelect id="foPick" value={pick} onChange={e => setPick(e.target.value)}>
              {options.map(o => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        ) : (
          <Hint>{isCode ? 'No codes left for this product. Add a batch under Catalog first.' : 'No free seat on this product. Add an account or free a seat first.'}</Hint>
        )}
      </Stack>
    </SheetShell>
  );
}

/** Used by the Orders screen's own actions (status moves) so every status change goes through one call. */
export async function moveOrder(order, status, after) {
  const r = await call('orderStatus', { id: order.id, status, requestId: rid() });
  notify(r.ok ? r.data.message : r.error);
  if (r.ok && after) after();
  return r;
}
