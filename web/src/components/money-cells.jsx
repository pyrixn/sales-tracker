import { EditableDate, EditableNote, EditableNumber, EditableSelect } from '@/components/inline';
import { METHODS } from '@/lib/format';
import { useApp, useInlineSave } from '@/lib/store';

// The editable cells of one money row (a payment, an expense or an account purchase). Each cell saves on its own through its own
// one-field action, so each has its own Undo. Locked fields come from the server (`locked`, a map of field to reason): the cell is
// shown disabled with that reason, and nothing is sent. No rule is repeated here.
// Every field is also exported on its own, so the Book table can put each one in its own column. The *Cells composites render a
// whole row in order (the phone card and the customer sheet).

// A saved value the list does not know (an old method, a retired account) stays selectable, so the cell shows what is stored.
function withCurrent(values, current) {
  return !current || values.includes(current) ? values : values.concat(current);
}

// Book rows show the money sign and colour (income +, expense and purchase -); the customer sheet shows plain figures.
const IN = { sign: '+', tone: 'ok', srText: 'income' };
const OUT = { sign: '−', tone: 'bad', srText: 'expense' };

/** Amount of a payment. Sent as editPayment { paymentId, amount }. */
export function PaymentAmount({ id, target, amount, locked = {}, signed = false, align }) {
  const save = useInlineSave('editPayment', v => ({ paymentId: id, amount: v }));
  return (
    <EditableNumber field="Amount" target={target} value={amount} onSave={save} mono {...(signed ? IN : {})} align={align}
      disabled={!!locked.amount} disabledReason={locked.amount} />
  );
}

/** Date of a payment. Sent as editPayment { paymentId, date }. */
export function PaymentDate({ id, target, date, locked = {} }) {
  const save = useInlineSave('editPayment', v => ({ paymentId: id, date: v }));
  return (
    <EditableDate field="Date" target={target} value={date || ''} onSave={save} allowBlank={false} mono placeholder="Before the app"
      disabled={!!locked.date} disabledReason={locked.date} />
  );
}

/** Method of a payment. Sent as editPayment { paymentId, method }. */
export function PaymentMethod({ id, target, method, locked = {} }) {
  const save = useInlineSave('editPayment', v => ({ paymentId: id, method: v }));
  const options = [{ value: '', label: 'No method' }].concat(withCurrent(METHODS, method).map(m => ({ value: m, label: m })));
  return (
    <EditableSelect field="Method" target={target} value={method || ''} options={options} onSave={save} allowBlank
      disabled={!!locked.method} disabledReason={locked.method} />
  );
}

/** Note of a payment. Sent as editPayment { paymentId, note }. */
export function PaymentNote({ id, target, note, locked = {} }) {
  const save = useInlineSave('editPayment', v => ({ paymentId: id, note: v }));
  return (
    <EditableNote field="Note" target={target} value={note || ''} onSave={save} placeholder="Add a note"
      disabled={!!locked.note} disabledReason={locked.note} />
  );
}

/** Amount, Date, Method and Note of a payment. */
export function PaymentCells({ id, target, amount, date, method, note, locked = {}, signed = false }) {
  return (
    <>
      <PaymentAmount id={id} target={target} amount={amount} locked={locked} signed={signed} />
      <PaymentDate id={id} target={target} date={date} locked={locked} />
      <PaymentMethod id={id} target={target} method={method} locked={locked} />
      <PaymentNote id={id} target={target} note={note} locked={locked} />
    </>
  );
}

/** Amount of an expense. Sent as editExpense { expenseId, amount }. */
export function ExpenseAmount({ id, target, amount, align }) {
  const save = useInlineSave('editExpense', v => ({ expenseId: id, amount: v }));
  return <EditableNumber field="Amount" target={target} value={amount} onSave={save} mono {...OUT} align={align} />;
}

/** Date of an expense. Sent as editExpense { expenseId, date }. */
export function ExpenseDate({ id, target, date }) {
  const save = useInlineSave('editExpense', v => ({ expenseId: id, date: v }));
  return <EditableDate field="Date" target={target} value={date || ''} onSave={save} allowBlank={false} mono />;
}

/** Category of an expense. Sent as editExpense { expenseId, category }. */
export function ExpenseCategory({ id, target, category }) {
  const { lookups: L } = useApp();
  const save = useInlineSave('editExpense', v => ({ expenseId: id, category: v }));
  const options = withCurrent(L.expenseCategories || [], category).map(c => ({ value: c, label: c }));
  return <EditableSelect field="Category" target={target} value={category || ''} options={options} onSave={save} />;
}

/** Note of an expense. Sent as editExpense { expenseId, note }. */
export function ExpenseNote({ id, target, note }) {
  const save = useInlineSave('editExpense', v => ({ expenseId: id, note: v }));
  return <EditableNote field="Note" target={target} value={note || ''} onSave={save} placeholder="Add a note" />;
}

/** Amount, Date, Category and Note of an expense. */
export function ExpenseCells({ id, target, amount, date, category, note }) {
  return (
    <>
      <ExpenseAmount id={id} target={target} amount={amount} />
      <ExpenseDate id={id} target={target} date={date} />
      <ExpenseCategory id={id} target={target} category={category} />
      <ExpenseNote id={id} target={target} note={note} />
    </>
  );
}

/** Amount of an account purchase. Sent as editPurchase { purchaseId, amount }. */
export function PurchaseAmount({ id, target, amount, align }) {
  const save = useInlineSave('editPurchase', v => ({ purchaseId: id, amount: v }));
  return <EditableNumber field="Amount" target={target} value={amount} onSave={save} mono {...OUT} align={align} />;
}

/** Date of an account purchase. Sent as editPurchase { purchaseId, date }. */
export function PurchaseDate({ id, target, date }) {
  const save = useInlineSave('editPurchase', v => ({ purchaseId: id, date: v }));
  return <EditableDate field="Date" target={target} value={date || ''} onSave={save} allowBlank={false} mono />;
}

/** Account of an account purchase. Sent as editPurchase { purchaseId, accountId }. */
export function PurchaseAccount({ id, target, accountId }) {
  const { lookups: L } = useApp();
  const save = useInlineSave('editPurchase', v => ({ purchaseId: id, accountId: v }));
  const known = (L.accounts || []).map(a => a.id);
  const options = (L.accounts || []).map(a => ({ value: a.id, label: a.id + ' · ' + a.label }))
    .concat(known.includes(accountId) || !accountId ? [] : [{ value: accountId, label: accountId }]);
  return <EditableSelect field="Account" target={target} value={accountId || ''} options={options} onSave={save} />;
}

/** Note of an account purchase. Sent as editPurchase { purchaseId, notes }. */
export function PurchaseNotes({ id, target, notes }) {
  const save = useInlineSave('editPurchase', v => ({ purchaseId: id, notes: v }));
  return <EditableNote field="Note" target={target} value={notes || ''} onSave={save} placeholder="Add a note" />;
}

/** Amount, Date, Account and Note of an account purchase. */
export function PurchaseCells({ id, target, amount, date, accountId, notes }) {
  return (
    <>
      <PurchaseAmount id={id} target={target} amount={amount} />
      <PurchaseDate id={id} target={target} date={date} />
      <PurchaseAccount id={id} target={target} accountId={accountId} />
      <PurchaseNotes id={id} target={target} notes={notes} />
    </>
  );
}
