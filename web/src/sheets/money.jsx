import { useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff, Info, Plus, Trash2 } from 'lucide-react';
import { call } from '@/lib/api';
import U from '@/lib/util';
import { CHANNELS, METHODS, num, productShort, tk } from '@/lib/format';
import { useApp, useSaver } from '@/lib/store';
import { CopyId } from '@/components/CopyId';
import { ConfirmButton, CustomerCombobox, CustomerPicker, ErrorBox, Field, Hint, SaveButton, SheetShell, Stack, Stepper, Two } from '@/components/kit';
import { InboxPick, Options } from '@/sheets/sale';
import PriceInput, { convertPriceText, priceParam, priceTotal, usePriceMode } from '@/components/PriceInput';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

function Footer({ error, busy, onSave, children }) {
  return <Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={onSave}>{children}</SaveButton></Stack>;
}

// ── Got paid ──────────────────────────────────────────────────────────
export function PaySheet({ arg }) {
  const preset = typeof arg === 'object' && arg ? arg : { customerId: arg };
  const [customer, setCustomer] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saleId, setSaleId] = useState(preset.saleId ? String(preset.saleId) : '');
  const [amount, setAmount] = useState(preset.amount ? String(preset.amount) : '');
  const [method, setMethod] = useState(({ bkash: 'bKash', nagad: 'Nagad', upay: 'Upay', bank: 'Bank' })[preset.method] || 'bKash');
  const [inbox, setInbox] = useState('');
  const [trx, setTrx] = useState(preset.trx || '');

  useEffect(() => {
    if (!customer) { setDetail(null); return undefined; }
    let live = true;
    call('customer', { id: customer.id }).then(r => {
      if (!live || !r.ok) return;
      setDetail(r.data);
      setAmount(a => (!a && r.data.owes ? String(r.data.owes) : a));
    });
    return () => { live = false; };
  }, [customer]);

  const { save, busy, error } = useSaver('pay', () => {
    if (!customer) throw new Error('Pick a customer.');
    const amt = num(amount, 'Amount');
    if (!amt) throw new Error('Enter the amount.');
    return { customerId: customer.id, amount: amt, method, trxId: trx.trim(), saleId };
  });

  return (
    <SheetShell title="Got paid" description="Record a payment from a customer" footer={<Footer error={error} busy={busy} onSave={save}>Save payment</Footer>}>
      <Stack>
        <CustomerPicker preset={preset.customerId} onPick={setCustomer} onClear={() => setCustomer(null)} />
        <div id="dueBox">
          {customer && detail ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h3 className="text-sm font-extrabold">{customer.name}</h3>
                <span className="font-mono text-xs font-semibold text-bad">{'owes ' + tk(detail.owes)}</span>
              </div>
              {detail.dues.length ? (
                <RadioGroup value={saleId} onValueChange={setSaleId} className="gap-0 divide-y divide-border">
                  <Label className="min-h-12 cursor-pointer justify-between px-4 py-3 text-sm font-medium">
                    <span>Oldest dues first</span><RadioGroupItem value="" id="due-oldest" />
                  </Label>
                  {detail.dues.map(x => {
                    const line = detail.history.find(h => h.saleId === x.saleId) || {};
                    return (
                      <Label key={x.saleId} className="min-h-12 cursor-pointer justify-between px-4 py-3 text-sm font-medium">
                        <span>{'#' + x.saleId + ' ' + productShort(line.productName) + ' · ' + tk(x.balance)}</span>
                        <RadioGroupItem value={String(x.saleId)} id={'due-' + x.saleId} />
                      </Label>
                    );
                  })}
                </RadioGroup>
              ) : <div className="px-4 py-5 text-center text-sm text-muted-foreground">Nothing owed. Money goes to credit.</div>}
            </div>
          ) : null}
        </div>
        <Two>
          <Field label="Amount" id="amount"><Input id="amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
          <Field label="Method" id="method"><NativeSelect id="method" value={method} onChange={e => setMethod(e.target.value)}><Options list={METHODS} /></NativeSelect></Field>
        </Two>
        <InboxPick value={inbox} onChange={(t, u) => { setInbox(t); if (u) { setAmount(String(u.amount)); setTrx(t); setMethod('bKash'); } }} />
        <Field label="Transaction ID (optional)" id="trx"><Input id="trx" autoComplete="off" value={trx} onChange={e => setTrx(e.target.value)} /></Field>
        <Hint>Part payment? Enter less — rest stays in Dues. Extra is kept as credit.</Hint>
      </Stack>
    </SheetShell>
  );
}

