import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { call, clearSecret, clearSession, invalidate as invalidateReads, readInitCache, rid, setSecret, signInWithPassword, writesInFlight } from '@/lib/api';
import { createInlineSave } from '@/lib/inline';

// App data: one `init` round trip (home + lookups), refreshed after every write and live: on focus, when the tab becomes
// visible, when the network comes back, and every POLL_MS while the tab is visible (POLL_BACKOFF_MS after a run of quiet answers).
// status: 'loading' | 'ready' | 'auth' (password missing or wrong) | 'error'.
// epoch moves whenever the data changed or a write was made. Screens that read with useRead refetch on it.
const POLL_MS = 25000, POLL_BACKOFF_MS = 60000, POLL_JITTER_MS = 3000, QUIET_BEFORE_BACKOFF = 5, REFRESH_FLOOR_MS = 5000;
const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// Sheets: a stack of slide-over panels. open(element) pushes; each element renders inside a
// SheetShell that reads its own close() from SheetCtx.
const SheetsCtx = createContext(null);
export const useSheets = () => useContext(SheetsCtx);
export const SheetCtx = createContext({ close: () => {} });
export const useSheetClose = () => useContext(SheetCtx).close;

// First paint: the last init answer for this secret and today's Dhaka date, if any (see readInitCache). The real read replaces it.
function firstState() {
  const c = readInitCache();
  if (c) return { status: 'ready', error: '', lookups: c.lookups, home: c.home, today: c.home.today, role: (c.me && c.me.role) || '' };
  return { status: 'loading', error: '', lookups: null, home: null, today: '', role: '' };
}

