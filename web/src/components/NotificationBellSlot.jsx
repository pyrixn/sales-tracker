import { lazy, Suspense } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { importWithRetry } from '@/lib/lazyScreen';

// The bell's code (the list and the attention counts) is its own chunk, fetched just after the shell paints, so it adds nothing to the
// first-load budget in docs/perf.md. Until it arrives, and if it never does (the loader falls back to the placeholder), the header shows
// the same button with no badge, so a failed chunk cannot take the page down.
function Placeholder() {
  return (
    <Button type="button" variant="ghost" size="icon-sm" disabled aria-label="Notifications">
      <Bell aria-hidden="true" />
    </Button>
  );
}

const NotificationBell = lazy(() => importWithRetry(() => import('@/components/NotificationBell')).then(
  m => ({ default: m.NotificationBell }),
  () => ({ default: Placeholder })
));

export function NotificationBellSlot({ onGo }) {
  return (
    <Suspense fallback={<Placeholder />}>
      <NotificationBell onGo={onGo} />
    </Suspense>
  );
}
