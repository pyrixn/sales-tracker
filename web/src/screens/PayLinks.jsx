import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, MessageCircle, Plus, Search, Settings2, Sparkles, Wallet } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { exactTime, relTime, tk, whatsappLink } from '@/lib/format';
import { CopyId } from '@/components/CopyId';
import { notify, useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { PayMethodIcon } from '@/components/icons';
import { Avatar, Chip, Empty, ErrorBox, Pill, Row, Section } from '@/components/kit';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const STAGE = {
  none: { tone: 'muted', text: 'No link yet' },
  created: { tone: 'muted', text: 'Not opened' },
  waiting: { tone: 'warn', text: 'Waiting' },
  claimed: { tone: 'bad', text: 'Says paid' },
  received: { tone: 'warn', text: 'Payment in' },
  confirmed: { tone: 'ok', text: 'Confirmed' }
};
// Custom links (payRequests) show one more stage than sale lines: how the request ended.
const REQ_STAGE = {
  none: { tone: 'muted', text: 'Open' },
  created: { tone: 'muted', text: 'Open' },
  waiting: { tone: 'warn', text: 'Waiting' },
  claimed: { tone: 'bad', text: 'Says paid' },
  received: { tone: 'warn', text: 'Payment in' },
  confirmed: { tone: 'ok', text: 'Confirmed' },
  expired: { tone: 'muted', text: 'Expired' },
  cancelled: { tone: 'muted', text: 'Cancelled' }
};
const METHOD = { bkash: 'bKash', nagad: 'Nagad', upay: 'Upay', bank: 'Bank' };

const FILTERS = [
  ['all', 'All', () => true],
  ['attention', 'Needs you', r => r.stage === 'claimed' || r.stage === 'received'],
  ['waiting', 'Waiting', r => r.stage === 'waiting'],
  ['idle', 'Not opened', r => r.stage === 'created' || r.stage === 'none'],
  ['done', 'Confirmed', r => r.stage === 'confirmed']
];
const CUSTOM = 'custom';
const LIVE = ['created', 'none', 'waiting', 'claimed', 'received'];

function useBase() {
  const { lookups } = useApp();
  return String((lookups.settings && lookups.settings.pay_base_url) || window.location.origin).replace(/\/+$/, '');
}

function shareText(lang, name, product, url) {
  return lang === 'bn'
    ? 'হ্যালো ' + name + ', ' + product + ' এর পেমেন্ট এই লিংকে করুন: ' + url
    : 'Hi ' + name + ', you can pay for ' + product + ' here: ' + url;
}

export function PayLinks() {
  const { lookups, reload } = useApp();
  const open = useOpeners();
  const base = useBase();
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState([]);
  const dq = useDeferredValue(q);

  const load = useCallback(() => call('payLinks').then(r => setState(r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error, data: null })), []);
  const loadCustom = useCallback(() => call('payRequests').then(r => { if (r.ok) setCustom(r.data.rows); }), []);
  useEffect(() => { load(); loadCustom(); }, [load, loadCustom, lookups]);

  const d = state.data;
  const rows = useMemo(() => {
    if (!d) return [];
    const s = dq.trim().toLowerCase();
    const test = (FILTERS.find(f => f[0] === filter) || FILTERS[0])[2];
    return d.rows.filter(r => test(r) && (!s || r.name.toLowerCase().indexOf(s) >= 0 || r.subCode.toLowerCase().indexOf(s) >= 0 || r.productName.toLowerCase().indexOf(s) >= 0));
  }, [d, dq, filter]);
  const customRows = useMemo(() => {
    const s = dq.trim().toLowerCase();
    return custom.filter(r => !s || [r.title, r.customer, r.ref, r.product].some(x => String(x || '').toLowerCase().indexOf(s) >= 0));
  }, [custom, dq]);

  if (state.loading) return <div className="mx-auto grid max-w-3xl gap-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (state.error) return <div className="mx-auto max-w-3xl"><ErrorBox>{state.error}</ErrorBox></div>;

  const urlOf = r => base + '/pay/' + encodeURIComponent(r.token);
  async function copy(r) {
    try { await navigator.clipboard.writeText(urlOf(r)); notify('Copied the link for ' + r.name); } catch (e) { notify(urlOf(r)); }
  }
  // The pay page is on this site too, so a link is always shareable: the saved base URL when set, else this site's origin.
  const linkOf = r => r.url || (r.token ? window.location.origin + '/pay/' + encodeURIComponent(r.token) : '');
  async function copyUrl(r) {
    const link = linkOf(r);
    try { await navigator.clipboard.writeText(link); notify('Copied the link for ' + r.title); } catch (e) { notify(link); }
  }
  async function cancelRequest(r) {
    const res = await call('cancelPayRequest', { id: r.id, requestId: rid() });
    notify(res.ok ? res.data.message : res.error);
    reload();
  }
  async function generate() {
    setBusy(true);
    const res = await call('backfillPayTokens', { requestId: rid() });
    setBusy(false);
    if (!res.ok) { notify(res.error); return; }
    notify(res.data.message);
    reload();
  }
  const lang = (lookups.settings && lookups.settings.language) || 'en';
  const notReady = d.methods.filter(m => !m.ready);
  const counts = Object.fromEntries(FILTERS.map(f => [f[0], d.rows.filter(f[2]).length]));

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <section className="grid gap-4 rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="page-title text-2xl">Customers pay here</h2>
            <p className="mt-1 text-sm text-muted-foreground">Each link asks for the customer's number, lets them pick how to pay, shows the steps, and tracks the order until you confirm it.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" onClick={() => open.payRequest()}><Plus />New link</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => open.payMethods()}><Settings2 />Methods</Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Payment methods on the pay page">
          {d.methods.length ? d.methods.map(m => (
            <Pill key={m.id} tone={m.ready ? 'ok' : 'warn'} className="gap-1.5 pl-1.5">
              <PayMethodIcon method={m.id} className="size-3.5 shrink-0" />
              <span>{m.label + (m.ready ? (m.auto ? ' · auto' : ' · by hand') : ' · not set up')}</span>
            </Pill>
          )) : <Pill tone="bad">No method enabled</Pill>}
        </div>
        {notReady.length ? <p className="text-sm text-warn">{notReady.map(m => m.label).join(', ') + (notReady.length === 1 ? ' has' : ' have') + ' no number or account yet, so customers see it greyed out.'}</p> : null}
        {d.missing ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
            <span className="flex-1 text-sm">{d.missing + (d.missing === 1 ? ' line has' : ' lines have') + ' no pay link yet.'}</span>
            <Button type="button" size="sm" onClick={generate} disabled={busy}><Sparkles />Generate links</Button>
          </div>
        ) : null}
      </section>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input id="linkSearch" type="search" placeholder="Search name, ref or product" aria-label="Search pay links" autoComplete="off" className="h-11 pl-9" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Order status">
        {FILTERS.map(([k, label]) => <Chip key={k} pressed={filter === k} onClick={() => setFilter(k)} className="shrink-0">{label + ' · ' + counts[k]}</Chip>)}
        <Chip testId="filter-custom" pressed={filter === CUSTOM} onClick={() => setFilter(CUSTOM)} className="shrink-0">{'Custom · ' + custom.length}</Chip>
      </div>

      {filter === CUSTOM ? (
        <Section title="Custom links" icon={Link2} count={customRows.length} testId="custom-list">
          {customRows.length ? customRows.map(r => {
            const st = REQ_STAGE[r.stage] || REQ_STAGE.created;
            const live = LIVE.indexOf(r.stage) >= 0;
            const detail = (<><CopyId value={r.ref} label="pay link reference" />{(r.customer ? ' · ' + r.customer : '') + (r.product ? ' · ' + r.product : '')}
              {live && r.expires ? <>{' · expires '}<time title={exactTime(r.expires)}>{relTime(r.expires)}</time></> : null}</>);
            return (
              <Row key={r.id} wrap stack data-testid={'custom-' + r.id}
                title={r.title} detail={detail}
                trail={(
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    <span className="money mr-1 text-sm font-semibold">{tk(r.amount)}</span>
                    <Pill tone={st.tone}>{st.text}</Pill>
                    {r.stage === 'confirmed' && r.deliveryStatus ? <Pill tone={r.deliveryStatus === 'Delivered' ? 'ok' : 'warn'}>{r.deliveryStatus === 'Delivered' ? 'Delivered' : 'Delivery ' + r.deliveryStatus.toLowerCase()}</Pill> : null}
                    {live ? (
                      <>
                        {linkOf(r) ? <Button type="button" size="sm" variant="outline" aria-label={'Copy link for ' + r.title} onClick={() => copyUrl(r)}><Link2 />Copy</Button> : null}
                        {linkOf(r) ? <Button asChild size="icon-sm" variant="ghost"><a href={linkOf(r)} target="_blank" rel="noopener" aria-label={'Open the pay page for ' + r.title}><ExternalLink /></a></Button> : null}
                        {r.canGotPaid ? <Button type="button" size="sm" aria-label={'Got paid for ' + r.title} onClick={() => open.gotPaidRequest(r)}><Wallet />Got paid</Button> : null}
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button type="button" size="sm" variant="ghost" className="text-bad hover:text-bad" aria-label={'Cancel link for ' + r.title}>Cancel</Button></AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{'Cancel ' + r.title + '?'}</AlertDialogTitle>
                              <AlertDialogDescription>The link stops working and any code held for it goes back to stock.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep it</AlertDialogCancel>
                              <AlertDialogAction onClick={() => cancelRequest(r)}>Cancel link</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    ) : null}
                  </div>
                )} />
            );
          }) : <Empty art={dq ? undefined : 'receipt'}>{dq ? 'No links match.' : 'No custom links yet. Use New link.'}</Empty>}
        </Section>
      ) : (

      <Section title="Pay links" icon={Link2} count={rows.length} testId="paylinks-list">
        {rows.length ? rows.map(r => {
          const st = STAGE[r.stage] || STAGE.created;
          const wa = whatsappLink(r.channel, r.handle);
          const detail = r.productName.split(' ')[0] + ' · ref ' + r.subCode + (r.method ? ' · ' + METHOD[r.method] + (r.payer ? ' from ' + r.payer : '') : '') + (r.claimTrx ? ' · TrxID ' + r.claimTrx : '');
          return (
            <Row key={r.saleId} wrap stack data-testid={'paylink-' + r.subCode} lead={<Avatar name={r.name} />}
              title={<button type="button" className="max-w-full truncate text-left hover:underline" onClick={() => open.customer(r.customerId)}>{r.name}</button>}
              detail={detail}
              trail={(
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  <span className="money mr-1 text-sm font-semibold">{tk(r.owes || r.price)}</span>
                  <Pill tone={st.tone}>{st.text}</Pill>
                  {r.token ? (
                    <>
                      <Button type="button" size="sm" variant="outline" aria-label={'Copy link for ' + r.name} onClick={() => copy(r)}><Link2 />Copy</Button>
                      {wa ? (
                        <Button asChild size="sm" variant="outline"><a href={wa + '?text=' + encodeURIComponent(shareText(lang, r.name, r.productName, urlOf(r)))} target="_blank" rel="noopener" aria-label={'Send the link to ' + r.name + ' on WhatsApp'}><MessageCircle />Send</a></Button>
                      ) : null}
                      <Button asChild size="icon-sm" variant="ghost"><a href={urlOf(r)} target="_blank" rel="noopener" aria-label={'Open the pay page for ' + r.name}><ExternalLink /></a></Button>
                    </>
                  ) : null}
                  {r.stage === 'claimed' || r.stage === 'received' ? (
                    <Button type="button" size="sm" aria-label={'Got paid for ' + r.name} onClick={() => open.pay({ customerId: r.customerId, saleId: r.saleId, amount: r.owes || r.price, trx: r.claimTrx, method: r.method })}><Wallet />Got paid</Button>
                  ) : null}
                </div>
              )} />
          );
        }) : <Empty art={dq || filter !== 'all' ? undefined : 'receipt'}>{dq || filter !== 'all' ? 'No links match.' : 'No active lines yet.'}</Empty>}
      </Section>
      )}
    </div>
  );
}
