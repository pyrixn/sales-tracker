import { AlertTriangle, BarChart3, CalendarClock, CheckCircle2, CircleDollarSign, Gauge, Hourglass, Package, PieChart, Plus, ShieldAlert, Target, TrendingDown, TrendingUp, Users, Wallet, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { shortDate, tk } from '@/lib/format';
import { useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Figure } from '@/components/Figure';
import { ProfitFigure } from '@/components/ProfitFigure';
import { Spotlight } from '@/components/fx/Spotlight';
import { Empty, Pill, Row, Section } from '@/components/kit';
import { BarSeries, Meter, Ring, Sparkline, StackBar } from '@/components/charts';
import { Button } from '@/components/ui/button';

const signed = n => (n < 0 ? '−' : '+') + tk(Math.abs(n));

function Net({ o, action }) {
  const delta = Number(o.delta) || 0;
  return (
    <Spotlight className="rounded-xl">
      <Section action={action} title="Net this month">
        <div className="grid gap-3 p-4">
          <Figure value={o.net} className={cn('text-[clamp(3rem,14vw,4.5rem)]', o.net < 0 ? 'text-bad' : 'text-foreground')} />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={delta >= 0 ? 'ok' : 'bad'}>{signed(delta) + ' vs last month'}</Pill>
            <span className="text-xs text-muted-foreground">{'Last month ' + tk(o.prevNet)}</span>
          </div>
          <Sparkline label="Net, last six months" values={o.series.map(s => s.net)} />
          <dl className="grid grid-cols-2 gap-4 border-t border-border pt-3">
            <div><dt className="text-xs text-muted-foreground">Money in</dt><dd className="money mt-1 text-lg font-semibold text-ok">{tk(o.in)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Money out</dt><dd className="money mt-1 text-lg font-semibold text-bad">{tk(o.out)}</dd></div>
          </dl>
        </div>
      </Section>
    </Spotlight>
  );
}

function Trend({ o, action }) {
  return (
    <Section action={action} title="Six-month trend">
      <div className="p-4">
        <BarSeries label="Money in and out by month" series={o.series}
          keys={[{ key: 'in', label: 'In', tone: 'ok' }, { key: 'out', label: 'Out', tone: 'bad' }]} />
      </div>
    </Section>
  );
}

function Cash({ o, action }) {
  return (
    <Section action={action} title="Cash by method" count="All time">
      {o.cash.length ? o.cash.map(c => (
        <Row key={c.method} title={c.method} detail={'In ' + tk(c.in) + ' · Out ' + tk(c.out)}
          trail={<span className={cn('money text-sm font-bold', c.balance < 0 ? 'text-bad' : '')}>{tk(c.balance)}</span>} />
      )) : <Empty>No cash movements yet.</Empty>}
    </Section>
  );
}

const AGE_TONES = ['ok', 'lime', 'warn', 'bad'];
function Dues({ o, action }) {
  const b = o.dues.buckets;
  return (
    <Section action={action} title="Dues by age" count={tk(o.dues.total)}>
      <div className="grid gap-3 p-4">
        {o.dues.total > 0 ? (
          <>
            <StackBar label="Dues by days late" parts={b.map((x, i) => ({ label: x.label + ' days', value: x.amount, tone: AGE_TONES[i] || 'muted' }))} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {b.map(x => (
                <div key={x.label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-xs text-muted-foreground">{x.label + ' days'}</dt>
                  <dd className="money text-sm font-semibold">{tk(x.amount)}<span className="ml-1 text-xs font-normal text-muted-foreground">{'· ' + x.count}</span></dd>
                </div>
              ))}
            </dl>
          </>
        ) : <p className="text-sm text-muted-foreground">Nobody owes anything.</p>}
      </div>
    </Section>
  );
}

function Products({ o, action }) {
  return (
    <Section action={action} title="Profit by product" count={o.products.length}>
      {o.products.length ? o.products.slice(0, 6).map(p => (
        <Row key={p.productId} title={p.name} detail={'Revenue ' + tk(p.revenue) + ' · Cost ' + tk(p.cost)}
          trail={<div className="flex flex-col items-end gap-1">
            <span className={cn('money text-sm font-bold', p.profit >= 0 ? 'text-ok' : 'text-bad')}>{signed(p.profit)}</span>
            <div className="flex flex-wrap items-center justify-end gap-x-1">
              <Pill tone={p.profit >= 0 ? 'ok' : 'bad'}>{p.marginPct + '%'}</Pill>
              <ProfitFigure size="row" profit={p.profit} collected={p.collectedProfit} uncollected={p.uncollected} />
            </div>
          </div>} />
      )) : <Empty>No sales this month.</Empty>}
    </Section>
  );
}

function Accounts({ o, action }) {
  return (
    <Section action={action} title="Profit by account" count={o.accounts.length}>
      {o.accounts.length ? o.accounts.slice(0, 6).map(a => (
        <Row key={a.accountId} title={a.label} detail={'Revenue ' + tk(a.revenue) + ' · Cost ' + tk(a.cost) + (a.retired ? ' · retired' : '')}
          trail={<span className={cn('money text-sm font-bold', a.profit >= 0 ? 'text-ok' : 'text-bad')}>{signed(a.profit)}</span>} />
      )) : <Empty>No account sales this month.</Empty>}
    </Section>
  );
}

function Customers({ o, action }) {
  return (
    <Section action={action} title="Top customers" count={o.customers.length}>
      {o.customers.length ? o.customers.map(c => (
        <Row key={c.customerId} title={c.name} detail={c.lines + (c.lines === 1 ? ' active line' : ' active lines') + ' · last 12 months'}
          trail={<span className="money text-sm font-bold">{tk(c.paid)}</span>} />
      )) : <Empty>No payments in the last 12 months.</Empty>}
    </Section>
  );
}

function Forecast({ o, action }) {
  const total = o.forecast.reduce((a, f) => a + f.amount, 0);
  return (
    <Section action={action} title="Renewals, next 14 days" count={tk(total)}>
      {o.forecast.length ? o.forecast.map(f => (
        <Row key={f.date} title={shortDate(f.date)} detail={f.count + (f.count === 1 ? ' line' : ' lines')}
          trail={<span className="money text-sm font-bold">{tk(f.amount)}</span>} />
      )) : <Empty>No renewals due in the next 14 days.</Empty>}
    </Section>
  );
}

const EXP_TONES = ['lime', 'warn', 'bad', 'ok', 'muted'];
function Expenses({ o, action }) {
  const total = o.expensesByType.reduce((a, e) => a + e.amount, 0);
  return (
    <Section action={action} title="Expenses by type" count={tk(total)}>
      <div className="grid gap-3 p-4">
        {o.expensesByType.length ? (
          <>
            <StackBar label="Expenses by type" parts={o.expensesByType.map((e, i) => ({ label: e.category, value: e.amount, tone: EXP_TONES[Math.min(i, EXP_TONES.length - 1)] }))} />
            <dl className="grid gap-2">
              {o.expensesByType.map(e => (
                <div key={e.category} className="flex items-baseline justify-between gap-2">
                  <dt className="truncate text-sm">{e.category}</dt>
                  <dd className="money text-sm font-semibold">{tk(e.amount)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : <p className="text-sm text-muted-foreground">No expenses this month.</p>}
      </div>
    </Section>
  );
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function Goals({ o, action }) {
  const { today } = useApp();
  const open = useOpeners();
  const list = o.goals || [];
  return (
    <Section action={action} title="Goals" count={list.length}>
      {list.length ? list.map(({ goal: g, progress: p }) => {
        const live = (g.Status || 'Active') === 'Active';
        const reached = p.pct >= 100;
        const left = g.Metric === 'new_customers' ? plural(p.remaining, 'customer', 'customers') + ' to go' : tk(p.remaining) + ' to go';
        const days = p.daysLeft > 0 ? plural(p.daysLeft, 'day', 'days') + ' left' : (g.End >= today ? 'Last day' : 'Ended');
        const StatusIcon = reached ? CheckCircle2 : p.onTrack ? TrendingUp : TrendingDown;
        const statusText = reached ? 'Target reached' : p.onTrack ? 'On track' : 'Behind pace';
        const tone = reached ? 'ok' : p.onTrack ? 'lime' : 'warn';
        return (
          <div key={g.Goal_ID} data-testid={'goal-' + g.Goal_ID} className="flex items-center gap-3 px-4 py-3.5">
            <Ring pct={p.pct} tone={tone} label={'Progress of ' + g.Title} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{g.Title}</div>
              <div className="text-xs text-muted-foreground">{left + ' · ' + days}</div>
              {live ? (
                <div className={cn('mt-1 flex items-center gap-1 text-xs font-semibold', reached ? 'text-ok' : p.onTrack ? 'text-foreground' : 'text-warn')}>
                  <StatusIcon className="size-3.5" aria-hidden="true" />{statusText}
                </div>
              ) : <div className="mt-1"><Pill>{g.Status}</Pill></div>}
            </div>
            <Button type="button" size="sm" variant="ghost" aria-label={'Edit goal ' + g.Title} data-goal-edit={g.Goal_ID} onClick={() => open.goal(g)}>Edit</Button>
          </div>
        );
      }) : <Empty>No goals yet. Set a target to track.</Empty>}
      <div className="px-4 py-3">
        <Button type="button" size="sm" variant="outline" id="addGoal" onClick={() => open.goal()}><Plus />Add goal</Button>
      </div>
    </Section>
  );
}

function Budgets({ o, action }) {
  const open = useOpeners();
  const list = o.budgets || [];
  return (
    <Section action={action} title="Budgets" count={list.length}>
      {list.length ? list.map(({ budget: b, progress: p }) => {
        const paused = (b.Active || 'Yes') === 'No';
        const atLimit = p.state === 'warn' && p.pct >= 100;
        const tone = p.state === 'over' ? 'bad' : p.state === 'warn' ? 'warn' : 'ok';
        const StateIcon = p.state === 'over' ? ShieldAlert : p.state === 'warn' ? AlertTriangle : CheckCircle2;
        const stateText = p.state === 'over' ? 'Over by ' + tk(p.spent - p.limit) : atLimit ? 'At the limit' : p.state === 'warn' ? 'Near the limit' : 'Within budget';
        return (
          <div key={b.Budget_ID} data-testid={'budget-' + b.Budget_ID} className="grid gap-2 px-4 py-3.5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">{b.Category}</div>
                <div className="text-xs text-muted-foreground">{tk(p.spent) + ' of ' + tk(p.limit) + ' · ' + Math.floor(p.pct) + '%'}</div>
              </div>
              <Button type="button" size="sm" variant="ghost" aria-label={'Edit budget ' + b.Category} data-budget-edit={b.Budget_ID} onClick={() => open.budget(b)}>Edit</Button>
            </div>
            <Meter pct={p.pct} tone={paused ? 'muted' : tone} label={b.Category + ' budget'} />
            {paused ? <div className="text-xs font-semibold text-muted-foreground">Paused</div> : (
              <div className={cn('flex items-center gap-1 text-xs font-semibold', p.state === 'over' ? 'text-bad' : p.state === 'warn' ? 'text-warn' : 'text-ok')}>
                <StateIcon className="size-3.5" aria-hidden="true" />{stateText}
              </div>
            )}
          </div>
        );
      }) : <Empty>No budgets yet. Set a monthly limit for a category.</Empty>}
      <div className="px-4 py-3">
        <Button type="button" size="sm" variant="outline" id="addBudget" onClick={() => open.budget()}><Plus />Add budget</Button>
      </div>
    </Section>
  );
}

export const WIDGET_VIEWS = {
  net: Net, trend: Trend, cash: Cash, dues: Dues, products: Products, accounts: Accounts,
  customers: Customers, forecast: Forecast, expenses: Expenses, goals: Goals, budgets: Budgets
};

/** What each card shows, for the Add widget menu. */
export const WIDGET_META = {
  net: { icon: CircleDollarSign, description: 'Money in minus money out this month, against last month.' },
  trend: { icon: BarChart3, description: 'Money in and out for each of the last six months.' },
  cash: { icon: Wallet, description: 'What came in, went out and is left in each payment method.' },
  dues: { icon: Hourglass, description: 'Unpaid amounts grouped by how many days late they are.' },
  products: { icon: Package, description: 'Revenue, cost and profit for each product this month.' },
  accounts: { icon: Server, description: 'Revenue, cost and profit for each shared account this month.' },
  customers: { icon: Users, description: 'Who paid the most over the last 12 months.' },
  forecast: { icon: CalendarClock, description: 'Money due from renewals in the next 14 days.' },
  expenses: { icon: PieChart, description: "Where the month's money went, by category." },
  goals: { icon: Target, description: 'Targets with progress, time left and whether you are on pace.' },
  budgets: { icon: Gauge, description: 'Monthly spending limits with a warning before you pass them.' }
};
