import { createContext, useContext, useId, useState } from 'react';
import { AlertTriangle, Lock, Trash2 } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { tk } from '@/lib/format';
import { notify, useApp, useInlineSave } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { EditableDate, EditableSelect, EditableText } from '@/components/inline';
import { ConfirmButton, Pill } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

// Shared pieces of the migration screen: one editable cell per staged field, the match picker, and the frame every row sits in.
// Every cell saves on its own through importEdit, so each has its own Undo. Applied rows are read-only.

export const STATUS_TONE = { Review: 'warn', Approved: 'ok', Skipped: 'muted', Applied: 'ok' };
const isNum = s => /^\d+(\.\d+)?$/.test(String(s).replace(/,/g, '').trim());
const cleanNum = s => String(s).replace(/,/g, '').trim();

/** Jump to a staged row from anywhere (an issue, an apply error): the screen switches tab, opens the card, highlights the row and focuses the field. */
export const MigNav = createContext({ target: null, go: () => {} });
export const useMigNav = () => useContext(MigNav);

export const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + tk(Math.abs(n));
export const sourceOf = v => (v.sheet ? v.sheet + '!' + v.ref : v.id);

export function Labeled({ label, children, field }) {
  return (
    <div className="min-w-0" data-field={field || undefined}>
      <div className="eyebrow px-1.5">{label}</div>
      {children}
    </div>
  );
}

/** One staged field. type: text (default), money (a number, or text kept as typed so the issue stays visible), plain (a count), date, select. */
// Fields where a pasted login is common: an "@" there is offered to the encrypted login details instead of being refused.
const LOGIN_FIELDS = ['profile', 'label', 'name'];

export function Cell({ v, field, label, type = 'text', options = [], placeholder = '', blank = false }) {
  const { reload, invalidate } = useApp();
  const [ask, setAsk] = useState(null);   // a value that looks like a login, waiting for the owner's choice
  const plainSave = useInlineSave('importEdit', val => ({ rowId: v.id, data: { [field]: val } }));
  const save = (val, meta) => {
    if (LOGIN_FIELDS.indexOf(field) >= 0 && typeof val === 'string' && val.indexOf('@') >= 0) { setAsk(val); return Promise.resolve({ ok: false, skipped: true }); }
    return plainSave(val, meta);
  };
  async function storeAsLogin() {
    const val = ask;
    setAsk(null);
    const r = await call('importEdit', { rowId: v.id, data: { [field]: val }, storeAsLogin: [field], requestId: rid() });
    if (!r.ok) { notify(r.error || 'Could not store the login details.'); return; }
    notify('Stored as login details (encrypted)');
    invalidate();
    reload();
  }
  const raw = v.data[field];
  const value = raw === undefined || raw === null ? '' : raw;
  const props = { field: label, target: sourceOf(v), value, onSave: save, disabled: v.status === 'Applied', placeholder: placeholder || 'Set ' + label.toLowerCase(), allowBlank: blank, visibleEdit: true };
  let cell;
  if (type === 'date') cell = <EditableDate {...props} mono />;
  else if (type === 'select') {
    const have = options.some(o => o.value === String(value));
    const opts = have || value === '' ? options : options.concat({ value: String(value), label: String(value) });
    cell = <EditableSelect {...props} options={opts} />;
  } else if (type === 'money' || type === 'plain') {
    cell = <EditableText {...props} mono
      format={x => (type === 'money' && isNum(x) ? tk(cleanNum(x)) : String(x))}
      parse={s => (isNum(s) ? Number(cleanNum(s)) : s.trim())}
      validate={s => (s.trim() === '' || isNum(s) ? '' : label + ' must be a number.')} />;
  } else cell = <EditableText {...props} />;
  return (
    <Labeled label={label} field={field}>
      {cell}
      <AlertDialog open={ask !== null} onOpenChange={o => { if (!o) setAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Store as login details?</AlertDialogTitle>
            <AlertDialogDescription>{label + ' looks like a login. It is moved into this row\'s encrypted login details and the field is cleared. Nothing is stored as plain text.'}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={storeAsLogin}>Store as login details</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Labeled>
  );
}

/**
 * Pick which existing record a row matches: Automatic (the server's best guess), a candidate, or Create new.
 * useKey is the match field (customerId, accountId, saleId, productId). `current` is what the row matches now, in words.
 */
export function MatchPick({ v, useKey, label, current, candidates, newLabel = 'Create new', allowNew = true, extraOptions = [] }) {
  const id = useId();
  const save = useInlineSave('importEdit', val => ({ rowId: v.id, match: { [useKey]: val } }));
  const chosen = (v.data.use && v.data.use[useKey]) || '';
  const [pick, setPick] = useState(null);
  const [error, setError] = useState('');
  const value = pick === null ? String(chosen) : pick;
  const list = (candidates || []).concat(extraOptions);
  const known = value === '' || value === 'new' || list.some(c => String(c.value) === value);
  async function change(e) {
    const next = e.target.value;
    setPick(next);
    setError('');
    const r = await save(next, { message: label + ' set' });
    setPick(null);
    if (!r.ok && !r.skipped) setError(r.error || 'Could not save.');
  }
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id} className="eyebrow">{label}</Label>
      <div className="min-w-0 truncate px-1 text-xs text-muted-foreground">{current}</div>
      <NativeSelect id={id} className="h-11" value={value} onChange={change} disabled={v.status === 'Applied'}>
        <NativeSelectOption value="">Automatic</NativeSelectOption>
        {list.map(c => <NativeSelectOption key={c.value} value={String(c.value)}>{c.label}</NativeSelectOption>)}
        {!known ? <NativeSelectOption value={value}>{value}</NativeSelectOption> : null}
        {allowNew ? <NativeSelectOption value="new">{newLabel}</NativeSelectOption> : null}
      </NativeSelect>
      {error ? <p role="alert" className="text-xs text-bad">{error}</p> : null}
    </div>
  );
}

