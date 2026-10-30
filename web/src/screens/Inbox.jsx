import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import { relTime, tk } from '@/lib/format';
import { useRead } from '@/lib/useRead';
import { cn } from '@/lib/utils';
import { useOpeners } from '@/sheets/openers';
import { Chip, Empty, ErrorBox, Pill, Row, useMedia } from '@/components/kit';
import { DataTable as Grid } from '@/components/DataTable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

// Payment messages (uplift plan 4.1). The read is bounded in Core.views.inboxRows: every open message plus the last 90 days.
// A row opens the Match sheet only when the sheet can act on it (open, not a wallet top-up, with a transaction id); the Ignore and
// Delete actions live in that sheet and are not repeated here.
const STATUSES = [['all', 'All'], ['Pending', 'Pending'], ['Review', 'Review'], ['Matched', 'Matched'], ['Auto-matched', 'Auto-matched'], ['Ignored', 'Ignored']];
// Colour is never the only signal: every status is also written out.
const TONE = { Pending: 'warn', Review: 'bad', Matched: 'ok', 'Auto-matched': 'ok', Ignored: 'muted' };

function StatusPill({ status }) {
  return <Pill tone={TONE[status] || 'muted'}>{status}</Pill>;
}

// Phone: one tappable row per message (64px or taller, from Row). Rows the sheet cannot open are plain.
function MessageRow({ r, onOpen }) {
  return (
    <Row wrap data-trx={r.trx} onClick={r.matchable ? () => onOpen(r.trx) : undefined}
      title={r.sender || 'Unknown sender'}
      detail={(
        <span className="flex flex-col gap-0.5">
          <span className="font-mono">{r.trx || 'No transaction ID'}</span>
          <span>{relTime(r.received) + (r.reference ? ' · ref ' + r.reference : '')}</span>
        </span>
      )}
      trail={(
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="money text-sm font-bold">{tk(r.amount)}</span>
          <StatusPill status={r.status} />
        </span>
      )} />
  );
}

