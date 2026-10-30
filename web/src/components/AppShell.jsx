import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Bell, CalendarDays, ChartNoAxesCombined, CircleDollarSign, Command as CommandIcon, History, Home, Inbox, Layers, LayoutGrid, Link2, Monitor, Moon, PackageCheck, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, RotateCw, Search, Settings, Sun, Users, Wallet, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fullDate, rateText } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { useApp } from '@/lib/store';
import { usePullToRefresh } from '@/lib/pullToRefresh';
import { useOpeners } from '@/sheets/openers';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CommandPalette } from '@/components/CommandPalette';
import { NotificationBellSlot } from '@/components/NotificationBellSlot';

// The sidebar groups, top to bottom. A new tab is one line in the group it belongs to.
// NAV is the flat list in displayed order: the number keys 1-9 and the phone dock both read it. Only the first nine have a number key.
export const GROUPS = [
  { label: 'Operate', tabs: [
    { tab: 'today', label: 'Today', icon: Home },
    { tab: 'customers', label: 'Customers', icon: Users },
    { tab: 'accounts', label: 'Accounts', icon: Layers },
    { tab: 'delivery', label: 'Delivery', icon: PackageCheck, desktopOnly: true },
    { tab: 'dues', label: 'Dues', icon: Wallet },
    // desktopOnly keeps a tab out of the phone dock (it holds five); the phone reaches these from More.
    { tab: 'inbox', label: 'Inbox', icon: Inbox, desktopOnly: true },
    { tab: 'reminders', label: 'Reminders', icon: Bell, desktopOnly: true },
    { tab: 'calendar', label: 'Calendar', icon: CalendarDays, desktopOnly: true }
  ] },
  { label: 'Money', tabs: [
    { tab: 'money', label: 'Money', icon: CircleDollarSign },
    { tab: 'insights', label: 'Insights', icon: ChartNoAxesCombined, desktopOnly: true },
    { tab: 'paylinks', label: 'Pay links', icon: Link2, desktopOnly: true }
  ] },
  { label: 'System', tabs: [
    // Activity and Settings sit before More. Like the other desktop-only tabs, the phone reaches them from More.
    { tab: 'activity', label: 'Activity', icon: History, desktopOnly: true },
    { tab: 'settings', label: 'Settings', icon: Settings, desktopOnly: true },
    { tab: 'more', label: 'More', icon: LayoutGrid }
  ] }
];
export const NAV = GROUPS.flatMap(g => g.tabs);

// Tabs the server answers to the owner only (src/core/permissions.js): money reports, the change log, settings.
const MONEY_TABS = ['money', 'insights', 'activity', 'settings', 'migration'];
// Tabs the server answers to staff and owner, not to viewers (inbox and reminderLog are STAFF).
const STAFF_TABS = ['inbox', 'reminders', 'calendar'];
const TITLES = { today: 'Today', customers: 'Customers', accounts: 'Accounts', delivery: 'Delivery', dues: 'Dues', inbox: 'Inbox', reminders: 'Reminders', calendar: 'Calendar', paylinks: 'Pay links', money: 'Money', migration: 'Data migration', more: 'More', insights: 'Insights', settings: 'Settings', activity: 'Activity', orders: 'Orders', staff: 'Staff', logins: 'Delivery & logins' };
// The number keys 1 to 9 open the first nine entries of NAV. Compared as numbers: as strings '9' sorts after '10'.
const SHORTCUT_KEYS = 9;

// The collapsed rail is a per-viewer convenience: it is remembered when storage works and the app works without it.
const RAIL_KEY = 'sales_tracker_sidebar';
function readRail() {
  try { return localStorage.getItem(RAIL_KEY) === 'collapsed'; } catch (e) { return false; }
}
function writeRail(collapsed) {
  try { localStorage.setItem(RAIL_KEY, collapsed ? 'collapsed' : 'expanded'); } catch (e) { /* storage unavailable: the rail still works for this visit */ }
}

