import { plain } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Sparkline } from '@/components/charts';
import { Pill } from '@/components/kit';

// Pills wrap inside narrow cards instead of spilling out.
const WRAP = 'max-w-full whitespace-normal leading-tight';

// One KPI card: eyebrow, the figure (money in taka, or a percent), a pill, and a sparkline with a visible caption saying what it plots.
function Kpi({ id, label, value, percent, pill, spark, sparkLabel }) {
  const neg = !percent && Number(value) < 0;
  return (
    <section data-testid={'insights-kpi-' + id} className="min-w-0 rounded-xl border border-border bg-card/70 p-4 backdrop-blur-sm">
      <div className="eyebrow">{label}</div>
      <div data-testid={'insights-kpi-' + id + '-value'} className={cn('hero-figure mt-2 truncate text-3xl', neg ? 'text-bad' : 'text-foreground')}>
        {percent ? null : <span className="mr-0.5 align-top text-[0.42em] text-muted-foreground">{neg ? '−৳' : '৳'}</span>}
        {plain(value)}
        {percent ? <span className="ml-0.5 text-[0.5em] text-muted-foreground">%</span> : null}
      </div>
      <div className="mt-2 min-h-6">{pill}</div>
      <div className="mt-2">
        <Sparkline values={spark} label={sparkLabel} />
        <div className="text-micro text-muted-foreground">{sparkLabel}</div>
      </div>
    </section>
  );
}

export function Kpis({ kpis, months }) {
  const by = k => months.map(m => m[k]);
  const margin = kpis.marginPct;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[repeat(3,minmax(0,1fr))] xl:grid-cols-[repeat(5,minmax(0,1fr))]">
      <Kpi id="revenue" label="Revenue" value={kpis.revenue} spark={by('revenue')} sparkLabel="Revenue by month"
        pill={<Pill className={WRAP}>{'Collected ৳' + plain(kpis.collected)}</Pill>} />
      <Kpi id="profit" label="Profit" value={kpis.profit} spark={by('profit')} sparkLabel="Profit by month"
        pill={<Pill className={WRAP} tone={margin >= 0 ? 'ok' : 'bad'}>{margin + '% margin'}</Pill>} />
      <Kpi id="arpu" label="ARPU" value={kpis.arpu} spark={by('newCustomers')} sparkLabel="New customers by month"
        pill={<Pill className={WRAP}>{kpis.activeCustomers + ' active customers'}</Pill>} />
      <Kpi id="renewal" label="Renewal rate" percent value={kpis.renewalRatePct} spark={by('renewals')} sparkLabel="Renewals by month"
        pill={<Pill className={WRAP} tone={kpis.churnedLines > 0 ? 'warn' : 'ok'}>{kpis.churnedLines + (kpis.churnedLines === 1 ? ' line lapsed' : ' lines lapsed')}</Pill>} />
      <Kpi id="collection" label="Collection rate" percent value={kpis.collectionRatePct} spark={by('collected')} sparkLabel="Collected by month"
        pill={<Pill className={WRAP} tone={kpis.avgDaysLate > 0 ? 'warn' : 'ok'}>{kpis.avgDaysLate > 0 ? 'Late ' + kpis.avgDaysLate + ' days on average' : 'No late payments'}</Pill>} />
    </div>
  );
}
