import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, X } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { ErrorBox } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportButton } from './ExportButton';
import { WIDGET_META, WIDGET_VIEWS } from './widgets';

const SAVE_DELAY = 400;

/** Per-card menu: move up, move down, remove. Keyboard operable (Radix menu). */
function WidgetMenu({ id, title, index, count, onMove, onRemove, holdFocus }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={'Options for ' + title} data-widget-menu={id}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40" onCloseAutoFocus={e => { if (holdFocus()) e.preventDefault(); }}>
        <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}><ArrowUp />Move up</DropdownMenuItem>
        <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(1)}><ArrowDown />Move down</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={count <= 1} variant="destructive" onSelect={onRemove}><X />Remove{count <= 1 ? <span className="text-xs text-muted-foreground">Keep at least one card</span> : null}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Overview() {
  const { lookups } = useApp();
  const open = useOpeners();
  const [month, setMonth] = useState('');
  const [tries, setTries] = useState(0);
  const [st, setSt] = useState({ loading: true, error: '', data: null });
  // The card order being edited. null = show what the server sent. Saves are debounced to the last change.
  const [draft, setDraft] = useState(null);
  const [layoutError, setLayoutError] = useState('');
  const timer = useRef(null);
  const latest = useRef(null);
  const seq = useRef(0);
  const [announce, setAnnounce] = useState('');
  const focusNext = useRef(null);

  const send = useCallback(() => {
    timer.current = null;
    const widgets = latest.current;
    if (!widgets) return;
    const n = ++seq.current;
    call('saveLayout', { widgets, requestId: rid() }).then(r => {
      if (n !== seq.current) return;
      if (r.ok) {
        setSt(s => (s.data ? { ...s, data: { ...s.data, layout: (r.data && r.data.widgets) || widgets } } : s));
        if (!timer.current) { latest.current = null; setDraft(null); }
      } else {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        latest.current = null;
        setDraft(null);
        setLayoutError(r.error || 'Could not save the layout.');
      }
    });
  }, []);
  const changeLayout = useCallback(next => {
    latest.current = next;
    setDraft(next);
    setLayoutError('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(send, SAVE_DELAY);
  }, [send]);
  // Leaving the screen inside the delay still saves the last change.
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); send(); } }, [send]);

  // After a card is removed its menu is gone: send focus to the neighbour's menu, or the + tile.
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const el = (target && document.querySelector('[data-widget-menu="' + target + '"]')) || document.getElementById('addWidget');
    if (el) el.focus();
  }, [draft]);

  useEffect(() => {
    let live = true;
    setSt(s => ({ ...s, loading: true, error: '' }));
    call('moneyOverview', month ? { month } : {}).then(r => {
      if (!live) return;
      setSt(s => (r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error, data: s.data }));
    });
    return () => { live = false; };
  }, [month, lookups, tries]);

  const { loading, error, data: o } = st;
  if (!o) {
    if (error) {
      return (
        <div className="grid gap-3">
          <ErrorBox>{error}</ErrorBox>
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setTries(n => n + 1)}>Retry</Button>
        </div>
      );
    }
    return <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-64 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  const sizes = {}, titles = {};
  (o.widgets || []).forEach(w => { sizes[w.id] = w.size; titles[w.id] = w.title; });
  const shown = [...new Set(draft || o.layout || [])].filter(id => WIDGET_VIEWS[id]);
  const available = (o.widgets || []).filter(w => WIDGET_VIEWS[w.id] && !shown.includes(w.id))
    .map(w => ({ id: w.id, title: w.title, description: (WIDGET_META[w.id] || {}).description || '', icon: (WIDGET_META[w.id] || {}).icon }));
  const move = (id, by) => {
    const i = shown.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= shown.length) return;
    const next = shown.slice();
    next[i] = shown[j]; next[j] = id;
    changeLayout(next);
    setAnnounce((titles[id] || id) + ' moved to position ' + (j + 1) + ' of ' + shown.length);
  };
  const remove = id => {
    if (shown.length <= 1) return;
    const i = shown.indexOf(id), rest = shown.filter(x => x !== id);
    focusNext.current = rest[i] || rest[i - 1] || '';
    changeLayout(rest);
    setAnnounce((titles[id] || id) + ' removed');
  };
  const add = id => {
    changeLayout(shown.concat(id));
    setAnnounce((titles[id] || id) + ' added');
    if (id === 'goals' && !(o.goals || []).length) open.goal();
    if (id === 'budgets' && !(o.budgets || []).length) open.budget();
  };
  // The select and the export follow the data actually shown: after a failed month change the old figures stay, so the old month stays.
  const current = o.month;
  const months = o.months && o.months.length ? o.months : [o.month];
  const options = months.includes(current) ? months : [current].concat(months);
  const showRateWarning = o.rateMissing && (shown.includes('products') || shown.includes('accounts'));

  return (
    <div className="grid gap-4" aria-busy={loading}>
      <div className="flex items-end gap-3 md:w-80">
        <div className="grid min-w-0 flex-1 gap-1.5">
          <label htmlFor="overviewMonth" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Month</label>
          <NativeSelect id="overviewMonth" className="h-11" value={current} onChange={e => setMonth(e.target.value)}>
            {options.map(m => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <ExportButton tab="overview" month={current} />
      </div>
      {error ? (
        <div className="grid gap-3">
          <ErrorBox>{error}</ErrorBox>
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setTries(n => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {showRateWarning ? <ErrorBox testId="rate-missing">Rate missing: USDT costs count as 0, so profit is incomplete. Set a manual rate in Settings.</ErrorBox> : null}
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      {layoutError ? <ErrorBox testId="layout-error">{layoutError}</ErrorBox> : null}
      <div className={cn('grid gap-4 transition-opacity md:grid-cols-2 md:items-start', loading && 'opacity-60')}>
        {shown.map((id, i) => {
          const View = WIDGET_VIEWS[id];
          const menu = <WidgetMenu id={id} holdFocus={() => focusNext.current !== null} title={titles[id] || id} index={i} count={shown.length} onMove={by => move(id, by)} onRemove={() => remove(id)} />;
          return (
            <div key={id} data-testid={'widget-' + id} className={cn('min-w-0', sizes[id] === 'lg' && 'md:col-span-2')}>
              <View o={o} action={menu} />
            </div>
          );
        })}
        <Button id="addWidget" type="button" variant="outline" aria-label="Add widget" className="h-20 border-dashed text-muted-foreground md:col-span-2"
          onClick={() => open.addWidget(available, add)}><Plus />Add widget</Button>
      </div>
    </div>
  );
}
