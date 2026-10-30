import { useId, useRef, useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { notify } from '@/lib/store';
import { useSavedViews } from '@/lib/savedViews';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

// "View" select with Default and the saved views of one screen (uplift plan 3.5). Picking a view applies it through applyState.
// Save opens an inline name row (Enter saves, Esc cancels; no browser prompt). Delete shows only when a saved view is selected.
// Every control is 44px tall. The row wraps, so nothing scrolls sideways at 360px.
export function SavedViews({ screenKey, getState, applyState, className }) {
  const { views, selected, choose, save, remove } = useSavedViews(screenKey, getState, applyState);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const uid = useId();
  const selectRef = useRef(null);
  const openRef = useRef(null);
  const errorId = uid + '-error';

  function openNaming() {
    setDraft('');
    setError('');
    setNaming(true);
  }
  function hideNaming() {
    setNaming(false);
    setDraft('');
    setError('');
  }
  // Cancel and Esc return focus to the button that opened the row, since the row's input leaves the page.
  function closeNaming() {
    hideNaming();
    if (openRef.current) openRef.current.focus();
  }
  function onSubmit(e) {
    e.preventDefault();
    const r = save(draft);
    if (r.error) { setError(r.error); return; }
    hideNaming();
    notify('View saved: ' + r.name);
    if (selectRef.current) selectRef.current.focus();
  }
  function onDelete() {
    remove();
    notify('View deleted');
    if (selectRef.current) selectRef.current.focus();
  }

  return (
    <div className={cn('grid min-w-0 gap-2', className)} data-testid="saved-views">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid w-44 max-w-full gap-1.5">
          <label htmlFor={uid + '-select'} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">View</label>
          <NativeSelect ref={selectRef} id={uid + '-select'} className="h-11" value={selected} onChange={e => choose(e.target.value)}>
            <NativeSelectOption value="">Default</NativeSelectOption>
            {views.map(v => <NativeSelectOption key={v.name} value={v.name}>{v.name}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <Button ref={openRef} type="button" variant="outline" className="h-11" onClick={openNaming}><Bookmark />Save current view as...</Button>
        {selected ? <Button type="button" variant="ghost" className="h-11" onClick={onDelete}><Trash2 />Delete view</Button> : null}
      </div>
      {naming ? (
        <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2">
          <div className="grid min-w-0 flex-1 basis-56 gap-1.5">
            <Input id={uid + '-name'} autoFocus aria-label="View name" placeholder="View name" autoComplete="off" className="h-11"
              value={draft} onChange={e => { setDraft(e.target.value); if (error) setError(''); }}
              aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
              onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNaming(); } }} />
            {error ? <p id={errorId} role="alert" className="text-xs font-medium text-bad">{error}</p> : null}
          </div>
          <Button type="submit" className="h-11">Save view</Button>
          <Button type="button" variant="ghost" className="h-11" onClick={closeNaming}>Cancel</Button>
        </form>
      ) : null}
    </div>
  );
}
