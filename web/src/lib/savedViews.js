// Saved views (uplift plan 3.5): a named copy of one screen's filter, sort, search and table columns.
// A per-viewer convenience: kept in this browser's localStorage under sales_tracker_views_<screenKey>, never on the server.
// When storage throws (private mode, blocked site data) the views are kept in memory for this page session only.
import { useRef, useState } from 'react';

export const MAX_VIEWS = 20;
export const VIEW_NAME_MAX = 40;
const PREFIX = 'sales_tracker_views_';
const memory = new Map();   // storage key -> views, only for keys whose last write failed in this page session

export const viewsKey = screenKey => PREFIX + screenKey;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// Trims and checks a typed name. Returns { name } or { error } with the text the form shows.
export function checkViewName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Type a name for the view.' };
  if (Array.from(name).length > VIEW_NAME_MAX) return { error: 'Use ' + VIEW_NAME_MAX + ' characters or fewer.' };
  return { name };
}

// Keeps only well-formed entries: a trimmed valid name, an object state, unique names (case-insensitive), at most MAX_VIEWS.
function clean(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (!v || typeof v !== 'object' || !v.state || typeof v.state !== 'object' || Array.isArray(v.state)) continue;
    const check = checkViewName(v.name);
    if (check.error || out.some(o => sameName(o.name, check.name))) continue;
    out.push({ name: check.name, state: v.state });
    if (out.length === MAX_VIEWS) break;
  }
  return out;
}

function readViews(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? [] : clean(JSON.parse(raw));
  } catch {
    return [];   // storage unavailable, or the saved text is not JSON: start with no views
  }
}

function writeViews(key, views) {
  try {
    window.localStorage.setItem(key, JSON.stringify(views));
    memory.delete(key);
  } catch {
    memory.set(key, views);   // storage refused the write: keep the views for this session
  }
}

// Helpers a screen uses in its applyState to accept a saved state it may have been written with (a stale or hand-edited one must not crash).
export function oneOf(value, allowed, fallback) {
  return allowed.indexOf(value) >= 0 ? value : fallback;
}
export function cleanSorting(value, columnIds) {
  if (!Array.isArray(value)) return [];
  return value.filter(s => s && typeof s.id === 'string' && columnIds.indexOf(s.id) >= 0 && typeof s.desc === 'boolean')
    .map(s => ({ id: s.id, desc: s.desc }));
}
export function cleanVisibility(value, columnIds) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  columnIds.forEach(id => { if (typeof value[id] === 'boolean') out[id] = value[id]; });
  return out;
}

// Saved views for one screen. getState() returns the screen's current state as plain data; applyState(state) sets it,
// and applyState(null) resets the screen to its defaults (the "Default" entry).
// Returns { views, selected, choose(name), save(rawName), remove() }. save returns { name } or { error }.
export function useSavedViews(screenKey, getState, applyState) {
  const key = viewsKey(screenKey);
  const [views, setViews] = useState(() => readViews(key));
  const [selected, setSelected] = useState('');
  const getRef = useRef(getState);
  const applyRef = useRef(applyState);
  getRef.current = getState;
  applyRef.current = applyState;

  function save(raw) {
    const check = checkViewName(raw);
    if (check.error) return check;
    const list = readViews(key);
    const at = list.findIndex(v => sameName(v.name, check.name));
    if (at < 0 && list.length >= MAX_VIEWS) return { error: 'You have ' + MAX_VIEWS + ' saved views. Delete one to make room.' };
    const entry = { name: check.name, state: getRef.current() };
    const next = at < 0 ? list.concat([entry]) : list.map((v, i) => (i === at ? entry : v));
    writeViews(key, next);
    setViews(next);
    setSelected(check.name);
    return { name: check.name };
  }

  function choose(name) {
    if (!name) {
      setSelected('');
      applyRef.current(null);
      return;
    }
    const view = views.find(v => v.name === name);
    if (!view) return;
    setSelected(view.name);
    applyRef.current(view.state);
  }

  function remove() {
    if (!selected) return;
    const next = readViews(key).filter(v => v.name !== selected);
    writeViews(key, next);
    setViews(next);
    setSelected('');
  }

  return { views, selected, choose, save, remove };
}