// Wallet top-ups (the owner's own bKash wallet, not a customer payment). Collapsed by default; read only here.
function TopUps({ rows }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/80">
      <button type="button" aria-expanded={expanded} aria-controls="inboxTopUps" data-testid="inbox-topups-toggle" onClick={() => setExpanded(e => !e)}
        className="flex min-h-16 w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04]">
        <span className="flex-1 text-sm font-extrabold tracking-tight">Wallet top-ups</span>
        <span className="font-mono text-xs text-muted-foreground">{rows.length}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id="inboxTopUps" data-testid="inbox-topups" className="divide-y divide-border border-t border-border">
          {rows.map(r => (
            <Row key={r.key} wrap data-trx={r.trx} title={r.sender || 'Unknown sender'}
              detail={<span className="font-mono">{r.trx || 'No transaction ID'}</span>}
              trail={(
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="money text-sm font-bold">{tk(r.amount)}</span>
                  <StatusPill status={r.status} />
                </span>
              )} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function Inbox() {
  const openers = useOpeners();
  const wide = useMedia('(min-width: 768px)');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  // The search goes to the server (the read is bounded and the match uses the whole window), so it waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const read = useRead('inbox', { status, q: dq });
  const d = read.data;

  // Keys are the transaction id, or a position for a message with none (several can be blank).
  const rows = useMemo(() => (d ? d.rows.map((r, i) => Object.assign({ key: r.trx || 'blank-' + i }, r)) : []), [d]);
  const main = useMemo(() => rows.filter(r => !r.topUp), [rows]);
  const topUps = useMemo(() => rows.filter(r => r.topUp), [rows]);

  const columns = useMemo(() => [
    { id: 'received', accessorFn: r => r.received, header: 'Received', meta: { label: 'Received', width: 'w-40', mono: true },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.received}</span> },
    { id: 'from', accessorFn: r => r.sender, header: 'From', meta: { label: 'From', width: 'w-44' },
      cell: ({ row }) => <span className="block truncate">{row.original.sender || '—'}</span> },
    { id: 'amount', accessorKey: 'amount', header: 'Amount', meta: { label: 'Amount', align: 'right', mono: true, width: 'w-28' },
      cell: ({ row }) => tk(row.original.amount) },
    { id: 'status', accessorFn: r => r.status, header: 'Status', meta: { label: 'Status', width: 'w-36' },
      cell: ({ row }) => <StatusPill status={row.original.status} /> },
    { id: 'reference', accessorFn: r => r.reference, header: 'Reference', meta: { label: 'Reference', width: 'w-32', mono: true, hideBelow: 'xl' },
      cell: ({ row }) => row.original.reference || '—' },
    { id: 'method', accessorFn: r => r.method, header: 'Method', meta: { label: 'Method', width: 'w-24', hideBelow: 'xl' },
      cell: ({ row }) => row.original.method || '—' },
    { id: 'trx', accessorFn: r => r.trx, header: 'Transaction ID', meta: { label: 'Transaction ID', width: 'w-44', mono: true, hideBelow: 'lg' },
      cell: ({ row }) => row.original.trx || '—' }
  ], []);

  const searchBar = (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input id="inboxSearch" type="search" placeholder="Search ID, sender, amount or reference" aria-label="Search inbox" autoComplete="off"
        className="h-11 pl-9" value={q} onChange={e => setQ(e.target.value)} />
    </div>
  );

  if (!d && read.error) {
    return (
      <div className="mx-auto grid max-w-3xl gap-4">
        {searchBar}
        <div className="grid max-w-xl gap-3" data-testid="inbox-error">
          <ErrorBox>{read.error}</ErrorBox>
          <Button type="button" variant="outline" className="w-fit font-bold" onClick={() => read.refetch()}><RefreshCw />Retry</Button>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="mx-auto grid max-w-3xl gap-4" aria-busy="true" aria-label="Loading inbox">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const toMatch = d.counts.Pending + d.counts.Review;
  const filtered = status !== 'all' || dq !== '';
  const emptyText = filtered ? 'No messages match.' : 'No payment messages yet.';
  const note = d.truncated
    ? 'Showing the first ' + rows.length + ' of ' + d.matching + '. Narrow the search or the status to see the rest.'
    : d.matching + (d.matching === 1 ? ' message' : ' messages') + ' · newest first';

  return (
    <div className="mx-auto grid min-w-0 max-w-5xl gap-4">
      {read.error ? <ErrorBox>{read.error}</ErrorBox> : null}
      <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="eyebrow">To match</div>
        <div className="hero-figure mt-2 text-[clamp(3.5rem,18vw,6.5rem)]" data-testid="inbox-open">{toMatch}</div>
        <div className="mt-3 text-sm text-muted-foreground">Pending or in review. The list holds the last 90 days, plus every message still open.</div>
      </section>

      {searchBar}

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Filter by status">
        {STATUSES.map(([k, label]) => (
          <Chip key={k} testId={'inbox-chip-' + k} pressed={status === k} onClick={() => setStatus(k)} className="shrink-0">
            {label + ' · ' + d.counts[k === 'all' ? 'total' : k]}
          </Chip>
        ))}
      </div>
      <p className="font-mono text-xs text-muted-foreground" data-testid="inbox-note">{note}</p>

      {wide ? (
        <div data-testid="inbox-list" className="grid min-w-0 gap-2">
          <div className="flex items-center gap-2 px-1">
            <h2 className="flex-1 text-sm font-extrabold tracking-tight">Payment messages</h2>
            <span className="font-mono text-xs text-muted-foreground">{main.length}</span>
          </div>
          <Grid label="Payment messages" columns={columns} data={main} getRowId={r => r.key}
            onRowClick={r => { if (r.matchable) openers.match(r.trx); }}
            getRowProps={r => ({ 'data-trx': r.trx, 'data-status': r.status })}
            empty={<div className="rounded-xl border border-border bg-card"><Empty art="inbox">{emptyText}</Empty></div>} />
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-border bg-card/80" data-testid="inbox-list">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="flex-1 text-sm font-extrabold tracking-tight">Payment messages</h2>
            <span className="font-mono text-xs text-muted-foreground">{main.length}</span>
          </header>
          <div className="divide-y divide-border">
            {main.length ? main.map(r => <MessageRow key={r.key} r={r} onOpen={openers.match} />) : <Empty art="inbox">{emptyText}</Empty>}
          </div>
        </section>
      )}

      <TopUps rows={topUps} />
    </div>
  );
}
