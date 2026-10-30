import { SheetShell } from '@/components/kit';

// The keys the shell really handles (AppShell's keydown handler). Keep this list in step with that handler.
export const SHORTCUTS = [
  ['N', 'New sale'],
  ['P', 'Got paid'],
  ['R', 'Renew a subscription'],
  ['L', 'New pay link'],
  ['/ or Ctrl+K (⌘K)', 'Search customers, screens and actions'],
  ['1 to 9', 'Go to a screen, in sidebar order: Today, Customers, Accounts, Delivery, Dues, Inbox, Reminders, Calendar, Money. Insights, Pay links, Activity, Settings and More have no number.'],
  ['[', 'Collapse or expand the sidebar (wide screens)'],
  ['?', 'Show this list']
];

/** Opened by ? when no field is focused. */
export function ShortcutsSheet() {
  return (
    <SheetShell title="Keyboard shortcuts" description="Used when no field is focused. Typing in a field never triggers them.">
      <dl data-testid="shortcut-list" className="grid gap-2">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <dt><kbd className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-bold">{keys}</kbd></dt>
            <dd className="text-right text-sm text-muted-foreground">{what}</dd>
          </div>
        ))}
      </dl>
    </SheetShell>
  );
}
