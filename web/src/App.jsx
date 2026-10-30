import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { RefreshCw } from 'lucide-react';
import { AppProvider, SheetsProvider, useApp } from '@/lib/store';
import { NavGuardCtx } from '@/lib/navGuard';
import { AppShell } from '@/components/AppShell';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SignIn } from '@/screens/SignIn';
import { Today } from '@/screens/Today';
import { lazyScreen, ScreenBoundary } from '@/lib/lazyScreen';

// Today and SignIn ship in the first chunk (a warm load paints Today from the cache at once); the rest load on first visit.
const Accounts = lazyScreen(() => import('@/screens/Accounts'), 'Accounts');
const Activity = lazyScreen(() => import('@/screens/Activity'), 'Activity');
const Calendar = lazyScreen(() => import('@/screens/Calendar'), 'Calendar');
const Customers = lazyScreen(() => import('@/screens/Customers'), 'Customers');
const Delivery = lazyScreen(() => import('@/screens/Delivery'), 'Delivery');
const Dues = lazyScreen(() => import('@/screens/Dues'), 'Dues');
const Inbox = lazyScreen(() => import('@/screens/Inbox'), 'Inbox');
const Insights = lazyScreen(() => import('@/screens/Insights'), 'Insights');
const Money = lazyScreen(() => import('@/screens/Money'), 'Money');
const Migration = lazyScreen(() => import('@/screens/Migration'), 'Migration');
const More = lazyScreen(() => import('@/screens/More'), 'More');
const PayLinks = lazyScreen(() => import('@/screens/PayLinks'), 'PayLinks');
const Orders = lazyScreen(() => import('@/screens/Orders'), 'Orders');
const DeliveryLogins = lazyScreen(() => import('@/screens/DeliveryLogins'), 'DeliveryLogins');
const Reminders = lazyScreen(() => import('@/screens/Reminders'), 'Reminders');
const Settings = lazyScreen(() => import('@/screens/Settings'), 'Settings');
const Staff = lazyScreen(() => import('@/screens/Staff'), 'Staff');

