import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { tk } from '@/lib/format';
import { useApp, useInlineSave } from '@/lib/store';
import { Pill } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Cell, MatchPick, RowFrame, signed, useMigNav } from '@/screens/migration/parts';

// One component per staged kind. Fields are the ones Core.importer.FIELDS allows; matches write data.use through importEdit.

const LINE_STATUS = [{ value: 'Paid', label: 'Paid' }, { value: 'Due', label: 'Due' }, { value: 'Unpaid', label: 'Unpaid' }];

function productExtras(L, kind, have) {
  const code = kind === 'code';
  return ((L && L.products) || [])
    .filter(p => (code ? p.deliversAs === 'code' : p.deliversAs === 'account') && !have.some(h => h.id === p.id))
    .map(p => ({ value: p.id, label: p.name }));
}

/** "6 months · ৳800 total (৳133.33/mo)": what the sale will be, from the months and the total (paid plus still owed). */
function SaleSummary({ d }) {
  const months = Math.max(1, Math.floor(Number(d.months) || 1));
  const total = (Number(d.amount) || 0) + (Number(d.dueAmount) || 0);
  if (!(total > 0)) return null;
  return <p data-testid="mig-summary" className="col-span-full px-1.5 text-xs text-muted-foreground">{months + (months === 1 ? ' month' : ' months') + ' · ' + tk(total) + ' total (' + tk(Math.round(total / months * 100) / 100) + '/mo)'}</p>;
}

/** A line: the customer on a shared account, with what the sheet says they paid. */
export function LineRow({ v, orphan = false }) {
  const { lookups: L } = useApp();
  const m = v.match || {};
  const cands = (m.candidates && m.candidates.customers) || [];
  const sales = (m.candidates && m.candidates.sales) || [];
  const diff = m.sale && m.sale.difference;
  const accountOptions = ((L && L.accounts) || []).map(a => ({ value: a.id, label: a.id + ' · ' + a.label }));
  const matches = [
    <MatchPick key="c" v={v} useKey="customerId" label="Customer" newLabel="Create new customer"
      current={m.customer ? 'Matches ' + m.customer.name : 'No existing customer: a new one is created'}
      candidates={cands.map(c => ({ value: c.id, label: c.name + ' · ' + c.id }))} />,
    <MatchPick key="s" v={v} useKey="saleId" label="Sale" newLabel="Create new sale"
      current={m.sale ? 'Matches sale ' + m.sale.saleId + (typeof diff === 'number' ? (diff > 0 ? ', adds a payment of ' + tk(diff) : diff < 0 ? ', already paid ' + tk(-diff) + ' more' : ', already paid in full') : '') : 'No existing sale: a new one is created'}
      candidates={sales.map(s => ({ value: s.saleId, label: 'Sale ' + s.saleId + ' · ' + s.customer + ' · paid ' + tk(s.paid) + (s.paidTill ? ' till ' + s.paidTill : '') }))} />
  ];
  if (orphan) {
    matches.unshift(<MatchPick key="a" v={v} useKey="accountId" label="Account" allowNew={false}
      current={m.account ? 'Posts to ' + m.account.label : 'No account yet. Pick one.'} candidates={accountOptions} />);
  }
  const fields = [
    <Cell key="name" v={v} field="name" label="Name" />,
    <Cell key="profile" v={v} field="profile" label="Profile" blank />,
    <Cell key="status" v={v} field="status" label="Status" type="select" options={LINE_STATUS} blank />,
    <Cell key="amount" v={v} field="amount" label="Total paid" type="money" />,
    <Cell key="dueAmount" v={v} field="dueAmount" label="Still owes" type="money" blank />,
    <Cell key="paidTill" v={v} field="paidTill" label="Paid till" type="date" />,
    <Cell key="coversFrom" v={v} field="coversFrom" label="Covers from" type="date" />,
    <Cell key="due" v={v} field="due" label="Due date" type="date" />,
    <Cell key="renewalDate" v={v} field="renewalDate" label="Renewal" type="date" />,
    <Cell key="months" v={v} field="months" label="Months (1 to 24)" type="plain" blank />,
    <SaleSummary key="sum" d={v.data} />
  ];
  return <RowFrame v={v} fields={fields} matches={matches} />;
}

/** An extra: rent or a custom amount on the account that belongs to no customer. */
export function ExtraRow({ v, orphan = false }) {
  const { lookups: L } = useApp();
  const m = v.match || {};
  const accountOptions = ((L && L.accounts) || []).map(a => ({ value: a.id, label: a.id + ' · ' + a.label }));
  const matches = orphan ? [<MatchPick key="a" v={v} useKey="accountId" label="Account" allowNew={false}
    current={m.account ? 'Posts to ' + m.account.label : 'No account yet. Pick one.'} candidates={accountOptions} />] : null;
  const fields = [
    <Cell key="label" v={v} field="label" label="Label" blank />,
    <Cell key="amount" v={v} field="amount" label="Amount" type="money" />,
    <Cell key="coversFrom" v={v} field="coversFrom" label="Covers from" type="date" />,
    <Cell key="paidTill" v={v} field="paidTill" label="Paid till" type="date" />
  ];
  return <RowFrame v={v} fields={fields} matches={matches} />;
}

export function CodeRow({ v }) {
  const { lookups: L } = useApp();
  const m = v.match || {};
  const prods = (m.candidates && m.candidates.products) || [];
  const fields = [
    <Cell key="code" v={v} field="code" label="Code" />,
    <Cell key="family" v={v} field="family" label="Family" blank />,
    <Cell key="productHint" v={v} field="productHint" label="Product hint" blank />
  ];
  const matches = [<MatchPick key="p" v={v} useKey="productId" label="Product" allowNew={false}
    current={m.product ? 'Matches ' + m.product.name : 'No product matches the hint'}
    candidates={prods.map(p => ({ value: p.id, label: p.name })).concat(productExtras(L, 'code', prods))} />];
  return <RowFrame v={v} fields={fields} matches={matches} />;
}

