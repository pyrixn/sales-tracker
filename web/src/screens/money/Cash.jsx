import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { call } from '@/lib/api';
import { cn } from '@/lib/utils';
import { shortDate, tk } from '@/lib/format';
import { useApp } from '@/lib/store';
import { Empty, ErrorBox, Hint, Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportButton } from './ExportButton';

/** Every payment method and wallet: in, out, balance and the last 5 movements. Figures are all time, not for a month. */
export function Cash() {
  const { lookups } = useApp();
  const [tries, setTries] = useState(0);
  const [st, setSt] = useState({ loading: true, error: '', data: null });
  useEffect(() => {
    let live = true;
    setSt(s => ({ ...s, loading: true, error: '' }));
    call('moneyOverview', {}).then(r => { if (live) setSt(r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error, data: null }); });
    return () => { live = false; };
  }, [lookups, tries]);

  if (st.loading && !st.data) return <div className="grid gap-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (st.error) {
    return (
      <div className="grid gap-3">
        <ErrorBox>{st.error}</ErrorBox>
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => setTries(n => n + 1)}>Retry</Button>
      </div>
    );
  }
  const cash = st.data.cash || [];
  const total = cash.reduce((a, c) => a + Number(c.balance || 0), 0);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">Total across all methods, all time</div>
          <div className={cn('money text-2xl font-bold', total < 0 ? 'text-bad' : '')}>{tk(total)}</div>
        </div>
        <ExportButton tab="cash" />
      </div>
      <Hint>Balances count every payment and expense ever recorded, not just one month.</Hint>
      {cash.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {cash.map(c => (
            <Section key={c.method} title={c.method} count={tk(c.balance)} testId={'cash-method-' + c.method}>
              <div className="grid grid-cols-2 gap-4 px-4 py-3">
                <div><div className="text-xs text-muted-foreground">In</div><div className="money text-sm font-semibold text-ok">{tk(c.in)}</div></div>
                <div><div className="text-xs text-muted-foreground">Out</div><div className="money text-sm font-semibold text-bad">{tk(c.out)}</div></div>
              </div>
              {(c.recent || []).length ? c.recent.map((x, i) => (
                <Row key={i} testId="cash-move" title={x.label} detail={shortDate(x.date)}
                  lead={<span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-full', x.kind === 'in' ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>{x.kind === 'in' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span>}
                  trail={<span className={cn('money text-sm font-semibold', x.kind === 'in' ? 'text-ok' : 'text-bad')}>{(x.kind === 'in' ? '+' : '−') + tk(x.amount)}</span>} />
              )) : <Empty>No dated movements.</Empty>}
            </Section>
          ))}
        </div>
      ) : <Empty>No cash movements yet.</Empty>}
    </div>
  );
}
