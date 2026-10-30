import { useState } from 'react';
import { RefreshCw, Undo2 } from 'lucide-react';
import { call, dhakaToday, rid } from '@/lib/api';
import { dhakaClock, dhakaDate, exactTime, longDate, relTime } from '@/lib/format';
import { notify, useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

// The change history and Undo (uplift plan 4.3). The `activity` read lists the newest 100 saved changes, one entry per batch, newest
// first (Core.views.activityBatches decides the labels, the summaries and which entry Undo would reverse). Only that entry has an Undo
// button. It sends the same `undo` write as the save toast, with the batch id and a request id made when the owner asks, so a change
// saved since the list was read is refused rather than reverted blind.

// The calendar day before a YYYY-MM-DD key (Dhaka dates; no daylight saving in Bangladesh).
function dayBefore(key) {
  const d = new Date(key + 'T00:00');
  d.setDate(d.getDate() - 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function dayLabel(key, today) {
  if (!key) return 'Earlier';
  if (today && key === today) return 'Today';
  if (today && key === dayBefore(today)) return 'Yesterday';
  return longDate(key);
}
const rowsText = n => (n === 1 ? '1 row' : n + ' rows');

// What an entry offers on its trailing edge. Words say the state (Undone, Automatic), so colour is never the only signal.
function Trail({ b, hasUndo, onUndo }) {
  if (b.undoable) return <Button type="button" size="sm" variant="outline" data-testid="undo-this" onClick={() => onUndo(b)}><Undo2 />Undo this</Button>;
  if (b.undone) return <Pill>Undone</Pill>;
  if (b.automatic) return <Pill>Automatic</Pill>;
  if (b.reversal) return null;
  // A plain change under the one Undo would reverse: read only.
  return hasUndo ? <span className="max-w-40 text-right text-xs leading-snug text-muted-foreground">Undo reverses the newest change first</span> : null;
}

export function Activity() {
  const { reload } = useApp();
  const read = useRead('activity', {});
  const [ask, setAsk] = useState(null);   // { batch, request }: the Undo waiting for the owner's yes, and the request id it will send
  const [busy, setBusy] = useState(false);
  const data = read.data;
  const batches = data ? data.batches : [];
  const next = batches.find(b => b.undoable) || null;
  const today = dhakaToday();

  // Batches come newest first, so one day's batches are next to each other.
  const days = [];
  batches.forEach(b => {
    const key = dhakaDate(b.at);
    const last = days[days.length - 1];
    if (last && last.key === key) last.list.push(b);
    else days.push({ key: key, list: [b] });
  });

  async function undoIt(pending) {
    setBusy(true);
    const r = await call('undo', { requestId: pending.request, batchId: pending.batch.batchId });
    setBusy(false);
    setAsk(null);
    if (r.ok) { notify('Undone'); reload(); }
    else notify(r.error || 'Could not undo that.');
    read.refetch();
  }

  let body;
  if (!data) {
    body = read.error ? (
      <div className="grid max-w-xl gap-3" data-testid="activity-error">
        <ErrorBox>{read.error}</ErrorBox>
        <Button type="button" variant="outline" className="w-fit font-bold" onClick={() => read.refetch()}><RefreshCw />Retry</Button>
      </div>
    ) : (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading activity">
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  } else if (!batches.length) {
    body = <Empty art="receipt">Nothing has been saved yet. Each save appears here, newest first, with Undo for the latest one.</Empty>;
  } else {
    body = days.map(day => (
      <Section key={day.key || 'earlier'} title={dayLabel(day.key, today)} count={day.list.length} testId={'activity-day-' + (day.key || 'earlier')}>
        {day.list.map(b => (
          <Row key={b.batchId} wrap testId={'activity-' + b.batchId}
            lead={<time dateTime={b.at} title={exactTime(b.at)} className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{dhakaClock(b.at)}</time>}
            title={b.action}
            detail={b.summary + ' · ' + rowsText(b.rows)}
            trail={<Trail b={b} hasUndo={!!next} onUndo={batch => setAsk({ batch: batch, request: rid() })} />} />
        ))}
      </Section>
    ));
  }

  return (
    <div className="mx-auto grid min-w-0 max-w-3xl gap-4">
      {read.error && data ? <ErrorBox>{read.error}</ErrorBox> : null}
      <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="eyebrow">Next to undo</div>
        {next ? (
          <>
            <div className="mt-2 text-xl font-extrabold tracking-tight" data-testid="activity-next">{next.action}</div>
            <div className="mt-1 text-sm text-muted-foreground">{next.summary + ' · ' + relTime(next.at)}</div>
          </>
        ) : data ? (
          <div className="mt-2 text-sm text-muted-foreground" data-testid="activity-next">Nothing to undo.</div>
        ) : (
          <div className="mt-2 h-6 w-40 rounded-md bg-foreground/[0.06]" aria-hidden="true" />
        )}
        <div className="mt-3 text-xs text-muted-foreground">The last 100 saved changes. Reminder messages are not saved as changes, so they are not listed.</div>
      </section>

      {body}

      <AlertDialog open={!!ask} onOpenChange={o => { if (!o && !busy) setAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this change?</AlertDialogTitle>
            <AlertDialogDescription>
              {ask ? ask.batch.action + ': ' + ask.batch.summary + '. ' : ''}It puts back the values it changed. It is refused if anything was saved after it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="undo-confirm" disabled={busy} onClick={() => undoIt(ask)}>Undo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
