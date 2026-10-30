import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Search } from 'lucide-react';
import { shortDate, toCsv, tk } from '@/lib/format';
import { saveText } from '@/lib/download';
import { copyText } from '@/lib/reminders';
import { cn } from '@/lib/utils';
import { notify, useApp } from '@/lib/store';
import { useOpeners } from '@/sheets/openers';
import { Avatar, Chevron, Chip, DaysPill, Empty, Pill, Row, Section, useMedia } from '@/components/kit';
import { BulkBar } from '@/components/BulkBar';
import { CustomerWorkspace } from '@/components/CustomerWorkspace';
import { DataTable as Grid } from '@/components/DataTable';
import { SavedViews } from '@/components/SavedViews';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { cleanSorting, cleanVisibility, oneOf } from '@/lib/savedViews';

const FILTERS = [['all', 'All'], ['owes', 'Owes'], ['credit', 'Credit'], ['soon', 'Expiring']];
const SORTS = ['name', 'owes', 'recent'];
const COLUMN_IDS = ['name', 'contact', 'lines', 'owes', 'credit', 'renewal'];

// Per customer: how many active lines, and the line that renews first (earliest paidTill). From lookups.lines, no extra read.
function lineSummary(lines) {
  const by = new Map();
  lines.forEach(l => {
    let s = by.get(l.customerId);
    if (!s) { s = { count: 0, next: null }; by.set(l.customerId, s); }
    s.count++;
    if (l.paidTill && (!s.next || l.paidTill < s.next.paidTill)) s.next = l;
  });
  return by;
}

