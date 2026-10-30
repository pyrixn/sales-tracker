import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ArrowUpRight, Bell, CheckCircle2, Clock, Copy, Eye, Inbox, MessageCircle, SkipForward, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { exactTime, longDate, plain, productShort, relTime, timeMs, tk } from '@/lib/format';
import { spring, stagger } from '@/lib/motion';
import { copyText, markReminder, REMINDER_LABEL } from '@/lib/reminders';
import { stockChips } from '@/lib/stock';
import { notify, useApp, useSaver } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Avatar, DaysPill, Empty, Pill, Row, Section } from '@/components/kit';
import { CopyId } from '@/components/CopyId';
import { EmptyArt } from '@/components/EmptyArt';
import { Figure } from '@/components/Figure';
import { Button } from '@/components/ui/button';
import { BentoGrid, BentoTile } from '@/components/ui/bento';
import { ShineBorder } from '@/components/fx/ShineBorder';
import { Spotlight } from '@/components/fx/Spotlight';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const BAR = ['h-1', 'h-3', 'h-5', 'h-7', 'h-9', 'h-11', 'h-14', 'h-16', 'h-20', 'h-24'];

/** Renewals in the next 14 days, one bar per day. Today's bar is the accent. */
function Runway({ lines, today, className }) {
  const days = useMemo(() => {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today + 'T00:00');
      d.setDate(d.getDate() + i);
      out.push({ i, label: d.getDate(), count: lines.filter(l => l.daysLeft === i).length });
    }
    return out;
  }, [lines, today]);
  const max = Math.max(1, ...days.map(d => d.count));
  const total = days.reduce((a, d) => a + d.count, 0);
  return (
    <section aria-label="Renewals in the next 14 days" className={cn('flex flex-col rounded-xl border border-border bg-card/80 p-4 backdrop-blur-sm', className)}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-extrabold tracking-tight">Renewal runway</h2>
        <span className="eyebrow truncate pl-2">{total + (total === 1 ? ' renewal' : ' renewals') + ' · 14 days'}</span>
      </div>
      <div role="img" aria-label={days.map(d => d.count + ' on day ' + d.label).join(', ')} className="mt-4 grid xl:mt-auto grid-cols-[repeat(14,minmax(0,1fr))] items-end gap-1">
        {days.map(d => (
          <Tooltip key={d.i}>
            <TooltipTrigger asChild>
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex h-24 w-full items-end">
                  <div className={cn('w-full rounded-t-sm', d.count ? BAR[Math.min(BAR.length - 1, Math.round((d.count / max) * (BAR.length - 1)))] : 'h-0.5', d.i === 0 ? 'bg-primary' : d.count ? 'bg-foreground/35' : 'bg-foreground/12')} />
                </div>
                <span className={cn('font-mono text-micro', d.i === 0 ? 'font-bold text-primary' : 'text-muted-foreground')}>{d.label}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{d.count + (d.count === 1 ? ' renewal' : ' renewals') + (d.i === 0 ? ' today' : ' in ' + d.i + 'd')}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </section>
  );
}

/** One row above the hero: counts that need the owner, each opening where they are handled. Zero counts are left out.
 *  The stock chips (uplift 4.8) have one chip per alert kind, each with data-kind; they open the Accounts screen. */
function AttentionStrip({ a, stock, onGo }) {
  if (!a) return null;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const items = [
    a.payments > 0 && { key: 'payments', label: plural(a.payments, 'payment to match', 'payments to match'),
      go: () => document.getElementById('payments-to-match')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    a.payLinks > 0 && { key: 'paylinks', label: plural(a.payLinks, 'pay link expiring within 6 hours', 'pay links expiring within 6 hours'), go: () => onGo('paylinks') },
    a.deliveries > 0 && { key: 'deliveries', label: plural(a.deliveries, 'delivery pending or failed', 'deliveries pending or failed'), go: () => onGo('delivery') },
    a.budgets > 0 && { key: 'budgets', label: plural(a.budgets, 'budget near or over its limit', 'budgets near or over their limit'), go: () => onGo('money') },
    ...stockChips(stock).map(c => ({ key: 'stock', kind: c.kind, label: c.label, go: () => onGo('accounts') }))
  ].filter(Boolean);
  if (!items.length) {
    return <p data-testid="attention-clear" className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">Nothing needs attention.</p>;
  }
  return (
    <section aria-label="Needs attention" data-testid="attention-strip" className="rounded-xl border border-border bg-card/80 p-3 backdrop-blur-sm">
      <div className="flex flex-wrap gap-2">
        {items.map(it => (
          <Button key={it.kind ? it.key + '-' + it.kind : it.key} type="button" size="sm" variant="outline"
            data-testid={it.kind ? 'attention-stock' : 'attention-' + it.key} data-kind={it.kind} onClick={it.go}>
            <AlertTriangle className="text-warn" />{it.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** A wallet top-up (owner's own bKash wallet, not a customer payment). One tap sets it aside; Undo comes from the toast. */
function TopUpRow({ u }) {
  const mark = useSaver('ignoreInbox', () => ({ trx: u.trx, topUp: true }), { stay: true });
  return (
    <div>
      <Row wrap testId={'topup-' + u.trx} title={tk(u.amount) + ' from ' + (u.sender || 'unknown')}
        detail={<><CopyId value={u.trx} label="transaction ID" />{' · '}<time title={exactTime(u.received)}>{relTime(u.received)}</time></>}
        trail={<Button type="button" size="sm" variant="outline" disabled={mark.busy} onClick={mark.save}>Mark as top-up</Button>} />
      {mark.error ? <p role="alert" className="px-4 pb-2 text-sm text-bad">{mark.error}</p> : null}
    </div>
  );
}

function ReminderRow({ it }) {
  const { reload } = useApp();
  const open = useOpeners();
  const label = (REMINDER_LABEL[it.kind] || (() => it.kind))(it, tk);
  const meta = productShort(it.productName) + ' · ' + label + (it.channel ? ' · ' + it.channel : ' · no contact');

  async function sent() { await markReminder(it, 'sent'); notify('Marked as sent'); }
  async function copy() {
    const win = it.link ? window.open(it.link, '_blank', 'noopener') : null;
    const copied = await copyText(it.message);
    if (!copied) open.message(it.message);
    await markReminder(it, 'sent');
    notify(copied ? 'Message copied' + (win ? ', paste in Messenger' : '') : 'Copy the message shown');
    reload();
  }
  async function skip() { await markReminder(it, 'skipped'); notify('Skipped'); reload(); }

  return (
    <Row wrap testId={'remind-' + it.saleId + '-' + it.kind} lead={<Avatar name={it.name} />} title={it.name} detail={meta}
      trail={(
        <div className="flex shrink-0 items-center gap-1">
          {it.link && it.channel === 'WhatsApp'
            ? <Button asChild size="sm"><a data-testid="remind-link" target="_blank" rel="noopener" href={it.link} onClick={sent}><MessageCircle />Remind</a></Button>
            : <Button type="button" size="sm" variant="outline" onClick={copy}><Copy />{it.channel === 'Messenger' ? 'Copy + open' : 'Copy'}</Button>}
          <Button type="button" size="icon-sm" variant="ghost" data-testid={'remind-preview-' + it.saleId + '-' + it.kind} onClick={() => open.reminder({ saleId: it.saleId, kind: it.kind, customerId: it.customerId })} aria-label="Preview this reminder" title="Preview this reminder"><Eye /></Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={skip} aria-label="Skip this reminder"><SkipForward /></Button>
        </div>
      )} />
  );
}

/** Unmatched payments, newest first, so a payment that just arrived is the top row. */
function newestFirst(list) {
  const at = u => { const t = timeMs(u.received); return isFinite(t) ? t : 0; };
  return list.slice().sort((a, b) => at(b) - at(a));
}

/**
 * The payments that arrived since the last refresh (uplift 1.4). The first list Today sees is the baseline: nothing arrives on
 * it. After that, each id that was not in the previous list is an arrival, and gets one toast. A refresh with the same ids does
 * nothing. The arrivals are worked out from the id set, so the toasts follow the data, not the renders.
 */
function useArrivals(list) {
  const seen = useRef(null);   // the ids at the previous refresh; null until the first one
  const key = list.map(u => u.trx).join('\n');
  const arrivals = useMemo(() => (seen.current ? list.filter(u => !seen.current.has(u.trx)) : []), [key]);
  useEffect(() => {
    seen.current = new Set(list.map(u => u.trx));
    arrivals.forEach(u => notify('New payment: Tk ' + plain(u.amount)));
  }, [key]);
  return arrivals;
}

export function Today({ onGo }) {
  const { home: h, lookups: L, today } = useApp();
  const open = useOpeners();
  const reduce = useReducedMotion();
  const [allRem, setAllRem] = useState(false);
  const unmatched = useMemo(() => newestFirst(h.unmatched), [h.unmatched]);
  const arrivedIds = new Set(useArrivals(h.unmatched).map(u => u.trx));
  const active = (L.lines || []).length;
  const lineRow = (x, sub) => (
    <Row key={x.saleId + ':' + x.subCode} onClick={() => open.customer(x.customerId)} lead={<Avatar name={x.name} />}
      title={x.name} detail={productShort(x.productName) + ' · ' + sub} trail={<DaysPill days={x.daysLeft} />} />
  );
  const reminders = allRem ? h.reminders : h.reminders.slice(0, 5);

  return (
    <BentoGrid variants={stagger} initial="hidden" animate="show">
      <BentoTile order={3}><AttentionStrip a={h.attention} stock={h.stock} onGo={onGo} /></BentoTile>

      {/* The hero is the one card with the pointer spotlight; its shine runs only while money is owed (uplift 1.3). */}
      <Spotlight component={BentoTile} as="section" hero tall span={7} order={1} aria-label="Today at a glance">
        <ShineBorder active={Number(h.owed) > 0} />
        <div className="eyebrow">{longDate(today)}</div>
        <button type="button" onClick={() => onGo('dues')} className="group mt-6 block w-full text-left">
          <span className="eyebrow flex items-center gap-1.5">Owed to you<ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" /></span>
          <Figure value={h.owed} testId="today-owed" className={cn('mt-2 text-[clamp(4.25rem,23vw,9.5rem)] break-all', h.owed ? 'text-foreground' : 'text-ok')} />
          <span className="mt-3 block text-sm text-muted-foreground">{h.owed ? 'Tap to see who owes' : 'Nobody owes you anything'}</span>
        </button>
        <div className="mt-6 flex flex-wrap gap-2">
          <Pill tone={h.renewSoon.length ? 'warn' : 'muted'}>{h.renewSoon.length + ' expiring soon'}</Pill>
          <Pill tone={h.expired.length ? 'bad' : 'muted'}>{h.expired.length + ' expired'}</Pill>
          <Pill>{active + ' active'}</Pill>
        </div>
      </Spotlight>

      <BentoTile span={5} tall order={2}><Runway lines={L.lines || []} today={today} className="xl:h-full" /></BentoTile>

      <BentoTile span={h.unmatched.length ? 6 : 12} order={4}>
        <Section title="Renew soon" icon={Clock} count={h.renewSoon.length} className="xl:h-full">
          {h.renewSoon.length ? h.renewSoon.map(x => lineRow(x, x.owes ? 'owes ' + tk(x.owes) : x.accountId)) : <Empty>Nobody expiring soon.</Empty>}
        </Section>
      </BentoTile>

      {/* A tile whose neighbour is missing takes the full row, so the bento has no empty half-row. */}
      {h.expired.length ? (
        <BentoTile span={h.topUps && h.topUps.length ? 6 : 12} order={6}>
          <Section title="Expired, not renewed" icon={XCircle} count={h.expired.length} className="xl:h-full">
            {h.expired.map(x => lineRow(x, (x.owes ? 'owes ' + tk(x.owes) + ' · ' : '') + x.accountId))}
          </Section>
        </BentoTile>
      ) : null}

      {h.unmatched.length ? (
        <BentoTile id="payments-to-match" span={6} order={5}>
          <Section title="Payments not matched" icon={Inbox} count={h.unmatched.length} className="xl:h-full">
            {/* An arrival slides in from above and the other rows spring to make room (layout). Rows present at the first
                render, and every row under reduced motion, are placed without animation. */}
            <AnimatePresence initial={false}>
              {unmatched.map(u => (
                <motion.div key={u.trx} layout={!reduce} transition={spring} animate={{ opacity: 1, y: 0 }}
                  initial={arrivedIds.has(u.trx) && !reduce ? { opacity: 0, y: -16 } : false}
                  exit={reduce ? undefined : { opacity: 0 }}>
                  <Row testId={'unm-' + u.trx} wrap lead={<Avatar name="" className="bg-primary/15 text-primary"><Inbox className="size-4" /></Avatar>}
                    title={tk(u.amount) + ' from ' + (u.sender || 'unknown')}
                    detail={<><CopyId value={u.trx} label="transaction ID" />{' · '}<time title={exactTime(u.received)}>{relTime(u.received)}</time>{(u.reference ? ' · ref ' + u.reference : '') + (u.status === 'Review' ? ' · needs review' : '')}</>}
                    trail={<Button type="button" size="sm" onClick={() => open.match(u.trx)}>Match</Button>} />
                </motion.div>
              ))}
            </AnimatePresence>
          </Section>
        </BentoTile>
      ) : null}

      {h.topUps && h.topUps.length ? (
        <BentoTile span={h.expired.length ? 6 : 12} order={7}>
          <details className="rounded-xl border border-border bg-card/80 backdrop-blur-sm xl:h-full">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-extrabold">
              <span>Wallet top-ups</span>
              <span className="font-mono text-micro text-muted-foreground">{h.topUps.length}</span>
            </summary>
            <div className="border-t border-border">
              {h.topUps.map(u => <TopUpRow key={u.trx} u={u} />)}
            </div>
          </details>
        </BentoTile>
      ) : null}

      {h.reminders.length ? (
        <BentoTile span={h.autoToCheck && h.autoToCheck.length ? 7 : 12} order={8}>
          <Section title="Reminders to send" icon={Bell} count={h.reminders.length} className="xl:h-full">
            {reminders.map((it, i) => <ReminderRow key={it.saleId + ':' + it.kind + ':' + i} it={it} />)}
            {h.reminders.length > 5 && !allRem ? (
              <div className="px-4 py-2"><Button type="button" variant="link" size="sm" onClick={() => setAllRem(true)}>{'Show all ' + h.reminders.length}</Button></div>
            ) : null}
          </Section>
        </BentoTile>
      ) : null}

      {h.autoToCheck && h.autoToCheck.length ? (
        <BentoTile span={h.reminders.length ? 5 : 12} order={9}>
          <Section title="Auto-matched payments" icon={CheckCircle2} count="check" className="xl:h-full">
            {h.autoToCheck.map(a => (
              <Row key={a.trx} onClick={() => open.customer(a.customerId)} lead={<Avatar name={a.name} />} title={a.name} detail={a.date + ' · ' + a.trx}
                trail={<span className="money text-sm font-semibold text-ok">{tk(a.amount)}</span>} />
            ))}
          </Section>
        </BentoTile>
      ) : null}

      {!h.unmatched.length && !h.reminders.length && !(h.autoToCheck && h.autoToCheck.length) ? (
        <BentoTile order={10} className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
          <div className="mb-3 flex justify-center"><EmptyArt name="calendar" /></div>
          <div className="page-title text-2xl">All caught up</div>
          <p className="mt-2 text-sm text-muted-foreground">No payments to match and no reminders to send.</p>
        </BentoTile>
      ) : null}
    </BentoGrid>
  );
}
