import { createContext, useContext, useMemo, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { DayButton } from 'react-day-picker';
import util from '@/lib/util';
import { longDate, tk } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { useOpeners } from '@/sheets/openers';
import { fromDate, toDate } from '@/screens/insights/range';
import { Avatar, DaysPill, Empty, ErrorBox, Hint, Pill, Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Calendar as MonthGrid } from '@/components/ui/calendar';
import { Skeleton } from '@/components/ui/skeleton';

// The renewals calendar (uplift plan 4.4). Lines come from lookups.lines (Paid_Till per line, already on the client); owes come from the
// `dues` read, matched on saleId, because lines carry no balance. A line that has expired and still owes is the red dot. All dates are
// Dhaka 'YYYY-MM-DD' strings: the month and day arithmetic goes through Core.util, and the widget's Date objects are only converted at
// its edge (range.js), so the browser time zone never moves a line onto another day.

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const monthOf = iso => iso.slice(0, 7) + '-01';

// The per-day marks for the grid. RenewalDay reads them through context so the `components` object below stays one stable value.
const MarksCtx = createContext({ counts: {}, expired: {} });

// One day cell: the day number, a count badge when lines renew that day (the number is the signal, the tint is not), and a red dot
// when one of them has expired and still owes money. The dot's words go into the day's accessible name.
function RenewalDay({ day, modifiers, children, ...rest }) {
  const { counts, expired } = useContext(MarksCtx);
  const n = counts[day.isoDate] || 0;
  const bad = expired[day.isoDate] || 0;
  const label = (rest['aria-label'] || '') + (n ? ', ' + plural(n, 'renewal', 'renewals') : '') + (bad ? ', ' + plural(bad, 'line', 'lines') + ' expired and unpaid' : '');
  return (
    <DayButton day={day} modifiers={modifiers} {...rest} aria-label={label}
      className={cn(rest.className, 'relative flex flex-col items-center justify-center gap-0.5', modifiers.selected && 'bg-foreground/[0.1] font-extrabold')}>
      <span className="leading-none">{children}</span>
      {n ? <span data-testid={'cal-count-' + day.isoDate} aria-hidden="true" className="min-w-5 rounded-full bg-primary/15 px-1 text-center font-mono text-micro leading-4 font-bold text-primary">{n}</span> : null}
      {bad ? <span data-testid={'cal-expired-' + day.isoDate} aria-hidden="true" className="absolute top-1 right-1 size-2 rounded-full bg-bad" /> : null}
    </DayButton>
  );
}
const GRID_COMPONENTS = { DayButton: RenewalDay };

export function Calendar() {
  const { lookups: L, today } = useApp();
  const open = useOpeners();
  const due = useRead('dues');
  const [view, setView] = useState(() => monthOf(today));   // the month on screen, 'YYYY-MM-01'
  const [selected, setSelected] = useState(today);          // the day whose lines are listed, 'YYYY-MM-DD'

  const lines = useMemo(() => (L ? L.lines : []), [L]);
  const owed = useMemo(() => {
    const m = {};
    ((due.data && due.data.rows) || []).forEach(r => { m[r.saleId] = r.amount; });
    return m;
  }, [due.data]);

  const marks = useMemo(() => {
    const byDay = {}, counts = {}, expired = {};
    lines.forEach(l => {
      if (!l.paidTill) return;
      (byDay[l.paidTill] = byDay[l.paidTill] || []).push(l);
      counts[l.paidTill] = (counts[l.paidTill] || 0) + 1;
      if (l.daysLeft < 0 && owed[l.saleId] > 0) expired[l.paidTill] = (expired[l.paidTill] || 0) + 1;
    });
    return { byDay: byDay, counts: counts, expired: expired };
  }, [lines, owed]);
  const marksCtx = useMemo(() => ({ counts: marks.counts, expired: marks.expired }), [marks]);

  const inMonth = lines.filter(l => l.paidTill && l.paidTill.slice(0, 7) === view.slice(0, 7));
  const dayLines = (marks.byDay[selected] || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.saleId - b.saleId);

  // Moving the month keeps the list on the month shown: a day outside it gives way to the first day of the new month.
  function moveTo(monthIso) {
    setView(monthIso);
    if (selected.slice(0, 7) !== monthIso.slice(0, 7)) setSelected(monthIso);
  }
  function pick(d) { if (d) setSelected(fromDate(d)); }

  if (!L) {
    return <div className="grid gap-3" aria-busy="true" aria-label="Loading calendar"><Skeleton className="h-96 w-full rounded-xl" /></div>;
  }

  return (
    <div className="mx-auto grid min-w-0 max-w-3xl gap-4" data-testid="calendar">
      {due.error ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="calendar-error">
          <ErrorBox>{due.error}</ErrorBox>
          <Button type="button" variant="outline" size="sm" className="font-bold" onClick={() => due.refetch()}><RefreshCw />Retry</Button>
        </div>
      ) : null}

      <section className="grid justify-items-center gap-2 rounded-xl border border-border bg-card/80 p-3 backdrop-blur-sm">
        <div className="flex w-full justify-end">
          <Button type="button" variant="outline" size="sm" className="font-bold" aria-label="Jump to today"
            onClick={() => { setView(monthOf(today)); setSelected(today); }}>Today</Button>
        </div>
        <MarksCtx.Provider value={marksCtx}>
          <MonthGrid mode="single" required touch showOutsideDays={false} className="p-0"
            month={toDate(view)} onMonthChange={d => moveTo(monthOf(fromDate(d)))}
            selected={toDate(selected)} onSelect={pick}
            components={GRID_COMPONENTS} />
        </MarksCtx.Provider>
        <Hint id="calendar-legend" className="text-center">
          Numbers count the lines whose paid-till date falls on that day. A red dot marks a line that has expired and still owes money.
        </Hint>
      </section>

      {inMonth.length ? (
        <Section title={longDate(selected)} count={dayLines.length} testId="calendar-day">
          {dayLines.length ? dayLines.map(l => {
            const owes = owed[l.saleId] || 0;
            return (
              <Row key={l.saleId} stack testId={'cal-line-' + l.subCode} className="relative"
                lead={<Avatar name={l.name} />}
                title={(
                  <button type="button" onClick={() => open.customer(l.customerId)}
                    className="max-w-full rounded-sm text-left after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {l.name}
                  </button>
                )}
                detail={<span>{l.productName} · <span className="font-mono">{l.subCode}</span></span>}
                trail={(
                  <div className="relative z-10 flex flex-wrap items-center gap-2">
                    <DaysPill days={l.daysLeft} />
                    {owes > 0 ? <Pill tone="bad">{'owes ' + tk(owes)}</Pill> : null}
                    <Button type="button" variant="outline" className="min-h-11 font-bold" data-testid={'cal-renew-' + l.subCode}
                      aria-label={'Renew ' + l.name} onClick={() => open.renew(l.subCode)}>
                      <RotateCw />Renew
                    </Button>
                  </div>
                )} />
            );
          }) : <Empty>Nothing renews on this day.</Empty>}
        </Section>
      ) : (
        <div className="rounded-xl border border-border bg-card/70"><Empty art="calendar">No renewals this month</Empty></div>
      )}
    </div>
  );
}
