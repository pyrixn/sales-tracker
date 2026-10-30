import { useState } from 'react';
import { num, tk } from '@/lib/format';
import { Field } from '@/components/kit';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const KEY = 'priceMode';

/** "per" (price per month) or "total" (one price for all months). Remembered per device; storage may be blocked, so never trust it. */
export function usePriceMode() {
  const [mode, setModeState] = useState(() => {
    try { return window.localStorage.getItem(KEY) === 'total' ? 'total' : 'per'; } catch { return 'per'; }
  });
  function setMode(m) {
    setModeState(m);
    try { window.localStorage.setItem(KEY, m); } catch { /* storage blocked: the choice still holds for this session */ }
  }
  return [mode, setMode];
}

const trim = n => String(Math.round(n * 10000) / 10000);

/** Re-express the typed text when the mode flips, so the same money stays on screen. Blank or non-numeric stays as typed. */
export function convertPriceText(text, from, to, months, qty = 1) {
  const n = Number(String(text).replace(/[,৳\s]/g, ''));
  const d = (Number(months) || 1) * (Number(qty) || 1);
  if (from === to || String(text).trim() === '' || !isFinite(n)) return text;
  return to === 'total' ? trim(n * d) : trim(n / d);
}

/** The server fields for the typed text: { price } in per-month mode, { total } in total mode. Blank gives {}. */
export function priceParam(mode, text, label = 'Price') {
  const n = num(text, label);
  if (n === null) return {};
  return mode === 'total' ? { total: n } : { price: n };
}

/** What the order comes to, for the summary line. */
export function priceTotal(mode, text, months, qty = 1) {
  const n = Number(text) || 0;
  return mode === 'total' ? n : n * (Number(months) || 1) * (Number(qty) || 1);
}

/** The other figure, shown under the input: "৳133.33 a month" (total mode) or "৳800 for 6 months" (per-month mode). */
export function priceHint(mode, text, months, qty = 1) {
  const n = Number(text), m = Number(months) || 1, d = m * (Number(qty) || 1);
  if (!(n > 0)) return '';
  if (mode === 'total') return tk(n / d) + ' a month';
  return d > 1 ? tk(n * d) + ' for ' + m + (m === 1 ? ' month' : ' months') : '';
}

/** Per-month / Total toggle. Small enough for a table popover. */
export function PriceModeToggle({ id, mode, onMode, text, onText, months, qty = 1 }) {
  function pick(m) {
    if (m === mode) return;
    onText(convertPriceText(text, mode, m, months, qty));
    onMode(m);
  }
  const btn = (m, label) => (
    <button key={m} type="button" id={id + '-mode-' + m} aria-pressed={mode === m} onClick={() => pick(m)}
      className={cn('rounded-md px-2 py-0.5 text-xs font-bold', mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
  );
  return <div role="group" aria-label="Price mode" className="inline-flex gap-0.5 rounded-lg border border-border p-0.5">{btn('per', 'Per month')}{btn('total', 'Total')}</div>;
}

/**
 * Price field with a Per month | Total toggle. The parent keeps `text` (what is typed) and `mode`; it sends priceParam(mode, text).
 * Total mode is the amount for all months (and qty); the per-month figure shows underneath.
 */
export default function PriceInput({ id = 'price', mode, onMode, text, onText, months, qty = 1, disabled, label, custom }) {
  const shown = label || (mode === 'total' ? 'Total price' : 'Price per month');
  const hint = priceHint(mode, text, months, qty);
  return (
    <Field label={shown} id={id}>
      {disabled ? null : <PriceModeToggle id={id} mode={mode} onMode={onMode} text={text} onText={onText} months={months} qty={qty} />}
      <Input id={id} inputMode="decimal" disabled={disabled} value={text} onChange={e => onText(e.target.value)} />
      {hint && !custom ? <p id={id + '-hint'} className="text-xs text-muted-foreground">{hint}</p> : null}
    </Field>
  );
}
