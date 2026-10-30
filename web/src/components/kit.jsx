import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { daysTone, hue, initials, tk } from '@/lib/format';
import { buildTree } from '@/lib/tree';
import { useApp, useSaver, useSheetClose, useSheets } from '@/lib/store';
import { previewTemplate, TEMPLATE_MAX, TEMPLATE_VARS } from '@/lib/reminders';
import { EmptyArt } from '@/components/EmptyArt';
import { Textarea } from '@/components/ui/textarea';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';

export function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Slide-over panel: a bottom sheet on phones, a right-hand panel on wider screens. */
// A click on a toast (Undo, say) is not a click outside the sheet: the sheet stays open.
const keepForToast = e => { const t = e.target; if (t && t.closest && t.closest('[data-sonner-toaster]')) e.preventDefault(); };

export function SheetShell({ title, description, children, footer }) {
  const close = useSheetClose();
  const { depth } = useSheets();
  const wide = useMedia('(min-width: 768px)');
  return (
    <Sheet open onOpenChange={o => { if (!o) close(); }}>
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        onEscapeKeyDown={e => { const a = document.activeElement; if (a && ((a.getAttribute('role') === 'combobox' && a.getAttribute('aria-expanded') === 'true') || a.closest('[data-inline-editing="true"]'))) e.preventDefault(); }}
        onPointerDownOutside={keepForToast}
        onInteractOutside={keepForToast}
        showCloseButton={false}
        aria-label={title}
        className={cn(
          'gap-0 border-border bg-background p-0',
          wide ? 'w-full sm:max-w-[30rem]' : 'max-h-[92dvh] rounded-t-2xl border-x-0'
        )}
      >
        <SheetHeader className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <Button type="button" variant="ghost" size="icon-sm" onClick={close} aria-label={depth > 1 ? 'Back' : 'Close'}>
            <ChevronLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <SheetTitle className="page-title truncate text-xl">{title}</SheetTitle>
            <SheetDescription className="sr-only">{description || title}</SheetDescription>
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-6 [scrollbar-width:thin]">{children}</div>
        {footer ? <div className="border-t border-border bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

export function Avatar({ name, className, children }) {
  const tints = [
    'bg-lime/15 text-lime',
    'bg-warn/15 text-warn',
    'bg-bad/15 text-bad',
    'bg-ok/15 text-ok',
    'bg-foreground/10 text-foreground'
  ];
  return (
    <span aria-hidden="true" className={cn('grid size-10 shrink-0 place-items-center rounded-full font-mono text-xs font-bold', tints[hue(name)], className)}>
      {children || initials(name)}
    </span>
  );
}

const PILL = {
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/14 text-warn',
  bad: 'bg-bad/14 text-bad',
  muted: 'bg-foreground/8 text-muted-foreground'
};
export function Pill({ tone = 'muted', children, className }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-micro leading-none font-semibold whitespace-nowrap', PILL[tone], className)}>
      {children}
    </span>
  );
}
export function DaysPill({ days }) {
  const t = daysTone(days);
  return <Pill tone={t.tone}>{t.text}</Pill>;
}

/** Bordered group with a heading, a count badge and an optional action. */
export function Section({ title, icon: Icon, count, action, children, className, testId }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-border bg-card/80 backdrop-blur-sm', className)}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
        <h2 className="flex-1 text-sm font-extrabold tracking-tight">{title}</h2>
        {count !== undefined && count !== null ? <span className="font-mono text-xs text-muted-foreground">{count}</span> : null}
        {action}
      </header>
      <div data-testid={testId} className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** One list row: leading visual, name over detail, trailing content. Tappable when onClick is set. */
export function Row({ lead, title, detail, trail, onClick, className, wrap, stack, testId, tabIndex, ...rest }) {
  const body = (
    <>
      {lead}
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-bold">{title}</div>
        {detail ? <div className={cn('text-xs text-muted-foreground', wrap ? 'break-words' : 'truncate')}>{detail}</div> : null}
      </div>
      {stack && trail ? <div className="w-full sm:w-auto">{trail}</div> : trail}
    </>
  );
  // md and up multiply the height and padding by --density (1, or 0.82 when compact; index.css). Phones keep min-h-16 (64px).
  const base = cn('flex min-h-16 md:min-h-[calc(4rem*var(--density))] w-full items-center gap-3 px-4 py-3 md:py-[calc(0.75rem*var(--density))]', stack && 'flex-wrap sm:flex-nowrap');
  if (onClick) {
    return (
      <div role="button" tabIndex={tabIndex ?? 0} data-testid={testId} onClick={onClick} {...rest}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
        className={cn(base, 'cursor-pointer transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.07]', className)}>
        {body}
      </div>
    );
  }
  return <div data-testid={testId} className={cn(base, className)} {...rest}>{body}</div>;
}

export function Chevron() { return <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />; }

/** Empty list message. `art` is an EmptyArt name drawn above the text; `action` is an optional node below it. */
export function Empty({ children, art, action }) {
  if (!art && !action) return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
  return (
    <div className="grid justify-items-center gap-3 px-4 py-8 text-center text-sm text-muted-foreground">
      {art ? <EmptyArt name={art} /> : null}
      <div>{children}</div>
      {action}
    </div>
  );
}

export function ErrorBox({ children, testId }) {
  if (!children) return null;
  return <div role="alert" data-testid={testId} className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2.5 text-sm font-semibold text-bad">{children}</div>;
}

export function NoteBox({ children, testId }) {
  return <div data-testid={testId} className="rounded-lg border border-border bg-foreground/[0.04] px-3 py-2.5 font-mono text-xs leading-relaxed">{children}</div>;
}

/** A heads-up that is not an error: warn colour plus the words, so colour is never the only signal. */
export function WarnBox({ children, testId }) {
  return <div role="note" data-testid={testId} className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm font-bold text-warn">{children}</div>;
}

export function Hint({ children, className, id }) {
  return <p id={id} className={cn('text-xs leading-relaxed text-muted-foreground', className)}>{children}</p>;
}

/** Label over a control. `id` joins them so getByLabel and screen readers find the input. */
export function Field({ label, id, children, className, hint }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label ? <Label htmlFor={id} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">{label}</Label> : null}
      {children}
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
export function Two({ children }) { return <div className="grid grid-cols-2 gap-3">{children}</div>; }
export function Stack({ children, className }) { return <div className={cn('grid gap-4', className)}>{children}</div>; }

export function SaveButton({ busy, children, onClick, id = 'save', variant, disabled }) {
  return (
    <div className="grid gap-2">
      <Button id={id} type="button" size="lg" variant={variant} onClick={onClick} disabled={busy || disabled} className="w-full font-extrabold">
        {busy ? <Spinner /> : null}{children}
      </Button>
    </div>
  );
}

/**
 * A button that asks first. onConfirm runs only after the owner taps the confirm button in the dialog.
 * The trigger button takes an id.
 */
export function ConfirmButton({ id, label, icon: Icon, title, description, confirmLabel, onConfirm, variant = 'outline', className, disabled }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button id={id} type="button" variant={variant} disabled={disabled} className={cn('font-bold', className)}>{Icon ? <Icon /> : null}{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Stepper({ value, onChange, min = 1, max = 12, id }) {
  const n = Math.max(min, Math.min(max, Number(value) || min));
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="icon" onClick={() => onChange(String(Math.max(min, n - 1)))} aria-label="Fewer">−</Button>
      <Input id={id} inputMode="numeric" value={value} onChange={e => onChange(e.target.value)} className="text-center font-mono" />
      <Button type="button" variant="outline" size="icon" onClick={() => onChange(String(Math.min(max, n + 1)))} aria-label="More">+</Button>
    </div>
  );
}

export function Chip({ pressed, children, onClick, testId, className, ...rest }) {
  return (
    <button type="button" data-testid={testId} aria-pressed={pressed} onClick={onClick} {...rest}
      className={cn(
        'rounded-full border border-border px-3.5 py-2 text-sm font-bold transition-colors',
        'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground',
        'hover:bg-foreground/[0.06] aria-pressed:hover:bg-primary',
        className
      )}>
      {children}
    </button>
  );
}


// ── Collapsible product tree ──────────────────────────────────────────
function readCollapsed(key) {
  try {
    const raw = window.localStorage.getItem('tree:' + key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function writeCollapsed(key, set) {
  try { window.localStorage.setItem('tree:' + key, JSON.stringify(Array.from(set))); } catch { /* storage unavailable: the tree still works */ }
}

/** Set of closed group keys, remembered under localStorage "tree:<key>". Returns [closedSet, toggle(groupKey)]. */
export function useCollapsed(key) {
  const [closed, setClosed] = useState(() => readCollapsed(key));
  function toggle(k) {
    const next = new Set(closed);
    if (next.has(k)) next.delete(k); else next.add(k);
    writeCollapsed(key, next);
    setClosed(next);
  }
  return [closed, toggle];
}

/**
 * Category > Product > Variant list. Groups start open; what the owner closes is remembered under
 * localStorage "tree:<collapsedKey>". A product is chosen with its own button (aria-pressed); a product
 * with variants has a second toggle button (aria-expanded). `selected` is a product id.
 * renderMeta(product) adds trailing content to a row (optional).
 */
export function ProductTree({ products, selected, onSelect, collapsedKey = 'products', renderMeta, renderBody }) {
  const tree = useMemo(() => buildTree(products), [products]);
  const [closed, toggle] = useCollapsed(collapsedKey);
  const pick = p => (!onSelect ? <span className="min-w-0 flex-1 truncate px-1 text-sm font-bold">{p.name}</span> : (
    <button type="button" aria-pressed={selected === p.id} onClick={() => onSelect(p.id)}
      className={cn('min-w-0 flex-1 truncate rounded-full border border-border px-3.5 py-2 text-left text-sm font-bold transition-colors',
        'hover:bg-foreground/[0.06] aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary')}>
      {p.name}
    </button>
  ));
  return (
    <ul data-testid="product-tree" className="grid gap-3">
      {tree.map(g => {
        const ck = 'c:' + g.category;
        const open = !closed.has(ck);
        const label = g.category || 'Other';
        return (
          <li key={ck} className="grid gap-1.5">
            <button type="button" aria-expanded={open} onClick={() => toggle(ck)}
              className="flex min-h-9 items-center gap-1.5 rounded-md text-left text-xs font-bold tracking-wide text-muted-foreground uppercase hover:text-foreground">
              {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
              <span className="flex-1 truncate">{label}</span>
              <span className="font-mono">{g.products.length}</span>
            </button>
            {open ? (
              <ul className="grid gap-1.5 pl-2">
                {g.products.map(({ product: p, variants }) => {
                  const pk = 'p:' + p.id;
                  const vOpen = !closed.has(pk);
                  return (
                    <li key={p.id} className="grid gap-1.5">
                      <div className="flex items-center gap-1.5">
                        {pick(p)}
                        {renderMeta ? renderMeta(p) : null}
                        {variants.length ? (
                          <Button type="button" variant="ghost" size="icon-sm" aria-expanded={vOpen} aria-label={(vOpen ? 'Hide' : 'Show') + ' variants of ' + p.name} onClick={() => toggle(pk)}>
                            {vOpen ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        ) : null}
                      </div>
                      {renderBody ? renderBody(p) : null}
                      {variants.length && vOpen ? (
                        <ul className="grid gap-1.5 border-l border-border pl-3">
                          {variants.map(v => (
                            <li key={v.id} className="grid gap-1.5">
                              <div className="flex items-center gap-1.5">{pick(v)}{renderMeta ? renderMeta(v) : null}</div>
                              {renderBody ? renderBody(v) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ── Customer combobox ─────────────────────────────────────────────────
const RECENT_KEY = 'recentCustomers';
function readRecent() {
  try { const a = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function rememberRecent(id) {
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify([id].concat(readRecent().filter(x => x !== id)).slice(0, 5))); } catch { /* storage unavailable */ }
}

/**
 * Type-ahead customer field. Filters lookups.customers locally (no API call per keystroke).
 * value: a customer, {id:'', name, isNew:true}, or null. onChange(customer | {id:'',name,isNew:true} | null).
 * suggestions: [{customerId, name, why}] from the server, shown first; onQuery(text) is called debounced (250ms) when given.
 * The input is #cp (label "Customer"); options are role=option.
 */
export function CustomerCombobox({ value, onChange, suggestions, onQuery, allowNew, id = 'cp', label = 'Customer', placeholder = 'Type a name', exclude }) {
  const { lookups } = useApp();
  const customers = lookups.customers || [];
  const uid = useId();
  const listId = uid + '-list';
  const [q, setQ] = useState(value && value.name ? value.name : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const valueName = value ? value.name : undefined;

  useEffect(() => { if (valueName !== undefined) setQ(valueName); }, [valueName]);

  useEffect(() => {
    if (!onQuery) return undefined;
    const t = setTimeout(() => onQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q, onQuery]);

  const query = q.trim().toLowerCase();
  const options = useMemo(() => {
    if (value) return [];
    const out = [];
    const seen = new Set();
    // exclude: a customer that must not be offered (the merge source), whatever the list would otherwise show.
    const add = (c, why) => { if (c && c.id !== exclude && !seen.has(c.id)) { seen.add(c.id); out.push({ kind: 'customer', c, why }); } };
    (suggestions || []).forEach(s => add(customers.find(c => c.id === s.customerId), s.why));
    if (query) customers.filter(c => c.name.toLowerCase().indexOf(query) >= 0 || (c.handle || '').toLowerCase().indexOf(query) >= 0).forEach(c => add(c));
    else {
      const rec = readRecent().map(x => customers.find(c => c.id === x)).filter(Boolean);
      (rec.length ? rec : customers.slice(0, 5)).forEach(c => add(c));
    }
    const list = out.slice(0, 8);
    if (allowNew && query && !customers.some(c => c.name.toLowerCase() === query)) list.push({ kind: 'new', name: q.trim() });
    return list;
  }, [value, suggestions, customers, query, q, allowNew, exclude]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const el = document.getElementById(uid + '-o' + active);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [active, uid, open]);
  const showList = open && options.length > 0;

  function choose(o) {
    setOpen(false);
    if (o.kind === 'new') { onChange({ id: '', name: o.name, isNew: true }); return; }
    rememberRecent(o.c.id);
    setQ(o.c.name);
    onChange(o.c);
  }
  function type(v) {
    setQ(v);
    if (value) onChange(null);
    setOpen(true);
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing && showList && options[active]) { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape' && showList) { e.preventDefault(); setOpen(false); }
  }

  return (
    <Field label={label} id={id}>
      <div className="relative">
        <Input id={id} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
          aria-activedescendant={showList ? uid + '-o' + active : undefined} placeholder={placeholder}
          value={q} onChange={e => type(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
        {showList ? (
          <ul id={listId} role="listbox" aria-label={label} className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1">
            {options.map((o, i) => (
              <li key={o.kind === 'new' ? '__new' : o.c.id} id={uid + '-o' + i} role="option" aria-selected={i === active}
                onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
                className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm', i === active && 'bg-foreground/[0.07]', o.kind === 'new' && 'font-bold text-lime')}>
                {o.kind === 'new' ? (
                  <span className="flex items-center gap-1.5"><Plus className="size-4" aria-hidden="true" />{'Add new customer "' + o.name + '"'}</span>
                ) : (
                  <>
                    <span className="min-w-0"><span className="block truncate font-bold">{o.c.name}</span>{o.why ? <span className="block truncate text-xs font-medium text-muted-foreground">{o.why}</span> : null}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{o.c.owes ? 'owes ' + tk(o.c.owes) : ''}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * Older call shape for CustomerCombobox: onPick(customer), onClear(), onNew(name), and a `preset` customer id.
 * The input is #cp (label "Customer").
 */
export function CustomerPicker({ preset, onPick, onClear, onNew, label = 'Customer', placeholder = 'Type a name', id = 'cp' }) {
  const { lookups } = useApp();
  const [value, setValue] = useState(null);
  const presetDone = useRef(false);
  const customers = lookups.customers || [];
  useEffect(() => {
    if (presetDone.current || !preset) return;
    const c = customers.find(x => x.id === preset);
    if (c) { presetDone.current = true; setValue(c); onPick(c); }
  });
  function change(v) {
    setValue(v);
    if (!v) { if (onClear) onClear(); } else if (v.isNew) { if (onNew) onNew(v.name); } else onPick(v);
  }
  return <CustomerCombobox value={value} onChange={change} allowNew={!!onNew} label={label} placeholder={placeholder} id={id} />;
}

/**
 * Editor for one reminder message template. scope 'global' edits the setting for `kind` and `lang`;
 * scope 'product' edits that product's own template (language-neutral, so `lang` is ignored).
 * Blank text means "use the built-in message", which is also what Reset to default saves.
 * Parents should key it by kind and lang so the text reloads when those change.
 * draft: the text to start from instead of the saved one (a parent that keeps unsaved text across remounts).
 * onDraft(text) is told every change; onDirty(bool) says whether the text differs from what is saved.
 */
export function TemplateEditor({ scope, productId, kind, lang, draft, onDraft, onDirty }) {
  const { lookups: L } = useApp();
  const saved = scope === 'product'
    ? ((L.products.find(p => p.id === productId) || {})[kind === 'due' ? 'tplDue' : 'tplRenew'] || '')
    : (L.settings['msg_' + kind + '_' + lang] || '');
  const defLang = scope === 'product' ? (L.settings.language === 'bn' ? 'bn' : 'en') : lang;
  const builtIn = (L.templateDefaults && L.templateDefaults[kind] && L.templateDefaults[kind][defLang]) || '';
  const [text, setText] = useState(draft !== undefined ? draft : saved);
  const area = useRef(null);
  const caret = useRef(null);
  const blank = useRef(false);
  const { save, busy, error } = useSaver('saveTemplate', () => {
    const t = blank.current ? '' : text;
    blank.current = false;
    if (t.length > TEMPLATE_MAX) throw new Error('A template can be at most ' + TEMPLATE_MAX + ' characters.');
    return scope === 'product' ? { scope, productId, kind, lang: 'en', text: t } : { scope, kind, lang, text: t };
  }, { stay: true, undo: false });
  const dirty = text !== saved;

  useEffect(() => {
    if (caret.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);
  useEffect(() => { if (onDraft) onDraft(text); }, [text]);
  useEffect(() => { if (onDirty) onDirty(dirty); }, [dirty]);

  function insert(v) {
    const el = area.current;
    const a = el ? el.selectionStart : text.length, b = el ? el.selectionEnd : text.length;
    const tok = '{' + v + '}';
    caret.current = a + tok.length;
    setText(text.slice(0, a) + tok + text.slice(b));
  }
  function reset() { blank.current = true; setText(''); save(); }

  const over = text.length > TEMPLATE_MAX;
  const near = text.length >= TEMPLATE_MAX * 0.9;
  return (
    <div className="grid gap-3" data-testid="template-editor">
      <Field label="Message" id="tplText" hint={text.trim() ? '' : 'Blank: the built-in message is used.'}>
        <Textarea id="tplText" ref={area} rows={7} placeholder={builtIn} value={text} onChange={e => setText(e.target.value)} aria-describedby="tplCount" />
      </Field>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Insert a variable">
        {TEMPLATE_VARS.map(v => (
          <Button key={v} type="button" size="sm" variant="outline" className="h-7 rounded-full px-2.5 font-mono text-xs"
            data-var={v} aria-label={'Insert {' + v + '}'} title={'Insert {' + v + '}'}
            onMouseDown={e => e.preventDefault()} onClick={() => insert(v)}>{'{' + v + '}'}</Button>
        ))}
      </div>
      <p id="tplCount" className={cn('money text-xs', over ? 'font-bold text-bad' : near ? 'text-warn' : 'text-muted-foreground')}>{text.length} / {TEMPLATE_MAX}</p>
      <div className="grid gap-1.5">
        <Label className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Sample preview</Label>
        <div id="tplPreview" className="rounded-lg border border-border bg-foreground/[0.04] px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{previewTemplate(text.trim() ? text : builtIn)}</div>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2">
        <Button id="tplSave" type="button" className="flex-1 font-extrabold" onClick={save} disabled={busy || over || text === saved}>{busy ? <Spinner /> : null}Save message</Button>
        <Button id="tplReset" type="button" variant="outline" onClick={reset} disabled={busy || (!text && !saved)}>Reset to default</Button>
      </div>
    </div>
  );
}
