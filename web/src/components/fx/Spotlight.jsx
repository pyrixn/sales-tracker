// Spotlight (uplift 1.3): a soft light that follows the pointer across one hero card. Written in-house, no library copy (2026-10-28).
// The glow is painted by the .spotlight rule in web/src/index.css; this wrapper only sets its --mx and --my variables.
// They are written with element.style.setProperty, not a style= prop: a style prop would re-render the card on every pointer
// move, and DESIGN.md bans inline style props in our components. CSS cannot read the pointer, so this is the one allowed write.
// Pointer work only runs where a fine pointer hovers (matchMedia hover: hover). Touch screens get no handlers at all.
// Usage: <Spotlight className="rounded-xl">...</Spotlight>, or component={BentoTile} to make the card itself the spotlight.
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

const HOVER = '(hover: hover)';

export function Spotlight({ component: Tag = 'div', className, children, ...props }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia || !window.matchMedia(HOVER).matches) return undefined;
    let frame = 0;
    let pointer = null;   // latest clientX / clientY; one paint per animation frame, however many moves arrived

    function paint() {
      frame = 0;
      if (!pointer) return;
      const box = el.getBoundingClientRect();
      el.style.setProperty('--mx', (pointer.x - box.left) + 'px');
      el.style.setProperty('--my', (pointer.y - box.top) + 'px');
    }
    function onMove(e) {
      if (e.pointerType === 'touch') return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    }

    el.addEventListener('pointermove', onMove);
    return () => {
      el.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <Tag ref={ref} className={cn('spotlight', className)} {...props}>
      {children}
    </Tag>
  );
}
