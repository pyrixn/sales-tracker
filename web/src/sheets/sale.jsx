import { useEffect, useMemo, useState } from 'react';
import U from '@/lib/util';
import { CHANNELS, METHODS, num, productShort, tk } from '@/lib/format';
import { useApp, useHoldRefresh, useSaver } from '@/lib/store';
import { Chip, DaysPill, ErrorBox, Field, Hint, NoteBox, SaveButton, SheetShell, Stack, Stepper, Two, CustomerCombobox, ProductTree } from '@/components/kit';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Plus } from 'lucide-react';
import PriceInput, { convertPriceText, priceParam, priceTotal, usePriceMode } from '@/components/PriceInput';

export function Options({ list }) {
  return list.map(o => (typeof o === 'string'
    ? <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>
    : <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>));
}

/** "Payment from inbox": pick an unmatched payment to fill amount, method and transaction id. */
export function InboxPick({ value, onChange }) {
  const { home } = useApp();
  const un = (home && home.unmatched) || [];
  return (
    <Field label="Payment from inbox (optional)" id="inboxPick">
      <NativeSelect id="inboxPick" value={value} onChange={e => onChange(e.target.value, un.find(u => u.trx === e.target.value))}>
        <NativeSelectOption value="">— none —</NativeSelectOption>
        {un.map(u => <NativeSelectOption key={u.trx} value={u.trx}>{tk(u.amount) + ' · ' + u.trx}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
  );
}

// ── New sale ──────────────────────────────────────────────────────────
export function NewSaleSheet({ preset, openers }) {
  const { lookups: L, today, role } = useApp();
  const ownerOnly = !!role && role !== 'owner'; // staff and viewers sell at catalog price, no custom cost, no full accounts
  const [v, setV] = useState({
    product: '', account: preset.accountId || '', code: '', customer: null, newName: '', channel: 'WhatsApp', handle: '', profile: '',
    months: '1', price: '', buyPrice: '', buyCurr: 'BDT', paidNow: '', method: 'bKash', inbox: '', allowFull: false,
    cTitle: '', cPrice: '', cCost: '', cDate: today, cPaid: '', cMethod: 'bKash'
  });
  // Custom item: a free-text sale with no product, account or delivery (Sales_Log row, Product_ID CUSTOM).
  const [custom, setCustom] = useState(false);
  const [pmode, setPmode] = usePriceMode();
  const mode = ownerOnly ? 'per' : pmode; // staff sell at the catalog price per month
  const pid = custom ? 'cPaid' : 'paidNow', mid = custom ? 'cMethod' : 'method';
  const set = (k, val) => setV(s => ({ ...s, [k]: val }));
  const product = L.products.find(p => p.id === v.product) || null;
  const isCode = product && product.deliversAs === 'code';
  const months = Math.max(1, Math.min(12, Number(v.months) || 1));

  const codes = useMemo(() => (product && isCode ? L.codes.filter(c => c.productId === product.id) : []), [product, isCode, L.codes]);
  // A variant with no accounts of its own (a 1-day rent of ExitLag) sells from its parent's accounts: poolId names them.
  const pool = product ? (product.poolId || product.id) : '';
  const shared = !!product && !isCode && pool !== product.id;
  const accounts = useMemo(() => {
    if (!product || isCode) return [];
    return L.accounts.filter(a => a.productId === pool && a.status === 'Active' && (a.free > 0 || v.allowFull));
  }, [product, pool, isCode, L.accounts, v.allowFull]);
  // A shared pool starts on a random free account (accountId ''); the server picks one.
  const account = accounts.some(a => a.id === v.account) ? v.account : (shared || !accounts.length ? '' : accounts[0].id);
  const code = codes.some(c => c.id === v.code) ? v.code : codes.length ? codes[0].id : '';

  useEffect(() => { if (preset.productId) pickProduct(preset.productId); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = preset.customerId && (L.customers || []).find(x => x.id === preset.customerId);
    if (c) setV(s => ({ ...s, customer: c }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A product made from here is picked as soon as the refreshed catalog has it.
  const [fresh, setFresh] = useState('');
  useEffect(() => { if (fresh && L.products.some(p => p.id === fresh)) { pickProduct(fresh); setFresh(''); } }, [fresh, L.products]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickProduct(id) {
    const p = L.products.find(x => x.id === id);
    setV(s => ({ ...s, product: id, price: p ? (mode === 'total' ? convertPriceText(String(p.price), 'per', 'total', s.months) : String(p.price)) : s.price }));
  }

  const total = priceTotal(mode, v.price, isCode ? 1 : months);
  const paid = Number(v.paidNow) || 0;
  const summary = !product ? 'Pick a product.'
    : (isCode ? 'One code' : 'Paid till: ' + U.addCycle(today, months, product.cycle)) + ' · total ' + tk(total) +
      (paid < total ? ' · ' + tk(total - paid) + ' → Dues' : paid > total ? ' · ' + tk(paid - total) + ' as credit' : ' · paid in full');

  const { save, busy, error } = useSaver('newSale', () => {
    if (!v.product) throw new Error('Pick a product.');
    const p = {
      productId: v.product, accountId: account || '', codeId: code || '', profile: v.profile,
      months: Number(v.months), ...priceParam(mode, v.price, mode === 'total' ? 'Total' : 'Price'), allowFull: ownerOnly ? false : v.allowFull,
      buyCurrency: v.buyCurr, buyPriceUSDT: v.buyCurr === 'USDT' && v.buyPrice.trim() ? Number(v.buyPrice) : ''
    };
    if (v.buyCurr !== 'USDT' && !ownerOnly) { const c = num(v.buyPrice, 'Buy cost'); if (c !== null) p.cost = c; }
    if (v.customer) p.customerId = v.customer.id;
    else if (v.newName) p.newCustomer = { name: v.newName, channel: v.channel, handle: v.handle };
    const paidAmt = num(v.paidNow, 'Paid now');
    if (paidAmt) p.paidNow = { amount: paidAmt, method: v.method, trxId: v.inbox };
    return p;
  });

  const cPrice = Number(v.cPrice) || 0, cCost = Number(v.cCost) || 0, cPaid = Number(v.cPaid) || 0;
  const customSummary = 'Custom item · total ' + tk(cPrice) + ' · cost ' + tk(cCost) + ' · profit ' + tk(cPrice - cCost) +
    (cPaid < cPrice ? ' · ' + tk(cPrice - cPaid) + ' → Dues' : cPaid > cPrice ? ' · ' + tk(cPaid - cPrice) + ' as credit' : ' · paid in full');
  const customSaver = useSaver('customSale', () => {
    if (!String(v.cTitle || '').trim()) throw new Error('Give the item a name (up to 80 characters).');
    const p = { title: v.cTitle, price: num(v.cPrice, 'Price') };
    const cost = num(v.cCost, 'Cost'); if (cost !== null) p.cost = cost;
    if (v.cDate) p.date = v.cDate;
    if (v.customer) p.customerId = v.customer.id;
    else if (v.newName) p.newCustomer = { name: v.newName, channel: v.channel, handle: v.handle };
    const paidAmt = num(v.cPaid, 'Paid now');
    if (paidAmt) p.paidNow = { amount: paidAmt, method: v.cMethod, trxId: v.inbox };
    return p;
  });

  return (
    <SheetShell title={custom ? 'Custom item' : 'New sale'} description={custom ? 'A free-text item with its own price and cost' : 'Record a subscription or code sale'}
      footer={custom
        ? <Stack className="gap-3"><NoteBox testId="custom-total">{customSummary}</NoteBox><ErrorBox>{customSaver.error}</ErrorBox><SaveButton busy={customSaver.busy} onClick={customSaver.save}>Save custom item</SaveButton></Stack>
        : <Stack className="gap-3"><NoteBox testId="paid-till">{summary}</NoteBox><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save sale</SaveButton></Stack>}>
      <Stack>
        {custom ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="link" size="sm" onClick={() => setCustom(false)}>Back to products</Button>
          </div>
        ) : null}
        {custom ? null : (<>
        <Field label="Product">
          <div className="grid gap-2" role="group" aria-label="Product">
            <ProductTree products={L.products} selected={v.product} onSelect={pickProduct} collapsedKey="newSale" />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="w-fit rounded-full border-dashed font-bold" onClick={() => openers.product(id => setFresh(id))}><Plus />New product</Button>
              <Button id="customItem" type="button" variant="outline" className="w-fit rounded-full border-dashed font-bold" onClick={() => setCustom(true)}>Custom item</Button>
            </div>
          </div>
        </Field>

        {product ? (
          <Field label={isCode ? 'Code' : 'Account (emptiest first)'}>
            <div className="flex flex-wrap items-center gap-2">
              {isCode
                ? (codes.length
                  ? codes.slice(0, 12).map(c => <Chip key={c.id} testId="code-chip" pressed={c.id === code} onClick={() => set('code', c.id)}>{c.id}</Chip>)
                  : <Hint>No codes in stock. Add under More, then Game codes.</Hint>)
                : (
                  <>
                    {shared && accounts.length ? <Chip testId="account-random" pressed={!account} onClick={() => set('account', '')}>Random free account</Chip> : null}
                    {accounts.map(a => <Chip key={a.id} testId="account-chip" pressed={a.id === account} onClick={() => set('account', a.id)}>{a.id + ' · ' + (a.free > 0 ? a.free + ' free' : 'full')}</Chip>)}
                    {accounts.length ? null : <Hint>{'Every ' + product.name + ' account is full.'}</Hint>}
                    <Button type="button" variant="link" size="sm" onClick={() => openers.addAccount(product.id)}>+ Add account</Button>
                  </>
                )}
            </div>
            {isCode || ownerOnly ? null : (
              <Label className="mt-1 gap-2 text-xs font-medium text-muted-foreground">
                <Checkbox checked={v.allowFull} onCheckedChange={c => set('allowFull', c === true)} aria-label="Add to a full account anyway" />
                Add to a full account anyway
              </Label>
            )}
          </Field>
        ) : null}
        </>)}

        {custom ? (
          <>
            <Field label="Item name" id="cTitle"><Input id="cTitle" autoComplete="off" value={v.cTitle} onChange={e => set('cTitle', e.target.value)} /></Field>
            <Two>
              <Field label="Price" id="cPrice"><Input id="cPrice" inputMode="decimal" value={v.cPrice} onChange={e => set('cPrice', e.target.value)} /></Field>
              <Field label="Cost (optional)" id="cCost"><Input id="cCost" inputMode="decimal" placeholder="0" value={v.cCost} onChange={e => set('cCost', e.target.value)} /></Field>
            </Two>
            <Field label="Date" id="cDate"><Input id="cDate" type="date" value={v.cDate} onChange={e => set('cDate', e.target.value)} /></Field>
          </>
        ) : null}

        <CustomerCombobox allowNew value={v.customer || (v.newName ? { id: '', name: v.newName, isNew: true } : null)}
          onChange={c => setV(s => ({ ...s, customer: c && !c.isNew ? c : null, newName: c && c.isNew ? c.name : '' }))} />

        {v.newName ? (
          <Two>
            <Field label="Contact via" id="ncChannel">
              <NativeSelect id="ncChannel" value={v.channel} onChange={e => set('channel', e.target.value)}><Options list={CHANNELS} /></NativeSelect>
            </Field>
            <Field label="Number or username" id="ncHandle">
              <Input id="ncHandle" autoComplete="off" autoFocus value={v.handle} onChange={e => set('handle', e.target.value)} />
            </Field>
          </Two>
        ) : null}

        {custom ? null : (<>
        <Field label="Profile / username on the account" id="profile">
          <Input id="profile" autoComplete="off" value={v.profile} onChange={e => set('profile', e.target.value)} />
        </Field>

        <Two>
          <Field label="Months" id="months"><Stepper id="months" value={v.months} onChange={x => set('months', x)} /></Field>
          <PriceInput id="price" mode={mode} onMode={setPmode} text={v.price} onText={x => set('price', x)} months={isCode ? 1 : months} disabled={ownerOnly} />
        </Two>

        <Two>
          <Field label="Buy cost (optional)" id="buyPrice"><Input id="buyPrice" inputMode="decimal" placeholder="0" disabled={ownerOnly} value={v.buyPrice} onChange={e => set('buyPrice', e.target.value)} /></Field>
          <Field label="Buy currency" id="buyCurr">
            <NativeSelect id="buyCurr" value={v.buyCurr} onChange={e => set('buyCurr', e.target.value)}><Options list={['BDT', 'USDT']} /></NativeSelect>
          </Field>
        </Two>
        </>)}

        <Two>
          <Field label="Paid now" id={pid}><Input id={pid} inputMode="decimal" placeholder="0" value={v[pid]} onChange={e => set(pid, e.target.value)} /></Field>
          <Field label="Method" id={mid}>
            <NativeSelect id={mid} value={v[mid]} onChange={e => set(mid, e.target.value)}><Options list={METHODS} /></NativeSelect>
          </Field>
        </Two>

        <InboxPick value={v.inbox} onChange={(trx, u) => setV(s => ({ ...s, inbox: trx, ...(u ? (custom ? { cPaid: String(u.amount), cMethod: 'bKash' } : { paidNow: String(u.amount), method: 'bKash' }) : {}) }))} />
      </Stack>
    </SheetShell>
  );
}

// ── Renew ─────────────────────────────────────────────────────────────
export function RenewSheet({ subCode }) {
  const { lookups: L, today, role } = useApp();
  const ownerOnly = !!role && role !== 'owner'; // staff and viewers sell at catalog price, no custom cost, no full accounts
  const initial = subCode ? L.lines.find(l => l.subCode === subCode) || null : null;
  const [line, setLine] = useState(initial);
  const [q, setQ] = useState(initial ? initial.name + ' · ' + initial.subCode : '');
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState('1');
  const [price, setPrice] = useState(initial ? String(initial.price) : '');
  const [pmode, setPmode] = usePriceMode();
  const mode = ownerOnly ? 'per' : pmode;
  const [paidNow, setPaidNow] = useState('');
  const [method, setMethod] = useState('bKash');
  const [inbox, setInbox] = useState('');

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || line) return [];
    return L.lines.filter(l => l.name.toLowerCase().indexOf(s) >= 0 || l.subCode.toLowerCase() === s).slice(0, 8);
  }, [q, line, L.lines]);

  function pick(l) { setLine(l); setQ(l.name + ' · ' + l.subCode); setPrice(mode === 'total' ? convertPriceText(String(l.price), 'per', 'total', months) : String(l.price)); setOpen(false); }
  const m = Math.max(1, Math.min(12, Number(months) || 1));
  let summary = 'Pick who is renewing.';
  if (line) {
    const p = L.products.find(x => x.id === line.productId) || { cycle: 30 };
    const grace = Number(L.settings.grace_days) || 3;
    const start = U.renewalStart(line.paidTill, today, grace);
    summary = 'Paid till: ' + U.addCycle(start, m, p.cycle) + ' (from ' + start + ') · total ' + tk(priceTotal(mode, price, m));
  }

  const { save, busy, error } = useSaver('renew', () => {
    if (!line) throw new Error('Pick who is renewing.');
    const p = { subCode: line.subCode, months: Number(months), ...priceParam(mode, price, mode === 'total' ? 'Total' : 'Price') };
    const paid = num(paidNow, 'Paid now');
    if (paid) p.paidNow = { amount: paid, method, trxId: inbox };
    return p;
  });

  return (
    <SheetShell title="Renew" description="Extend a subscription"
      footer={<Stack className="gap-3"><NoteBox testId="paid-till">{summary}</NoteBox><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save renewal</SaveButton></Stack>}>
      <Stack>
        <Field label="Customer or reference" id="lineSearch">
          <Command shouldFilter={false} className="overflow-visible bg-transparent">
            <Input id="lineSearch" role="combobox" aria-expanded={open} aria-autocomplete="list" autoComplete="off" placeholder="Name or code like N44" value={q}
              onChange={e => { setQ(e.target.value); setLine(null); setOpen(true); }} onFocus={() => setOpen(true)} />
            {open && hits.length ? (
              <CommandList className="mt-1 max-h-60 rounded-lg border border-border bg-popover">
                {hits.map(l => (
                  <CommandItem key={l.subCode} value={l.subCode} className="justify-between px-3 py-2.5" onSelect={() => pick(l)}>
                    <span className="font-bold">{l.name + ' · ' + productShort(l.productName)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{l.subCode + ' · ' + (l.paidTill || '')}</span>
                  </CommandItem>
                ))}
              </CommandList>
            ) : null}
          </Command>
        </Field>

        {line ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{line.name}</div>
              <div className="truncate text-xs text-muted-foreground">{line.productName + ' · ' + line.accountId + ' · ref ' + line.subCode}</div>
            </div>
            <DaysPill days={line.daysLeft} />
          </div>
        ) : null}

        <Two>
          <Field label="Months" id="months"><Stepper id="months" value={months} onChange={setMonths} /></Field>
          <PriceInput id="price" mode={mode} onMode={setPmode} text={price} onText={setPrice} months={m} disabled={ownerOnly} />
        </Two>
        <Two>
          <Field label="Paid now" id="paidNow"><Input id="paidNow" inputMode="decimal" placeholder="0" value={paidNow} onChange={e => setPaidNow(e.target.value)} /></Field>
          <Field label="Method" id="method"><NativeSelect id="method" value={method} onChange={e => setMethod(e.target.value)}><Options list={METHODS} /></NativeSelect></Field>
        </Two>
        <InboxPick value={inbox} onChange={(trx, u) => { setInbox(trx); if (u) { setPaidNow(String(u.amount)); setMethod('bKash'); } }} />
      </Stack>
    </SheetShell>
  );
}

// ── Edit sale ─────────────────────────────────────────────────────────
export function EditSaleSheet({ sale: h }) {
  useHoldRefresh();
  const { lookups: L } = useApp();
  const accts = L.accounts.filter(a => a.productId === h.productId);
  const cycle = (L.products.find(p => p.id === h.productId) || { cycle: 30 }).cycle;
  const [profile, setProfile] = useState(h.profile || '');
  const [account, setAccount] = useState(h.accountId || '');
  const [pmode, setPmode] = usePriceMode();
  const mode = h.custom ? 'per' : pmode;
  const [price, setPrice] = useState(mode === 'total' ? convertPriceText(String(h.price), 'per', 'total', h.months) : String(h.price));
  const [months, setMonths] = useState(String(h.months));
  const [till, setTill] = useState(h.paidTill || '');
  const [status, setStatus] = useState(h.status);
  const [cost, setCost] = useState(String(h.costSnapshot || 0));
  const [notes, setNotes] = useState(h.notes || '');
  const [moveTill, setMoveTill] = useState(false);

  const want = U.suggestPaidTill(h.paidTill, h.months, Number(months), cycle);
  function changeMonths(x) {
    setMonths(x);
    if (moveTill) { const w = U.suggestPaidTill(h.paidTill, h.months, Number(x), cycle); if (w) setTill(w); }
  }
  function changeMove(c) {
    setMoveTill(c);
    if (c && want) setTill(want);
  }
  const note = h.custom ? '' : !h.paidTill ? 'This sale has no end date.'
    : want && till !== want && !moveTill ? 'Paid till and Months do not agree. Tick above to move the date, or set it by hand.' : '';

  const { save, busy, error } = useSaver('edit', () => {
    const vals = {};
    const p = num(price, mode === 'total' ? 'Total' : 'Price');
    const mo = num(months, 'Months');
    if (profile !== (h.profile || '')) vals.Contact = profile;
    if (account && account !== h.accountId) vals.Account_ID = account;
    if (mode === 'total') { if (p !== null && (U.round2(p) !== U.round2(h.price * Number(h.months)) || mo !== Number(h.months))) vals.Total = p; }
    else if (p !== h.price) vals.Unit_Price = p;
    if (mo !== Number(h.months)) vals.Months = mo;
    if (till !== (h.paidTill || '')) vals.Paid_Till = till;
    if (status !== h.status) vals.Record_Status = status;
    const cs = num(cost, 'Cost for this sale');
    if (cs !== null && cs !== (h.costSnapshot || 0)) vals.Cost_Snapshot = cs;
    if (notes !== (h.notes || '')) vals.Notes = notes;
    if (!Object.keys(vals).length) throw new Error('Nothing changed.');
    return { kind: 'sale', id: h.saleId, values: vals };
  }, { keepParent: true });

  return (
    <SheetShell title={'Edit sale #' + h.saleId} description="Change a recorded sale"
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save changes</SaveButton></Stack>}>
      <Stack>
        <Hint>{h.custom ? 'Custom item' : h.productName + ' · ref ' + h.subCode}</Hint>
        {h.custom ? null : (
          <Field label="Profile / username" id="sProfile"><Input id="sProfile" value={profile} onChange={e => setProfile(e.target.value)} /></Field>
        )}
        {accts.length && !h.custom ? (
          <Field label="Account" id="sAccount">
            <NativeSelect id="sAccount" value={account} onChange={e => setAccount(e.target.value)}><Options list={accts.map(a => a.id)} /></NativeSelect>
          </Field>
        ) : null}
        <Two>
          {h.custom
            ? <Field label="Price" id="sPrice"><Input id="sPrice" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></Field>
            : <PriceInput id="sPrice" mode={mode} onMode={setPmode} text={price} onText={setPrice} months={Number(months) || 1} />}
          {h.custom ? null : <Field label="Months" id="sMonths"><Input id="sMonths" inputMode="numeric" value={months} onChange={e => changeMonths(e.target.value)} /></Field>}
        </Two>
        <Two>
          {h.custom ? null : <Field label="Paid till" id="sTill"><Input id="sTill" type="date" value={till} onChange={e => setTill(e.target.value)} /></Field>}
          <Field label="Status" id="sStatus">
            <NativeSelect id="sStatus" value={status} onChange={e => setStatus(e.target.value)}><Options list={['Active', 'Renewed', 'Refunded', 'Void'].concat(h.status === 'Ended' ? ['Ended'] : [])} /></NativeSelect>
          </Field>
        </Two>
        <Field label="Cost for this sale" id="sCost" hint="What this one sale cost you, in taka. Use it for a one-off item that has its own cost.">
          <Input id="sCost" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} />
        </Field>
        <Field label={h.custom ? 'Item name' : 'Notes'} id="sNotes"><Textarea id="sNotes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        {h.custom ? null : (
          <Label className="gap-2 text-xs font-medium text-muted-foreground">
            <Checkbox id="sMoveTill" checked={moveTill} onCheckedChange={c => changeMove(c === true)} />
            Move Paid till when Months changes
          </Label>
        )}
        {note ? <Hint>{note}</Hint> : null}
        <Hint>Void = entered by mistake. Refunded = money returned. Both remove from totals; nothing is deleted.</Hint>
      </Stack>
    </SheetShell>
  );
}
