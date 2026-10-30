import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, CalendarClock, Pencil, Plus, RotateCw } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { cn } from '@/lib/utils';
import { daysTone, fullDate, plain, shortDate, tk } from '@/lib/format';
import { notify, useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Avatar, Chip, Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { LoginDetails } from '@/components/LoginDetails';
import { DeliveryMessage } from '@/screens/DeliveryLogins';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

function Stat({ label, value, tone, testId }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div data-testid={testId} className={cn('money mt-1 truncate text-base font-semibold md:text-lg', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad')}>{value}</div>
    </div>
  );
}

/** Slot meter: one block per slot, filled when taken, dashed when open. */
function Slots({ used, slots, host }) {
  return (
    <div className="flex items-center gap-2" role="img" aria-label={used + ' of ' + slots + ' slots in use' + (host ? ', plus the host seat' : '')}>
      <div className="flex gap-1">
        {Array.from({ length: slots }, (_, i) => (
          <span key={i} className={cn('h-2 w-4 rounded-sm md:w-5', i < used ? 'bg-primary' : 'border border-dashed border-foreground/40')} />
        ))}
        {host ? <span className="h-2 w-4 rounded-sm bg-foreground/45 md:w-5" title="Host seat" /> : null}
      </div>
      <span className="font-mono text-xs text-muted-foreground">{used + '/' + slots + (host ? ' + host' : '')}</span>
    </div>
  );
}

function tillText(d) { return d < 0 ? 'lapsed ' + (-d) + 'd' : d === 0 ? 'today' : d + 'd left'; }

function statusOf(r) {
  if (r.owes > 0) return { tone: 'bad', text: 'Due ' + tk(r.owes) };
  if (r.daysLeft !== null && r.daysLeft < 0) return { tone: 'bad', text: 'Expired' };
  return { tone: 'ok', text: 'Paid' };
}

const COLS = 'md:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_5.5rem_5rem_4.5rem_10rem_5.5rem]';

function UserRow({ r, onOpen, onPay, onEdit }) {
  const st = statusOf(r);
  const till = r.daysLeft === null ? null : daysTone(r.daysLeft);
  return (
    <div role="button" tabIndex={0} data-testid={'acct-user-' + r.subCode} onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={cn('grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-foreground/[0.04]', COLS)}>
      <Avatar name={r.name} className="size-9" />
      <div className="min-w-0">
        <div className="truncate text-sm font-bold">{r.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground md:hidden">{(r.profile || 'no login noted') + ' · ref ' + r.subCode}</div>
      </div>
      <div className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block" title={r.profile}>{r.profile || '—'}</div>
      <div className="col-start-3 row-start-1 flex flex-col items-end gap-1 md:col-start-auto md:row-start-auto md:items-start">
        <Pill tone={st.tone}>{st.text}</Pill>
      </div>
      <div className="hidden text-right font-mono text-sm font-semibold md:block">{tk(r.paid)}</div>
      <div className={cn('hidden text-right font-mono text-sm font-semibold md:block', r.owes > 0 ? 'text-bad' : 'text-muted-foreground')}>{r.owes > 0 ? tk(r.owes) : '—'}</div>
      <div className="col-span-3 col-start-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-12 md:col-span-1 md:col-start-auto md:pl-0">
        <span className="font-mono text-xs text-muted-foreground md:hidden">{'paid ' + tk(r.paid)}</span>
        {till ? <Pill tone={till.tone}>{(r.paidTill ? shortDate(r.paidTill) + ' · ' : '') + tillText(r.daysLeft)}</Pill> : <Pill>no end date</Pill>}
        <Button type="button" size="sm" variant="ghost" className="ml-auto md:hidden" onClick={e => { e.stopPropagation(); onEdit(); }}><Pencil />Edit</Button>
      </div>
      <div className="hidden items-center justify-end gap-1 md:flex">
        <LoginDetails saleId={String(r.saleId)} accountId={r.accountId} size="icon-sm" label="" className="size-9" />
        <DeliveryMessage saleId={r.saleId} productId={r.productId} accountId={r.accountId} size="icon-sm" className="size-9" />
        {r.owes > 0 ? <Button type="button" size="sm" onClick={e => { e.stopPropagation(); onPay(); }}>Paid</Button> : null}
        <Button type="button" size="icon-sm" variant="ghost" aria-label={'Edit ' + r.name + "'s line"} onClick={e => { e.stopPropagation(); onEdit(); }}><Pencil /></Button>
      </div>
    </div>
  );
}

function AccountCard({ a, productId, open }) {
  const net = a.net;
  const renew = a.renewalDate ? daysTone(a.daysLeft) : null;
  const expiredUsers = a.rows.filter(r => r.daysLeft !== null && r.daysLeft < 0).length;
  const editLine = r => open.editSale({ saleId: r.saleId, productId: r.productId, productName: r.productName, subCode: r.subCode, profile: r.profile,
    accountId: r.accountId, price: r.price, months: r.months, paidTill: r.paidTill, status: r.status, notes: r.notes, costSnapshot: r.costSnapshot });
  return (
    <details open className="group overflow-hidden rounded-xl border border-border bg-card/80 backdrop-blur-sm" data-testid={'acct-' + a.id}>
      <summary className="flex cursor-pointer list-none flex-col gap-4 p-4 marker:hidden md:p-5 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-x-4">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">{a.id}</div>
            <h3 className="break-all font-mono text-base font-bold md:text-lg" title={a.label}>{a.label}</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {renew
              ? <Pill tone={renew.tone}><CalendarClock className="size-3" aria-hidden="true" />{'renews ' + shortDate(a.renewalDate) + ' · ' + (a.daysLeft < 0 ? 'lapsed ' + (-a.daysLeft) + 'd' : a.daysLeft + 'd')}</Pill>
              : <Pill>renewal date not set</Pill>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat label="Collected" value={tk(a.collected)} tone="ok" />
          <Stat label="Cost" value={tk(a.cost)} />
          <Stat label="Net" value={(net >= 0 ? '+' : '') + tk(net)} tone={net >= 0 ? 'ok' : 'bad'} testId={'acct-net-' + a.id} />
          <Stat label="Due" value={a.due ? tk(a.due) : '—'} tone={a.due ? 'bad' : undefined} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Slots used={a.used} slots={a.slots} host={a.host} />
          {expiredUsers ? <span className="font-mono text-xs text-bad">{expiredUsers + ' expired'}</span> : null}
        </div>
      </summary>

      <div className="border-t border-border">
        <div className={cn('hidden gap-x-3 px-4 py-2 md:grid', COLS)}>
          {['', 'Customer', 'Login / profile', 'Status', 'Paid', 'Due', 'Paid till', ''].map((h, i) => (
            <div key={i} className={cn('eyebrow', (h === 'Paid' || h === 'Due') && 'text-right')}>{h}</div>
          ))}
        </div>
        <div className="divide-y divide-border">
          {a.rows.map(r => (
            <UserRow key={r.saleId} r={r} onOpen={() => open.customer(r.customerId)} onEdit={() => editLine(r)}
              onPay={() => open.pay({ customerId: r.customerId, saleId: r.saleId, amount: r.owes })} />
          ))}
          {a.host ? (
            <div className="flex items-center gap-3 px-4 py-3" data-testid={'host-seat-' + a.id}>
              <span className="grid size-9 place-items-center rounded-full bg-foreground/10 font-mono text-xs font-bold">H</span>
              <span className="flex-1 text-sm text-muted-foreground">Host seat</span>
              <Pill>not for sale</Pill>
            </div>
          ) : null}
          {Array.from({ length: a.free }, (_, i) => (
            <div key={'free' + i} className="flex items-center gap-3 px-4 py-3">
              <span className="grid size-9 place-items-center rounded-full border border-dashed border-foreground/40 text-muted-foreground"><Plus className="size-4" aria-hidden="true" /></span>
              <span className="flex-1 text-sm text-muted-foreground">Open slot</span>
              {i === 0 ? <Button type="button" size="sm" variant="outline" onClick={() => open.newSale({ productId, accountId: a.id })}>Sell it</Button> : null}
            </div>
          ))}
        </div>
        {a.unattributed.count ? (
          <div className="flex items-center justify-between gap-3 border-t border-border bg-foreground/[0.03] px-4 py-2.5 text-xs text-muted-foreground">
            <span>{a.unattributed.count + (a.unattributed.count === 1 ? ' receipt' : ' receipts') + ' with no named user'}</span>
            <span className="money font-semibold text-foreground">{tk(a.unattributed.amount)}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <LoginDetails accountId={a.id} />
          <Button type="button" size="sm" variant="ghost" onClick={() => open.editAccount(a)}><Pencil />Edit account</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => open.retireAccount(a)}><Archive />Retire</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => open.purchase(a.id)}><RotateCw />Renewed it</Button>
        </div>
      </div>
    </details>
  );
}

/** The log of accounts out of service: totals by product, and each account's own profit. */
function RetiredLog({ groups, open, onReactivate }) {
  if (!groups.length) return <Section title="Retired accounts"><Empty>No retired accounts. Retire an account from its card to keep its profit on record here.</Empty></Section>;
  return (
    <div className="grid gap-5" data-testid="retired-log">
      {groups.map(g => {
        const t = g.accounts.reduce((s, a) => ({ collected: s.collected + a.collected, cost: s.cost + a.cost }), { collected: 0, cost: 0 });
        const net = t.collected - t.cost;
        return (
          <section key={g.productId} className="grid gap-3" aria-label={g.productName}>
            <h2 className="flex flex-wrap items-baseline gap-x-3 px-1">
              <span className="page-title text-2xl">{g.productName}</span>
              <span className="money text-sm font-semibold">{(net >= 0 ? '+' : '') + tk(net)}</span>
              <span className="eyebrow">{g.accounts.length + (g.accounts.length === 1 ? ' retired account' : ' retired accounts') + ' · collected ' + tk(t.collected) + ' · cost ' + tk(t.cost)}</span>
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/80">
              {g.accounts.map(a => (
                <div key={a.id} data-testid={'retired-' + a.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,6rem))_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="break-all font-mono text-sm font-bold">{a.label}</div>
                    <div className="text-xs text-muted-foreground">{a.id + (a.retiredOn ? ' · retired ' + fullDate(a.retiredOn) : a.lastActive ? ' · last paid till ' + fullDate(a.lastActive) : '') + ' · ' + a.rows.length + ' users'}</div>
                  </div>
                  <Stat label="Collected" value={tk(a.collected)} tone="ok" />
                  <Stat label="Cost" value={tk(a.cost)} />
                  <Stat label="Net" value={(a.net >= 0 ? '+' : '') + tk(a.net)} tone={a.net >= 0 ? 'ok' : 'bad'} />
                  <div className="flex gap-1.5 md:justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => open.editAccount(a)}><Pencil />Edit</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => onReactivate(a)}><ArchiveRestore />Reactivate</Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Single subscription lines ended from a customer sheet: what each one collected, cost and netted. */
function EndedLines({ groups }) {
  const count = groups.reduce((n, g) => n + g.lines.length, 0);
  if (!count) return null;
  return (
    <Section title="Ended lines" count={count} testId="ended-log">
      {groups.map(g => g.lines.map(l => (
        <Row key={l.saleId} testId={'ended-' + l.subCode} wrap
          title={l.name + ' · ' + g.productName}
          detail={(l.accountId || '') + ' · ref ' + l.subCode + (l.endedOn ? ' · ended ' + fullDate(l.endedOn) : '') + ' · collected ' + tk(l.collected) + ' · cost ' + tk(l.cost)}
          trail={<span className={cn('money text-sm font-semibold', l.net >= 0 ? 'text-ok' : 'text-bad')}>{(l.net >= 0 ? '+' : '') + tk(l.net)}</span>} />
      )))}
    </Section>
  );
}

export function Accounts() {
  const { lookups, reload, home } = useApp();
  const open = useOpeners();
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [product, setProduct] = useState('all');
  const [view, setView] = useState('active');
  const [lowOnly, setLowOnly] = useState(false);
  // Accounts with a stock or capacity alert (uplift 4.8): no free seat, or renewing within 5 days. Code products have no account here.
  const lowIds = useMemo(() => new Set(((home && home.stock) || []).filter(s => s.kind !== 'code_low').map(s => s.id)), [home]);

  const load = useCallback(() => call('accounts').then(r => setState(r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error, data: null })), []);
  useEffect(() => { load(); }, [load, lookups]);

  const d = state.data;
  const split = useMemo(() => {
    if (!d) return { active: [], retired: [], retiredCount: 0 };
    const pick = retired => d.groups.map(g => ({ ...g, accounts: g.accounts.filter(a => a.retired === retired) })).filter(g => g.accounts.length);
    const retired = pick(true);
    return { active: pick(false), retired, retiredCount: retired.reduce((n, g) => n + g.accounts.length, 0) };
  }, [d]);

  if (state.loading) return <div className="mx-auto grid max-w-5xl gap-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (state.error) return <div className="mx-auto max-w-5xl"><ErrorBox>{state.error}</ErrorBox></div>;

  async function reactivate(a) {
    const r = await call('edit', { kind: 'account', id: a.id, values: { Account_Status: 'Active' }, requestId: rid() });
    if (!r.ok) { notify(r.error); return; }
    notify(a.id + ' is active again', { undo: true, batchId: r.data && r.data.batchId, onUndo: reload });
    reload();
  }

  const list = view === 'active' ? split.active : split.retired;
  const shownAll = list.filter(g => product === 'all' || g.productId === product);
  const shown = lowOnly ? shownAll.map(g => ({ ...g, accounts: g.accounts.filter(a => lowIds.has(a.id)) })).filter(g => g.accounts.length) : shownAll;
  const endedShown = view === 'retired' ? (d.endedLines || []).filter(g => product === 'all' || g.productId === product) : [];
  const t = shown.reduce((a, g) => g.accounts.reduce((b, x) => ({
    collected: b.collected + x.collected, cost: b.cost + x.cost, due: b.due + x.due, free: b.free + x.free, count: b.count + 1
  }), a), { collected: 0, cost: 0, due: 0, free: 0, count: 0 });
  const net = t.collected - t.cost;

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Tabs value={view} onValueChange={v => { setView(v); setProduct('all'); setLowOnly(false); }}>
        <TabsList className="h-11 w-full md:w-80">
          <TabsTrigger value="active" className="font-bold">Active</TabsTrigger>
          <TabsTrigger value="retired" className="font-bold" data-testid="retired-tab">{'Retired · ' + split.retiredCount}</TabsTrigger>
        </TabsList>
      </Tabs>

      <section className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="eyebrow">{(view === 'active' ? 'Net across ' : 'Kept from ') + t.count + (view === 'active' ? ' accounts' : ' retired accounts')}</div>
        <div data-testid="accounts-net" className={cn('hero-figure mt-2 text-[clamp(3.25rem,16vw,6rem)]', net < 0 && 'text-bad')}>
          <span className="mr-1 align-top text-[0.38em] text-muted-foreground">{net < 0 ? '−৳' : '৳'}</span>{plain(net)}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <Stat label="Collected" value={tk(t.collected)} tone="ok" />
          <Stat label="Cost" value={tk(t.cost)} />
          {view === 'active' ? <Stat label="Still due" value={t.due ? tk(t.due) : '—'} tone={t.due ? 'bad' : undefined} /> : null}
          {view === 'active' ? <Stat label="Open slots" value={String(t.free)} /> : null}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Filter by product">
        <Chip pressed={product === 'all'} onClick={() => setProduct('all')} className="shrink-0">All</Chip>
        {list.map(g => <Chip key={g.productId} pressed={product === g.productId} onClick={() => setProduct(g.productId)} className="shrink-0">{g.productName.split(' ')[0] + ' · ' + g.accounts.length}</Chip>)}
      </div>

      {view === 'active' ? (
        <div className="flex gap-2" role="group" aria-label="Filter by stock">
          <Chip pressed={lowOnly} onClick={() => setLowOnly(v => !v)} testId="accounts-low-stock" className="shrink-0">{'Low stock · ' + lowIds.size}</Chip>
        </div>
      ) : null}

      {view === 'retired' ? (
        <>
          {shown.length || !endedShown.length ? <RetiredLog groups={shown} open={open} onReactivate={reactivate} /> : null}
          <EndedLines groups={endedShown} />
        </>
      ) : shown.map(g => (
        <section key={g.productId} className="grid gap-3" aria-label={g.productName}>
          <h2 className="flex flex-wrap items-baseline gap-x-3 px-1"><span className="page-title text-2xl">{g.productName}</span><span className="eyebrow">{g.accounts.length + (g.accounts.length === 1 ? ' account' : ' accounts')}</span></h2>
          {g.accounts.map(a => <AccountCard key={a.id} a={a} productId={g.productId} open={open} />)}
        </section>
      ))}
    </div>
  );
}
