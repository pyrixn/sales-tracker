import { useDeferredValue, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowLeft, Search } from 'lucide-react';
import { tk } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOpeners } from '@/sheets/openers';
import { CustomerDetail, useCustomerData } from '@/components/CustomerDetail';
import { Avatar, Empty, Pill } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

// The desktop customer workspace (md and up, route #/customers/<id>). From lg (1024px) the list is a 320px column on the left and the
// chosen customer fills the main pane. Between md and lg the sidebar takes the room, so the list stacks above the detail instead.
// Picking another row swaps the detail in place. The list keeps focus while the user is in it (data-keep-focus, see AppShell).
export function CustomerWorkspace({ id, customers, onPick, onBack }) {
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const rows = useMemo(() => {
    const s = dq.trim().toLowerCase();
    return customers
      .filter(c => !s || c.name.toLowerCase().indexOf(s) >= 0 || String(c.handle).toLowerCase().indexOf(s) >= 0)
      .slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, dq]);

  return (
    <div data-testid="cust-workspace" className="mx-auto grid min-w-0 max-w-6xl gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
      <section aria-label="Customer list" className="grid min-w-0 gap-2 lg:sticky lg:top-20">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input id="wsSearch" type="search" placeholder="Search customers" aria-label="Search customers" autoComplete="off" className="h-11 pl-9" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {/* The height sits on this box: Virtuoso fills it (h-full), the same way the DataTable does. */}
        <div data-keep-focus="" data-testid="ws-list" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card h-[min(40dvh,22rem)] lg:h-[min(70dvh,40rem)]">
          {rows.length ? (
            <Virtuoso data={rows} className="h-full" computeItemKey={(i, c) => c.id}
              itemContent={(i, c) => <PickRow c={c} active={String(c.id) === String(id)} onPick={onPick} />} />
          ) : <Empty art="people">No customer matches.</Empty>}
        </div>
      </section>

      <div data-testid="ws-detail" className="min-w-0">
        <WorkspaceDetail key={id} id={id} onBack={onBack} />
      </div>
    </div>
  );
}

// One customer in the list. A real button (Enter and Space work); the active one carries aria-current, so the mark is not colour alone.
function PickRow({ c, active, onPick }) {
  return (
    <button type="button" data-testid={'ws-cust-' + c.id} aria-current={active ? 'true' : undefined} onClick={() => onPick(c.id)}
      className={cn('flex min-h-16 w-full items-center gap-3 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-foreground/[0.04]', active && 'bg-foreground/[0.07]')}>
      <Avatar name={c.name} className="size-9" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{c.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{c.channel ? c.channel + ' · ' + c.handle : 'no contact'}</span>
      </span>
      {c.owes ? <Pill tone="bad">{'owes ' + tk(c.owes)}</Pill> : c.credit ? <Pill tone="ok">{'credit ' + tk(c.credit)}</Pill> : null}
    </button>
  );
}

// The main pane. An id that is not a customer shows an Empty with a way back to the table, never an error screen.
function WorkspaceDetail({ id, onBack }) {
  const open = useOpeners();
  const cs = useCustomerData(id, { strict: true });
  if (cs.loading) {
    return <div aria-busy="true" aria-label="Loading customer" className="grid gap-4"><Skeleton className="h-40 w-full rounded-xl" /><Skeleton className="h-32 w-full rounded-xl" /></div>;
  }
  if (cs.error) {
    return (
      <div className="rounded-xl border border-border bg-card/80">
        <Empty art="people" action={<Button type="button" variant="outline" className="font-bold" onClick={onBack}><ArrowLeft />Back to customers</Button>}>
          That customer is not on file.
        </Empty>
      </div>
    );
  }
  return <CustomerDetail data={cs.data} openers={open} wide />;
}
