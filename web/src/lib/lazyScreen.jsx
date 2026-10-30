import { Component, Suspense, use } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

// A screen loaded on first visit. On a flaky connection the chunk fetch can fail: the import is retried a
// couple of times, and if it still fails the screen shows an error with a Retry button, never a blank page.
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function importWithRetry(loader, tries = 3, delay = 400) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await loader(); } catch (e) { last = e; if (i < tries - 1) await wait(delay * (i + 1)); }
  }
  throw last;
}

// A chunk that will not load fails its import with one of these. Any other error is a bug in the screen.
export function isChunkLoadError(error) {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(String(error.message || ''));
}

// Test host only. The UI tests set window.__TEST_CRASH__ = true with an init script and open ?crash=<tab> to make that
// screen throw while it renders. Production never sets the flag, so this never throws there.
function crashRequested(tab) {
  try {
    return window.__TEST_CRASH__ === true && new URLSearchParams(window.location.search).get('crash') === tab;
  } catch (e) { return false; }
}
function CrashProbe({ tab, children }) {
  if (crashRequested(tab)) throw new Error('Test crash in ' + tab);
  return children;
}

function Fallback() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading screen">
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

// Wraps one screen. Retry clears the error and remounts the screen (onRetry first, for a screen that must reset its own
// data). A chunk failure says to check the connection; any other error gets a generic line and is logged once, here.
// main.jsx leaves these errors to this boundary, so React's own console report does not add a second line.
export class ScreenBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null, n: 0 }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { if (!isChunkLoadError(error)) console.error(error); }
  retry = () => {
    if (this.props.onRetry) this.props.onRetry();
    this.setState(s => ({ error: null, n: s.n + 1 }));
  };
  render() {
    const { error } = this.state;
    if (!error) return <CrashProbe key={this.state.n} tab={this.props.tab}>{this.props.children}</CrashProbe>;
    const chunk = isChunkLoadError(error);
    return (
      <div data-testid="screen-error" className="mx-auto w-full max-w-md rounded-2xl border border-bad/40 bg-card/80 p-6">
        <div className="eyebrow">{chunk ? 'Could not load this screen' : 'This screen hit an error'}</div>
        <p role="alert" className="mt-3 text-sm font-semibold text-bad">{chunk ? 'Check your connection and try again.' : 'Something went wrong on this screen.'}</p>
        <Button type="button" className="mt-5 font-bold" onClick={this.retry}><RefreshCw />Retry</Button>
      </div>
    );
  }
}

// The screen's chunk is fetched once and kept as a promise that carries its settled state, so `use` reads a loaded
// screen at once (no fallback flash) and the shell can wait for it (LazyScreen.preload) before it swaps screens.
// A failed chunk stays failed until Retry builds a fresh import.
// lazyScreen(() => import('./X'), 'Name') -> component, with static preload() and ready().
// The tab is the export name in lower case (Customers -> customers, PayLinks -> paylinks), as App.jsx names tabs.
export function lazyScreen(loader, pick, retryOpts) {
  let chunk = null;
  const tab = pick.toLowerCase();
  const load = () => {
    if (!chunk) {
      const p = importWithRetry(loader, retryOpts && retryOpts.tries, retryOpts && retryOpts.delay).then(
        m => { p.status = 'fulfilled'; p.value = m[pick]; return p.value; },
        e => { p.status = 'rejected'; p.reason = e; throw e; }
      );
      chunk = p;
    }
    return chunk;
  };
  function Screen({ load: get, ...props }) {
    const Comp = use(get());
    return <Comp {...props} />;
  }
  function LazyScreen(props) {
    return (
      <ScreenBoundary tab={tab} onRetry={() => { chunk = null; }}>
        <Suspense fallback={<Fallback />}><Screen load={load} {...props} /></Suspense>
      </ScreenBoundary>
    );
  }
  LazyScreen.preload = () => load();
  LazyScreen.ready = () => !!chunk && chunk.status === 'fulfilled';
  return LazyScreen;
}
