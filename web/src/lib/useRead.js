import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '@/lib/api';
import { useApp } from '@/lib/store';

/**
 * useRead(action, payload) -> { data, loading, error, refetch }
 * Reads again whenever the app data changes (epoch moves when a refresh finds a change), when the payload changes, and on refetch().
 * It does not wait for init: after a write the screen's read starts at once, in parallel with init.
 * A failed read keeps the data already on screen and sets error, so one bad refresh never blanks a screen. A failed read is also
 * retried on focus and when the network comes back, even when no data changed.
 * Only the newest read's answer is applied, so a slow old answer cannot overwrite a newer one.
 */
export function useRead(action, payload) {
  const { epoch } = useApp();
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const seq = useRef(0);
  const failed = useRef(false);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const payloadKey = JSON.stringify(payload === undefined ? null : payload);

  const run = useCallback(() => {
    const mine = ++seq.current;
    const done = (ok, next) => { if (mine === seq.current) { failed.current = !ok; setState(next); } };
    return call(action, payloadRef.current).then(
      r => done(r.ok, s => (r.ok ? { loading: false, error: '', data: r.data } : { loading: false, error: r.error || 'Could not load.', data: s.data })),
      e => done(false, s => ({ loading: false, error: String((e && e.message) || e), data: s.data }))
    );
  }, [action]);

  useEffect(() => { run(); }, [run, epoch, payloadKey]);

  useEffect(() => {
    const retry = () => { if (failed.current) run(); };
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, [run]);

  return { ...state, refetch: run };
}
