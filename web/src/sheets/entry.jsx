import { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { call } from '@/lib/api';
import { num, productShort, tk } from '@/lib/format';
import { useApp, useSaver, useSheets } from '@/lib/store';
import { ConfirmButton, ErrorBox, Field, Hint, SheetShell, SaveButton, Stack, Two } from '@/components/kit';
import { EditPaymentSheet } from '@/sheets/payment';
import { Options } from '@/sheets/sale';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';

const KINDS = {
  payment: { name: 'Payment', idKey: 'Payment_ID', param: 'paymentId', remove: 'deletePayment', gone: 'Payment deleted' },
  expense: { name: 'Expense', idKey: 'Expense_ID', param: 'expenseId', remove: 'deleteExpense', gone: 'Expense deleted' },
  purchase: { name: 'Purchase', idKey: 'Purchase_ID', param: 'purchaseId', remove: 'deletePurchase', gone: 'Purchase deleted' }
};

function walletOptions(L, current) {
  const list = L.wallets.map(w => ({ value: w.id, label: w.label + ' (' + w.id + ')' }));
  if (current && !L.wallets.some(w => w.id === current)) list.push({ value: current, label: current });
  return list;
}

function Fact({ label, children }) {
  if (children === '' || children === null || children === undefined) return null;
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-bold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm font-semibold break-words">{children}</dd>
    </div>
  );
}

