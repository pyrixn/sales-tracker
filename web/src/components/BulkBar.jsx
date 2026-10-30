import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';

// Bulk action bar (uplift plan 3.4). Shows while at least one row is selected: "N selected", the screen's actions (children), Clear.
// Phone: sits above the mobile dock (the dock is 0.75rem plus about 4.25rem from the bottom, plus the safe area).
// Desktop: floats centred at the bottom. It is portalled to body, so a transformed screen wrapper cannot move it.
// Esc clears the selection, but only when focus is not in a field and no dialog, menu or list is open.
export function BulkBar({ count, onClear, children }) {
  const clearRef = useRef(onClear);
  clearRef.current = onClear;

  useEffect(() => {
    if (!count) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || (t.closest && t.closest('[data-inline-cell]')));
      if (typing || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      clearRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count]);

  if (!count) return null;
  return createPortal(
    <motion.div role="region" aria-label="Bulk actions" data-testid="bulk-bar"
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-x-3 bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))] z-40 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-popover/95 p-3 shadow-2xl shadow-black/30 backdrop-blur-2xl md:inset-x-auto md:bottom-6 md:left-1/2 md:max-w-[min(48rem,calc(100vw-2rem))] md:-translate-x-1/2 md:flex-nowrap">
      <span aria-live="polite" data-testid="bulk-count" className="shrink-0 font-mono text-sm font-bold">{count + ' selected'}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      <Button type="button" variant="ghost" size="sm" onClick={() => clearRef.current()} className="shrink-0">Clear</Button>
    </motion.div>,
    document.body
  );
}
