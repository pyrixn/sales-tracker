import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tk } from '@/lib/format';
import { useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { BarSeries } from '@/components/charts';
import { Empty, ErrorBox, Field, Pill, Section, WarnBox } from '@/components/kit';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';

// Profit by month: each sale's revenue and each account purchase's cost are spread over the days they cover (Core.accrual).
// The server does the sums; this screen picks the range and shows the answer.

const signed = n => (n >= 0 ? '+' : '−') + tk(Math.abs(n));

/** The last n months as YYYY-MM, oldest first, ending with the month of `today` (YYYY-MM-DD). */
export function lastMonths(today, n) {
  const y = Number(String(today).slice(0, 4)), m = Number(String(today).slice(5, 7));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = y * 12 + (m - 1) - i;
    out.push(Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0'));
  }
  return out;
}

function MonthRow({ m, open, onToggle }) {
  const accounts = m.byAccount || [], products = m.byProduct || [];
  const expandable = accounts.length > 0 || products.length > 0;
  return (
    <div data-testid={'pm-' + m.month} className="grid gap-2.5 px-4 py-3.5">
      <button type="button" aria-expanded={open} disabled={!expandable} onClick={onToggle} className="flex min-h-11 items-start gap-3 text-left">
        {expandable ? (open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />) : <span className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-sm font-bold">{m.month}</span>
          <span className="block text-xs text-muted-foreground">{'Revenue ' + tk(m.revenue) + ' · Cost ' + tk(m.cost) + ' · Collected ' + tk(m.collected)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn('money text-sm font-bold', m.profit >= 0 ? 'text-ok' : 'text-bad')}>{signed(m.profit)}</span>
          <Pill tone={m.profit >= 0 ? 'ok' : 'bad'}>{m.profit >= 0 ? 'Profit' : 'Loss'}</Pill>
        </span>
      </button>
      {open && accounts.length ? (
        <ul aria-label={'Accounts in ' + m.month} className="grid gap-2 border-l border-border pl-3">
          {accounts.map(a => (
            <li key={a.accountId} data-testid="pm-account" className="grid gap-0.5 text-xs">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-bold">{a.label || a.accountId}</span>
                <span className={cn('money shrink-0 font-bold', a.profit >= 0 ? 'text-ok' : 'text-bad')}>{signed(a.profit)}</span>
              </div>
              <div className="text-muted-foreground">{'Seats ' + a.seatsUsed + '/' + a.seats + ' · Revenue ' + tk(a.revenue) + ' · Cost ' + tk(a.cost)}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {open && products.length ? (
        <ul aria-label={'Products in ' + m.month} className="grid gap-1.5 border-l border-border pl-3">
          {products.map(p => (
            <li key={p.productId} className="flex items-baseline gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate font-bold">{p.name}</span>
              <span className="money text-muted-foreground">{tk(p.revenue)}</span>
              <span className={cn('money w-20 text-right font-bold', p.profit >= 0 ? 'text-ok' : 'text-bad')}>{signed(p.profit)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ProfitByMonth() {
  const { today, lookups } = useApp();
  const months = useMemo(() => lastMonths(today, 12), [today]);
  const [from, setFrom] = useState(months[months.length - 6]);
  const [to, setTo] = useState(months[months.length - 1]);
  const [openSet, setOpenSet] = useState(() => new Set());
  const { data, loading, error } = useRead('profitMonthly', { from, to });
  const toggle = k => setOpenSet(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const labelOf = id => { const a = ((lookups && lookups.accounts) || []).find(x => x.id === id); return a ? a.label + ' (' + id + ')' : id; };

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" id="pm-from">
          <NativeSelect id="pm-from" className="h-11" value={from} onChange={e => setFrom(e.target.value)}>
            {months.map(m => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field label="To" id="pm-to">
          <NativeSelect id="pm-to" className="h-11" value={to} onChange={e => setTo(e.target.value)}>
            {months.map(m => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      </div>
      <ErrorBox testId="pm-error">{error}</ErrorBox>
      {loading && !data ? <Skeleton className="h-64 w-full" /> : null}
      {data ? (
        <>
          {data.rateMissing ? <ErrorBox testId="rate-missing">Rate missing: USDT costs count as 0, so profit is incomplete. Set a manual rate in Settings.</ErrorBox> : null}
          {data.costMissing && data.costMissing.length ? (
            <WarnBox testId="cost-missing">{'No purchase recorded for ' + data.costMissing.map(labelOf).join(', ') + ': add a purchase so its cost counts. Until then the seat cost saved on each sale is used.'}</WarnBox>
          ) : null}
          <section className="rounded-xl border border-border bg-card/80 p-4 backdrop-blur-sm">
            <BarSeries series={data.months} label="Profit by month"
              keys={[{ key: 'revenue', label: 'Revenue', tone: 'ok' }, { key: 'cost', label: 'Cost', tone: 'bad' }, { key: 'profit', label: 'Profit', tone: 'lime' }]} />
          </section>
          <Section title="By month" count={data.months.length + (data.months.length === 1 ? ' month' : ' months')} testId="pm-table">
            {data.months.length ? data.months.map(m => <MonthRow key={m.month} m={m} open={openSet.has(m.month)} onToggle={() => toggle(m.month)} />)
              : <Empty>No months in this range.</Empty>}
          </Section>
        </>
      ) : null}
    </div>
  );
}
