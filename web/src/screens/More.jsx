import { Bell, Box, CalendarDays, ChartNoAxesCombined, CreditCard, Database, Download, Gamepad2, History, Inbox, KeyRound, Layers, Link2, Lock, LogOut, PackageCheck, Repeat, Settings, ShoppingBag, Tag, Truck, Undo2, Users, Wallet, Webhook } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { rateText } from '@/lib/format';
import { notify, useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Chevron, ErrorBox, Row, Section } from '@/components/kit';
import { ThemeToggle } from '@/components/AppShell';
import { NotificationsCard } from '@/screens/NotificationsCard';
import { useRead } from '@/lib/useRead';

const JOB_LABELS = { 'match-sweep': 'Auto-match sweep', rate: 'USDT rate', backup: 'Backup', cleanup: 'Cleanup', 'relay-check': 'Relay check', webhooks: 'Webhook sender', notify: 'Notification sender' };

// A stored ISO time as Dhaka wall time, short form. Empty for a missing or bad value.
function dhakaShort(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  try {
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return ''; }
}

// The scheduled jobs: the last run of each, and the relay's silence flag. A failed job, or a relay with no signal, reads in warn.
function JobsCard() {
  const { data, error } = useRead('jobs');
  if (!data) return error ? <Section title="Jobs" testId="jobs-card"><div className="px-4 py-3"><ErrorBox>Could not load jobs.</ErrorBox></div></Section> : null;
  const warn = (text) => <span className="font-semibold text-warn">{text}</span>;
  const rows = data.jobs.map(j => {
    const r = j.lastRun;
    let detail = 'Not run yet';
    if (r && j.failed) detail = warn('Failed ' + dhakaShort(r.startedAt) + ': ' + r.detail);
    else if (r) detail = 'Last run ' + dhakaShort(r.startedAt) + ' · ' + r.detail;
    return { job: j.job, title: JOB_LABELS[j.job] || j.job, detail };
  });
  const relay = data.relay || {};
  const relayDetail = relay.alert
    ? warn('No SMS or heartbeat for ' + (relay.hours || 6) + ' h')
    : relay.heartbeat ? 'Last heartbeat ' + dhakaShort(relay.heartbeat) : 'No heartbeat yet';
  return (
    <Section title="Jobs" testId="jobs-card">
      {rows.map(x => <Row key={x.job} data-job={x.job} title={x.title} detail={x.detail} wrap />)}
      <Row data-job="relay" title="Relay phone" detail={relayDetail} wrap />
    </Section>
  );
}

