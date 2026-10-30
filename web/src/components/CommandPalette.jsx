import { useState } from 'react';
import { Bell, CalendarDays, ChartNoAxesCombined, CircleDollarSign, Database, Hash, History, Home, Inbox, Layers, LayoutGrid, Link2, PackageCheck, Plus, Receipt, RotateCw, Settings, Users, Wallet } from 'lucide-react';
import { tk } from '@/lib/format';
import { MIN_QUERY, recordMatches } from '@/lib/palette';
import { useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Avatar } from '@/components/kit';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';

/** Cmd/Ctrl+K: jump to a screen, start an action, or open a customer, a sub-code or a payment. Three typed characters also search records. */
export function CommandPalette({ open, onOpenChange, onGo }) {
  const { lookups, home, role } = useApp();
  const openers = useOpeners();
  const [q, setQ] = useState('');
  const close = v => { if (!v) setQ(''); onOpenChange(v); };
  const run = fn => () => { close(false); setTimeout(fn, 60); };
  const customers = (lookups && lookups.customers) || [];
  const deep = q.trim().length >= MIN_QUERY;
  const found = recordMatches(q, { customers, lines: (lookups && lookups.lines) || [], unmatched: (home && home.unmatched) || [], autoToCheck: (home && home.autoToCheck) || [] });
  const customerRows = deep ? found.customers : customers.slice(0, 120);

  return (
    <CommandDialog open={open} onOpenChange={close} title="Search" description="Find a customer, jump to a screen or start an action">
      <CommandInput placeholder="Search customers, or type an action" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>{deep ? 'No results for "' + q.trim() + '".' : 'Nothing matches.'}</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem value="new sale add" onSelect={run(() => openers.newSale())}><Plus />New sale</CommandItem>
          <CommandItem value="got paid payment" onSelect={run(() => openers.pay())}><Wallet />Got paid</CommandItem>
          <CommandItem value="new pay link new link request" onSelect={run(() => openers.payRequest())}><Link2 />New pay link</CommandItem>
          <CommandItem value="renew renewal" onSelect={run(() => openers.renew())}><RotateCw />Renew</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem value="go today" onSelect={run(() => onGo('today'))}><Home />Today</CommandItem>
          <CommandItem value="go customers" onSelect={run(() => onGo('customers'))}><Users />Customers</CommandItem>
          <CommandItem value="go accounts logins slots" onSelect={run(() => onGo('accounts'))}><Layers />Accounts</CommandItem>
          <CommandItem value="go delivery deliver keys seats pending" onSelect={run(() => onGo('delivery'))}><PackageCheck />Delivery</CommandItem>
          <CommandItem value="go dues owed" onSelect={run(() => onGo('dues'))}><Wallet />Dues</CommandItem>
          {role !== 'viewer' ? <CommandItem value="go inbox payments messages sms match" onSelect={run(() => onGo('inbox'))}><Inbox />Inbox</CommandItem> : null}
          {role !== 'viewer' ? <CommandItem value="go reminders remind send copy message skip sent queue" onSelect={run(() => onGo('reminders'))}><Bell />Reminders</CommandItem> : null}
          {role !== 'viewer' ? <CommandItem value="go calendar renewals renew expiry expired due month days" onSelect={run(() => onGo('calendar'))}><CalendarDays />Calendar</CommandItem> : null}
          <CommandItem value="go pay links share link generate" onSelect={run(() => onGo('paylinks'))}><Link2 />Pay links</CommandItem>
          <CommandItem value="go money profit book" onSelect={run(() => onGo('money'))}><CircleDollarSign />Money</CommandItem>
          <CommandItem value="go insights charts revenue retention forecast" onSelect={run(() => onGo('insights'))}><ChartNoAxesCombined />Insights</CommandItem>
          <CommandItem value="go activity history undo changes saves audit log" onSelect={run(() => onGo('activity'))}><History />Activity</CommandItem>
          <CommandItem value="go settings preferences bkash templates messages rates pay methods appearance theme" onSelect={run(() => onGo('settings'))}><Settings />Settings</CommandItem>
          {role === 'owner' && lookups && lookups.settings && lookups.settings.migration_panel === 'on' ? <CommandItem value="go data migration import staged rows" onSelect={run(() => onGo('migration'))}><Database />Data migration</CommandItem> : null}
          <CommandItem value="go more" onSelect={run(() => onGo('more'))}><LayoutGrid />More</CommandItem>
        </CommandGroup>
        {customerRows.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Customers">
              {customerRows.map(c => (
                <CommandItem key={c.id} value={'customer ' + c.name + ' ' + (c.handle || '')} onSelect={run(() => openers.customer(c.id))}>
                  <Avatar name={c.name} className="size-7 text-[0.625rem]" />
                  <span className="flex-1 truncate font-bold">{c.name}</span>
                  {c.owes ? <span className="font-mono text-xs text-bad">owes {tk(c.owes)}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        {deep && found.subCodes.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sub-codes">
              {found.subCodes.map(l => (
                <CommandItem key={l.subCode} value={'subcode ' + l.subCode + ' ' + l.name} onSelect={run(() => openers.customer(l.customerId))}>
                  <Hash />
                  <span className="flex-1 truncate font-mono font-bold">{l.subCode}</span>
                  <span className="truncate text-xs text-muted-foreground">{l.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        {deep && found.transactions.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Transactions">
              {found.transactions.map(t => (
                <CommandItem key={t.trx} value={'transaction ' + t.trx} onSelect={run(() => (t.pending ? openers.match(t.trx) : openers.customer(t.customerId)))}>
                  <Receipt />
                  <span className="flex-1 truncate font-mono font-bold">{t.trx}</span>
                  <span className="font-mono text-xs text-muted-foreground">{tk(t.amount)}{t.pending ? ' · to match' : ''}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