/** One Book entry in full: its facts, the raw message for a payment, and the audit trail. Edit and Delete live here. */
export function EntrySheet({ kind, id }) {
  const { lookups } = useApp();
  const sheets = useSheets();
  const k = KINDS[kind];
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Reads again after every save, so a change made in the edit sheet shows here and in the audit trail. A failed read (or a rejected call) shows an error with Retry, never a skeleton that stays.
  useEffect(() => {
    let live = true;
    setState(s => (s.error ? { loading: true, error: '', data: null } : s));
    call('entry', { kind, id }).then(r => {
      if (live) setState(r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error || 'Could not load this entry.', data: null });
    }, () => {
      if (live) setState({ loading: false, error: 'Could not load this entry. Check the connection and try again.', data: null });
    });
    return () => { live = false; };
  }, [kind, id, lookups, attempt]);
  const remove = useSaver(k.remove, () => ({ [k.param]: id }), { keepParent: false });
  const title = k.name + ' ' + id;

  if (state.loading) return <SheetShell title={title}><Stack><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></Stack></SheetShell>;
  if (state.error) {
    return (
      <SheetShell title={title}>
        <Stack>
          <ErrorBox testId="entry-error">{state.error}</ErrorBox>
          <Button type="button" variant="outline" onClick={() => setAttempt(a => a + 1)}>Retry</Button>
        </Stack>
      </SheetShell>
    );
  }

  const d = state.data;
  const r = d.row;
  async function edit() {
    if (kind === 'expense') { sheets.open(<EditExpenseSheet row={r} />); return; }
    if (kind === 'purchase') { sheets.open(<EditPurchaseSheet row={r} />); return; }
    setOpening(true); setOpenError('');
    const c = await call('customer', { id: r.Customer_ID });
    setOpening(false);
    if (!c.ok) { setOpenError(c.error); return; }
    sheets.open(<EditPaymentSheet payment={{ paymentId: r.Payment_ID, date: r.Date || '', saleId: r.Sale_ID, amount: Number(r.Amount) || 0,
      method: r.Method || '', trx: r.Transaction_ID || '', source: r.Source, lines: c.data.history }} />);
  }

  const product = d.sale ? lookups.products.find(p => p.id === d.sale.Product_ID) : null;
  const wallet = d.wallet ? d.wallet.Label + ' (' + d.wallet.Wallet_ID + ')' : r.Paid_With;
  const footer = (
    <Stack className="gap-3">
      <ErrorBox>{remove.error || openError}</ErrorBox>
      <div className="grid grid-cols-2 gap-2">
        <Button id="entryEdit" type="button" size="lg" className="font-extrabold" disabled={opening || remove.busy} onClick={edit}><Pencil />Edit</Button>
        <ConfirmButton id="entryDelete" label="Delete" icon={Trash2} className="h-10 w-full text-bad hover:text-bad" title={'Delete this ' + kind + '?'} confirmLabel="Delete"
          description={kind === 'payment' ? "The customer's balance is recomputed without it. You can undo this right after from the toast." : 'The Book is recomputed without it. You can undo this right after from the toast.'}
          onConfirm={remove.save} />
      </div>
    </Stack>
  );

  return (
    <SheetShell title={title} description={'Details and history of ' + kind + ' ' + id} footer={footer}>
      <Stack>
        <div className="flex items-baseline justify-between gap-3">
          <span className="money text-3xl font-extrabold">{tk(r.Amount)}</span>
          <span className="font-mono text-xs text-muted-foreground">{r.Date || 'No date'}</span>
        </div>
        <dl className="grid gap-3">
          {kind === 'payment' ? (
            <>
              <Fact label="Transaction ID"><span className="font-mono">{r.Transaction_ID}</span></Fact>
              <Fact label="Customer">{d.customer ? d.customer.Name : r.Customer_ID}</Fact>
              <Fact label="Applied to">{d.sale
                ? '#' + d.sale.Sale_ID + ' ' + (product ? productShort(product.name) : d.sale.Product_ID) + ' · ' + d.sale.Sub_Code
                : 'Credit (not applied to a line)'}</Fact>
              <Fact label="Method">{r.Method}</Fact>
              <Fact label="Source">{r.Source}</Fact>
            </>
          ) : null}
          {kind === 'expense' ? (
            <>
              <Fact label="Category">{r.Category}</Fact>
              <Fact label="Note">{r.Note}</Fact>
              <Fact label="Paid with">{wallet}</Fact>
            </>
          ) : null}
          {kind === 'purchase' ? (
            <>
              <Fact label="Account">{r.Account_ID}</Fact>
              <Fact label="Paid with">{wallet}</Fact>
              <Fact label="Covers until">{r.Covers_Until}</Fact>
              <Fact label="Notes">{r.Notes}</Fact>
            </>
          ) : null}
        </dl>
        {d.sms ? (
          <details className="rounded-xl border border-border bg-card/60 px-4 py-3">
            <summary className="cursor-pointer text-sm font-bold">Raw message</summary>
            <p className="mt-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{d.sms}</p>
          </details>
        ) : null}
        <section className="grid gap-2" aria-label="History">
          <h3 className="text-sm font-extrabold tracking-tight">History</h3>
          {d.audit.length ? (
            <ul aria-label="Audit trail" className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {d.audit.map((a, i) => (
                <li key={i} className="grid gap-0.5 px-4 py-2.5 text-xs">
                  <span className="font-mono text-muted-foreground">{a.when}</span>
                  <span className="font-semibold">{[a.action, a.field].filter(Boolean).join(' · ')}</span>
                  {a.old !== '' || a.new !== '' ? <span className="break-words text-muted-foreground">{(a.old === '' ? '(blank)' : a.old) + ' became ' + (a.new === '' ? '(blank)' : a.new)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <Hint>No changes recorded for this entry.</Hint>}
        </section>
      </Stack>
    </SheetShell>
  );
}

function Footer({ error, busy, onSave, children }) {
  return <Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={onSave}>{children}</SaveButton></Stack>;
}

export function EditExpenseSheet({ row: r }) {
  const { lookups: L } = useApp();
  const [cat, setCat] = useState(r.Category || '');
  const [amt, setAmt] = useState(String(r.Amount));
  const [date, setDate] = useState(r.Date || '');
  const [wallet, setWallet] = useState(r.Paid_With || '');
  const [note, setNote] = useState(r.Note || '');
  const cats = L.expenseCategories.includes(cat) ? L.expenseCategories : L.expenseCategories.concat(cat);
  const { save, busy, error } = useSaver('editExpense', () => {
    const v = { expenseId: r.Expense_ID };
    const a = num(amt, 'Amount');
    if (!a) throw new Error('Enter the amount.');
    if (a !== Number(r.Amount)) v.amount = a;
    if (cat !== (r.Category || '')) v.category = cat;
    if (date !== (r.Date || '')) v.date = date;
    if (wallet !== (r.Paid_With || '')) v.paidWith = wallet;
    if (note.trim() !== (r.Note || '')) v.note = note.trim();
    if (Object.keys(v).length === 1) throw new Error('Nothing changed.');
    return v;
  }, { keepParent: true });
  return (
    <SheetShell title="Edit expense" description={'Change expense ' + r.Expense_ID} footer={<Footer error={error} busy={busy} onSave={save}>Save changes</Footer>}>
      <Stack>
        <Hint>{r.Expense_ID}</Hint>
        <Two>
          <Field label="Category" id="xCat"><NativeSelect id="xCat" value={cat} onChange={e => setCat(e.target.value)}><Options list={cats} /></NativeSelect></Field>
          <Field label="Amount" id="xAmt"><Input id="xAmt" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Date" id="xDate"><Input id="xDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="Paid with" id="xWallet">
            <NativeSelect id="xWallet" value={wallet} onChange={e => setWallet(e.target.value)}>
              {wallet ? null : <NativeSelectOption value="">Not recorded</NativeSelectOption>}
              <Options list={walletOptions(L, wallet)} />
            </NativeSelect>
          </Field>
        </Two>
        <Field label="Note" id="xNote"><Input id="xNote" value={note} onChange={e => setNote(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

export function EditPurchaseSheet({ row: r }) {
  const { lookups: L } = useApp();
  const [acct, setAcct] = useState(r.Account_ID || '');
  const [amt, setAmt] = useState(String(r.Amount));
  const [wallet, setWallet] = useState(r.Paid_With || '');
  const [date, setDate] = useState(r.Date || '');
  const [till, setTill] = useState(r.Covers_Until || '');
  const [notes, setNotes] = useState(r.Notes || '');
  const accounts = L.accounts.map(a => ({ value: a.id, label: a.id + ' · ' + a.label }));
  if (!L.accounts.some(a => a.id === r.Account_ID)) accounts.push({ value: r.Account_ID, label: r.Account_ID });
  const { save, busy, error } = useSaver('editPurchase', () => {
    const v = { purchaseId: r.Purchase_ID };
    const a = num(amt, 'Amount');
    if (!a) throw new Error('Enter the amount.');
    if (a !== Number(r.Amount)) v.amount = a;
    if (acct !== (r.Account_ID || '')) v.accountId = acct;
    if (wallet !== (r.Paid_With || '')) v.paidWith = wallet;
    if (date !== (r.Date || '')) v.date = date;
    if (till !== (r.Covers_Until || '')) v.coversUntil = till;
    if (notes.trim() !== (r.Notes || '')) v.notes = notes.trim();
    if (Object.keys(v).length === 1) throw new Error('Nothing changed.');
    return v;
  }, { keepParent: true });
  return (
    <SheetShell title="Edit purchase" description={'Change purchase ' + r.Purchase_ID} footer={<Footer error={error} busy={busy} onSave={save}>Save changes</Footer>}>
      <Stack>
        <Hint>{r.Purchase_ID}</Hint>
        <Field label="Account" id="uAcct"><NativeSelect id="uAcct" value={acct} onChange={e => setAcct(e.target.value)}><Options list={accounts} /></NativeSelect></Field>
        <Two>
          <Field label="Amount paid" id="uAmt"><Input id="uAmt" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} /></Field>
          <Field label="Paid with" id="uWallet">
            <NativeSelect id="uWallet" value={wallet} onChange={e => setWallet(e.target.value)}>
              {wallet ? null : <NativeSelectOption value="">Not recorded</NativeSelectOption>}
              <Options list={walletOptions(L, wallet)} />
            </NativeSelect>
          </Field>
        </Two>
        <Two>
          <Field label="Date" id="uDate"><Input id="uDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="Covers until" id="uTill"><Input id="uTill" type="date" value={till} onChange={e => setTill(e.target.value)} /></Field>
        </Two>
        <Field label="Notes" id="uNotes"><Input id="uNotes" value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}
