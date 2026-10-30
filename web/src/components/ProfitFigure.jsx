import { cn } from '@/lib/utils';
import { tk } from '@/lib/format';
import { Figure } from '@/components/Figure';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Profit with the part still unpaid. The big figure is the full billed profit; when something is unpaid a smaller gray line shows the
 * profit actually collected (profit minus uncollected). Nothing extra renders when uncollected is 0. A collected figure below zero while
 * profit is positive is still shown, in the bad colour, because it is true.
 *   size 'hero': the big number plus the line under it.  size 'row': only the inline " · ৳X collected" text, for list rows.
 */
export function ProfitFigure({ profit, collected, uncollected, size = 'hero', className }) {
  const p = Number(profit) || 0;
  const unpaid = Number(uncollected) > 0;
  const got = Number(collected) || 0;
  const tone = got < 0 && Number(profit) > 0 ? 'text-bad' : 'text-muted-foreground';
  const spoken = 'of which collected ' + tk(got) + ', unpaid ' + tk(uncollected);
  const tip = 'Profit actually received. ' + tk(uncollected) + ' is still unpaid.';

  if (size === 'row') {
    if (!unpaid) return null;
    return (
      <span data-testid="profit-collected" className={cn('money text-xs', tone, className)}>
        <span aria-hidden="true"> · {tk(got)} collected</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }

  return (
    <div className={className}>
      <Figure value={p} testId="profit-big" className={cn('text-[clamp(3.5rem,18vw,6.5rem)]', p < 0 ? 'text-bad' : 'text-foreground')} />
      {unpaid ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div tabIndex={0} data-testid="profit-collected" className={cn('hero-figure money mt-2 w-fit text-2xl md:text-3xl', tone)}>
              <span aria-hidden="true">{tk(got)} collected</span>
              <span className="sr-only">{spoken}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