function MoreRow({ k, icon: Icon, title, sub, onClick }) {
  return (
    <Row data-more={k} onClick={onClick} title={title} detail={sub} wrap
      lead={<span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-foreground/[0.04]"><Icon className="size-4" /></span>}
      trail={<Chevron />} />
  );
}

export function More({ onGo }) {
  const { lookups: L, home, reload, signOut, role } = useApp();
  // Owner only in the server (src/core/permissions.js). Hidden here so staff and viewers see only what they can use.
  const owner = role === 'owner';
  const open = useOpeners();
  const stock = L.products.filter(p => p.deliversAs === 'code').map(p => p.name + ': ' + L.codes.filter(c => c.productId === p.id).length).join(' · ');
  const free = L.accounts.reduce((a, x) => a + Math.max(0, x.free), 0);

  async function undo() {
    const r = await call('undo', { requestId: rid() });
    notify(r.ok ? r.data.message : r.error);
    if (r.ok) reload();
  }
  async function exportAll() {
    notify('Exporting…');
    const r = await call('export', { requestId: rid() });
    if (!r.ok) return notify(r.error);
    notify('Exported to Drive');
    window.open(r.data.url, '_blank', 'noopener');
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Section title="Catalog and stock">
        {owner ? <MoreRow k="suppliers" icon={Truck} title="Suppliers & markups" sub={(L.suppliers ? L.suppliers.length : 0) + ' suppliers configured'} onClick={() => open.suppliers()} /> : null}
        {owner ? <MoreRow k="batches" icon={Tag} title="Gift cards & batches" sub={stock || 'On-demand placeholders & codes'} onClick={() => open.batches()} /> : null}
        {owner ? <MoreRow k="newProduct" icon={Box} title="New subscription / code product" sub="Adds a product to the catalog" onClick={() => open.product()} /> : null}
        <MoreRow k="accounts" icon={Layers} title="Accounts" sub={L.accounts.length + ' accounts · ' + free + ' free slots'} onClick={() => open.accounts()} />
        {owner ? <MoreRow k="codes" icon={Gamepad2} title="Game codes" sub={stock || 'No code products'} onClick={() => open.codes()} /> : null}
      </Section>
      <Section title="Money">
        {owner ? <MoreRow k="insights" icon={ChartNoAxesCombined} title="Insights" sub="Revenue, profit, renewals and retention over a date range" onClick={() => onGo('insights')} /> : null}
        {role !== 'viewer' ? <MoreRow k="inbox" icon={Inbox} title="Inbox" sub={(home && home.attention.payments ? home.attention.payments + ' to match' : 'Nothing to match') + ' · every payment message'} onClick={() => onGo('inbox')}  /> : null}
        {role !== 'viewer' ? <MoreRow k="reminders" icon={Bell} title="Reminders" sub={(home && home.reminders.length ? home.reminders.length + ' to send' : 'Nothing to send') + ' · sent and skipped'} onClick={() => onGo('reminders')}  /> : null}
        {role !== 'viewer' ? <MoreRow k="calendar" icon={CalendarDays} title="Calendar" sub="Renewals by day, and lines that expired unpaid" onClick={() => onGo('calendar')}  /> : null}
        <MoreRow k="newlink" icon={Link2} title="New pay link" sub="Type an amount, share the link" onClick={() => open.payRequest()} />
        <MoreRow k="delivery" icon={PackageCheck} title="Delivery" sub={(L.pendingDeliveries ? L.pendingDeliveries + ' pending' : 'Nothing pending') + ' · keys and seats after payment'} onClick={() => onGo('delivery')} />
        <MoreRow k="paylinks" icon={Link2} title="Pay links" sub="Generate and share pay links, set how customers pay" onClick={() => onGo('paylinks')} />
        {role !== 'viewer' ? <MoreRow k="logins" icon={Lock} title="Delivery & logins" sub="Encrypted login details and delivery message templates" onClick={() => onGo('logins')} /> : null}
        {owner ? <MoreRow k="orders" icon={ShoppingBag} title="Orders" sub="Customer orders: pay link, then the sale when you fulfil" onClick={() => onGo('orders')} /> : null}
        {owner ? <MoreRow k="calc" icon={Repeat} title="Bybit USDT calculator" sub={rateText(L.rate)} onClick={() => open.calculator()} /> : null}
        {owner ? <MoreRow k="wallets" icon={CreditCard} title="Wallets" sub="Cards and bKash numbers you pay with" onClick={() => open.wallets()} /> : null}
        {owner ? <MoreRow k="export" icon={Download} title="Export all data" sub="CSV files in a Drive folder" onClick={exportAll} /> : null}
      </Section>
      <Section title="Website">
        <MoreRow k="apikeys" icon={KeyRound} title="API keys" sub="Keys for your website and other integrations" onClick={() => open.apiKeys()} />
        <MoreRow k="webhooks" icon={Webhook} title="Webhooks" sub="Signed messages for orders, payments and renewals" onClick={() => open.webhooks()} />
      </Section>
      <NotificationsCard />
      <Section title="Panel">
        {owner ? <MoreRow k="staff" icon={Users} title="Staff" sub="Invite staff and set what they can do" onClick={() => onGo('staff')} /> : null}
        {owner ? <MoreRow k="activity" icon={History} title="Activity" sub="Every save, newest first, with Undo for the last one" onClick={() => onGo('activity')} /> : null}
        {owner ? <MoreRow k="settings" icon={Settings} title="Settings" sub="Business, reminders, messages, pay methods, rates" onClick={() => onGo('settings')} /> : null}
        {owner && L.settings && L.settings.migration_panel === 'on' ? <MoreRow k="migration" icon={Database} title="Data migration" sub="Review and apply rows staged from the old sheet" onClick={() => onGo('migration')} /> : null}
        {owner ? <MoreRow k="undo" icon={Undo2} title="Undo last action" sub="Reverses your last save" onClick={undo} /> : null}
        <Row title="Theme" detail="System, light or dark"
          lead={<span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-foreground/[0.04]"><Wallet className="size-4" /></span>}
          trail={<ThemeToggle />} />
        <MoreRow k="signout" icon={LogOut} title="Sign out" sub="Forget the password on this device" onClick={signOut} />
      </Section>
      <JobsCard />
      <p className="px-1 text-center font-mono text-micro text-muted-foreground">Shortcuts: N new sale · P got paid · R renew · L new link · / or ⌘K search · 1–9 screens</p>
    </div>
  );
}