const TABS = ['today', 'customers', 'accounts', 'delivery', 'dues', 'inbox', 'reminders', 'calendar', 'paylinks', 'money', 'migration', 'more', 'insights', 'activity', 'settings', 'orders', 'staff', 'logins'];
// staff and orders are reached from More (owner only); they are not in the navigation.
// The screens that load as their own chunk, by tab. Today is in the first chunk and is not here.
const CHUNKS = { accounts: Accounts, activity: Activity, calendar: Calendar, customers: Customers, delivery: Delivery, dues: Dues, inbox: Inbox, reminders: Reminders, paylinks: PayLinks, money: Money, migration: Migration, more: More, insights: Insights, settings: Settings, orders: Orders, staff: Staff, logins: DeliveryLogins };
// The hash is '#/<tab>', '#/customers/<id>' (the customer workspace) or either with a query ('#/insights?from=...'):
// the query never takes part in matching the tab. A route is { tab, id }; id is set only for a customer.
const safeDecode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
function parseRoute(raw) {
  const path = String(raw || '').replace(/^#\/?/, '').split('?')[0];
  const cut = path.indexOf('/');
  const head = cut < 0 ? path : path.slice(0, cut);
  const rest = cut < 0 ? '' : path.slice(cut + 1);
  if (head === 'customers' && rest) return { tab: head, id: safeDecode(rest) };
  if (TABS.includes(head) && (cut < 0 || head === 'customers')) return { tab: head, id: null };
  return { tab: 'today', id: null };
}
// The canonical path of a route, without the '#/': 'dues', 'customers', 'customers/CU-0001'.
const pathOf = r => (r.id === null ? r.tab : r.tab + '/' + encodeURIComponent(r.id));
const hashIs = p => { const h = window.location.hash; return h === '#/' + p || h.startsWith('#/' + p + '?'); };

function Loading() {
  return (
    <div className="mx-auto grid max-w-3xl gap-4 px-4 py-10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-56 w-full rounded-2xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function Shell() {
  const { status, error, reload, role } = useApp();
  const [at, setAt] = useState(() => parseRoute(window.location.hash));   // { tab, id }
  const tab = at.tab;
  const custId = at.id;
  const here = pathOf(at);
  const [pending, setPending] = useState(null);   // the tab whose chunk is still loading: the previous screen stays up meanwhile
  const latest = useRef(0);                       // only the newest route change may commit (a slow chunk never overrides a newer tap)
  // p is a canonical path. push writes a history entry; replace writes it in place (the workspace list swapping customers, no scroll).
  const route = useCallback((p, push, replace) => {
    const r = parseRoute(p);
    const seq = ++latest.current;
    const show = () => {
      if (seq !== latest.current) return;
      setPending(null);
      setAt(r);
      if (push && !replace) window.scrollTo(0, 0);
    };
    if (push && !hashIs(p)) window.history[replace ? 'replaceState' : 'pushState'](null, '', '#/' + p);   // already here: keep the query (the Insights range)
    const chunk = CHUNKS[r.tab];
    if (chunk && !chunk.ready() && status === 'ready') {
      setPending(r.tab);
      chunk.preload().catch(() => {}).then(show);   // a failed chunk still commits: the screen shows its Retry
    } else show();
  }, [status]);
  // A screen with unsaved edits (Settings) reports them through NavGuardCtx. Any move away then waits for the owner's choice:
  // Stay keeps the screen and its edits, Leave goes on. Back and forward are held the same way (the hash is put back first).
  const dirty = useRef(false);
  const [leave, setLeave] = useState(null);   // { run }: the move the owner has asked for and not yet confirmed
  const guard = useMemo(() => ({ setDirty: v => { dirty.current = !!v; } }), []);
  const go = useCallback(p => {
    if (dirty.current && parseRoute(p).tab !== tab) setLeave({ run: () => route(p, true) });
    else route(p, true);
  }, [route, tab]);
  // The customer workspace list: picking a customer swaps the detail and replaces the entry, so Back still returns to the table.
  const swap = useCallback(p => route(p, true, true), [route]);
  useEffect(() => {
    const on = () => {
      const p = pathOf(parseRoute(window.location.hash));
      if (dirty.current && parseRoute(p).tab !== tab) {
        window.history.pushState(null, '', '#/' + here);
        setLeave({ run: () => route(p, true) });
        return;
      }
      route(p, false);
    };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, [route, tab, here]);
  const leaveNow = () => {
    if (!leave) return;
    const run = leave.run;
    dirty.current = false;
    setLeave(null);
    run();
  };

  if (status === 'auth') return <SignIn />;
  if (status === 'loading') return <Loading />;
  if (status === 'error') {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-bad/40 bg-card/80 p-6">
          <div className="eyebrow">Could not load</div>
          <p role="alert" className="mt-3 text-sm font-semibold text-bad">{error}</p>
          <Button id="retry" type="button" className="mt-5 font-bold" onClick={reload}><RefreshCw />Try again</Button>
        </div>
      </div>
    );
  }

  const isOwner = !role || role === 'owner';
  const canStaff = !role || role !== 'viewer';
  return (
    <NavGuardCtx.Provider value={guard}>
      <AppShell tab={tab} routeKey={here} onGo={go} pending={pending}>
        {tab === 'today' ? <ScreenBoundary tab="today"><Today onGo={go} /></ScreenBoundary>
          : tab === 'customers' ? <Customers id={custId} onGo={go} onSwap={swap} />
            : tab === 'accounts' ? <Accounts />
              : tab === 'delivery' ? <Delivery />
                : tab === 'dues' ? <Dues />
                  : tab === 'paylinks' ? <PayLinks />
                    : tab === 'inbox' && canStaff ? <Inbox />
                      : tab === 'reminders' && canStaff ? <Reminders />
                        : tab === 'calendar' && canStaff ? <Calendar />
                        : tab === 'orders' && isOwner ? <Orders />
                          : tab === 'money' && isOwner ? <Money />
                      : tab === 'migration' && isOwner ? <Migration />
                            : tab === 'insights' && isOwner ? <Insights />
                            : tab === 'activity' && isOwner ? <Activity />
                              : tab === 'settings' && isOwner ? <Settings />
                                : tab === 'staff' && isOwner ? <Staff />
                                : tab === 'logins' && role !== 'viewer' ? <DeliveryLogins />
                              : <More onGo={go} />}
      </AppShell>
      <AlertDialog open={!!leave} onOpenChange={o => { if (!o) setLeave(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>Some changes on this screen are not saved yet. Leaving now loses them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={leaveNow}>Leave without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NavGuardCtx.Provider>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={250}>
        <AppProvider>
          <SheetsProvider>
            <Shell />
          </SheetsProvider>
        </AppProvider>
        <Toaster position="top-center" />
      </TooltipProvider>
    </MotionConfig>
  );
}
