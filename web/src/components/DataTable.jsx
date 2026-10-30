import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { TableVirtuoso } from 'react-virtuoso';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Desktop data table (uplift plan 3.1). TanStack Table v8 holds the state, react-virtuoso renders long bodies.
// Lazy screens only: this file pulls both libraries in, so import it through lazyScreen, never from App.jsx.
// Columns: TanStack column defs. Memoise the array. meta: { align: 'right' (numbers), mono (money and ids), hideBelow: 'sm' | 'md' | 'lg' | 'xl'
// (column hidden under that breakpoint), width: a Tailwind width class such as 'w-32' (widths keep the virtualised header and body in line),
// label: the name in the Columns menu (default: the column id) }. Columns sort by default; enableSorting: false turns it off.
// Props: data, getRowId(row, index) -> stable string id, label (the table's accessible name), onRowClick(row) (Enter on a focused row, or a
// click on the row), selectable + onSelectionChange(ids) (called with the selected row ids when the selection changes), empty (node shown
// when data is []), defaultColumnVisibility ({ columnId: false }), defaultSorting ([{ id, desc }]),
// getRowProps(row) -> attributes spread on each <tr> (e.g. data-testid), clearRef (a ref object: the screen calls clearRef.current() to empty
// the selection from outside, e.g. a bulk bar's Clear; onSelectionChange then reports []).
// Optional controlled state (saved views, uplift 3.5): sorting + onSortingChange(sorting), columnVisibility + onColumnVisibilityChange(visibility).
// When the value prop is undefined the table keeps its own state, as before.
// Keyboard: one row sits in the tab order. ArrowUp and ArrowDown move, Home and End jump, Enter opens, Space toggles the row when selectable.
// Keys pressed inside a cell's own control (InlineCell, a checkbox) belong to that control.
// Above 60 rows the body is virtualised. The table scrolls inside its own box; the page never scrolls sideways.
// The tbody carries data-cell-group, so InlineCell's Tab moves to the next cell in the row group.

const VIRTUAL_ROWS = 60;
const TABLE = 'w-full min-w-[36rem] table-fixed border-separate border-spacing-0 text-sm';
const PLAIN_BOX = 'relative min-w-0 max-h-[min(70dvh,40rem)] overflow-auto rounded-xl border border-border bg-card';
const VIRTUAL_BOX = 'relative min-w-0 h-[min(70dvh,40rem)] overflow-hidden rounded-xl border border-border bg-card';
const HIDE_BELOW = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' };
// Heights read --density (index.css): 1 comfortable, 0.82 compact at md and up. Phones always get 1, so their rows do not change.
const CELL_H = 'h-[calc(3.5rem*var(--density))]';
const HEAD_H = 'h-[calc(2.5rem*var(--density))]';
const INTERACTIVE = 'button,a,input,select,textarea,label,[role="checkbox"],[data-inline-cell]';

function cellClass(meta, head) {
  return cn(
    'px-3 align-middle border-b border-border',
    head ? HEAD_H : CELL_H,
    head && 'sticky top-0 z-10 bg-card text-left text-xs font-medium text-muted-foreground',
    !head && !meta.select && 'truncate',
    meta.align === 'right' && 'text-right',
    !head && meta.mono && 'money',
    meta.hideBelow && HIDE_BELOW[meta.hideBelow],
    meta.width
  );
}

function HeadCell({ header }) {
  const col = header.column;
  const meta = col.columnDef.meta || {};
  const sortable = col.getCanSort();
  const dir = col.getIsSorted();
  const ariaSort = !sortable ? undefined : dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  const content = flexRender(col.columnDef.header, header.getContext());
  return (
    <th scope="col" aria-sort={ariaSort} className={cellClass(meta, true)}>
      {sortable ? (
        <button type="button" onClick={() => col.toggleSorting(undefined, false)}
          className={cn('-mx-1 inline-flex h-8 max-w-full items-center gap-1 rounded-md px-1 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50', dir && 'text-foreground')}>
          <span className="truncate">{content}</span>
          <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', !dir && 'opacity-50')} />
        </button>
      ) : content}
    </th>
  );
}

function cellsOf(row) {
  return row.getVisibleCells().map(cell => (
    <td key={cell.id} className={cellClass(cell.column.columnDef.meta || {}, false)}>
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </td>
  ));
}

