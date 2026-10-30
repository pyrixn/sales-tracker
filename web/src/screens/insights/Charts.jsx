import { Area, AreaChart, CartesianGrid, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { useReducedMotion } from 'motion/react';
import { plain, tk } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DataTable } from '@/components/charts';
import { Empty, Section } from '@/components/kit';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { compact, monthShort, monthTitle } from '@/screens/insights/range';

const SERIES = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
  cost: { label: 'Cost', color: 'var(--chart-4)' }
};

/** Billed revenue (area) against cost (dashed line) by month. The numbers are also in a screen-reader table. */
export function RevenueChart({ months, className }) {
  const reduced = useReducedMotion();
  const years = months.length > 12;
  const rows = months.map(m => ({ month: m.month, label: monthShort(m.month, years), revenue: m.revenue, cost: m.cost }));
  const summary = 'Revenue and cost by month, ' + rows.length + ' months';
  return (
    <Section title="Revenue vs cost" count={rows.length + (rows.length === 1 ? ' month' : ' months')} className={className} testId="insights-revenue-chart">
      <div className="p-4">
        <div role="img" aria-label={summary}>
          <ChartContainer config={SERIES} className="aspect-auto h-60 w-full md:h-72">
            <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer={false}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
              <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compact} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" valueFormat={v => tk(v)} labelFormatter={(_, p) => (p && p[0] ? monthTitle(p[0].payload.month) : '')} />} />
              <Area dataKey="revenue" type="monotone" stroke="var(--color-revenue)" fill="var(--color-revenue)" fillOpacity={0.16} strokeWidth={2} isAnimationActive={!reduced} animationDuration={500} />
              <Area dataKey="cost" type="monotone" stroke="var(--color-cost)" fill="none" strokeWidth={2} strokeDasharray="5 4" isAnimationActive={!reduced} animationDuration={500} />
            </AreaChart>
          </ChartContainer>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-chart-1" />Revenue (solid line, shaded)</span>
          <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-chart-4" />Cost (dashed line)</span>
        </div>
        <DataTable caption={summary} head={['Month', 'Revenue', 'Cost']} rows={rows.map(r => [r.month, tk(r.revenue), tk(r.cost)])} />
      </div>
    </Section>
  );
}

// Top four categories get the four chart colours, everything after that shares the muted fifth, so a colour never stands for two names in the donut.
const SWATCH = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4'];
const FILLS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

/** Revenue share by category: donut plus a text list (name, revenue, share), so colour is never the only signal. */
export function CategoryChart({ rows, className }) {
  const reduced = useReducedMotion();
  const list = rows.filter(r => r.revenue > 0);
  const top = list.slice(0, 4), rest = list.slice(4);
  const restRevenue = rest.reduce((a, r) => a + r.revenue, 0);
  const slices = top.map((r, i) => ({ name: r.category, value: r.revenue, fill: FILLS[i] }))
    .concat(rest.length ? [{ name: 'Other (' + rest.length + ')', value: restRevenue, fill: 'var(--chart-5)' }] : []);
  const summary = 'Revenue by category: ' + list.map(r => r.category + ' ' + tk(r.revenue) + ', ' + r.share + '%').join('; ');
  return (
    <Section title="By category" count={list.length + (list.length === 1 ? ' category' : ' categories')} className={className} testId="insights-category">
      {list.length ? (
        <div className="grid gap-4 p-4">
          <div role="img" aria-label={summary}>
            <ChartContainer config={{}} className="mx-auto aspect-square h-44">
              <PieChart accessibilityLayer={false}>
                <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" valueFormat={v => tk(v)} />} />
                <Pie data={slices} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="92%" paddingAngle={2} stroke="none" isAnimationActive={!reduced} animationDuration={500} />
              </PieChart>
            </ChartContainer>
          </div>
          <ul className="grid gap-2" data-testid="insights-category-list">
            {list.map((r, i) => (
              <li key={r.category} className="flex items-center gap-2.5 text-sm">
                <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm', SWATCH[i] || 'bg-chart-5')} />
                <span className="min-w-0 flex-1 truncate font-bold">{r.category}</span>
                <span className="money shrink-0 text-xs text-muted-foreground">{tk(r.revenue)}</span>
                <span className="money w-14 shrink-0 text-right text-xs font-semibold">{plain(r.share)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty>No billed sales in this range.</Empty>}
    </Section>
  );
}
