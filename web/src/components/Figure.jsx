import NumberFlow from '@number-flow/react';
import { cn } from '@/lib/utils';
import { plain } from '@/lib/format';

// Same rule as plain(): whole taka show no decimals, fractions always two. The rolling digits and the text copy must read alike.
const WHOLE = { maximumFractionDigits: 0 };
const CENTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/**
 * A big money figure. When `value` changes, its digits roll from the previous value (NumberFlow); a refresh that returns the same
 * number does nothing, and the first render never animates from zero. Reduced motion shows the final value at once.
 *   The baht sign is a small top-aligned span, a negative value shows the real minus sign (U+2212) there, and the digits are
 *   drawn without their sign. The wrapper's aria-label is the full sentence and the rolling digits are hidden from assistive tech.
 *   A plain-text copy (sr-only, so visually hidden) sits in the DOM before NumberFlow: textContent and text search read the number,
 *   and the copy comes first because Playwright's text matching also reads NumberFlow's shadow digits, after the copy.
 *   className: size and tone classes (`hero-figure` is always added). testId: optional data-testid on the wrapper.
 */
export function Figure({ value, className, testId }) {
  const v = Math.round(Number(value || 0) * 100) / 100;
  const neg = v < 0;
  const label = (neg ? '−' : '') + '৳' + plain(v);
  return (
    <span role="img" aria-label={label} data-testid={testId} className={cn('hero-figure block', className)}>
      <span aria-hidden="true" className="mr-1 align-top text-[0.38em] text-muted-foreground">{neg ? '−৳' : '৳'}</span>
      <span className="sr-only">{plain(v)}</span>
      <NumberFlow aria-hidden="true" value={Math.abs(v)} locales="en-US" format={Number.isInteger(v) ? WHOLE : CENTS} trend={0} />
    </span>
  );
}
