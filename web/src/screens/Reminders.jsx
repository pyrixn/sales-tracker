import { useState } from 'react';
import { Check, Copy, MessageCircle, MessageSquare, RefreshCw, SkipForward, UserX } from 'lucide-react';
import { productShort, shortDate, tk } from '@/lib/format';
import { copyText, markReminder, markReminders, REMINDER_LABEL, reminderBlocks } from '@/lib/reminders';
import { notify, useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { useOpeners } from '@/sheets/openers';
import { Avatar, Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { BulkBar } from '@/components/BulkBar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// The reminders queue (uplift plan 4.2). To send comes from the `home` read (Core.reminders.planReminders); Sent and Skipped come from
// `reminderLog` (Reminders_Log, the last 60 days). Ended lines never remind and custom sales never auto-remind, so neither appears here.
// Group headings are the owner's words; each row's label is REMINDER_LABEL's text for its kind.
const GROUPS = [
  { kind: 'on_day', title: 'Ends today' },
  { kind: 'after', title: 'Ended' },
  { kind: 'due', title: 'Overdue' },
  { kind: 'before', title: 'Upcoming' }
];
const TABS = [['to-send', 'To send'], ['sent', 'Sent'], ['skipped', 'Skipped']];
const keyOf = x => x.saleId + ':' + x.kind;
const labelOf = x => (REMINDER_LABEL[x.kind] || (() => x.kind))(x, tk);

// The channel is written out next to its icon, so the icon is never the only signal.
function Channel({ channel }) {
  const Icon = channel === 'WhatsApp' ? MessageCircle : channel === 'Messenger' ? MessageSquare : UserX;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {channel || 'No contact'}
    </span>
  );
}

// One reminder still to send. Copy puts the message on the clipboard; Mark sent and Skip record it, so it leaves this list.
function QueueRow({ it, checked, onCheck }) {
  const { reload } = useApp();
  const open = useOpeners();
  async function copy() {
    if (await copyText(it.message)) { notify('Copied message'); return; }
    open.message(it.message);
    notify('The browser blocked the clipboard. Copy the text from the sheet');
  }
  async function record(status) {
    const r = await markReminder(it, status);
    if (!r.ok) { notify(r.error || 'Could not save that.'); return; }
    notify(status === 'sent' ? 'Marked as sent' : 'Skipped');
    reload();
  }
  return (
    <Row wrap testId={'queue-' + it.saleId + '-' + it.kind} lead={<Avatar name={it.name} />} title={it.name}
      detail={(
        <span className="flex flex-col gap-0.5">
          <span>{productShort(it.productName) + ' · ' + labelOf(it)}</span>
          <span><Channel channel={it.channel} /></span>
        </span>
      )}
      trail={(
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <span className="-m-3 grid place-items-center p-3">
            <Checkbox aria-label={'Select reminder for ' + it.name} checked={checked} onCheckedChange={v => onCheck(!!v)} />
          </span>
          <Button type="button" size="sm" variant="outline" data-testid="copy-message" onClick={copy}><Copy />Copy message</Button>
          <Button type="button" size="sm" data-testid="mark-sent" onClick={() => record('sent')}><Check />Mark sent</Button>
          <Button type="button" size="sm" variant="ghost" data-testid="skip-reminder" onClick={() => record('skipped')}><SkipForward />Skip</Button>
        </div>
      )} />
  );
}

// A reminder already sent or skipped. Read only.
function LoggedRow({ r }) {
  const sent = r.status === 'sent';
  return (
    <Row wrap testId={'logged-' + r.saleId + '-' + r.kind + '-' + r.date} lead={<Avatar name={r.name} />} title={r.name}
      detail={(
        <span className="flex flex-col gap-0.5">
          <span>{productShort(r.productName) + (r.subCode ? ' · ref ' + r.subCode : '')}</span>
          <span><Channel channel={r.channel} /></span>
        </span>
      )}
      trail={(
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <Pill tone={sent ? 'ok' : 'muted'}>{sent ? 'Sent' : 'Skipped'}</Pill>
          <span className="font-mono text-xs text-muted-foreground">{r.date ? shortDate(r.date) : ''}</span>
        </span>
      )} />
  );
}

export function Reminders() {
  const { home, reload } = useApp();
  const open = useOpeners();
  const [tab, setTab] = useState('to-send');
  const [picked, setPicked] = useState(() => new Set());   // keys of the to-send rows ticked for a bulk action
  const [copiedFor, setCopiedFor] = useState('');          // the selection the messages were copied for
  const [busy, setBusy] = useState(false);
  // Sent and Skipped share one read window; the counts on every tab come from whichever answer is held.
  const wanted = tab === 'skipped' ? 'skipped' : 'sent';
  const read = useRead('reminderLog', { status: wanted });
  const log = read.data && read.data.status === wanted ? read.data : null;
  const counts = read.data ? read.data.counts : null;

  const toSend = home.reminders;
  const selected = toSend.filter(x => picked.has(keyOf(x)));
  const selKey = selected.map(keyOf).join(',');

  function changeTab(t) {
    setTab(t);
    setPicked(new Set());
    setCopiedFor('');
  }
  function setPick(x, on) {
    setCopiedFor('');
    setPicked(prev => { const n = new Set(prev); if (on) n.add(keyOf(x)); else n.delete(keyOf(x)); return n; });
  }
  function clearPicked() {
    setCopiedFor('');
    setPicked(new Set());
  }

  // One block per customer, as on Dues. The messages are already built on the home read, so no request is needed.
  async function copySelected() {
    const list = selected.slice();
    const key = selKey;
    const text = reminderBlocks(list.map(x => ({ customerId: x.customerId, name: x.name, message: x.message })));
    setBusy(true);
    const ok = await copyText(text);
    setBusy(false);
    if (!ok) { open.message(text); notify('The browser blocked the clipboard. Copy the text from the sheet'); return; }
    setCopiedFor(key);
    notify('Copied ' + list.length + (list.length === 1 ? ' reminder message' : ' reminder messages'));
  }

  async function markSelected() {
    const list = selected.slice();
    setBusy(true);
    setCopiedFor('');
    const { marked, error } = await markReminders(list, 'sent');
    setBusy(false);
    const gone = new Set(marked.map(keyOf));
    setPicked(prev => new Set(Array.from(prev).filter(k => !gone.has(k))));
    notify('Marked ' + marked.length + ' of ' + list.length + ' as sent' + (error ? '. Stopped: ' + error : ''));
    reload();
  }

  const groupsOf = rows => GROUPS.map(g => ({ g, list: rows.filter(x => x.kind === g.kind) })).filter(x => x.list.length);

  let body;
  if (tab === 'to-send') {
    const groups = groupsOf(toSend);
    body = groups.length ? groups.map(({ g, list }) => (
      <Section key={g.kind} title={g.title} count={list.length} testId={'reminders-group-' + g.kind}>
        {list.map(x => <QueueRow key={keyOf(x)} it={x} checked={picked.has(keyOf(x))} onCheck={on => setPick(x, on)} />)}
      </Section>
    )) : <Empty art="inbox">Nothing to send. Reminders appear here when a line is due, ends soon or has a balance.</Empty>;
  } else if (!log) {
    body = read.error ? (
      <div className="grid max-w-xl gap-3" data-testid="reminders-error">
        <ErrorBox>{read.error}</ErrorBox>
        <Button type="button" variant="outline" className="w-fit font-bold" onClick={() => read.refetch()}><RefreshCw />Retry</Button>
      </div>
    ) : (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading reminders">
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  } else {
    const groups = groupsOf(log.rows);
    body = (
      <>
        {groups.length ? groups.map(({ g, list }) => (
          <Section key={g.kind} title={g.title} count={list.length} testId={'reminders-group-' + g.kind}>
            {list.map(r => <LoggedRow key={r.saleId + ':' + r.kind + ':' + r.date + ':' + r.status} r={r} />)}
          </Section>
        )) : <Empty art="inbox">{tab === 'sent' ? 'Nothing sent in the last 60 days.' : 'Nothing skipped in the last 60 days.'}</Empty>}
        {log.truncated ? <p className="font-mono text-xs text-muted-foreground" data-testid="reminders-note">{'Showing the first ' + log.rows.length + ' of ' + log.matching + '.'}</p> : null}
      </>
    );
  }

  return (
    <div className="mx-auto grid min-w-0 max-w-3xl gap-4">
      {read.error && log ? <ErrorBox>{read.error}</ErrorBox> : null}
      <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="eyebrow">To send</div>
        <div className="hero-figure mt-2 text-[clamp(3.5rem,18vw,6.5rem)]" data-testid="reminders-open">{toSend.length}</div>
        <div className="mt-3 text-sm text-muted-foreground">Copy each message, then mark it sent or skip it. Sent and Skipped list the last 60 days.</div>
      </section>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="h-11 w-full md:w-96">
          <TabsTrigger value="to-send" className="font-bold" data-testid="reminders-tab-to-send">{'To send · ' + toSend.length}</TabsTrigger>
          <TabsTrigger value="sent" className="font-bold" data-testid="reminders-tab-sent">{'Sent' + (counts ? ' · ' + counts.sent : '')}</TabsTrigger>
          <TabsTrigger value="skipped" className="font-bold" data-testid="reminders-tab-skipped">{'Skipped' + (counts ? ' · ' + counts.skipped : '')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {body}

      {tab === 'to-send' ? (
        <BulkBar count={selected.length} onClear={clearPicked}>
          <Button type="button" variant="outline" size="sm" data-testid="bulk-copy-reminders" onClick={copySelected} disabled={busy}><Copy />Copy reminder messages</Button>
          {selected.length && copiedFor === selKey ? (
            <Button type="button" size="sm" data-testid="bulk-mark-sent" onClick={markSelected} disabled={busy}><Check />Mark all sent</Button>
          ) : null}
        </BulkBar>
      ) : null}
    </div>
  );
}
