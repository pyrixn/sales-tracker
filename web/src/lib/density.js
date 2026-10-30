import { useEffect, useState } from 'react';

// Density (uplift plan 5.3): 'comfortable' (the default) or 'compact', kept on this device like the theme.
// theme-init.js sets data-density on <html> before first paint; index.css applies the compact value at md and up only,
// so a phone row keeps its 64px touch height. This hook is imported by the Settings screen alone, so the shell does not grow.

const KEY = 'sales_tracker_density';

function stored() {
  try { return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable'; } catch (e) { return 'comfortable'; }
}

/** useDensity() -> { density: 'comfortable'|'compact', setDensity } */
export function useDensity() {
  const [density, setDensityState] = useState(stored);
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);
  // Another open tab changes the stored value: the Settings toggle here follows. (theme-init.js re-applies the attribute itself.)
  useEffect(() => {
    const onStorage = e => { if (e.key === null || e.key === KEY) setDensityState(stored()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  function setDensity(next) {
    const mode = next === 'compact' ? 'compact' : 'comfortable';
    try { if (mode === 'compact') localStorage.setItem(KEY, mode); else localStorage.removeItem(KEY); } catch (e) { /* storage denied: this visit only */ }
    setDensityState(mode);
  }
  return { density, setDensity };
}
