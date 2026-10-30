import { plain, shortDate, tk } from '@/lib/format';
import { cn } from '@/lib/utils';
import { StackBar } from '@/components/charts';
import { Avatar, Empty, Pill, Row, Section } from '@/components/kit';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthTitle } from '@/screens/insights/range';

/** Ranked customers by billed revenue in the range. Tapping a row opens the customer. */
export function TopCustomers({ rows, onOpen, className }) {
  return (
    <Section title="Top customers" count={rows.length} className={className} testId="insights-top">
      {rows.length ? rows.map((c, i) => (
        <Row key={c.customerId} testId={'insights-top-' + c.customerId} onClick={() => onOpen(c.customerId)}
          lead={<><span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">{i + 1}</span><Avatar name={c.name} /></>}
          title={c.name}
          detail={<span className="money">{tk(c.revenue) + ' billed · profit ' + tk(c.profit)}</span>}
          trail={c.owes > 0 ? <Pill tone="bad">{'owes ' + tk(c.owes)}</Pill> : null} />
      )) : <Empty>No sales in this range.</Empty>}
    </Section>
  );
}

const LIMIT = 8;

/** Money expected from lines that renew in the next 30 days. */
export function Forecast({ forecast, onOpen, className }) {
  const lines = forecast.next30Lines;
  return (
    <Section title="Expected next 30 days" count={lines.length + (lines.length === 1 ? ' line' : ' lines')} className={className} testId="insights-forecast">
      <div className="p-4">
        <div data-testid="insights-forecast-total" className="hero-figure text-4xl">
          <span className="mr-0.5 align-top text-[0.42em] text-muted-foreground">৳</span>{plain(forecast.next30Expected)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">One more month of each active line that ends in the next 30 days, at its current price.</p>
      </div>
      {lines.slice(0, LIMIT).map(l => (
        <Row key={l.saleId} onClick={() => onOpen(l.customerId)} lead={<Avatar name={l.name} />} title={l.name}
          detail={l.productName + ' · renews ' + shortDate(l.date)}
          trail={<span className="money text-sm font-bold">{tk(l.amount)}</span>} />
      ))}
      {lines.length > LIMIT ? <div className="px-4 py-3 text-xs text-muted-foreground">{'and ' + (lines.length - LIMIT) + ' more, ' + tk(lines.slice(LIMIT).reduce((a, l) => a + l.amount, 0))}</div> : null}
      {!lines.length ? <Empty>Nothing renews in the next 30 days.</Empty> : null}
    </Section>
  );
}

const STEPS = ['1 month', '2 months', '3 months', '6 months'];
// Heat steps by share kept; the percentage is always written in the cell, so shade is a reinforcement only.
const heat = p => (p >= 75 ? 'bg-primary/40' : p >= 50 ? 'bg-primary/30' : p >= 25 ? 'bg-primary/20' : 'bg-primary/10');

/** Share of each first-sale month's customers still paid up after 1, 2, 3 and 6 months. */
export function Retention({ rows, className }) {
  return (
    <Section title="Retention" count={rows.length + (rows.length === 1 ? ' cohort' : ' cohorts')} className={className} testId="insights-retention">
      {rows.length ? (
        <div className="p-2">
          <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">Share of each month's new customers still paid up after 1, 2, 3 and 6 months.</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">First sale</TableHead>
                <TableHead className="text-right text-xs">Customers</TableHead>
                {STEPS.map(s => <TableHead key={s} className="text-right text-xs">{s}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.cohort}>
                  <TableCell className="font-bold">{monthTitle(r.cohort)}</TableCell>
                  <TableCell className="money text-right">{r.size}</TableCell>
                  {r.kept.map((p, i) => (
                    <TableCell key={i} className={cn('money text-right font-semibold', p === null ? 'text-muted-foreground' : heat(p))}>
                      {p === null ? <><span aria-hidden="true">–</span><span className="sr-only">too early to tell</span></> : plain(p) + '%'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : <Empty>No new customers in this range.</Empty>}
    </Section>
  );
}

const TONES = ['lime', 'ok', 'warn', 'bad', 'muted'];
const DOT = { lime: 'bg-lime', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', muted: 'bg-muted-foreground' };

/** Money received by method: one stacked bar plus a text list with the share. */
export function MethodMix({ rows, className }) {
  const list = rows.filter(r => r.amount > 0);
  return (
    <Section title="Payment methods" count={list.length} className={className} testId="insights-methods">
      {list.length ? (
        <div className="grid gap-4 p-4">
          <StackBar label="Money received by method" parts={list.map((r, i) => ({ label: r.method, value: r.amount, tone: TONES[i % TONES.length] }))} />
          <ul className="grid gap-2">
            {list.map((r, i) => (
              <li key={r.method} className="flex items-center gap-2.5 text-sm">
                <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm', DOT[TONES[i % TONES.length]])} />
                <span className="min-w-0 flex-1 truncate font-bold">{r.method}</span>
                <span className="money shrink-0 text-xs text-muted-foreground">{tk(r.amount)}</span>
                <span className="money w-14 shrink-0 text-right text-xs font-semibold">{plain(r.share)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty>No payments in this range.</Empty>}
    </Section>
  );
}