// id: the customer in the route (#/customers/<id>), or null for the list. onGo moves to a route; onSwap replaces the route (the workspace list).
export function Customers({ id = null, onGo, onSwap }) {
  const { lookups: L, today } = useApp();
  const open = useOpeners();
  const wide = useMedia('(min-width: 768px)');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [tableSort, setTableSort] = useState([]);   // the table's own column sorting (saved views keep it)
  const [colVis, setColVis] = useState({});         // the table's column visibility (saved views keep it)
  const clearRef = useRef(null);   // the table's own selection, cleared from the bulk bar
  const dq = useDeferredValue(q);

  // Saved views (uplift 3.5): applyView(null) is the Default view.
  const viewState = () => ({ q, sort, filter, tableSort, columns: colVis });
  function applyView(s) {
    const v = s || {};
    setQ(typeof v.q === 'string' ? v.q : '');
    setSort(oneOf(v.sort, SORTS, 'name'));
    setFilter(oneOf(v.filter, FILTERS.map(f => f[0]), 'all'));
    setTableSort(cleanSorting(v.tableSort, COLUMN_IDS));
    setColVis(cleanVisibility(v.columns, COLUMN_IDS));
  }

  const soon = useMemo(() => {
    const ids = new Set();
    (L.lines || []).forEach(l => { if (l.daysLeft !== null && l.daysLeft !== undefined && l.daysLeft <= 7) ids.add(l.customerId); });
    return ids;
  }, [L.lines]);
  const summary = useMemo(() => lineSummary(L.lines || []), [L.lines]);

  const all = L.customers;
  const counts = {
    all: all.length,
    owes: all.filter(c => c.owes > 0).length,
    credit: all.filter(c => c.credit > 0).length,
    soon: all.filter(c => soon.has(c.id)).length
  };

  const rows = useMemo(() => {
    const s = dq.trim().toLowerCase();
    let list = all.filter(c => !s || c.name.toLowerCase().indexOf(s) >= 0 || String(c.handle).toLowerCase().indexOf(s) >= 0);
    if (filter === 'owes') list = list.filter(c => c.owes > 0);
    else if (filter === 'credit') list = list.filter(c => c.credit > 0);
    else if (filter === 'soon') list = list.filter(c => soon.has(c.id));
    if (sort === 'owes') list = list.slice().sort((a, b) => b.owes - a.owes);
    else if (sort === 'recent') list = list.slice().reverse();
    else list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [all, dq, filter, sort, soon]);

  // Table columns (md and up). Sorting here is on top of the order the select gives.
  const columns = useMemo(() => [
    { id: 'name', accessorFn: c => c.name, header: 'Name', meta: { label: 'Name' },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={row.original.name} className="size-8" />
          <span className="truncate font-bold">{row.original.name}</span>
        </span>
      ) },
    { id: 'contact', accessorFn: c => (c.channel ? c.channel + ' ' + c.handle : ''), header: 'Contact', meta: { label: 'Contact', hideBelow: 'lg' },
      cell: ({ row }) => (row.original.channel
        ? <span className="truncate">{row.original.channel + ' · '}<span className="money">{row.original.handle}</span></span>
        : <span className="text-muted-foreground">no contact</span>) },
    { id: 'lines', accessorFn: c => (summary.get(c.id) || { count: 0 }).count, header: 'Lines',
      meta: { label: 'Lines', align: 'right', mono: true, width: 'w-20' },
      cell: ({ row }) => (summary.get(row.original.id) || { count: 0 }).count },
    { id: 'owes', accessorKey: 'owes', header: 'Owes', meta: { label: 'Owes', align: 'right', mono: true, width: 'w-28' },
      cell: ({ row }) => (row.original.owes ? <span className="text-bad">{tk(row.original.owes)}</span> : <span className="text-muted-foreground">—</span>) },
    { id: 'credit', accessorKey: 'credit', header: 'Credit', meta: { label: 'Credit', align: 'right', mono: true, width: 'w-28' },
      cell: ({ row }) => (row.original.credit ? <span className="text-ok">{tk(row.original.credit)}</span> : <span className="text-muted-foreground">—</span>) },
    { id: 'renewal', accessorFn: c => ((summary.get(c.id) || {}).next || {}).paidTill || '', header: 'Next renewal',
      meta: { label: 'Next renewal', width: 'w-48' },
      cell: ({ row }) => {
        const next = (summary.get(row.original.id) || {}).next;
        return next
          ? <span className="flex min-w-0 items-center gap-2"><span>{shortDate(next.paidTill)}</span><DaysPill days={next.daysLeft} /></span>
          : <span className="text-muted-foreground">no line</span>;
      } }
  ], [summary]);

  const count = rows.length;

  // Selected customers that are on screen. The table drops a selection the search hides, so this matches what it reports.
  const picked = useMemo(() => {
    const set = new Set(selectedIds);
    return rows.filter(c => set.has(String(c.id)));
  }, [rows, selectedIds]);
  const selCount = wide ? picked.length : 0;
  // Leaving the wide table empties the selection, so coming back does not show rows picked before.
  useEffect(() => { if (!wide) setSelectedIds(prev => (prev.length ? [] : prev)); }, [wide]);
  // On a phone there is no workspace: #/customers/<id> opens the customer sheet over the list.
  useEffect(() => { if (id && !wide) open.customer(id); }, [id, wide]);

  function clearSelection() {
    if (clearRef.current) clearRef.current();
    setSelectedIds([]);
  }
  function exportSelected() {
    saveText('customers-selected-' + today + '.csv', toCsv(['Customer', 'Channel', 'Handle', 'Owes', 'Credit'],
      picked.map(c => [c.name, c.channel, c.handle, c.owes, c.credit])));
    notify('Exported ' + picked.length + (picked.length === 1 ? ' customer' : ' customers'));
  }
  // One handle per line. Customers with no contact are left out and the message says how many.
  async function copyHandles() {
    const handles = picked.map(c => String(c.handle || '').trim()).filter(Boolean);
    if (!handles.length) { notify('None of the selected customers has a contact'); return; }
    const ok = await copyText(handles.join('\n'));
    const skipped = picked.length - handles.length;
    notify(ok
      ? 'Copied ' + handles.length + (handles.length === 1 ? ' handle' : ' handles') + (skipped ? ', ' + skipped + ' with no contact left out' : '')
      : 'Could not copy: the browser blocked the clipboard');
  }

  // md and up with a customer in the route: the workspace (list and detail side by side) replaces the table.
  if (id && wide) {
    return (
      <CustomerWorkspace id={id} customers={L.customers} onPick={cid => onSwap('customers/' + encodeURIComponent(cid))}
        onBack={() => onGo('customers')} />
    );
  }

  return (
    <div className={cn('mx-auto grid min-w-0 gap-4', wide ? 'max-w-5xl' : 'max-w-3xl')}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input id="custSearch" type="search" placeholder="Search customers" aria-label="Search customers" autoComplete="off" className="h-11 pl-9" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="w-36 shrink-0">
          <NativeSelect id="custSort" aria-label="Sort customers" className="h-11" value={sort} onChange={e => setSort(e.target.value)}>
            <NativeSelectOption value="name">A – Z</NativeSelectOption>
            <NativeSelectOption value="owes">Owes most</NativeSelectOption>
            <NativeSelectOption value="recent">Recent first</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      <SavedViews screenKey="customers" getState={viewState} applyState={applyView} />
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Filter customers">
        {FILTERS.map(([k, label]) => <Chip key={k} pressed={filter === k} onClick={() => setFilter(k)} className="shrink-0">{label + ' · ' + counts[k]}</Chip>)}
      </div>
      {wide ? (
        <div data-testid="cust-list" data-selected={selectedIds.length} className="grid min-w-0 gap-2">
          <div className="flex items-center gap-2 px-1">
            <h2 className="flex-1 text-sm font-extrabold tracking-tight">Customers</h2>
            <span data-testid="cust-count" className="font-mono text-xs text-muted-foreground">{count}</span>
          </div>
          <Grid label="Customers" columns={columns} data={rows} getRowId={c => c.id} onRowClick={c => onGo('customers/' + encodeURIComponent(c.id))}
            selectable onSelectionChange={setSelectedIds} clearRef={clearRef}
            sorting={tableSort} onSortingChange={setTableSort} columnVisibility={colVis} onColumnVisibilityChange={setColVis}
            empty={<div className="rounded-xl border border-border bg-card"><Empty art="people">No customer matches.</Empty></div>} />
        </div>
      ) : (
        <Section title="Customers" count={count} testId="cust-list">
          {rows.length ? rows.map(c => (
            <Row key={c.id} onClick={() => open.customer(c.id)} lead={<Avatar name={c.name} />} title={c.name}
              detail={c.channel ? c.channel + ' · ' + c.handle : 'no contact'}
              trail={(
                <div className="flex shrink-0 items-center gap-2">
                  {c.owes ? <Pill tone="bad">{'owes ' + tk(c.owes)}</Pill> : c.credit ? <Pill tone="ok">{'credit ' + tk(c.credit)}</Pill> : null}
                  <Chevron />
                </div>
              )} />
          )) : <Empty art="people">No customer matches.</Empty>}
        </Section>
      )}
      <BulkBar count={selCount} onClear={clearSelection}>
        <Button type="button" variant="outline" size="sm" onClick={exportSelected}><Download />Export selected CSV</Button>
        <Button type="button" variant="outline" size="sm" onClick={copyHandles}><Copy />Copy phone/handle list</Button>
      </BulkBar>
    </div>
  );
}
