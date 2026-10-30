import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Plus, Repeat, Search } from 'lucide-react';
import { call } from '@/lib/api';
import { cn } from '@/lib/utils';
import { rateText, shortDate, tk } from '@/lib/format';
import { useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { ExpenseAmount, ExpenseCategory, ExpenseCells, ExpenseDate, ExpenseNote, PaymentAmount, PaymentCells, PaymentDate, PaymentMethod,
  PaymentNote, PurchaseAccount, PurchaseAmount, PurchaseCells, PurchaseDate, PurchaseNotes } from '@/components/money-cells';
import { DataTable as Grid } from '@/components/DataTable';
import { SavedViews } from '@/components/SavedViews';
import { Figure as NumberFigure } from '@/components/Figure';
import { ProfitFigure } from '@/components/ProfitFigure';
import { Chip, Empty, ErrorBox, Hint, Pill, Section, useCollapsed, useMedia } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfitByMonth } from '@/screens/money/ProfitByMonth';
import { Overview } from '@/screens/money/Overview';
import { Cash } from '@/screens/money/Cash';
import { ExportButton } from '@/screens/money/ExportButton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cleanSorting, cleanVisibility, oneOf } from '@/lib/savedViews';

function useCall(action, payload, deps) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    call(action, payload).then(r => { if (live) setState(r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error, data: null }); });
    return () => { live = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Figure({ label, value, tone, sub, lines, figure }) {
  return (
    <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
      <div className="eyebrow">{label}</div>
      {figure ? <div className="mt-2">{figure}</div> : (
        <NumberFigure value={value} className={cn('mt-2 text-[clamp(3.5rem,18vw,6.5rem)]', tone === 'bad' ? 'text-bad' : 'text-foreground')} />
      )}
      {sub ? <div className="mt-3 text-sm text-muted-foreground">{sub}</div> : null}
      {lines ? (
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
          {lines.map(l => (
            <div key={l[0]}>
              <dt className="eyebrow">{l[0]}</dt>
              <dd className={cn('money mt-1 text-lg font-semibold', l[2] === 'ok' ? 'text-ok' : l[2] === 'bad' ? 'text-bad' : '')}>{l[1]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function ProfitByCategory() {
  const { lookups } = useApp();
  const open = useOpeners();
  const { loading, error, data } = useCall('profit', {}, [lookups]);
  const rate = lookups.rate;
  const [closed, toggle] = useCollapsed('profit');

  if (loading && !data) return <div className="grid gap-4"><Skeleton className="h-52 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  const fams = (data && data.families) || [];
  const rev = fams.reduce((a, f) => a + Number(f.revenue || 0), 0);
  const cost = fams.reduce((a, f) => a + Number(f.cost || 0), 0);
  const net = rev - cost;
  const unpaid = Number(data && data.totals ? data.totals.uncollected : fams.reduce((a, f) => a + Number(f.uncollected || 0), 0));
  const margin = rev > 0 ? Math.round(net / rev * 10000) / 100 : 0;
  const rateMissing = fams.some(f => f.rateMissing);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
      <div className="grid gap-4">
        <Figure label="Net profit" value={net} tone={net >= 0 ? 'ok' : 'bad'} sub={'Margin ' + margin + '%'}
          figure={<ProfitFigure profit={net} collected={net - unpaid} uncollected={unpaid} />}
          lines={[['Revenue', tk(rev), 'ok'], ['Cost', tk(cost), 'bad']]} />
        {rateMissing ? <ErrorBox testId="rate-missing">Rate missing: USDT costs count as 0, so profit is incomplete. Set a manual rate in Settings.</ErrorBox> : null}
        <div data-testid="rate-line" className="flex items-center gap-3 rounded-xl border border-border bg-card/70 px-4 py-3">
          <Repeat className="size-4 text-muted-foreground" aria-hidden="true" />
          <b className="money flex-1 text-xs font-semibold">{rateText(rate)}</b>
          <Button type="button" size="sm" variant="outline" id="openCalc" onClick={() => open.calculator()}>Calculator</Button>
        </div>
      </div>
      <Section title="By category" count={fams.length + (fams.length === 1 ? ' category' : ' categories')}>
        {fams.length ? fams.map(f => {
          const share = rev > 0 ? Math.max(0, Math.min(100, (Number(f.revenue) / rev) * 100)) : 0;
          const ck = 'c:' + f.category;
          const isOpen = !closed.has(ck);
          const prods = f.products || [];
          return (
            <div key={f.category} className="grid gap-2.5 px-4 py-3.5">
              <div className="flex items-start gap-3">
                <button type="button" aria-expanded={isOpen} disabled={!prods.length} onClick={() => toggle(ck)} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
                  {prods.length ? (isOpen ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{f.category}</span>
                    <span className="block text-xs text-muted-foreground">{'Revenue ' + tk(f.revenue) + ' · Cost ' + tk(f.cost)}</span>
                  </span>
                </button>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn('money text-sm font-bold', f.profit >= 0 ? 'text-ok' : 'text-bad')}>{(f.profit >= 0 ? '+' : '−') + tk(Math.abs(f.profit))}</span>
                  <div className="flex flex-wrap items-center justify-end gap-x-1">
                    <Pill tone={f.profit >= 0 ? 'ok' : 'bad'}>{f.marginPct + '% margin'}</Pill>
                    <ProfitFigure size="row" profit={f.profit} collected={f.collectedProfit} uncollected={f.uncollected} />
                  </div>
                </div>
              </div>
              <Progress value={share} aria-label={f.category + ' share of revenue'} className="h-1.5" />
              {isOpen && prods.length ? (
                <ul className="grid gap-1.5 border-l border-border pl-3">
                  {prods.map(x => (
                    <li key={x.productId} className="flex items-baseline gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate font-semibold">{x.name}</span>
                      <span className="money text-muted-foreground">{tk(x.revenue)}</span>
                      <span className={cn('money w-20 text-right font-semibold', x.profit >= 0 ? 'text-ok' : 'text-bad')}>{(x.profit >= 0 ? '+' : '−') + tk(Math.abs(x.profit))}</span>
                      <ProfitFigure size="row" profit={x.profit} collected={x.collectedProfit} uncollected={x.uncollected} className="shrink-0" />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        }) : <Empty>No sales data recorded yet.</Empty>}
      </Section>
    </div>
  );
}

const bookTarget = e => (e.type === 'payment' ? 'payment ' : e.type === 'expense' ? 'expense ' : 'purchase ') + e.id;
const BOOK_COLUMN_IDS = ['date', 'type', 'label', 'method', 'in', 'out', 'balance'];

// Book table (md and up). The same entries in the same order as the cards; each field is the card's inline editor in its own column.
// Expense and purchase rows put Category and Account under the type word, and a payment's method is its Method cell.
const BOOK_NONE = [];
const BOOK_COLUMNS = [
  { id: 'date', accessorKey: 'date', header: 'Date', meta: { label: 'Date', width: 'w-40' },
    cell: ({ row }) => {
      const e = row.original;
      if (e.type === 'payment') return <PaymentDate id={e.id} target={bookTarget(e)} date={e.date} locked={e.locked} />;
      if (e.type === 'expense') return <ExpenseDate id={e.id} target={bookTarget(e)} date={e.date} />;
      return <PurchaseDate id={e.id} target={bookTarget(e)} date={e.date} />;
    } },
  { id: 'type', accessorKey: 'type', header: 'Type', meta: { label: 'Type', width: 'w-44' },
    cell: ({ row }) => {
      const e = row.original;
      if (e.type === 'expense') return <div className="grid min-w-0 gap-1"><span className="truncate">Expense</span><ExpenseCategory id={e.id} target={bookTarget(e)} category={e.category} /></div>;
      if (e.type === 'purchase') return <div className="grid min-w-0 gap-1"><span className="truncate">Purchase</span><PurchaseAccount id={e.id} target={bookTarget(e)} accountId={e.accountId} /></div>;
      return <span className="truncate">Payment</span>;
    } },
  { id: 'label', accessorKey: 'label', header: 'Label', meta: { label: 'Label' },
    cell: ({ row }) => {
      const e = row.original;
      const target = bookTarget(e);
      const note = e.type === 'payment' ? <PaymentNote id={e.id} target={target} note={e.note} locked={e.locked} />
        : e.type === 'expense' ? <ExpenseNote id={e.id} target={target} note={e.note} />
          : <PurchaseNotes id={e.id} target={target} notes={e.notes} />;
      return <div className="grid min-w-0 gap-1"><span className="truncate font-bold">{e.label}</span>{note}</div>;
    } },
  { id: 'method', accessorKey: 'method', header: 'Method', meta: { label: 'Method', width: 'w-36' },
    cell: ({ row }) => {
      const e = row.original;
      if (e.type === 'payment') return <PaymentMethod id={e.id} target={bookTarget(e)} method={e.method} locked={e.locked} />;
      return <span className="text-muted-foreground">{e.method || '—'}</span>;
    } },
  { id: 'in', accessorFn: e => (e.kind === 'in' ? e.amount : 0), header: 'In', meta: { label: 'In', align: 'right', mono: true, width: 'w-32' },
    cell: ({ row }) => {
      const e = row.original;
      return e.kind === 'in' ? <PaymentAmount id={e.id} target={bookTarget(e)} amount={e.amount} locked={e.locked} signed align="end" /> : null;
    } },
  { id: 'out', accessorFn: e => (e.kind === 'out' ? e.amount : 0), header: 'Out', meta: { label: 'Out', align: 'right', mono: true, width: 'w-32' },
    cell: ({ row }) => {
      const e = row.original;
      if (e.kind !== 'out') return null;
      if (e.type === 'expense') return <ExpenseAmount id={e.id} target={bookTarget(e)} amount={e.amount} align="end" />;
      return <PurchaseAmount id={e.id} target={bookTarget(e)} amount={e.amount} align="end" />;
    } },
  { id: 'balance', accessorKey: 'balance', header: 'Balance', meta: { label: 'Balance', align: 'right', mono: true, width: 'w-36' }, enableSorting: false,
    cell: ({ row }) => tk(row.original.balance) },
];

// Filter chips: 'all', 'in', 'out', or 'm:' + a method. Search matches the label, the method, or the amount digits.
function isBookFilter(f) {
  return f === 'all' || f === 'in' || f === 'out' || (typeof f === 'string' && f.indexOf('m:') === 0);
}
function inFilter(e, filter) {
  if (filter === 'in') return e.kind === 'in';
  if (filter === 'out') return e.kind === 'out';
  if (filter.indexOf('m:') === 0) return e.method === filter.slice(2);
  return true;
}
function Profit() {
  const [by, setBy] = useState('category');
  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Group profit" className="flex flex-wrap gap-2">
        <Chip pressed={by === 'category'} onClick={() => setBy('category')}>By category</Chip>
        <Chip pressed={by === 'month'} onClick={() => setBy('month')}>By month</Chip>
      </div>
      {by === 'month' ? <ProfitByMonth /> : <ProfitByCategory />}
    </div>
  );
}

// One book row: the label opens the entry sheet (Details does too); its fields are edited in place. Clicks and keys on a cell stay in the cell.
function BookEntry({ e, onOpen }) {
  const target = bookTarget(e);
  const cells = e.type === 'payment'
    ? <PaymentCells id={e.id} target={target} amount={e.amount} date={e.date} method={e.method} note={e.note} locked={e.locked} signed />
    : e.type === 'expense'
      ? <ExpenseCells id={e.id} target={target} amount={e.amount} date={e.date} category={e.category} note={e.note} />
      : <PurchaseCells id={e.id} target={target} amount={e.amount} date={e.date} accountId={e.accountId} notes={e.notes} />;
  return (
    <div data-testid={'entry-' + e.id} onClick={onOpen} className="grid cursor-pointer gap-2 px-4 py-3 transition-colors hover:bg-foreground/[0.02]">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-full', e.kind === 'in' ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>{e.kind === 'in' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span>
        <div className="min-w-0 flex-1 truncate text-sm font-bold">{e.label}</div>
        <Button type="button" size="sm" variant="ghost" onClick={ev => { ev.stopPropagation(); onOpen(); }}>Details</Button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 pl-12 sm:grid-cols-4">{cells}</div>
    </div>
  );
}

function Book() {
  const { lookups, epoch } = useApp();
  const open = useOpeners();
  const wide = useMedia('(min-width: 768px)');
  const [month, setMonth] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [tableSort, setTableSort] = useState([]);   // the table's own column sorting (saved views keep it)
  const [colVis, setColVis] = useState({});         // the table's column visibility (saved views keep it)
  const { loading, error, data: b } = useCall('book', { month }, [month, lookups, epoch]);

  // Saved views (uplift 3.5, md and up): the filter, search, table sorting and columns. The month is not part of a view.
  const viewState = () => ({ filter, q, tableSort, columns: colVis });
  function applyView(s) {
    const v = s || {};
    setFilter(isBookFilter(v.filter) ? v.filter : 'all');
    setQ(typeof v.q === 'string' ? v.q : '');
    setTableSort(cleanSorting(v.tableSort, BOOK_COLUMN_IDS));
    setColVis(cleanVisibility(v.columns, BOOK_COLUMN_IDS));
  }
  const entries = b ? b.entries : BOOK_NONE;

  const groups = useMemo(() => {
    if (!b) return [];
    const map = new Map();
    b.entries.slice().reverse().forEach(e => { if (!map.has(e.date)) map.set(e.date, []); map.get(e.date).push(e); });
    return Array.from(map.entries());
  }, [b]);

  // Chips: All, In, Out, then one per method present this month (with its count). Rows are newest first, as the cards are.
  const chips = useMemo(() => {
    const inCount = entries.filter(e => e.kind === 'in').length;
    const methods = new Map();
    entries.forEach(e => { if (e.method) methods.set(e.method, (methods.get(e.method) || 0) + 1); });
    const byName = Array.from(methods.entries()).sort((x, y) => x[0].localeCompare(y[0]));
    return [['all', 'All', entries.length], ['in', 'In', inCount], ['out', 'Out', entries.length - inCount]]
      .concat(byName.map(([m, n]) => ['m:' + m, m, n]));
  }, [entries]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/,/g, '');
    return entries.slice().reverse().filter(e => {
      if (!inFilter(e, filter)) return false;
      if (!s) return true;
      return String(e.label || '').toLowerCase().indexOf(s) >= 0 || String(e.method || '').toLowerCase().indexOf(s) >= 0
        || (digits !== '' && String(e.amount).indexOf(digits) >= 0);
    });
  }, [entries, filter, q]);

  if (loading && !b) return <div className="grid gap-4"><Skeleton className="h-52 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (error) return <ErrorBox>{error}</ErrorBox>;

  const monthRow = (
    <div className="flex items-end gap-3">
      <div className="grid min-w-0 flex-1 gap-1.5">
        <label htmlFor="bookMonth" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Month</label>
        <NativeSelect id="bookMonth" className="h-11" value={b.month} onChange={e => setMonth(e.target.value)}>
          {b.months.map(m => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <ExportButton tab="book" month={b.month} />
    </div>
  );
  const figure = (
    <Figure label="Net this month" value={b.net} tone={b.net >= 0 ? 'ok' : 'bad'} sub={'Closing balance ' + tk(b.closing)}
      lines={[['Money in', tk(b.in), 'ok'], ['Money out', tk(b.out), 'bad']]} />
  );
  const actions = (
    <div className="grid grid-cols-2 gap-2">
      <Button id="addExpense" type="button" variant="outline" className="font-bold" onClick={() => open.expense()}><Plus />Expense</Button>
      <Button id="addPurchase" type="button" variant="outline" className="font-bold" onClick={() => open.purchase()}><Plus />Account purchase</Button>
    </div>
  );
  const hint = <Hint>{'Opening balance includes ' + tk(b.legacyOpening) + ' collected before the app.'}</Hint>;

  if (!wide) {
    return (
      <div className="grid gap-4">
        <div className="grid gap-4">
          {monthRow}
          {figure}
          {actions}
          {hint}
        </div>
        <Section title="Entries" count={b.entries.length}>
          {groups.length ? groups.map(([date, list]) => (
            <div key={date}>
              <div className="eyebrow border-b border-border bg-foreground/[0.03] px-4 py-2">{shortDate(date)}</div>
              <div data-cell-group="" className="divide-y divide-border">
                {list.map(e => <BookEntry key={e.type + ':' + e.id} e={e} onOpen={() => open.entry(e.type, e.id)} />)}
              </div>
            </div>
          )) : <Empty>No entries this month yet.</Empty>}
        </Section>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="grid min-w-0 gap-4">{monthRow}{figure}</div>
        <div className="grid min-w-0 gap-4">{actions}{hint}</div>
      </div>
      <div data-testid="book-list" className="grid min-w-0 gap-2">
        <div className="flex items-center gap-2 px-1">
          <h2 className="flex-1 text-sm font-extrabold tracking-tight">Entries</h2>
          <span data-testid="book-count" className="font-mono text-xs text-muted-foreground">{rows.length}</span>
        </div>
        <SavedViews screenKey="book" getState={viewState} applyState={applyView} />
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Filter entries">
          {chips.map(([k, label, n]) => <Chip key={k} pressed={filter === k} onClick={() => setFilter(k)} className="shrink-0">{label + ' · ' + n}</Chip>)}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input id="bookSearch" type="search" placeholder="Search entries" aria-label="Search entries" autoComplete="off" className="h-11 pl-9"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <Grid label="Book entries" columns={BOOK_COLUMNS} data={rows} getRowId={e => e.type + ':' + e.id}
          getRowProps={e => ({ 'data-testid': 'entry-' + e.id })} onRowClick={e => open.entry(e.type, e.id)}
          sorting={tableSort} onSortingChange={setTableSort} columnVisibility={colVis} onColumnVisibilityChange={setColVis}
          empty={<div className="rounded-xl border border-border bg-card">{entries.length ? <Empty>No entries match.</Empty> : <Empty>No entries this month yet.</Empty>}</div>} />
      </div>
    </div>
  );
}

export function Money() {
  const [view, setView] = useState('overview');
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <Tabs value={view} onValueChange={setView}>
        <TabsList className="h-11 w-full md:w-[30rem]">
          <TabsTrigger value="overview" className="font-bold">Overview</TabsTrigger>
          <TabsTrigger value="profit" className="font-bold">Profit</TabsTrigger>
          <TabsTrigger value="book" className="font-bold">Book</TabsTrigger>
          <TabsTrigger value="cash" className="font-bold">Cash</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === 'overview' ? <Overview /> : view === 'profit' ? <Profit /> : view === 'cash' ? <Cash /> : <Book />}
    </div>
  );
}