export function ThemeToggle({ className }) {
  const { theme, setTheme } = useTheme();
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className={className} onClick={() => setTheme(next)} aria-label={'Theme: ' + theme + '. Switch to ' + next}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Theme: {theme}</TooltipContent>
    </Tooltip>
  );
}

function Wordmark({ collapsed }) {
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <span className="page-title text-2xl" aria-hidden="true">L</span>
        <span className="sr-only">Ledger sales</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-1.5 px-1">
      <span className="page-title text-2xl">Ledger</span>
      <span className="eyebrow">sales</span>
    </div>
  );
}

// On the desktop sidebar the active bar is a shared layoutId, so it glides from one item to the next (the dock dot does the same).
// Collapsed, the label is not drawn: the button keeps its name through aria-label and shows its title on hover.
function NavButton({ item, active, onGo, compact, badge, collapsed }) {
  const Icon = item.icon;
  const reduce = useReducedMotion();
  const iconOnly = collapsed && !compact;
  const name = badge ? item.label + ', ' + badge + ' pending' : item.label;
  return (
    <button type="button" aria-current={active ? 'page' : undefined} onClick={() => onGo(item.tab)}
      aria-label={iconOnly ? name : undefined} title={iconOnly ? item.label : undefined}
      className={cn(
        'group relative flex items-center transition-colors',
        compact
          ? 'min-h-14 flex-1 flex-col justify-center gap-1 rounded-xl px-1 text-micro font-bold text-muted-foreground aria-[current=page]:text-primary'
          : cn('h-10 w-full gap-3 rounded-lg px-3 text-sm font-bold text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground aria-[current=page]:bg-foreground/[0.07] aria-[current=page]:text-foreground', iconOnly && 'justify-center px-0')
      )}>
      <Icon className={cn('size-[1.15rem]', compact && 'size-5')} aria-hidden="true" />
      {iconOnly ? null : <span>{item.label}</span>}
      {badge ? <span data-testid={item.tab + '-badge'} className={cn('grid min-w-5 place-items-center rounded-full bg-primary px-1.5 font-mono text-micro font-bold text-primary-foreground', compact ? 'absolute top-1.5 left-1/2 ml-2' : iconOnly ? 'absolute top-1 right-1 min-w-4 px-1' : 'ml-auto mr-6')}>{badge}</span> : null}
      {!compact && active ? <motion.span layoutId="side-bar" transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }} className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}
      {compact && active ? <motion.span layoutId="dock-dot" className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" aria-hidden="true" /> : null}
    </button>
  );
}

// A sidebar quick action. Collapsed, it is its icon with the label as aria-label.
function SideAction({ collapsed, label, hint, icon: Icon, primary, onClick }) {
  return (
    <Button type="button" size={primary ? 'lg' : 'default'} variant={primary ? 'default' : 'outline'}
      aria-label={collapsed ? label : undefined} title={collapsed ? label : undefined} onClick={onClick}
      className={cn('font-bold', primary && 'font-extrabold', collapsed ? 'justify-center px-0' : 'justify-between')}>
      {collapsed ? <Icon aria-hidden="true" /> : (
        <>
          <span className="flex items-center gap-2"><Icon aria-hidden="true" />{label}</span>
          <kbd className="font-mono text-micro opacity-60">{hint}</kbd>
        </>
      )}
    </Button>
  );
}

