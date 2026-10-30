// ShineBorder (uplift 1.3): a thin lime highlight that travels round the edge of a card while it is active. Written in-house,
// no library copy (2026-10-28). The ring is a masked 1px padding box; the sweep is a background-position keyframe (.shine-border
// in web/src/index.css). It runs only while `active` is true and the tab is visible: visibility is a data attribute that the CSS
// pauses on. Under prefers-reduced-motion nothing is rendered. The parent must be position: relative; this sits over its edge.
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const REDUCE = '(prefers-reduced-motion: reduce)';

function useMedia(query) {
  const [on, setOn] = useState(() => !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

function Sweep({ className }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const sync = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return <div data-testid="shine-border" aria-hidden="true" data-paused={hidden ? 'true' : 'false'} className={cn('shine-border', className)} />;
}

export function ShineBorder({ active = false, className }) {
  const reduce = useMedia(REDUCE);
  if (!active || reduce) return null;
  return <Sweep className={className} />;
}
