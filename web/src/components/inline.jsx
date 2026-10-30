import { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { tk } from '@/lib/format';
import { isRealDate, norm, sameValue } from '@/lib/inline';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

// An editable value in place. Display: a button that reads as text, with a pencil on hover or focus (always on touch).
// Edit: the matching input. Enter or blur saves, Esc cancels, Tab moves to the next cell in [data-cell-group], Ctrl/Cmd+Enter
// saves a note. An unchanged value sends nothing. The shown value moves at once and rolls back on a refused save, with the error
// under the cell. While a cell is being edited, live refresh is held, so a poll never replaces the draft.
// Props: value (server value), onSave(next, { message }) -> Promise<{ ok, error?, skipped? }> (useInlineSave),
// field and target (the accessible name starts `Edit <field> for <target>`, the display button adds the value), format(value), validate(draft) -> error text,
// parse(draft) -> value sent, allowBlank, options (select), disabled + disabledReason (shown, and read by screen readers).
// Book money cells: sign ('+' or '−') prefixes the shown figure, tone ('ok' or 'bad') colours it, srText (e.g. 'income') is read by screen readers after it.
// The sign and tone are display only: the message, the draft and the value sent are the plain figure.
// align ('start' or 'end'): 'end' right-aligns the shown value (money columns in a table).
// visibleEdit: the pencil is always shown (screens where every field is meant to be edited, and phones have no hover).

export function InlineCell({ kind = 'text', value, onSave, field, target, format, validate, parse, options = [], allowBlank = false,
  placeholder = '', mono = false, disabled = false, disabledReason = '', min, className, editHint = '', onEditingChange,
  sign = '', tone = '', srText = '', align = 'start', visibleEdit = false }) {
  const { holdRefresh, releaseRefresh } = useApp();
  const reasonId = useId();
  const wrap = useRef(null);
  const btn = useRef(null);
  const control = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(null);   // { to, saving } the value shown after an edit, until the server's value arrives
  const pendingRef = useRef(null);
  pendingRef.current = pending;
  const draftRef = useRef('');
  const rejected = useRef(null);      // a draft the server refused: shown again when the cell is reopened
  const startValue = useRef(value);   // the server value when editing began, to tell a change made elsewhere
  const editingRef = useRef(false);
  const finished = useRef(true);      // the edit is over (saved, cancelled or unchanged): nothing else may save it
  const returnFocus = useRef(false);
  const openRef = useRef(null);
  const shown = pending ? pending.to : value;

  const optionLabel = v => { const o = options.find(x => x.value === String(v)); return o ? o.label : ''; };
  const fmt = v => (kind === 'select' ? optionLabel(v) || String(v ?? '') : v === null || v === undefined || v === '' ? '' : format ? format(v) : kind === 'number' ? tk(v) : String(v));
  const shownText = fmt(shown) || placeholder;
  const displayText = sign && fmt(shown) ? sign + fmt(shown) : shownText;
  const label = `Edit ${field} for ${target}`;
  const keyboardPick = useRef(false); // a select changed by arrow keys: saved by Enter or blur, not by the change itself

  useEffect(() => { editingRef.current = editing; }, [editing]);

  // Tells the owner (a list that holds its row order) while this cell is open. The cleanup reports it closed.
  const onEditingRef = useRef(onEditingChange);
  onEditingRef.current = onEditingChange;
  useEffect(() => {
    if (!editing || !onEditingRef.current) return undefined;
    onEditingRef.current(true);
    return () => { if (onEditingRef.current) onEditingRef.current(false); };
  }, [editing]);

  // The server value moved: the optimistic value is no longer needed (a save still in flight keeps it until its value arrives).
  useEffect(() => {
    const p = pendingRef.current;
    if (p && p.saving && !sameValue(value, p.to)) return;
    if (p) setPending(null);
  }, [value]);

  // Someone else changed this value while the owner is typing: say so, keep the draft, let the owner decide.
  useEffect(() => {
    if (editingRef.current && !sameValue(value, startValue.current)) setHint('Changed elsewhere to ' + (fmt(value) || 'empty') + '.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // A live refresh would replace the displayed data while a draft is open: hold it for the length of the edit.
  useEffect(() => {
    if (!editing) return undefined;
    holdRefresh();
    return releaseRefresh;
  }, [editing, holdRefresh, releaseRefresh]);

  useEffect(() => {
    if (editing) {
      const el = control.current;
      if (el) {
        el.focus();
        if (typeof el.select === 'function' && kind !== 'date') el.select();
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      }
    } else if (returnFocus.current) {
      returnFocus.current = false;
      if (btn.current) btn.current.focus();
    }
  }, [editing, kind]);

  // Tab from a cell opens the next one (dispatched by this cell's neighbour; see moveTo).
  useEffect(() => {
    const el = wrap.current;
    const open = () => { if (openRef.current) openRef.current(); };
    el.addEventListener('inline-open', open);
    return () => el.removeEventListener('inline-open', open);
  }, []);

  function beginEdit() {
    if (disabled || editingRef.current) return;
    const p = pendingRef.current;
    if (p && p.saving) return;
    startValue.current = value;
    finished.current = false;
    const d = rejected.current !== null ? rejected.current : (shown === null || shown === undefined ? '' : String(shown));
    draftRef.current = d;
    setDraft(d);
    setError('');
    setHint('');
    setEditing(true);
  }
  openRef.current = beginEdit;

  function cancelEdit() {
    finished.current = true;
    rejected.current = null;
    setEditing(false);
    setError('');
    setHint('');
  }

  // Returns true when the edit is closed (saved, unchanged or already done), false when it stays open with an error.
  function submit(raw = draftRef.current) {
    if (finished.current) return true;
    const blank = norm(raw) === '';
    const err = blank && !allowBlank ? field + ' cannot be empty.' : (validate ? validate(raw) : '');
    if (err) { setError(err); return false; }
    const next = parse ? parse(raw) : norm(raw);
    finished.current = true;
    setEditing(false);
    setHint('');
    if (sameValue(next, shown)) { setError(''); return true; }   // unchanged: no request, no toast
    const from = shown;
    setError('');
    setPending({ to: next, saving: true });
    const message = field + ': ' + (fmt(next) || 'empty') + ' (was ' + (fmt(from) || 'empty') + ')';
    Promise.resolve(onSave(next, { message })).then(res => {
      if (res && res.ok) {
        rejected.current = null;
        setPending(p => (p ? { ...p, saving: false } : p));
        setStatus('Saved');
      } else if (res && res.skipped) {
        setPending(null);
      } else {
        rejected.current = raw;
        setPending(null);
        setError((res && res.error) || 'Could not save.');
        setStatus('Not saved.');
      }
    }, e => {
      rejected.current = raw;
      setPending(null);
      setError(String((e && e.message) || e));
      setStatus('Not saved.');
    });
    return true;
  }

  function moveTo(forward) {
    const group = (wrap.current && wrap.current.closest('[data-cell-group]')) || document;
    const cells = Array.from(group.querySelectorAll('[data-inline-cell]:not([data-disabled="true"])'));
    const i = cells.indexOf(wrap.current);
    return cells[i + (forward ? 1 : -1)] || null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editingRef.current) { cancelEdit(); returnFocus.current = true; }
      return;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (kind === 'note' && !(e.metaKey || e.ctrlKey)) return;   // a note takes new lines; Ctrl/Cmd+Enter saves
      e.preventDefault();
      e.stopPropagation();
      if (submit(kind === 'select' ? e.currentTarget.value : undefined)) returnFocus.current = true;
      return;
    }
    // A date input keeps Tab for its own segments (month, day, year); the blur saves when focus leaves it.
    if (e.key === 'Tab' && kind !== 'date') {
      const next = moveTo(!e.shiftKey);
      if (!next) return;   // the last cell: normal focus order, and the blur saves
      e.preventDefault();
      if (submit()) next.dispatchEvent(new CustomEvent('inline-open'));
    }
  }

  // The cell sits inside clickable rows and keyboard shortcuts: its keys and clicks never reach them.
  const stop = e => { e.stopPropagation(); };
  const stopKeys = e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') e.stopPropagation(); };

  const controlProps = {
    ref: control,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    onKeyDown: kind === 'select' ? e => {
      if (/^(Arrow|Home|End|PageUp|PageDown)/.test(e.key) || e.key.length === 1) {
        keyboardPick.current = true;
        setTimeout(() => { keyboardPick.current = false; }, 0);
      }
      onKeyDown(e);
    } : onKeyDown,
    onBlur: () => { if (!finished.current) submit(); }
  };

  let body;
  if (editing) {
    if (kind === 'select') {
      body = (
        <NativeSelect {...controlProps} value={draft} onChange={e => {
          const v = e.target.value;
          draftRef.current = v;
          setDraft(v);
          if (!keyboardPick.current) submit(v);   // a mouse or touch choice saves at once; keys wait for Enter or blur
        }}>
          {options.map(o => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
        </NativeSelect>
      );
    } else if (kind === 'note') {
      body = (
        <Textarea {...controlProps} value={draft} onChange={e => { draftRef.current = e.target.value; setDraft(e.target.value); }} rows={3} className="min-h-20" />
      );
    } else {
      const type = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
      body = (
        <Input {...controlProps} type={type} inputMode={kind === 'number' ? 'decimal' : undefined} step={kind === 'number' ? 'any' : undefined}
          min={kind === 'number' ? min : undefined} enterKeyHint="done" autoComplete="off" value={draft} className="h-11"
          onChange={e => { draftRef.current = e.target.value; setDraft(e.target.value); }} />
      );
    }
  } else {
    const saving = pending && pending.saving;
    body = (
      <button ref={btn} type="button" aria-label={`${label}: ${displayText || 'empty'}${srText && fmt(shown) ? ` (${srText})` : ''}. Press Enter to edit`} aria-disabled={disabled || undefined}
        aria-describedby={disabled && disabledReason ? reasonId : undefined} onClick={e => { e.stopPropagation(); beginEdit(); }}
        onKeyDown={e => { if (e.key === 'F2') { e.preventDefault(); beginEdit(); } }}
        className={cn('group flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 outline-none transition-colors',
          align === 'end' ? 'justify-end text-right' : 'text-left',
          'hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50',
          disabled && 'cursor-not-allowed text-muted-foreground')}>
        <span className={cn('min-w-0 truncate', mono && 'money', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', !shown && 'text-muted-foreground', saving && 'opacity-60')}>{displayText}</span>
        {saving ? <Spinner aria-hidden="true" role={undefined} aria-label={undefined} className="size-3.5 shrink-0" /> : null}
        {!disabled && !saving ? <Pencil aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-opacity', visibleEdit ? 'opacity-80' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-70')} /> : null}
      </button>
    );
  }

  return (
    <div ref={wrap} data-inline-cell="" data-disabled={disabled ? 'true' : undefined} data-inline-editing={editing ? 'true' : undefined}
      className={cn('min-w-0', className)} onClick={stop} onKeyDown={stopKeys}>
      {body}
      {disabled && disabledReason ? <p id={reasonId} className="px-1.5 text-xs text-muted-foreground">{disabledReason}</p> : null}
      {editing && editHint ? <p className="px-1.5 text-xs text-muted-foreground">{editHint}</p> : null}
      {hint && editing ? <p className="px-1.5 text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p role="alert" className="px-1.5 text-xs text-bad">{error}</p> : null}
      <span role="status" aria-live="polite" className="sr-only">{status}</span>
    </div>
  );
}

const textOf = v => (v === null || v === undefined ? '' : String(v));

/** Free text. Enter or blur saves. allowBlank lets the value be cleared. */
export function EditableText(props) {
  return <InlineCell kind="text" {...props} />;
}

/** A number. Sent as a Number. min (default 0) is checked before the save. */
export function EditableNumber({ min = 0, validate, ...props }) {
  return (
    <InlineCell kind="number" min={min} {...props}
      parse={v => (norm(v) === '' ? null : Number(v))}
      validate={v => {
        if (norm(v) === '') return '';
        const n = Number(v);
        if (!Number.isFinite(n) || n < min) return props.field + ' must be ' + min + ' or more.';
        return validate ? validate(v) : '';
      }} />
  );
}

/** A date as YYYY-MM-DD (the native date picker on phones). Blank clears it when allowBlank (default true). */
export function EditableDate({ allowBlank = true, validate, ...props }) {
  return (
    <InlineCell kind="date" allowBlank={allowBlank} {...props}
      parse={v => norm(v)}
      validate={v => {
        if (norm(v) && !isRealDate(v)) return 'Date must be like 2026-10-18.';
        return validate ? validate(v) : '';
      }} />
  );
}

/** One of options ([{ value, label }]). Saves as soon as a choice is made. */
export function EditableSelect({ options, ...props }) {
  return <InlineCell kind="select" options={options} {...props} parse={v => textOf(v)} />;
}

/** A longer note. Ctrl/Cmd+Enter or blur saves; Enter starts a new line. Blank allowed by default. */
export function EditableNote({ allowBlank = true, ...props }) {
  return <InlineCell kind="note" allowBlank={allowBlank} {...props} parse={v => norm(v)} />;
}