export function AppShell({ tab, routeKey = tab, onGo, pending, children }) {
  const { today, lookups, reload, offline, role } = useApp();
  // Money reports are owner only (src/core/permissions.js). The tab is hidden for staff and viewers; the server refuses it anyway.
  const canMoney = !role || role === 'owner';
  const canStaff = !role || role !== 'viewer';
  const shown = tab => (!MONEY_TABS.includes(tab) || canMoney) && (!STAFF_TABS.includes(tab) || canStaff);
  const nav = NAV.filter(n => shown(n.tab));
  const open = useOpeners();
  const [palette, setPalette] = useState(false);
  const [spin, setSpin] = useState(false);
  const [collapsed, setCollapsed] = useState(readRail);
  const toggleRail = useCallback(() => setCollapsed(c => !c), []);
  const badges = { delivery: (lookups && lookups.pendingDeliveries) || 0 };
  const titleRef = useRef(null);
  const shownRoute = useRef(routeKey);

  useEffect(() => { writeRail(collapsed); }, [collapsed]);

  // After a route change (a tab, a customer opened from the list, Back), focus moves to the page title so keyboard and screen-reader
  // users start at the top of the new screen. Not on first load, not while the user is typing, not while focus is in the customer
  // workspace list (data-keep-focus: picking a customer there keeps the place in the list), and not while a dialog or sheet is open.
  useEffect(() => {
    if (shownRoute.current === routeKey) return;
    shownRoute.current = routeKey;
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    const inList = a && a.closest && a.closest('[data-keep-focus]');
    if (typing || inList || document.querySelector('[role="dialog"]') || !titleRef.current) return;
    titleRef.current.focus({ preventScroll: true });
  }, [routeKey]);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return; }
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || (t.closest && t.closest('[data-inline-cell]')));
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); open.newSale(); }
      else if (k === 'p') { e.preventDefault(); open.pay(); }
      else if (k === 'r') { e.preventDefault(); open.renew(); }
      else if (k === 'l') { e.preventDefault(); open.payRequest(); }
      else if (k === '/') { e.preventDefault(); setPalette(true); }
      else if (k === '?') { e.preventDefault(); open.shortcuts(); }
      else if (k === '[') { e.preventDefault(); toggleRail(); }
      else if (k >= '1' && k <= '9' && Number(k) <= Math.min(NAV.length, SHORTCUT_KEYS)) {
        const item = NAV[Number(k) - 1];
        if (shown(item.tab)) onGo(item.tab);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onGo, toggleRail, canMoney, canStaff]);

  async function refresh() {
    setSpin(true);
    await reload();
    setSpin(false);
  }
  // A phone pull runs the same refresh as the header button (uplift 5.5). The chip below shows while it runs.
  const pulled = usePullToRefresh(refresh);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[90rem]">
      {pending ? <div data-testid="route-progress" className="route-progress" aria-hidden="true" /> : null}
      <aside className={cn('sticky top-0 hidden h-dvh shrink-0 flex-col gap-3 overflow-y-auto border-r border-border py-4 transition-[width,padding] duration-200 ease-out motion-reduce:transition-none md:flex', collapsed ? 'w-16 px-2' : 'w-60 px-4')}>
        <Wordmark collapsed={collapsed} />
        <nav aria-label="Sections" className="grid gap-2">
          {GROUPS.map(g => ({ ...g, tabs: g.tabs.filter(n => shown(n.tab)) })).filter(g => g.tabs.length).map((g, gi) => (
            <div key={g.label} role="group" aria-label={g.label} className="grid gap-1">
              {collapsed ? (gi > 0 ? <div className="mx-2 mb-1 h-px bg-border" aria-hidden="true" /> : null) : <p className="eyebrow px-3 leading-none">{g.label}</p>}
              {g.tabs.map(n => (
                <div key={n.tab} className="relative">
                  <NavButton item={n} active={tab === n.tab} onGo={onGo} badge={badges[n.tab]} collapsed={collapsed} />
                  {collapsed ? null : <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-micro text-muted-foreground/70">{NAV.indexOf(n) < SHORTCUT_KEYS ? NAV.indexOf(n) + 1 : null}</kbd>}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="grid gap-2">
          <SideAction collapsed={collapsed} label="New sale" hint="N" icon={Plus} primary onClick={() => open.newSale()} />
          <SideAction collapsed={collapsed} label="New pay link" hint="L" icon={Link2} onClick={() => open.payRequest()} />
          <SideAction collapsed={collapsed} label="Got paid" hint="P" icon={Wallet} onClick={() => open.pay()} />
          <SideAction collapsed={collapsed} label="Renew" hint="R" icon={RotateCw} onClick={() => open.renew()} />
        </div>
        <div className="mt-auto grid gap-2">
          <button type="button" onClick={() => setPalette(true)} aria-label={collapsed ? 'Search' : undefined} title={collapsed ? 'Search' : undefined}
            className={cn('flex h-9 items-center gap-2 rounded-lg border border-border text-sm text-muted-foreground transition-colors hover:text-foreground', collapsed ? 'justify-center' : 'px-3')}>
            <Search className="size-4" aria-hidden="true" />
            {collapsed ? null : (
              <>
                <span className="flex-1 text-left">Search</span>
                <kbd className="flex items-center gap-0.5 font-mono text-micro"><CommandIcon className="size-3" aria-hidden="true" />K</kbd>
              </>
            )}
          </button>
          <div className={cn('flex items-center px-1', collapsed ? 'flex-col gap-2' : 'justify-between')}>
            {collapsed ? null : <span id="sbDate" className="eyebrow">{today ? fullDate(today) : ''}</span>}
            <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
              <ThemeToggle />
              <Button type="button" variant="ghost" size="icon-sm" aria-pressed={collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={(collapsed ? 'Expand sidebar' : 'Collapse sidebar') + ' ([)'} onClick={toggleRail}>
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-xl md:px-8">
          <div className="min-w-0 flex-1">
            <h1 id="pageTitle" ref={titleRef} tabIndex={-1} className="page-title truncate text-3xl outline-none md:text-4xl">{TITLES[tab]}</h1>
            <div className="eyebrow mt-1 truncate md:hidden">{today ? fullDate(today) : ''}</div>
          </div>
          {lookups && lookups.rate && lookups.rate.rate ? (
            <span className="hidden font-mono text-xs text-muted-foreground lg:inline" title="USDT rate">{rateText(lookups.rate)}</span>
          ) : null}
          <NotificationBellSlot onGo={onGo} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="hidden md:inline-flex" onClick={refresh} aria-label="Refresh">
                <RefreshCw className={spin ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <Button type="button" variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setPalette(true)} aria-label="Search">
            <Search />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className="md:hidden" onClick={() => onGo('more')} aria-label="More" aria-current={tab === 'more' ? 'page' : undefined}>
            <LayoutGrid />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon-sm" className="md:hidden" aria-label="Quick actions"><Plus /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44" onCloseAutoFocus={e => e.preventDefault()}>
              <DropdownMenuItem className="py-3 text-base font-bold" onSelect={() => open.newSale()}><Plus />New sale</DropdownMenuItem>
              <DropdownMenuItem className="py-3 text-base font-bold" onSelect={() => open.payRequest()}><Link2 />New pay link</DropdownMenuItem>
              <DropdownMenuItem className="py-3 text-base font-bold" onSelect={() => open.pay()}><Wallet />Got paid</DropdownMenuItem>
              <DropdownMenuItem className="py-3 text-base font-bold" onSelect={() => open.renew()}><RotateCw />Renew</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The live region stays in the DOM so the status is announced; the chip is drawn under the header only while a pull refreshes. */}
          <div aria-live="polite" className="pointer-events-none absolute inset-x-0 top-full z-30 flex justify-center">
            {pulled ? (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-bold text-muted-foreground shadow-lg shadow-black/20">
                <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Refreshing
              </span>
            ) : null}
          </div>
        </header>

        <main id="screen" className="flex-1 px-4 pt-5 pb-28 md:px-8 md:pb-12">
          {offline ? (
            <p role="status" data-testid="offline-note" className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs font-semibold text-warn">
              <WifiOff className="size-3.5" aria-hidden="true" />Saved figures, offline
            </p>
          ) : null}
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <nav aria-label="Sections" className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex items-stretch rounded-2xl border border-border bg-popover/85 p-1 shadow-2xl shadow-black/30 backdrop-blur-2xl md:hidden">
        {nav.filter(n => n.tab !== 'more' && !n.desktopOnly).map(n => <NavButton key={n.tab} item={n} active={tab === n.tab} onGo={onGo} compact badge={badges[n.tab]} />)}
      </nav>

      <CommandPalette open={palette} onOpenChange={setPalette} onGo={onGo} />
    </div>
  );
}