export function AppProvider({ children }) {
  const [state, setState] = useState(firstState);
  const [authTried, setAuthTried] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const painted = useRef(state.status === 'ready');   // showing the cached answer, not yet confirmed by the server
  const stateRef = useRef(state);
  stateRef.current = state;
  const raw = useRef(null);          // the init data object last applied; a notModified answer hands back this same object
  const holds = useRef(0);           // open edit sheets: no polling while one is open
  const quiet = useRef(0);           // consecutive refreshes that changed nothing
  const lastRefresh = useRef(0);
  const loadSeq = useRef(0);         // the newest load started: an older load's answer is dropped when it arrives
  const gen = useRef(0);             // bumped by sign-in and sign-out: an answer to a request sent under the old secret is dropped

  // init does the snapshot-if-due and the stale-rate refresh on the server, once, so one call is all a load takes.
  // A failure while a screen is already on (a background refresh, or a reload after a save) keeps that screen; an unchanged answer does not re-render.
  // An answer is dropped when a newer load was started after it, or when the secret changed meanwhile (sign-in or sign-out). An
  // Unauthorized answer is never dropped for being older: a wrong password must still show.
  const load = useCallback(async () => {
    lastRefresh.current = Date.now();
    const mine = ++loadSeq.current, myGen = gen.current;
    const r = await call('init');
    const unauthorized = !r.ok && r.error === 'Unauthorized';
    if (myGen !== gen.current) return r;
    if (mine !== loadSeq.current && !unauthorized) return r;
    if (!r.ok) {
      if (unauthorized) { painted.current = false; raw.current = null; setState({ status: 'auth', error: '', lookups: null, home: null, today: '' }); }
      // A failed refresh keeps the figures on screen and says so (offline: true shows the "Saved figures, offline" note).
      else if (painted.current || stateRef.current.status === 'ready') setState(s => (s.offline ? s : { ...s, offline: true }));
      else setState(s => ({ ...s, status: 'error', error: r.error || 'Failed to load.' }));
      return r;
    }
    painted.current = false;
    if (raw.current && r.data === raw.current && stateRef.current.status === 'ready') {
      quiet.current++;   // notModified: same data, no state change, no re-render (a successful refresh still clears the note)
      setState(s => (s.offline ? { ...s, offline: false } : s));
      return r;
    }
    raw.current = r.data;
    quiet.current = 0;
    const lookups = r.data.lookups;
    const home = r.data.home;
    // role: 'owner', 'staff' or 'viewer' (init carries it from the server, see me). Kept when an answer has none.
    setState({ status: 'ready', error: '', lookups, home, today: home.today, offline: false, role: (r.data.me && r.data.me.role) || stateRef.current.role || '' });
    setEpoch(e => e + 1);
    return r;
  }, []);

  useEffect(() => { load(); }, [load]);

  // A background refresh runs only when the tab is visible, nothing is being saved or edited, and the last one is not very recent.
  const refresh = useCallback(() => {
    if (document.visibilityState !== 'visible' || holds.current > 0 || writesInFlight() > 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (stateRef.current.status !== 'ready' || Date.now() - lastRefresh.current < REFRESH_FLOOR_MS) return;
    load();
  }, [load]);

  useEffect(() => {
    let timer = null;
    const tick = () => {
      timer = null;
      if (document.visibilityState !== 'visible') return;
      refresh();
      schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      const base = quiet.current >= QUIET_BEFORE_BACKOFF ? POLL_BACKOFF_MS : POLL_MS;
      timer = setTimeout(tick, base + Math.round((Math.random() * 2 - 1) * POLL_JITTER_MS));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { refresh(); schedule(); }
      else { clearTimeout(timer); timer = null; }
    };
    const onFocus = () => refresh();
    if (document.visibilityState === 'visible') schedule();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [refresh]);

  // A write was made: reads in flight are not shared any more, and the next poll starts from the short interval again.
  // The save's own reload then moves epoch once (when the data changed), so a screen reading with useRead reads once more.
  const invalidate = useCallback(() => {
    invalidateReads();
    quiet.current = 0;
  }, []);

  const holdRefresh = useCallback(() => { holds.current++; }, []);
  // The last edit sheet closed: catch up at once rather than waiting for the next poll.
  const releaseRefresh = useCallback(() => {
    holds.current = Math.max(0, holds.current - 1);
    if (holds.current === 0) refresh();
  }, [refresh]);

  const signIn = useCallback(async secret => {
    gen.current++;
    setSecret(secret);
    setAuthTried(true);
    setState(s => ({ ...s, status: 'loading' }));
    const r = await load();
    if (r && r.ok) setAuthTried(false);
    return r;
  }, [load]);

  // Staff sign-in with email and password (Supabase Auth). A login with no staff role is signed out again, with the reason.
  const signInEmail = useCallback(async (email, password) => {
    gen.current++;
    const a = await signInWithPassword(email, password);
    if (!a.ok) return a;
    setState(s => ({ ...s, status: 'loading' }));
    const r = await load();
    if (r && r.ok) return { ok: true };
    clearSession();
    raw.current = null;
    setState({ status: 'auth', error: '', lookups: null, home: null, today: '' });
    return { ok: false, error: r && r.error === 'Unauthorized' ? 'That login could not open the panel.' : (r && r.error) || 'Could not sign in.' };
  }, [load]);

  const signOut = useCallback(() => {
    gen.current++;
    clearSecret();
    setAuthTried(false);
    raw.current = null;
    setState({ status: 'auth', error: '', lookups: null, home: null, today: '' });
  }, []);

  const value = useMemo(() => ({ ...state, authTried, epoch, reload: load, invalidate, holdRefresh, releaseRefresh, signIn, signInEmail, signOut }),
    [state, authTried, epoch, load, invalidate, holdRefresh, releaseRefresh, signIn, signInEmail, signOut]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Keeps the live refresh paused while the calling edit sheet is open (a sheet holds its own copy of the values). */
export function useHoldRefresh() {
  const { holdRefresh, releaseRefresh } = useApp();
  useEffect(() => { holdRefresh(); return releaseRefresh; }, [holdRefresh, releaseRefresh]);
}

export function SheetsProvider({ children }) {
  const [stack, setStack] = useState([]);
  const nextId = useRef(1);
  const open = useCallback(element => { setStack(s => [...s, { id: nextId.current++, element }]); }, []);
  const closeTop = useCallback(() => setStack(s => s.slice(0, -1)), []);
  const closeAll = useCallback(() => setStack([]), []);
  const closeId = useCallback(id => setStack(s => s.filter(x => x.id !== id)), []);
  const api = useMemo(() => ({ open, close: closeTop, closeAll, depth: stack.length }), [open, closeTop, closeAll, stack.length]);
  return (
    <SheetsCtx.Provider value={api}>
      {children}
      {stack.map(entry => (
        <SheetCtx.Provider key={entry.id} value={{ close: () => closeId(entry.id) }}>{entry.element}</SheetCtx.Provider>
      ))}
    </SheetsCtx.Provider>
  );
}

/** Toast with an Undo button for a save that can be reversed. opts.batchId is the batch the save wrote (the server's batchId):
 *  Undo reverts exactly that batch, and is refused if anything was saved after it. */
export function notify(message, opts) {
  if (opts && opts.undo && opts.batchId) {
    const undoRequest = rid();   // one id for this toast: a double click replays the same Undo instead of refusing the second
    const id = toast(message, {
      duration: 10000,
      action: {
        label: 'Undo',
        onClick: async () => {
          const r = await call('undo', { requestId: undoRequest, batchId: opts.batchId });
          if (r.ok) toast(String(r.data.message).replace(/^Undone: .*/, 'Undone'));
          else { invalidateReads(); toast(r.error); }
          if (opts.onUndo) opts.onUndo();
        }
      }
    });
    return id;
  }
  return toast(message, { duration: 4000 });
}

/**
 * useSaver(action, build, { undo, keepParent, after }) -> { save, busy, error }
 * stay keeps this sheet open after saving (for a section inside a longer form).
 * keepParent closes only this sheet, so a list underneath stays open and shows the change.
 * build() returns the payload or throws an Error with a readable message. The request id stays the
 * same across retries of one form, so a double tap or a retry after a lost reply writes once.
 * Undo is offered only when the server says the save changed something (response.changed) and names its batch (response.batchId),
 * so it never reverts an older action.
 */
export function useSaver(action, build, opts) {
  const { reload, invalidate } = useApp();
  const sheets = useSheets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(rid());
  const guard = useRef(false);
  const buildRef = useRef(build);
  buildRef.current = build;
  const optsRef = useRef(opts || {});
  optsRef.current = opts || {};

  const save = useCallback(async () => {
    if (guard.current) return;
    let payload;
    try { payload = buildRef.current(); } catch (e) { setError(e.message); return; }
    guard.current = true; setBusy(true); setError('');
    const r = await call(action, { ...payload, requestId: requestId.current });
    guard.current = false; setBusy(false);
    if (!r.ok) { setError(r.error || 'Could not save.'); return; }
    requestId.current = rid();
    if (optsRef.current.stay) { /* keep this sheet open */ }
    else if (optsRef.current.keepParent) sheets.close(); else sheets.closeAll();
    const changed = !!(r.data && r.data.changed === true);
    notify((r.data && r.data.message) || 'Saved', { undo: optsRef.current.undo !== false && changed, batchId: r.data && r.data.batchId, onUndo: reload });
    if (optsRef.current.after) optsRef.current.after(r.data);
    invalidate();
    reload();
  }, [action, reload, invalidate, sheets]);

  return { save, busy, error };
}

/**
 * useInlineSave(action, build, opts) -> save(next, meta) -> Promise<{ ok, changed?, message?, error?, skipped? }>
 * One cell's save (components/inline.jsx). Same rules as createInlineSave (lib/inline.js): one save at a time, one requestId per
 * payload, Undo only for a change the server names by batch. It never closes a sheet. The cell moves its own display value
 * (optimistic) and rolls it back on error; the reload that follows a success brings the stored value into every screen.
 */
export function useInlineSave(action, build, opts) {
  const { reload, invalidate } = useApp();
  const buildRef = useRef(build);
  buildRef.current = build;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const saver = useRef(null);
  if (!saver.current) {
    saver.current = createInlineSave({ call, rid, notify, reload, invalidate }, action,
      next => buildRef.current(next), () => optsRef.current);
  }
  return saver.current;
}