// ── Match an unmatched payment ────────────────────────────────────────
/** A typed amount as a number; blank or not a number is 0 (rendering must never throw). */
function numOr0(v) {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(/[,৳\s]/g, ''));
  return isFinite(n) ? n : 0;
}

/** The end date a renewal item gets by default: from the line's paid-till (or today) plus its months. */
function renewDefault(it, lines, L, today) {
  const line = lines.find(l => l.subCode === it.subCode);
  if (!line) return '';
  const p = L.products.find(x => x.id === line.productId) || { cycle: 30 };
  const start = it.from === 'today' ? today : (line.paidTill || today);
  return U.addCycle(start, Math.max(1, Math.min(12, numOr0(it.months) || 1)), p.cycle);
}

/** What one split item takes from the payment: renewal and product sale = months x price, custom = price. */
function itemAmount(it, mode) {
  if (it.kind === 'custom') return U.round2(numOr0(it.amt));
  return U.round2(priceTotal(mode, it.price, numOr0(it.months) || 1));
}

/** One split item in the shape splitMatch expects. Only an overridden end date is sent. */
function targetOf(it, lines, L, today, mode) {
  if (it.kind === 'custom') {
    const t = { kind: 'custom', title: it.title, price: num(it.amt, 'Item price') };
    const c = num(it.cost, 'Cost'); if (c !== null) t.cost = c;
    return t;
  }
  if (it.kind === 'newSale') {
    const t = { kind: 'newSale', productId: it.productId, months: Number(it.months) || 1, ...priceParam(mode, it.price, 'Price') };
    if (it.accountId) t.accountId = it.accountId;
    return t;
  }
  if (!it.subCode) throw new Error('Pick the line to renew.');
  const t = { kind: 'renew', subCode: it.subCode, months: Number(it.months) || 1, ...priceParam(mode, it.price, 'Price'), from: it.from };
  const def = renewDefault(it, lines, L, today);
  if (it.till && it.till !== def) t.paidTill = it.till;
  return t;
}

const EMPTY_ITEM = { kind: 'renew', subCode: '', months: '1', price: '', from: 'oldPaidTill', till: null, title: '', amt: '', cost: '', productId: '', accountId: '' };

