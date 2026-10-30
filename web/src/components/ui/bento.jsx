// Bento grid for the Today screen (uplift 1.2). Hand-written, no library: a 12-column grid from xl up, one column below.
// Phones keep the DOM order. `order` moves a tile on desktop only (xl:order-N); `span` and `tall` shape it on desktop only.
// Surfaces use tokens (bg-card, border-border). The hero is rounded-2xl; the other tiles bring their own rounded-xl card.
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { rise } from '@/lib/motion';

const SPAN = { 5: 'xl:col-span-5', 6: 'xl:col-span-6', 7: 'xl:col-span-7', 12: 'xl:col-span-12' };
const ORDER = { 1: 'xl:order-1', 2: 'xl:order-2', 3: 'xl:order-3', 4: 'xl:order-4', 5: 'xl:order-5', 6: 'xl:order-6', 7: 'xl:order-7', 8: 'xl:order-8', 9: 'xl:order-9', 10: 'xl:order-10' };
export const HERO_SURFACE = 'relative overflow-hidden rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm md:p-8';

/** The grid. Pass motion props (variants, initial, animate) straight through; tiles inherit them. */
export function BentoGrid({ className, ...props }) {
  return (
    <motion.div
      className={cn('grid grid-cols-[minmax(0,1fr)] grid-flow-dense gap-4 xl:grid-cols-[repeat(12,minmax(0,1fr))] xl:gap-6', className)}
      {...props}
    />
  );
}

/**
 * One tile. span: desktop columns (5, 6, 7 or 12). tall: two desktop rows (the hero). order: desktop position.
 * hero: the tile is the card (HERO_SURFACE). Otherwise the child is the card and must add xl:h-full to fill the tile.
 */
export function BentoTile({ span = 12, tall = false, order, hero = false, as = 'div', className, children, ...props }) {
  const Tag = as === 'section' ? motion.section : motion.div;
  return (
    <Tag
      variants={rise}
      className={cn('min-w-0 xl:h-full', SPAN[span], tall && 'xl:row-span-2', order && ORDER[order], hero && HERO_SURFACE, className)}
      {...props}
    >
      {children}
    </Tag>
  );
}
