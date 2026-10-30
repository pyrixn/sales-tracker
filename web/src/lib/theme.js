import { useEffect, useState } from 'react';

const KEY = 'sales_tracker_theme';

function stored() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
}

function resolve(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode) {
  const r = resolve(mode);
  document.documentElement.classList.toggle('dark', r === 'dark');
  document.documentElement.setAttribute('data-theme', r);
}

// Every useTheme() instance (the sidebar toggle, More, the Settings screen) follows a change made in any of them.
const CHANGED = 'sales_tracker_theme_changed';

/** useTheme() -> { theme: 'system'|'light'|'dark', resolved, setTheme } */
export function useTheme() {
  const [theme, setThemeState] = useState(stored);
  const [resolved, setResolved] = useState(() => resolve(stored()));
  useEffect(() => {
    applyTheme(theme);
    setResolved(resolve(theme));
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => { applyTheme('system'); setResolved(resolve('system')); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  useEffect(() => {
    const sync = e => setThemeState(e.detail);
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  function setTheme(next) {
    try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (e) {}
    setThemeState(next);
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }));
  }
  return { theme, resolved, setTheme };
}
