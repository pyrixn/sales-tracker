import { useReducer, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isUnread, markSeen, readSeen, useAttentionItems } from '@/lib/attention';

// The header bell. Its badge is the total of the unread counts; opening the list marks every item on screen as read, so the badge
// clears. Items unread when the list opened keep a "New" tag while it is open. Esc closes it and focus returns to the bell. Picking an
// item moves to its screen and focus goes to the page title.
export function NotificationBell({ onGo }) {
  const items = useAttentionItems();
  const [open, setOpen] = useState(false);
  const [, redraw] = useReducer(n => n + 1, 0);
  const [fresh, setFresh] = useState([]);
  const picked = useRef(null);
  const seen = readSeen();   // read on every render: storage is the one source, so the badge follows a mark made in another tab too
  const unread = items.filter(it => isUnread(seen, it));
  const total = unread.reduce((n, it) => n + it.count, 0);

  function onOpenChange(next) {
    setOpen(next);
    picked.current = null;
    if (next) {
      setFresh(unread.map(it => it.id));
      markSeen(items);
      redraw();
    }
  }

  function choose(it) {
    picked.current = it;   // read by onCloseAutoFocus, which runs after the list has closed
    setOpen(false);
    onGo(it.tab);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="relative" aria-label={total ? 'Notifications, ' + total + ' new' : 'Notifications'}>
          <Bell aria-hidden="true" />
          {total ? (
            <span aria-hidden="true" data-testid="bell-badge" className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-micro leading-none font-bold text-primary-foreground">
              {total > 9 ? '9+' : total}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} aria-label="Notifications" className="w-[min(22rem,calc(100vw-2rem))] p-0"
        onCloseAutoFocus={e => {
          if (!picked.current) return;   // closed with Esc or outside a click: focus goes back to the bell
          e.preventDefault();
          picked.current = null;
          const title = document.getElementById('pageTitle');
          if (title) title.focus({ preventScroll: true });
        }}>
        <p className="eyebrow px-4 pt-3 pb-1">Needs attention</p>
        {items.length ? (
          <ul className="grid pb-2">
            {items.map(it => (
              <li key={it.id}>
                <button type="button" data-testid={'bell-' + it.id} onClick={() => choose(it)}
                  className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left text-sm font-bold transition-colors hover:bg-foreground/[0.05] md:min-h-9">
                  <span className="min-w-0 flex-1">{it.label}</span>
                  {fresh.includes(it.id) || isUnread(seen, it) ? <span className="rounded-full bg-primary/15 px-2 text-micro font-bold text-primary">New</span> : null}
                  <span className="font-mono text-micro text-muted-foreground">{it.count}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 pt-1 pb-4 text-sm text-muted-foreground">Nothing needs attention.</p>}
      </PopoverContent>
    </Popover>
  );
}
