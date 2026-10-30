import { cn } from '@/lib/utils';


/** Plain number with a real minus sign, so a screen reader never hears a loss as a gain. */
const signed = n => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
};

// Tailwind needs whole class names, so tones map to literals.
const FILL = { ok: 'fill-ok', bad: 'fill-bad', warn: 'fill-warn', lime: 'fill-lime', muted: 'fill-muted-foreground' };
const STROKE = { ok: 'stroke-ok', bad: 'stroke-bad', warn: 'stroke-warn', lime: 'stroke-lime', muted: 'stroke-muted-foreground' };
const TEXT = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', lime: 'text-lime', muted: 'text-muted-foreground' };
const SWATCH = { ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn', lime: 'bg-lime', muted: 'bg-muted-foreground' };

/** Visually hidden values, so the numbers behind a chart reach screen readers. */
export function DataTable({ caption, head, rows }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
    </table>
  );
}

function monthLabel(m) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[Number(String(m).slice(5, 7)) - 1] || String(m);
}

/** Grouped bars, one group per series row. keys: [{ key, label, tone }]. */
export function BarSeries({ series, keys, label }) {
  const W = 300, H = 120, top = 6, base = 100;
  const max = Math.max(1, ...series.flatMap(s => keys.map(k => Math.abs(Number(s[k.key]) || 0))));
  const group = W / Math.max(1, series.length);
  const bw = Math.min(14, (group - 8) / keys.length);
  const summary = label + ': ' + series.map(s => monthLabel(s.month) + ' ' + keys.map(k => k.label + ' ' + signed(s[k.key])).join(', ')).join('; ');
  return (
    <div>
      <svg role="img" aria-label={summary} viewBox={'0 0 ' + W + ' ' + H} className="h-auto w-full">
        <line x1="0" x2={W} y1={base} y2={base} className="stroke-border" strokeWidth="1" />
        {series.map((s, i) => {
          const x0 = i * group + (group - bw * keys.length) / 2;
          return (
            <g key={s.month}>
              {keys.map((k, j) => {
                const h = Math.max(1, (Math.abs(Number(s[k.key]) || 0) / max) * (base - top));
                return <rect key={k.key} x={x0 + j * bw} y={base - h} width={bw - 1.5} height={h} rx="2" className={FILL[k.tone] || FILL.muted} />;
              })}
              <text x={i * group + group / 2} y={H - 6} textAnchor="middle" fontSize="9" className="fill-muted-foreground font-mono">{monthLabel(s.month)}</text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-hidden="true">
        {keys.map(k => (
          <span key={k.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('size-2 rounded-full', SWATCH[k.tone] || SWATCH.muted)} />{k.label}
          </span>
        ))}
      </div>
      <DataTable caption={label} head={['Month'].concat(keys.map(k => k.label))} rows={series.map(s => [s.month].concat(keys.map(k => signed(s[k.key]))))} />
    </div>
  );
}

/** Tiny trend line. */
export function Sparkline({ values, label = 'Trend', tone = 'lime' }) {
  const v = (values || []).map(n => Number(n) || 0);
  const W = 100, H = 28;
  const lo = Math.min(...v, 0), hi = Math.max(...v, 1), span = hi - lo || 1;
  const pt = (n, i) => [v.length > 1 ? (i / (v.length - 1)) * W : W / 2, H - 2 - ((n - lo) / span) * (H - 4)];
  const pts = v.map((n, i) => pt(n, i).map(x => x.toFixed(1)).join(',')).join(' ');
  const last = v.length ? pt(v[v.length - 1], v.length - 1) : null;
  return (
    <div>
      <svg role="img" aria-label={label + ': ' + (v.length ? v.map(n => signed(n)).join(', ') : 'no data')} viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" className="h-8 w-full">
        {v.length > 1 ? <polyline points={pts} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className={STROKE[tone] || STROKE.lime} /> : null}
        {last ? <circle cx={last[0]} cy={last[1]} r="1.8" className={FILL[tone] || FILL.lime} /> : null}
      </svg>
      <DataTable caption={label} head={['Point', 'Value']} rows={v.map((n, i) => [String(i + 1), signed(n)])} />
    </div>
  );
}

/** Progress ring, pct 0..100+ (the ring caps at a full turn, the number does not). */
export function Ring({ pct, tone = 'lime', label = 'Progress' }) {
  const p = Number(pct) || 0, r = 15.9155, c = 100;
  const shown = Math.max(0, Math.min(100, p));
  return (
    <div className="relative size-16 shrink-0">
      <svg role="img" aria-label={label + ' ' + Math.floor(p) + '%'} viewBox="0 0 36 36" className="size-full -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3.5" className="stroke-foreground/10" />
        <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={shown + ' ' + (c - shown)} className={STROKE[tone] || STROKE.lime} />
      </svg>
      <span aria-hidden="true" className={cn('money absolute inset-0 grid place-items-center text-xs font-bold', TEXT[tone] || '')}>{Math.floor(p) + '%'}</span>
      <table className="sr-only"><caption>{label}</caption><tbody><tr><th scope="row">Percent</th><td>{Math.floor(p)}</td></tr></tbody></table>
    </div>
  );
}

/** One horizontal bar split into labelled parts: [{ label, value, tone }]. */
export function StackBar({ parts, label = 'Breakdown' }) {
  const list = (parts || []).filter(p => Number(p.value) > 0);
  const total = list.reduce((a, p) => a + Number(p.value), 0);
  let x = 0;
  const summary = label + ': ' + (list.length ? list.map(p => p.label + ' ' + signed(p.value)).join(', ') : 'nothing');
  return (
    <div>
      <svg role="img" aria-label={summary} viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2.5 w-full overflow-hidden rounded-full">
        <rect x="0" y="0" width="100" height="8" className="fill-foreground/10" />
        {list.map(p => {
          const w = (Number(p.value) / total) * 100, rx = x;
          x += w;
          return <rect key={p.label} x={rx} y="0" width={Math.max(0, w - 0.4)} height="8" className={FILL[p.tone] || FILL.muted} />;
        })}
      </svg>
      <DataTable caption={label} head={['Part', 'Value']} rows={list.map(p => [p.label, signed(p.value)])} />
    </div>
  );
}

/** One progress bar: pct may exceed 100, the bar stops at full and the caller prints the real number. */
export function Meter({ pct, tone = 'lime', label = 'Progress' }) {
  const p = Number(pct) || 0;
  const shown = Math.max(0, Math.min(100, p));
  return (
    <svg role="img" aria-label={label + ' ' + Math.floor(p) + '%'} viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 w-full overflow-hidden rounded-full">
      <rect x="0" y="0" width="100" height="8" className="fill-foreground/10" />
      <rect x="0" y="0" width={shown} height="8" className={FILL[tone] || FILL.lime} />
    </svg>
  );
}
