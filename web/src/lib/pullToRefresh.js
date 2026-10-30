import { useEffect, useRef, useState } from 'react';

// Pull to refresh (uplift plan 5.5). On a touch phone, a downward drag that starts at the top of the page and is released
// at least PULL_PX below where it started calls onRefresh once. The page scrolls on the window, so "top" is window.scrollY.
// The touch is started by a pointer event with pointerType 'touch' (a mouse drag never counts). The distance is read from
// touch events: Chromium cancels the pointer stream (pointercancel) as soon as a touch pan begins, even at the top of the
// page, so pointermove cannot follow a pull. Listeners are passive and nothing calls preventDefault, so scrolling is never
// intercepted. index.css sets overscroll-behavior-y on phones so the browser's own pull-to-reload does not fire as well.
// A pull is skipped when a dialog or sheet is open, when a field has focus, when the drag began inside a list already
// scrolled, when reduced motion is on, or while a refresh is still running.

export const PULL_PX = 64;

function dialogOpen() {
  return document.querySelector('[role="dialog"]') !== null;
}

function typing() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

function reducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// A drag that starts inside a list scrolled down is that list scrolling back up, not a pull of the page.
function insideScrolled(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
  }
  return false;
}

/** usePullToRefresh(onRefresh) -> refreshing: true while the pull-started refresh runs (the shell shows the chip). */
export function usePullToRefresh(onRefresh) {
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  const busy = useRef(false);
  const drag = useRef(null);   // { y, last }: where the one possible pull started, and where the finger is now

  useEffect(() => {
    function down(e) {
      drag.current = null;
      if (e.pointerType !== 'touch' || !e.isPrimary || busy.current || reducedMotion() || dialogOpen() || typing()) return;
      if (window.scrollY > 0 || insideScrolled(e.target)) return;
      drag.current = { y: e.clientY, last: e.clientY };
    }
    function move(e) {
      const d = drag.current;
      if (!d) return;
      if (e.touches.length !== 1) { drag.current = null; return; }
      d.last = e.touches[0].clientY;
    }
    function end() {
      const d = drag.current;
      drag.current = null;
      if (!d || d.last - d.y < PULL_PX) return;
      if (busy.current || reducedMotion() || dialogOpen() || typing()) return;
      busy.current = true;
      setRefreshing(true);
      Promise.resolve()
        .then(() => latest.current())
        .catch(() => { /* the screen keeps its figures and shows the offline note */ })
        .finally(() => { busy.current = false; setRefreshing(false); });
    }
    function cancel() { drag.current = null; }
    const passive = { passive: true };
    window.addEventListener('pointerdown', down, passive);
    window.addEventListener('touchmove', move, passive);
    window.addEventListener('touchend', end, passive);
    window.addEventListener('touchcancel', cancel, passive);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
    };
  }, []);

  return refreshing;
}