function appliedText(applied) {
  return Object.keys(applied || {}).map(k => k + ' ' + [].concat(applied[k]).join(', ')).join(' · ');
}

/** The frame of one staged row: source, status, issues, fields, matches, and the Approve, Skip and Delete buttons. */
export function RowFrame({ v, fields, matches }) {
  const nav = useMigNav();
  const fixSave = useInlineSave('importEdit', vals => ({ rowId: v.id, data: vals }));
  const setStatus = useInlineSave('importStatus', s => ({ rowIds: [v.id], status: s }));
  const del = useInlineSave('importDelete', () => ({ rowId: v.id }));
  const open = useOpeners();
  const applied = v.status === 'Applied';
  const customers = applied && v.applied && v.applied.customers ? [].concat(v.applied.customers) : [];
  const set = (s, message) => <Button key={s} type="button" size="sm" variant={s === 'Approved' ? 'default' : 'outline'} className="h-11 px-4 font-bold"
    onClick={() => setStatus(s, { message })}>{s === 'Review' ? 'Back to review' : s === 'Approved' ? 'Approve' : 'Skip'}</Button>;
  return (
    <div data-testid="mig-row" data-row={v.id} data-kind={v.kind} data-status={v.status} data-blocks={v.blocks ? 'true' : undefined}
      className="mig-row grid gap-2.5 px-4 py-3 transition-colors data-[highlight=true]:bg-primary/15 data-[highlight=true]:ring-2 data-[highlight=true]:ring-primary/60">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">{sourceOf(v)}</span>
        {v.hasSecret ? <Pill tone="muted"><Lock className="size-3" aria-hidden="true" />Has login details</Pill> : null}
        {v.data && Number(v.data.dueAmount) > 0 ? <Pill tone="warn">{'Still owes ' + tk(v.data.dueAmount)}</Pill> : null}
        {v.blocks && v.status !== 'Applied' ? <Pill tone="bad"><span data-testid="mig-blocks">Blocks apply</span></Pill> : null}
        {v.issues.length ? <Pill tone="warn">{v.issues.length + (v.issues.length === 1 ? ' issue' : ' issues')}</Pill> : null}
        <Pill tone={STATUS_TONE[v.status] || 'muted'}>{v.status}</Pill>
      </div>
      {v.issues.length ? (
        <ul aria-label="Issues" className="grid gap-1">
          {v.issues.map(t => {
            const b = (v.blocking || []).find(x => x.text === t);
            return (
              <li key={t} className={'flex items-start gap-1.5 text-xs font-bold ' + (b ? 'text-bad' : 'text-warn')}>
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <button type="button" data-testid="mig-issue" onClick={() => nav.go(v.id, b ? b.field : '')}
                  className="min-w-0 rounded-sm text-left break-words underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{t}</button>
                {b ? <span className="shrink-0 font-mono text-micro uppercase">blocks apply</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {(v.fixes || []).length && v.status !== 'Applied' ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="Fixes">
          {v.fixes.map(f => f.picker ? (
            <Button key={f.id} type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" data-testid={'mig-fix-' + f.id} onClick={() => nav.go(v.id, f.field, true)}>{f.label}</Button>
          ) : (
            <Button key={f.id} type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" data-testid={'mig-fix-' + f.id}
              onClick={() => fixSave(f.values, { message: f.label })}>{f.label + (f.field === 'paidTill' ? ' = ' + f.value : '')}</Button>
          ))}
          {v.fixes.some(f => f.id === 'paidTill-computed') ? <span className="text-xs text-muted-foreground">{'Sale starts ' + v.fixes.find(f => f.id === 'paidTill-computed').coversFrom + (v.data.coversFrom ? '' : ' (today)')}</span> : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">{fields}</div>
      {matches ? <div className="grid gap-3 sm:grid-cols-2">{matches}</div> : null}
      {applied ? (
        <div className="grid gap-2">
          <p data-testid="mig-applied" className="font-mono text-xs break-words text-muted-foreground">{'Created ' + (appliedText(v.applied) || 'nothing')}</p>
          {customers.length ? <div><Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" onClick={() => open.customer(customers[0])}>Open customer</Button></div> : null}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {v.status !== 'Approved' ? set('Approved', 'Row approved') : null}
          {v.status !== 'Skipped' ? set('Skipped', 'Row skipped') : null}
          {v.status !== 'Review' ? set('Review', 'Row back in review') : null}
          <ConfirmButton label="Delete" icon={Trash2} title="Delete this staged row?" description={sourceOf(v) + ' leaves the batch. Nothing real is touched. Undo is offered after.'}
            confirmLabel="Delete row" className="h-11 px-4" onConfirm={() => del(null, { message: 'Row deleted' })} />
        </div>
      )}
    </div>
  );
}
