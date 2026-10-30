import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import util from '@/lib/util';
import { fullDate } from '@/lib/format';
import { Chip, Hint } from '@/components/kit';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fromDate, presets, toDate } from '@/screens/insights/range';

const MAX_DAYS = 731;

/** Quick ranges as chips plus a custom range in a popover. onChange({ from, to }) with Dhaka date strings. */
export function RangeBar({ today, range, onChange }) {
  const list = presets(today);
  const active = list.find(p => p.from === range.from && p.to === range.to);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(undefined);
  const [note, setNote] = useState('');

  // react-day-picker v10 reports the first click as a one-day range, so the two clicks are tracked here: first day, then last day (either order).
  function pick(day) {
    if (!draft) { setDraft({ from: day }); setNote(''); return; }
    const a = fromDate(draft.from), b = fromDate(day);
    const from = a <= b ? a : b, to = a <= b ? b : a;
    if (util.daysBetween(from, to) > MAX_DAYS) { setNote('Pick 24 months or less.'); setDraft(undefined); return; }
    setNote('');
    setOpen(false);
    onChange({ from, to });
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
      {list.map(p => (
        <Chip key={p.id} testId={'insights-preset-' + p.id} pressed={!!active && active.id === p.id} onClick={() => onChange({ from: p.from, to: p.to })}>{p.label}</Chip>
      ))}
      <Popover open={open} onOpenChange={o => { setOpen(o); if (o) { setDraft(undefined); setNote(''); } }}>
        <PopoverTrigger asChild>
          <Chip testId="insights-custom" pressed={!active} className="inline-flex items-center gap-1.5">
            <CalendarRange className="size-4" aria-hidden="true" />
            {active ? 'Custom range' : fullDate(range.from) + ' – ' + fullDate(range.to)}
          </Chip>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
          <Calendar mode="range" selected={draft} onSelect={() => {}} onDayClick={pick} defaultMonth={toDate(range.to)} disabled={{ after: toDate(today) }} />
          <Hint className="border-t border-border px-4 py-3" id="insights-range-hint">
            {note || (draft && draft.from ? 'Now pick the last day.' : 'Pick the first day, then the last day. Up to 24 months.')}
          </Hint>
        </PopoverContent>
      </Popover>
    </div>
  );
}
