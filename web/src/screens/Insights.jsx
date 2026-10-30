import { useEffect, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { cn } from '@/lib/utils';
import { useOpeners } from '@/sheets/openers';
import { Empty, ErrorBox } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RangeBar } from '@/screens/insights/RangeBar';
import { Kpis } from '@/screens/insights/Kpis';
import { CategoryChart, RevenueChart } from '@/screens/insights/Charts';
import { Forecast, MethodMix, Retention, TopCustomers } from '@/screens/insights/Lists';
import { presets, readRange, writeRange } from '@/screens/insights/range';

function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading insights" data-testid="insights-loading">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[repeat(3,minmax(0,1fr))] xl:grid-cols-[repeat(5,minmax(0,1fr))]">
        {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[repeat(12,minmax(0,1fr))]">
        <Skeleton className="h-80 w-full rounded-xl xl:col-span-8" />
        <Skeleton className="h-80 w-full rounded-xl xl:col-span-4" />
        <Skeleton className="h-96 w-full rounded-xl xl:col-span-5" />
        <Skeleton className="h-96 w-full rounded-xl xl:col-span-7" />
      </div>
    </div>
  );
}

export function Insights() {
  const { today } = useApp();
  const open = useOpeners();
  // The range lives in the URL hash (#/insights?from=...&to=...); no query means the default, last 12 months.
  const [chosen, setChosen] = useState(readRange);
  useEffect(() => {
    const on = () => setChosen(readRange());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const def = presets(today).find(p => p.id === 'last12');
  const range = chosen || { from: def.from, to: def.to };
  const choose = r => { writeRange(r); setChosen(r); };

  const read = useRead('insights', { from: range.from, to: range.to });
  const d = read.data;
  const stale = !!d && (d.range.from !== range.from || d.range.to !== range.to);
  const bar = <RangeBar today={today} range={range} onChange={choose} />;

  if (!d && read.error) {
    return (
      <div className="grid gap-4">
        {bar}
        <div className="grid max-w-xl gap-3" data-testid="insights-error">
          <ErrorBox>{read.error}</ErrorBox>
          <Button type="button" variant="outline" className="w-fit font-bold" onClick={() => read.refetch()}><RefreshCw />Retry</Button>
        </div>
      </div>
    );
  }
  if (!d) return <div className="grid gap-4">{bar}<Loading /></div>;

  const k = d.kpis;
  if (!stale && k.revenue === 0 && k.collected === 0) {
    return <div className="grid gap-4">{bar}<div className="rounded-xl border border-border bg-card/70"><Empty art="chart">Not enough data yet</Empty></div></div>;
  }

  return (
    <div className={cn('grid gap-4 transition-opacity', stale && 'opacity-60')} aria-busy={stale} data-testid="insights">
      {bar}
      {read.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <ErrorBox>{read.error}</ErrorBox>
          <Button type="button" variant="outline" size="sm" className="font-bold" onClick={() => read.refetch()}><RefreshCw />Retry</Button>
        </div>
      ) : null}
      {k.rateMissing ? <ErrorBox testId="rate-missing">Rate missing: USDT costs count as 0, so profit is incomplete. Set a manual rate in Settings.</ErrorBox> : null}
      {k.undatedPayments > 0 ? (
        <p role="status" data-testid="undated-note" className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {k.undatedPayments + (k.undatedPayments === 1 ? ' payment has' : ' payments have') + ' no date and ' + (k.undatedPayments === 1 ? 'is' : 'are') + ' not in the monthly figures.'}
        </p>
      ) : null}
      <Kpis kpis={k} months={d.months} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(12,minmax(0,1fr))]">
        <RevenueChart months={d.months} className="xl:col-span-8" />
        <CategoryChart rows={d.byCategory} className="xl:col-span-4" />
        <TopCustomers rows={d.topCustomers} onOpen={id => open.customer(id)} className="xl:col-span-5" />
        <Forecast forecast={d.forecast} onOpen={id => open.customer(id)} className="xl:col-span-7" />
        <Retention rows={d.retention} className="xl:col-span-7" />
        <MethodMix rows={d.methodMix} className="xl:col-span-5" />
      </div>
    </div>
  );
}