// One row element, shared by the plain body and the virtualised body (Virtuoso passes item, context, children and its own data-* props).
function rowShell(row, ctx, rest, ref, children) {
  const idx = ctx.indexById.get(row.id) ?? 0;
  const extra = ctx.getRowProps ? ctx.getRowProps(row.original) : null;
  return (
    <tr {...rest} {...extra} ref={ref} key={row.id} data-row-index={idx} data-state={row.getIsSelected() ? 'selected' : undefined}
      tabIndex={idx === ctx.focusIdx ? 0 : -1}
      onFocus={e => { if (e.target === e.currentTarget) ctx.onFocusRow(idx); }}
      onKeyDown={e => ctx.onRowKey(e, row, idx)}
      onClick={e => ctx.openRow(e, row)}
      className={cn('transition-colors outline-none hover:bg-muted/50 data-[state=selected]:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        ctx.clickable && 'cursor-pointer')}>
      {children}
    </tr>
  );
}

const VirtualTable = forwardRef(function VirtualTable({ context, ...props }, ref) {
  return <table ref={ref} aria-label={context && context.label} {...props} className={TABLE} />;
});
const VirtualHead = forwardRef(function VirtualHead({ context, ...props }, ref) {
  return <thead ref={ref} {...props} />;
});
const VirtualBody = forwardRef(function VirtualBody({ context, ...props }, ref) {
  return <tbody ref={ref} data-cell-group="" {...props} />;
});
const VirtualRow = forwardRef(function VirtualRow({ item, context, children, ...rest }, ref) {
  return rowShell(item, context, rest, ref, children);
});
const VIRTUAL_COMPONENTS = { Table: VirtualTable, TableHead: VirtualHead, TableBody: VirtualBody, TableRow: VirtualRow };

const SELECT_COLUMN = {
  id: 'select',
  enableSorting: false,
  enableHiding: false,
  meta: { select: true, width: 'w-12', label: 'Select' },
  header: ({ table }) => (
    <Checkbox aria-label="Select all"
      checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false}
      onCheckedChange={v => table.toggleAllRowsSelected(!!v)} />
  ),
  cell: ({ row }) => (
    <Checkbox aria-label="Select row" checked={row.getIsSelected()} disabled={!row.getCanSelect()}
      onCheckedChange={v => row.toggleSelected(!!v)} />
  ),
};

export function DataTable({ columns, data, getRowId, getRowProps, onRowClick, selectable = false, onSelectionChange, clearRef, empty,
  defaultColumnVisibility, defaultSorting, label = '', sorting: sortingProp, onSortingChange, columnVisibility: visibilityProp, onColumnVisibilityChange }) {
  const [sortingState, setSortingState] = useState(defaultSorting || []);
  const [visibilityState, setVisibilityState] = useState(defaultColumnVisibility || {});
  const sorting = sortingProp !== undefined ? sortingProp : sortingState;
  const columnVisibility = visibilityProp !== undefined ? visibilityProp : visibilityState;
  // TanStack passes an updater (or a value); the table keeps the value itself only when the screen does not control it.
  const setSorting = updater => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    if (sortingProp === undefined) setSortingState(next);
    if (onSortingChange) onSortingChange(next);
  };
  const setColumnVisibility = updater => {
    const next = typeof updater === 'function' ? updater(columnVisibility) : updater;
    if (visibilityProp === undefined) setVisibilityState(next);
    if (onColumnVisibilityChange) onColumnVisibilityChange(next);
  };
  const [rowSelection, setRowSelection] = useState({});
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef(null);
  const virtuosoRef = useRef(null);
  const selectionSent = useRef('');
  const onSelectionRef = useRef(onSelectionChange);
  onSelectionRef.current = onSelectionChange;

  const idOf = (row, i) => String(getRowId ? getRowId(row, i) : i);
  const allColumns = useMemo(() => (selectable ? [SELECT_COLUMN, ...columns] : columns), [columns, selectable]);

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getRowId: (row, i) => idOf(row, i),
    enableRowSelection: selectable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const headerRows = table.getHeaderGroups().map(hg => (
    <tr key={hg.id}>{hg.headers.map(h => <HeadCell key={h.id} header={h} />)}</tr>
  ));
  const hideable = table.getAllLeafColumns().filter(c => c.getCanHide());
  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const active = Math.min(focusIdx, Math.max(rows.length - 1, 0));

  // Selected ids that the data no longer holds are dropped, so a count never includes rows the owner cannot see.
  useEffect(() => {
    const present = new Set(data.map((row, i) => idOf(row, i)));
    setRowSelection(prev => {
      const keys = Object.keys(prev);
      if (!keys.some(k => prev[k] && !present.has(k))) return prev;
      const next = {};
      for (const k of keys) if (present.has(k)) next[k] = prev[k];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const ids = Object.keys(rowSelection).filter(k => rowSelection[k]);
    const key = ids.join('\u0001');
    if (key === selectionSent.current) return;
    selectionSent.current = key;
    if (onSelectionRef.current) onSelectionRef.current(ids);
  }, [rowSelection]);

  // The screen can clear the selection from outside (see clearRef in the header comment).
  useEffect(() => {
    if (!clearRef) return undefined;
    clearRef.current = () => setRowSelection({});
    return () => { clearRef.current = null; };
  }, [clearRef]);

  function findRow(i) {
    return rootRef.current ? rootRef.current.querySelector(`tr[data-row-index="${i}"]`) : null;
  }

  // Moves focus to row i. A row Virtuoso has not rendered yet is scrolled to first, then focused on the next frames.
  function moveTo(i, align) {
    setFocusIdx(i);
    const el = findRow(i);
    if (el) { el.focus(); return; }
    if (virtuosoRef.current) virtuosoRef.current.scrollToIndex({ index: i, align });
    let tries = 0;
    const retry = () => {
      const later = findRow(i);
      if (later) later.focus();
      else if (tries++ < 10) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }

  function onRowKey(e, row, idx) {
    if (e.target !== e.currentTarget) return;
    const last = rows.length - 1;
    let to = null;
    if (e.key === 'ArrowDown') to = Math.min(idx + 1, last);
    else if (e.key === 'ArrowUp') to = Math.max(idx - 1, 0);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = last;
    else if (e.key === 'Enter') { if (onRowClick) { e.preventDefault(); onRowClick(row.original); } return; }
    else if (e.key === ' ') { if (selectable && row.getCanSelect()) { e.preventDefault(); row.toggleSelected(); } return; }
    else return;
    e.preventDefault();
    moveTo(to, to < idx ? 'start' : 'end');
  }

  function openRow(e, row) {
    if (!onRowClick) return;
    if (e.target.closest && e.target.closest(INTERACTIVE)) return;
    onRowClick(row.original);
  }

  const ctx = { label, clickable: Boolean(onRowClick), focusIdx: active, indexById, onFocusRow: setFocusIdx, onRowKey, openRow, getRowProps };

  const columnMenu = hideable.length ? (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm"><Columns3 aria-hidden="true" />Columns</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuLabel>Show columns</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {hideable.map(col => (
            <DropdownMenuCheckboxItem key={col.id} checked={col.getIsVisible()} onCheckedChange={v => col.toggleVisibility(!!v)}
              onSelect={e => e.preventDefault()}>
              {(col.columnDef.meta && col.columnDef.meta.label) || col.id}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : null;

  let body;
  if (rows.length === 0) {
    body = empty || <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">Nothing to show.</div>;
  } else if (rows.length > VIRTUAL_ROWS) {
    body = (
      <div ref={rootRef} className={VIRTUAL_BOX}>
        <TableVirtuoso ref={virtuosoRef} data={rows} context={ctx} className="h-full" components={VIRTUAL_COMPONENTS}
          fixedHeaderContent={() => headerRows}
          itemContent={(i, row) => cellsOf(row)} />
      </div>
    );
  } else {
    body = (
      <div ref={rootRef} className={PLAIN_BOX}>
        <table aria-label={label || undefined} className={TABLE}>
          <thead className="sticky top-0 z-10 bg-card">{headerRows}</thead>
          <tbody data-cell-group="">
            {rows.map(row => rowShell(row, ctx, {}, undefined, cellsOf(row)))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {columnMenu}
      {body}
    </div>
  );
}
