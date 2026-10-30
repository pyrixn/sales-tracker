import { useApp, useSaver, useSheetClose } from '@/lib/store';
import { useState } from 'react';
import { num } from '@/lib/format';
import { ErrorBox, Field, Hint, Row, SaveButton, SheetShell, Stack, Two } from '@/components/kit';
import { Options } from '@/sheets/sale';
import { DeleteButton } from '@/sheets/catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

function Footer({ error, busy, onSave, children, extra }) {
  return <Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={onSave}>{children}</SaveButton>{extra}</Stack>;
}

export const GOAL_METRICS = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'profit', label: 'Profit' },
  { value: 'collected', label: 'Money collected' },
  { value: 'new_customers', label: 'New customers' }
];
const GOAL_STATUSES = ['Active', 'Done', 'Dropped'];

const monthStart = d => String(d).slice(0, 8) + '01';
function monthEnd(d) {
  const y = Number(String(d).slice(0, 4)), m = Number(String(d).slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return String(d).slice(0, 8) + String(last).padStart(2, '0');
}
const need = (v, label) => {
  const n = num(v, label);
  if (n === null) throw new Error(label + ' is required.');
  return n;
};

// ── Add widget menu ───────────────────────────────────────────────────
/** items: [{ id, title, description, icon }]. Picking one closes this sheet, then calls onAdd(id). */
export function AddWidgetSheet({ items, onAdd }) {
  const close = useSheetClose();
  return (
    <SheetShell title="Add a widget" description="Pick a card to put on the dashboard">
      {items.length ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/80">
          {items.map(it => {
            const Icon = it.icon;
            return (
              <Row key={it.id} wrap
                lead={<span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/10 text-muted-foreground">{Icon ? <Icon className="size-4" /> : null}</span>}
                title={it.title} detail={it.description}
                trail={<Button type="button" size="sm" variant="outline" aria-label={'Add ' + it.title} data-widget-add={it.id} onClick={() => { close(); onAdd(it.id); }}>Add</Button>} />
            );
          })}
        </div>
      ) : <Hint>Every widget is already on the dashboard.</Hint>}
    </SheetShell>
  );
}

// ── Goals ─────────────────────────────────────────────────────────────
export function GoalSheet({ goal }) {
  const { today } = useApp();
  const close = useSheetClose();
  const editing = !!goal;
  const [title, setTitle] = useState(goal ? goal.Title : '');
  const [metric, setMetric] = useState(goal ? goal.Metric : 'revenue');
  const [target, setTarget] = useState(goal ? String(goal.Target) : '');
  const [start, setStart] = useState(goal ? goal.Start : monthStart(today));
  const [end, setEnd] = useState(goal ? goal.End : monthEnd(today));
  const [note, setNote] = useState(goal ? goal.Note || '' : '');
  const [status, setStatus] = useState(goal ? goal.Status || 'Active' : 'Active');

  const { save, busy, error } = useSaver('saveGoal', () => {
    if (!title.trim()) throw new Error('Give the goal a title.');
    const body = { title: title.trim(), metric, target: need(target, 'Target'), start, end, note: note.trim() };
    if (editing) { body.goalId = goal.Goal_ID; body.status = status; }
    return body;
  });

  return (
    <SheetShell title={editing ? 'Edit goal' : 'New goal'} description="A target to reach between two dates"
      footer={<Footer error={error} busy={busy} onSave={save}
        extra={editing ? <DeleteButton label="Delete goal" what={'goal ' + goal.Title} action="deleteGoal" payload={{ goalId: goal.Goal_ID }} attr={{ id: 'goalDelete' }} onDone={close} /> : null}>
        {editing ? 'Save goal' : 'Add goal'}</Footer>}>
      <Stack>
        <Field label="Title" id="goalTitle"><Input id="goalTitle" placeholder="e.g. Winter push" value={title} onChange={e => setTitle(e.target.value)} /></Field>
        <Two>
          <Field label="Measure" id="goalMetric"><NativeSelect id="goalMetric" value={metric} onChange={e => setMetric(e.target.value)}><Options list={GOAL_METRICS} /></NativeSelect></Field>
          <Field label="Target" id="goalTarget"><Input id="goalTarget" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Start" id="goalStart"><Input id="goalStart" type="date" value={start} onChange={e => setStart(e.target.value)} /></Field>
          <Field label="End" id="goalEnd"><Input id="goalEnd" type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field>
        </Two>
        {editing ? (
          <Field label="Status" id="goalStatus"><NativeSelect id="goalStatus" value={status} onChange={e => setStatus(e.target.value)}><Options list={GOAL_STATUSES} /></NativeSelect></Field>
        ) : null}
        <Field label="Note (optional)" id="goalNote"><Input id="goalNote" value={note} onChange={e => setNote(e.target.value)} /></Field>
        <Hint>Revenue and profit count sales dated in the period. Money collected counts payments received. Target is in taka, or a head count for new customers.</Hint>
      </Stack>
    </SheetShell>
  );
}

// ── Budgets ───────────────────────────────────────────────────────────
export function BudgetSheet({ budget }) {
  const { lookups: L } = useApp();
  const close = useSheetClose();
  const editing = !!budget;
  const categories = (L.expenseCategories || []).concat(['Account purchases']).filter((c, i, a) => a.indexOf(c) === i);
  const [category, setCategory] = useState(budget ? budget.Category : categories[0]);
  const [limit, setLimit] = useState(budget ? String(budget.Monthly_Limit) : '');
  const [alertPct, setAlertPct] = useState(budget ? String(budget.Alert_Pct || 80) : '80');
  const [active, setActive] = useState(budget ? (budget.Active || 'Yes') : 'Yes');

  const { save, busy, error } = useSaver('saveBudget', () => {
    const body = { category, monthlyLimit: need(limit, 'Monthly limit'), alertPct: need(alertPct, 'Alert level') };
    if (editing) { body.budgetId = budget.Budget_ID; body.active = active === 'Yes'; }
    return body;
  });

  return (
    <SheetShell title={editing ? 'Edit budget' : 'New budget'} description="A monthly spending limit for one category"
      footer={<Footer error={error} busy={busy} onSave={save}
        extra={editing ? <DeleteButton label="Delete budget" what={'budget for ' + budget.Category} action="deleteBudget" payload={{ budgetId: budget.Budget_ID }} attr={{ id: 'budgetDelete' }} onDone={close} /> : null}>
        {editing ? 'Save budget' : 'Add budget'}</Footer>}>
      <Stack>
        <Field label="Category" id="budCategory"><NativeSelect id="budCategory" value={category} onChange={e => setCategory(e.target.value)}><Options list={categories} /></NativeSelect></Field>
        <Two>
          <Field label="Monthly limit" id="budLimit"><Input id="budLimit" inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} /></Field>
          <Field label="Warn at (%)" id="budAlert"><Input id="budAlert" inputMode="numeric" value={alertPct} onChange={e => setAlertPct(e.target.value)} /></Field>
        </Two>
        {editing ? (
          <Field label="Status" id="budActive"><NativeSelect id="budActive" value={active} onChange={e => setActive(e.target.value)}><Options list={[{ value: 'Yes', label: 'Active' }, { value: 'No', label: 'Paused' }]} /></NativeSelect></Field>
        ) : null}
        <Hint>Spending in this category is counted per month. You get a warning at the chosen level and again once the limit is passed.</Hint>
      </Stack>
    </SheetShell>
  );
}
