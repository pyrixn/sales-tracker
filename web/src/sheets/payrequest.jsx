import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Link2, MessageCircle } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { METHODS, num, whatsappLink } from '@/lib/format';
import { notify, useApp, useSaver, useSheets } from '@/lib/store';
import { CustomerCombobox, ErrorBox, Field, Hint, ProductTree, SaveButton, SheetShell, Stack, Two } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

/** Pay page address for a token, built from the pay_base_url setting when the server did not send one. */
export function linkOf(lookups, token) {
  const base = String((lookups.settings && lookups.settings.pay_base_url) || window.location.origin).replace(/\/+$/, '');
  return base + '/pay/' + encodeURIComponent(token);
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); notify(done); } catch (e) { notify(text); }
}

// ── New custom link ───────────────────────────────────────────────────
// Only the amount is asked for. Everything else sits under "Details (optional)".
export function PayRequestSheet() {
  const sheets = useSheets();
  const { lookups, reload } = useApp();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [customer, setCustomer] = useState(null);
  const [name, setName] = useState('');
  const [productId, setProductId] = useState('');
  const [note, setNote] = useState('');
  const [hours, setHours] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);
  const requestId = useRef(rid());
  const sentKey = useRef('');
  const guard = useRef(false);
  const amountRef = useRef(null);
  // Focus the amount after the sheet settles: the menu that opened it hands focus back to its trigger.
  useEffect(() => { const t = setTimeout(() => { if (amountRef.current) amountRef.current.focus(); }, 80); return () => clearTimeout(t); }, []);

  const stock = useMemo(() => {
    const n = {};
    (lookups.codes || []).forEach(c => { n[c.productId] = (n[c.productId] || 0) + 1; });
    return n;
  }, [lookups.codes]);
  const product = (lookups.products || []).find(p => p.id === productId);

  function pickProduct(id) {
    setProductId(id);
    const p = (lookups.products || []).find(x => x.id === id);
    if (p) {
      setTitle(t => t || p.name);
      setAmount(a => a || (p.price ? String(p.price) : ''));
    }
  }

  async function save(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (guard.current) return;
    let payload;
    try {
      const amt = num(amount, 'Amount');
      if (amt === null) throw new Error('Enter the amount.');
      payload = { amount: Number(amt) };
      if (title.trim()) payload.title = title.trim();
      if (customer) payload.customerId = customer.id; else if (name.trim()) payload.customerName = name.trim();
      if (productId) payload.productId = productId;
      if (note.trim()) payload.note = note.trim();
      if (String(hours).trim() !== '') {
        const h = Number(hours);
        if (!Number.isInteger(h) || h < 1 || h > 720) throw new Error('Expiry must be a whole number of hours, 1 to 720.');
        payload.hours = h;
      }
    } catch (err) { setError(err.message); return; }
    // The request id is an idempotency key for one payload: a retry of the same payload reuses it, a changed payload gets a new one.
    const key = JSON.stringify(payload);
    if (key !== sentKey.current) { requestId.current = rid(); sentKey.current = key; }
    guard.current = true; setBusy(true); setError('');
    const r = await call('createPayRequest', { ...payload, requestId: requestId.current });
    guard.current = false; setBusy(false);
    if (!r.ok) {
      // A typed name that is already a customer: offer the list, so Details opens on its own.
      if (r.code === 'customer_name_taken') setDetails(true);
      setError(r.error || 'Could not create the link.');
      return;
    }
    requestId.current = rid(); sentKey.current = '';
    setMade({ id: r.data.requestId, url: r.data.url || linkOf(lookups, r.data.token), title: payload.title || 'Payment' });
    reload();
  }

  if (made) {
    const wa = (customer && whatsappLink(customer.channel, customer.handle)) || 'https://wa.me/';
    const text = 'Hi, you can pay for ' + made.title + ' here: ' + made.url;
    return (
      <SheetShell title="Link ready" description="Share the pay link"
        footer={<SaveButton id="done" onClick={() => sheets.closeAll()}>Done</SaveButton>}>
        <Stack>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-sm font-bold">{made.title}</div>
            <div className="font-mono text-xs text-muted-foreground">{'ref ' + made.id}</div>
            <div id="prUrl" className="mt-2 font-mono text-xs break-all">{made.url}</div>
          </div>
          <Button id="prCopy" type="button" size="lg" className="w-full font-extrabold" onClick={() => copyText(made.url, 'Copied the link for ' + made.title)}><Link2 />Copy link</Button>
          <Button asChild variant="outline" size="lg" className="w-full font-bold"><a id="prWhatsapp" href={wa + '?text=' + encodeURIComponent(text)} target="_blank" rel="noopener"><MessageCircle />Share via WhatsApp</a></Button>
        </Stack>
      </SheetShell>
    );
  }

  return (
    <SheetShell title="New pay link" description="A link for a one-off payment"
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Create link</SaveButton></Stack>}>
      <form id="prForm" className="grid gap-4" onSubmit={save}>
        {/* Enter in any field submits. A form with several fields needs a submit button for that. */}
        <button type="submit" tabIndex={-1} className="sr-only">Create link</button>
        <Field label="Amount" id="prAmount"><Input id="prAmount" ref={amountRef} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Collapsible open={details} onOpenChange={setDetails} className="grid gap-4">
          <CollapsibleTrigger asChild>
            <Button id="prDetailsToggle" type="button" variant="ghost" className="justify-between font-bold" aria-expanded={details}>
              Details (optional)<ChevronDown className={details ? 'rotate-180' : ''} aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-4">
            <Field label="Title (optional)" id="prTitle" hint="Leave blank to call it Payment."><Input id="prTitle" autoComplete="off" value={title} onChange={e => setTitle(e.target.value)} /></Field>
            <CustomerCombobox id="prCustomer" label="Customer (optional)" value={customer} onChange={c => setCustomer(c && !c.isNew ? c : null)} />
            {customer ? null : (
              <Field label="Or a name (optional)" id="prCustomerName"><Input id="prCustomerName" autoComplete="off" value={name} onChange={e => setName(e.target.value)} /></Field>
            )}
            <Field label="Product (optional)" id="prProduct">
              <div role="group" aria-label="Product">
                <ProductTree products={lookups.products || []} selected={productId} onSelect={id => pickProduct(id === productId ? '' : id)} collapsedKey="payLink"
                  renderMeta={p => (p.deliversAs === 'code' ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{(stock[p.id] || 0) + ' in stock'}</span> : null)} />
              </div>
            </Field>
            {product && product.deliversAs === 'code' ? <Hint>One code is held for this link until it is paid, cancelled or expires.</Hint> : null}
            <Field label="Note (optional)" id="prNote"><Textarea id="prNote" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
            <Field label="Expires after (hours, optional)" id="prHours" hint="Leave blank for the default."><Input id="prHours" inputMode="numeric" autoComplete="off" value={hours} onChange={e => setHours(e.target.value)} /></Field>
          </CollapsibleContent>
        </Collapsible>
      </form>
    </SheetShell>
  );
}