/** The split rows: one block per item, a live "left to assign" line, and the keep-as-credit choice. */
function SplitItems({ items, lines, L, today, left, credit, onCredit, onAdd, onPatch, onRemove, mode, onMode }) {
  // The toggle on one row converts that row itself; the other rows follow so every row means the same thing.
  const priceField = (it, i) => (
    <PriceInput id={'sPrice-' + i} mode={mode} text={it.price} onText={x => onPatch(i, { price: x })} months={Number(it.months) || 1}
      onMode={m => { items.forEach((o, j) => { if (j !== i) onPatch(j, { price: convertPriceText(o.price, mode, m, o.months) }); }); onMode(m); }} />
  );
  const catalog = (price, it) => (mode === 'total' ? convertPriceText(String(price), 'per', 'total', it.months) : String(price));
  const prods = L.products.filter(p => p.deliversAs !== 'code');
  function accountsFor(productId) {
    const p = L.products.find(x => x.id === productId);
    const pool = p ? (p.poolId || p.id) : '';
    return L.accounts.filter(a => a.productId === pool && a.status === 'Active' && a.free > 0);
  }
  return (
    <div className="grid gap-3">
      {items.map((it, i) => {
        const def = it.kind === 'renew' ? renewDefault(it, lines, L, today) : '';
        const shared = it.kind === 'newSale' && (() => { const p = L.products.find(x => x.id === it.productId); return !!p && (p.poolId || p.id) !== p.id; })();
        return (
          <div key={it.key} data-testid={'split-row-' + i} className="grid gap-3 rounded-xl border border-border p-3">
            <Field label="Kind" id={'sKind-' + i}>
              <NativeSelect id={'sKind-' + i} value={it.kind} onChange={e => onPatch(i, { kind: e.target.value })}>
                <NativeSelectOption value="renew">Renew a subscription</NativeSelectOption>
                <NativeSelectOption value="custom">Custom item</NativeSelectOption>
                <NativeSelectOption value="newSale">New product sale</NativeSelectOption>
              </NativeSelect>
            </Field>
            {it.kind === 'renew' ? (
              <>
                <Field label="Line to renew" id={'sLine-' + i}>
                  <NativeSelect id={'sLine-' + i} value={it.subCode} onChange={e => {
                    const l = lines.find(x => x.subCode === e.target.value);
                    onPatch(i, { subCode: e.target.value, price: l ? catalog(l.price, it) : it.price, till: null });
                  }}>
                    <NativeSelectOption value="">Pick a line</NativeSelectOption>
                    {lines.map(l => <NativeSelectOption key={l.subCode} value={l.subCode}>{productShort(l.productName) + ' · ' + l.subCode + ' · ' + tk(l.price) + '/month'}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Two>
                  <Field label="Months" id={'sMonths-' + i}><Stepper id={'sMonths-' + i} value={it.months} onChange={x => onPatch(i, { months: x, till: null })} /></Field>
                  {priceField(it, i)}
                </Two>
                <Two>
                  <Field label="Start from" id={'sFrom-' + i}>
                    <NativeSelect id={'sFrom-' + i} value={it.from} onChange={e => onPatch(i, { from: e.target.value, till: null })}>
                      <NativeSelectOption value="oldPaidTill">Old paid-till date</NativeSelectOption>
                      <NativeSelectOption value="today">Today</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <Field label="Paid till" id={'sTill-' + i}>
                    <Input id={'sTill-' + i} type="date" value={it.till === null ? def : it.till} onChange={e => onPatch(i, { till: e.target.value })} />
                  </Field>
                </Two>
              </>
            ) : null}
            {it.kind === 'custom' ? (
              <>
                <Field label="Item name" id={'sTitle-' + i}><Input id={'sTitle-' + i} autoComplete="off" value={it.title} onChange={e => onPatch(i, { title: e.target.value })} /></Field>
                <Two>
                  <Field label="Price" id={'sAmt-' + i}><Input id={'sAmt-' + i} inputMode="decimal" value={it.amt} onChange={e => onPatch(i, { amt: e.target.value })} /></Field>
                  <Field label="Cost (optional)" id={'sCost-' + i}><Input id={'sCost-' + i} inputMode="decimal" placeholder="0" value={it.cost} onChange={e => onPatch(i, { cost: e.target.value })} /></Field>
                </Two>
              </>
            ) : null}
            {it.kind === 'newSale' ? (
              <>
                <Field label="Product" id={'sProduct-' + i}>
                  <NativeSelect id={'sProduct-' + i} value={it.productId} onChange={e => {
                    const p = L.products.find(x => x.id === e.target.value);
                    onPatch(i, { productId: e.target.value, price: p ? catalog(p.price, it) : '', accountId: '' });
                  }}>
                    <NativeSelectOption value="">Pick a product</NativeSelectOption>
                    {prods.map(p => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field label="Account" id={'sAccount-' + i}>
                  <NativeSelect id={'sAccount-' + i} value={it.accountId} onChange={e => onPatch(i, { accountId: e.target.value })}>
                    <NativeSelectOption value="">{shared ? 'Random free account' : 'Pick an account'}</NativeSelectOption>
                    {accountsFor(it.productId).map(a => <NativeSelectOption key={a.id} value={a.id}>{a.id + ' · ' + a.free + ' free'}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Two>
                  <Field label="Months" id={'sMonths-' + i}><Stepper id={'sMonths-' + i} value={it.months} onChange={x => onPatch(i, { months: x })} /></Field>
                  {priceField(it, i)}
                </Two>
              </>
            ) : null}
            <div className="flex justify-end">
              <Button id={'sRemove-' + i} type="button" variant="ghost" size="sm" onClick={() => onRemove(i)}>Remove</Button>
            </div>
          </div>
        );
      })}
      <Button id="splitAdd" type="button" variant="outline" className="w-fit rounded-full border-dashed font-bold" disabled={items.length >= 6} onClick={onAdd}>
        <Plus />Add item
      </Button>
      <div data-testid="split-left" className="text-sm font-bold">
        {left < 0 ? <span className="text-bad">{'Over by ' + tk(-left)}</span> : 'Left to assign: ' + tk(left)}
      </div>
      {left > 0 ? (
        <Label className="gap-2 text-sm font-medium">
          <Checkbox id="splitCredit" checked={credit} onCheckedChange={c => onCredit(c === true)} />
          Keep the rest as credit
        </Label>
      ) : null}
    </div>
  );
}

export function MatchSheet({ trx }) {
  const { home, lookups: L, today } = useApp();
  const u = (home.unmatched || []).find(x => x.trx === trx);
  const smsDate = u && /^(\d{4}-\d{2}-\d{2})/.exec(String(u.received || '')) ? /^(\d{4}-\d{2}-\d{2})/.exec(String(u.received))[1] : '';
  const smsMethod = (u && METHODS.find(m => m.toLowerCase() === String(u.method || '').toLowerCase())) || 'bKash';
  const [customer, setCustomer] = useState(null);
  const [subCode, setSubCode] = useState('');
  const [channel, setChannel] = useState('WhatsApp');
  const [handle, setHandle] = useState(u ? u.counterparty : '');
  const [amount, setAmount] = useState(u ? String(u.amount) : '');
  const [date, setDate] = useState(smsDate);
  const [method, setMethod] = useState(smsMethod);
  const [note, setNote] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const asked = useRef(0);
  const lines = customer && !customer.isNew ? L.lines.filter(l => l.customerId === customer.id) : [];

  // Server suggestions: same number as the sender, owner of the reference, name match, recent payers.
  const onQuery = useCallback(query => {
    const n = ++asked.current;
    call('suggestCustomers', { trx, query }).then(r => { if (n === asked.current && r.ok) setSuggestions(r.data || []); });
  }, [trx]);

  const { save, busy, error } = useSaver('match', () => {
    if (!customer) throw new Error('Pick a customer.');
    const p = { trx };
    if (customer.isNew) p.newCustomer = { name: customer.name, channel, handle: handle.trim() };
    else { p.customerId = customer.id; if (subCode) p.subCode = subCode; }
    // Only what the owner changed is sent; the rest comes from the SMS.
    const amt = num(amount, 'Amount');
    if (!amt) throw new Error('Enter the amount.');
    if (amt !== u.amount) p.amount = amt;
    if (date && date !== smsDate) p.date = date;
    if (method !== smsMethod) p.method = method;
    if (note.trim()) p.note = note.trim();
    return p;
  });
  // Split: one payment across several items (renewals, custom items, product sales), one request, one Undo.
  const [split, setSplit] = useState(false);
  const [items, setItems] = useState([]);
  const [credit, setCredit] = useState(false);
  const itemKey = useRef(0);
  const [pmode, setPmode] = usePriceMode();
  const payAmt = numOr0(amount);
  const left = U.round2(payAmt - items.reduce((s, it) => U.round2(s + itemAmount(it, pmode)), 0));
  const splitSaver = useSaver('splitMatch', () => {
    if (!customer) throw new Error('Pick a customer.');
    if (!items.length) throw new Error('Add at least one item.');
    const p = { trx, targets: items.map(it => targetOf(it, lines, L, today, pmode)), creditRest: credit };
    if (customer.isNew) p.newCustomer = { name: customer.name, channel, handle: handle.trim() };
    else p.customerId = customer.id;
    // Same overrides as a single match: only what the owner changed is sent.
    const amt = num(amount, 'Amount');
    if (!amt) throw new Error('Enter the amount.');
    if (amt !== u.amount) p.amount = amt;
    if (date && date !== smsDate) p.date = date;
    if (method !== smsMethod) p.method = method;
    if (note.trim()) p.note = note.trim();
    return p;
  });
  function addItem() { setItems(list => (list.length >= 6 ? list : list.concat([Object.assign({ key: ++itemKey.current }, EMPTY_ITEM)]))); }
  function patchItem(i, patch) { setItems(list => list.map((it, j) => (j === i ? Object.assign({}, it, patch) : it))); }
  function removeItem(i) { setItems(list => list.filter((_, j) => j !== i)); }

  const ignore = useSaver('ignoreInbox', () => ({ trx }));
  const remove = useSaver('deleteInbox', () => ({ trx }));
  // One busy flag for the saves: while one runs, the others are disabled too (no second write from another button).
  const anyBusy = busy || splitSaver.busy || ignore.busy || remove.busy;

  if (!u) return <SheetShell title="Match payment"><Hint>This payment is already matched.</Hint></SheetShell>;
  const problem = error || splitSaver.error || ignore.error || remove.error;
  const methods = METHODS.includes(method) ? METHODS : METHODS.concat(method);
  return (
    <SheetShell title="Match payment" description="Attach a received payment to a customer"
      footer={<Footer error={problem} busy={anyBusy} onSave={split ? splitSaver.save : save}>{split ? 'Save split' : 'Save match'}</Footer>}>
      <Stack>
        <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-border bg-background px-4 pt-4 pb-3">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="hero-figure text-5xl">{tk(u.amount)}</div>
            <div className="mt-2 text-sm font-bold">{'from ' + (u.sender || 'unknown')}</div>
            <div className="font-mono text-xs text-muted-foreground"><CopyId value={u.trx} label="transaction ID" />{' · ' + u.received}</div>
          </div>
        </div>
        {u.why ? (
          <div id="mWhy" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm font-medium text-warn">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{u.why}</span>
          </div>
        ) : null}
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-bold">Show the SMS</summary>
          <p className="mt-2 font-mono text-xs leading-relaxed break-words text-muted-foreground">{u.sms}</p>
        </details>

        <CustomerCombobox id="mCustomer" allowNew value={customer} onChange={c => { setCustomer(c); setSubCode(''); }}
          suggestions={suggestions} onQuery={onQuery} />
        {customer && customer.isNew ? (
          <Two>
            <Field label="Contact via" id="mnChannel"><NativeSelect id="mnChannel" value={channel} onChange={e => setChannel(e.target.value)}><Options list={CHANNELS} /></NativeSelect></Field>
            <Field label="Number or username" id="mnHandle"><Input id="mnHandle" autoComplete="off" value={handle} onChange={e => setHandle(e.target.value)} /></Field>
          </Two>
        ) : null}

        {split ? null : (<>
        <Field label="Renew a subscription (optional)" id="lineSel">
          <NativeSelect id="lineSel" value={subCode} onChange={e => setSubCode(e.target.value)}>
            <NativeSelectOption value="">Just record the payment</NativeSelectOption>
            {lines.map(l => <NativeSelectOption key={l.subCode} value={l.subCode}>{productShort(l.productName) + ' · ' + l.subCode + ' · ' + tk(l.price) + '/month'}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Hint>Dues are paid first. If enough is left for a full month it renews.</Hint>
        </>)}

        <Label className="gap-2 text-sm font-bold">
          <Checkbox id="splitToggle" checked={split} onCheckedChange={c => { setSplit(c === true); if (c === true && !items.length) addItem(); }} />
          Split this payment
        </Label>
        {split ? (
          <SplitItems items={items} lines={lines} L={L} today={today} left={left} credit={credit} onCredit={setCredit}
            onAdd={addItem} onPatch={patchItem} onRemove={removeItem} mode={pmode} onMode={setPmode} />
        ) : null}

        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-bold">Adjust amount, date or method</summary>
          <div className="mt-3 grid gap-3">
            <Two>
              <Field label="Amount" id="mAmount"><Input id="mAmount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
              <Field label="Method" id="mMethod"><NativeSelect id="mMethod" value={method} onChange={e => setMethod(e.target.value)}><Options list={methods} /></NativeSelect></Field>
            </Two>
            <Field label="Date" id="mDate"><Input id="mDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
            <Field label="Note" id="mNote"><Input id="mNote" value={note} onChange={e => setNote(e.target.value)} /></Field>
            <Hint>The SMS text stays as received. These change only the payment that is recorded.</Hint>
          </div>
        </details>

        <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
          <ConfirmButton id="mIgnore" label="Not a sale" icon={EyeOff} title="Mark as not a sale?" confirmLabel="Not a sale" disabled={anyBusy}
            description="The message is kept for the record but leaves this list. You can undo this right after from the toast." onConfirm={ignore.save} />
          <ConfirmButton id="mDelete" label="Delete" icon={Trash2} variant="outline" className="text-bad hover:text-bad" title="Delete this message?" confirmLabel="Delete" disabled={anyBusy}
            description="The message is removed from the inbox. You can undo this right after from the toast." onConfirm={remove.save} />
        </div>
      </Stack>
    </SheetShell>
  );
}

function walletList(L) { return L.wallets.map(w => ({ value: w.id, label: w.label + ' (' + w.id + ')' })); }

// ── Money out ─────────────────────────────────────────────────────────
export function ExpenseSheet() {
  const { lookups: L, today } = useApp();
  const [cat, setCat] = useState(L.expenseCategories[0] || '');
  const [amt, setAmt] = useState('');
  const [date, setDate] = useState(today);
  const [wallet, setWallet] = useState(L.wallets[0] ? L.wallets[0].id : '');
  const [note, setNote] = useState('');
  const { save, busy, error } = useSaver('addExpense', () => ({ category: cat, amount: num(amt, 'Amount'), date, paidWith: wallet, note }));
  return (
    <SheetShell title="Add expense" description="Record money you spent" footer={<Footer error={error} busy={busy} onSave={save}>Save expense</Footer>}>
      <Stack>
        <Two>
          <Field label="Category" id="xCat"><NativeSelect id="xCat" value={cat} onChange={e => setCat(e.target.value)}><Options list={L.expenseCategories} /></NativeSelect></Field>
          <Field label="Amount" id="xAmt"><Input id="xAmt" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Date" id="xDate"><Input id="xDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="Paid with" id="xWallet"><NativeSelect id="xWallet" value={wallet} onChange={e => setWallet(e.target.value)}><Options list={walletList(L)} /></NativeSelect></Field>
        </Two>
        <Field label="Note" id="xNote"><Input id="xNote" value={note} onChange={e => setNote(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

export function PurchaseSheet({ accountId }) {
  const { lookups: L, today } = useApp();
  const first = accountId || (L.accounts[0] ? L.accounts[0].id : '');
  const [acct, setAcct] = useState(first);
  const costOf = id => { const a = L.accounts.find(x => x.id === id); return a ? String(a.cost) : ''; };
  const [amt, setAmt] = useState(costOf(first));
  const [wallet, setWallet] = useState(L.wallets[0] ? L.wallets[0].id : '');
  const [date, setDate] = useState(today);
  const [till, setTill] = useState('');
  const { save, busy, error } = useSaver('addPurchase', () => ({ accountId: acct, amount: num(amt, 'Amount'), paidWith: wallet, date, coversUntil: till }));
  return (
    <SheetShell title="Account purchase" description="Record paying for a shared account" footer={<Footer error={error} busy={busy} onSave={save}>Save purchase</Footer>}>
      <Stack>
        <Field label="Account" id="uAcct">
          <NativeSelect id="uAcct" value={acct} onChange={e => { setAcct(e.target.value); setAmt(costOf(e.target.value)); }}>
            <Options list={L.accounts.map(a => ({ value: a.id, label: a.id + ' · ' + a.label }))} />
          </NativeSelect>
        </Field>
        <Two>
          <Field label="Amount paid" id="uAmt"><Input id="uAmt" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} /></Field>
          <Field label="Paid with" id="uWallet"><NativeSelect id="uWallet" value={wallet} onChange={e => setWallet(e.target.value)}><Options list={walletList(L)} /></NativeSelect></Field>
        </Two>
        <Two>
          <Field label="Date" id="uDate"><Input id="uDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="Covers until" id="uTill"><Input id="uTill" type="date" value={till} onChange={e => setTill(e.target.value)} /></Field>
        </Two>
      </Stack>
    </SheetShell>
  );
}