export function InboxRow({ v }) {
  const fields = [
    <Cell key="trx" v={v} field="Transaction_ID" label="Transaction" />,
    <Cell key="amount" v={v} field="Amount" label="Amount" type="money" blank />,
    <Cell key="cp" v={v} field="Counterparty" label="Counterparty" blank />,
    <Cell key="ref" v={v} field="Reference" label="Reference" blank />,
    <Cell key="status" v={v} field="Status" label="Status" blank />
  ];
  return <RowFrame v={v} fields={fields} />;
}

function Money({ label, value, tone }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={'money text-sm font-bold' + (tone === 'warn' ? ' text-warn' : tone === 'ok' ? ' text-ok' : '')}>{value}</div>
    </div>
  );
}

/** What the sheet says it collected against what the staged lines add up to. The words carry the meaning; colour backs them up. */
function Totals({ a }) {
  const d = a.difference;
  const say = d === null ? 'No sheet total' : d === 0 ? 'Matches' : d > 0 ? 'Sheet is higher by ' + tk(d) : 'Staged is higher by ' + tk(-d);
  return (
    <div data-testid="mig-totals" className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
      <Money label="Sheet collected" value={a.sheetCollected === null ? '—' : tk(a.sheetCollected)} />
      <Money label="Staged total" value={tk(a.stagedTotal)} />
      <Money label="Difference" value={d === null ? '—' : signed(d)} tone={d === 0 ? 'ok' : d === null ? '' : 'warn'} />
      <div className="min-w-0"><div className="eyebrow">Check</div><div className={'text-sm font-bold' + (d === 0 ? ' text-ok' : d === null ? ' text-muted-foreground' : ' text-warn')}>{say}</div></div>
    </div>
  );
}

/** One staged account with its lines and extras nested below. */
export function AccountCard({ a, batch, kids, startOpen }) {
  const { lookups: L } = useApp();
  const v = a.row;
  const m = v.match || {};
  const [open, setOpen] = useState(startOpen);
  const nav = useMigNav();
  // A jump to one of this card's rows opens the card.
  useEffect(() => {
    if (nav.target && a.lines.concat(a.extras).some(k => k.id === nav.target.rowId)) setOpen(true);
  }, [nav.target]);   // eslint-disable-line react-hooks/exhaustive-deps
  const bulk = useInlineSave('importStatus', ids => ({ rowIds: ids, status: 'Approved' }));
  const add = useInlineSave('importAdd', k => ({ batch, kind: k, data: k === 'line' ? { accountRef: v.id, status: 'Paid' } : { accountRef: v.id } }));
  const all = [v].concat(a.lines, a.extras);
  const clean = all.filter(r => r.status === 'Review' && !r.issues.length).map(r => r.id);
  const prods = (m.candidates && m.candidates.products) || [];
  const accs = (m.candidates && m.candidates.accounts) || [];
  const applied = v.status === 'Applied';
  const shown = kids.length;
  const fields = [
    <Cell key="label" v={v} field="label" label="Account label" placeholder="Type a label" />,
    <Cell key="cost" v={v} field="cost" label="Cost" type="money" />,
    <Cell key="renewalDate" v={v} field="renewalDate" label="Renewal" type="date" />,
    <Cell key="slots" v={v} field="slots" label="Slots" type="plain" />
  ];
  const matches = [
    <MatchPick key="p" v={v} useKey="productId" label="Product" allowNew={false}
      current={m.product ? 'Matches ' + m.product.name : 'No product yet. Pick one.'}
      candidates={prods.map(p => ({ value: p.id, label: p.name })).concat(productExtras(L, 'account', prods))} />,
    <MatchPick key="a" v={v} useKey="accountId" label="Account" newLabel="Create new account"
      current={m.account ? 'Matches ' + m.account.label : 'No existing account: a new one is created'}
      candidates={accs.map(x => ({ value: x.id, label: x.id + ' · ' + x.label }))} />
  ];
  return (
    <section data-testid="mig-account" data-row={v.id} data-cell-group="" className="overflow-hidden rounded-xl border border-border bg-card/80 backdrop-blur-sm">
      <RowFrame v={v} fields={fields} matches={matches} />
      <div className="grid gap-3 border-t border-border px-4 py-3">
        <Totals a={a} />
        {!applied ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" disabled={!clean.length}
              onClick={() => bulk(clean, { message: clean.length + ' clean rows approved' })}>{'Approve all clean rows' + (clean.length ? ' (' + clean.length + ')' : '')}</Button>
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" onClick={() => add('line', { message: 'Line added' })}><Plus />Add line</Button>
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" onClick={() => add('extra', { message: 'Extra added' })}><Plus />Add extra</Button>
          </div>
        ) : null}
        <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
          className="flex min-h-11 items-center gap-2 rounded-md text-left text-sm font-bold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          {a.lines.length + (a.lines.length === 1 ? ' line' : ' lines') + ' · ' + a.extras.length + (a.extras.length === 1 ? ' extra' : ' extras')}
          {shown !== a.lines.length + a.extras.length ? <Pill tone="muted">{shown + ' shown'}</Pill> : null}
        </button>
      </div>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {kids.map(k => (k.kind === 'line' ? <LineRow key={k.id} v={k} /> : <ExtraRow key={k.id} v={k} />))}
          {!kids.length ? <p className="px-4 py-4 text-sm text-muted-foreground">No rows match the filter.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