// ── Got paid, for a custom link ───────────────────────────────────────
export function GotPaidRequestSheet({ request }) {
  const [method, setMethod] = useState('bKash');
  const [trx, setTrx] = useState('');
  const [amount, setAmount] = useState(String(request.amount));
  const { save, busy, error } = useSaver('gotPaidRequest', () => {
    const amt = num(amount, 'Amount');
    if (!amt) throw new Error('Enter the amount.');
    return { id: request.id, method, trx: trx.trim(), amount: Number(amt) };
  });
  return (
    <SheetShell title="Got paid" description={request.title + ' · ' + request.id}
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Confirm payment</SaveButton></Stack>}>
      <Stack>
        <Two>
          <Field label="Amount" id="gpAmount"><Input id="gpAmount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
          <Field label="Method" id="gpMethod"><NativeSelect id="gpMethod" value={method} onChange={e => setMethod(e.target.value)}>
            {METHODS.map(m => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
          </NativeSelect></Field>
        </Two>
        <Field label="Transaction ID (optional)" id="gpTrx"><Input id="gpTrx" autoComplete="off" value={trx} onChange={e => setTrx(e.target.value)} /></Field>
        <Hint>A paid link makes the sale and hands over the code. Confirming the same transaction twice records it once.</Hint>
      </Stack>
    </SheetShell>
  );
}
