import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { METHODS, num, productShort, tk } from '@/lib/format';
import { useHoldRefresh, useSaver } from '@/lib/store';
import { ConfirmButton, ErrorBox, Field, Hint, SaveButton, SheetShell, Stack, Two } from '@/components/kit';
import { Options } from '@/sheets/sale';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

/**
 * Edit one payment row. payment: {paymentId, date, saleId ('' for credit), amount, method, trx, lines}
 * where lines are the customer's sales (history rows) the money can be applied to.
 * Only the fields the owner changed are sent. A refusal from the server stays inside the sheet.
 */
export function EditPaymentSheet({ payment: p }) {
  useHoldRefresh();
  const credit = p.saleId === '' || p.saleId === null || p.saleId === undefined;
  const [amount, setAmount] = useState(String(p.amount));
  const [date, setDate] = useState(p.date || '');
  const [method, setMethod] = useState(p.method || '');
  const [trx, setTrx] = useState(p.trx || '');
  const [saleId, setSaleId] = useState(credit ? '' : String(p.saleId));

  const lines = (p.lines || []).filter(l => l.status === 'Active' || String(l.saleId) === String(p.saleId));
  const methods = METHODS.includes(method) || !method ? METHODS : METHODS.concat(method);

  const { save, busy, error } = useSaver('editPayment', () => {
    const v = { paymentId: p.paymentId };
    const amt = num(amount, 'Amount');
    if (!amt) throw new Error('Enter the amount.');
    if (amt !== p.amount) v.amount = amt;
    if (date !== (p.date || '')) v.date = date;
    if (method !== (p.method || '')) v.method = method;
    if (trx.trim() !== (p.trx || '')) v.transactionId = trx.trim();
    if (saleId !== (credit ? '' : String(p.saleId))) v.saleId = saleId === '' ? '' : Number(saleId);
    if (Object.keys(v).length === 1) throw new Error('Nothing changed.');
    return v;
  }, { keepParent: true });
  const remove = useSaver('deletePayment', () => ({ paymentId: p.paymentId }), { keepParent: true });

  const title = credit ? 'Edit credit' : 'Edit payment';
  const problem = error || remove.error;
  return (
    <SheetShell title={title} description={credit ? 'Change a credit the customer holds' : 'Change a recorded payment'}
      footer={<Stack className="gap-3"><ErrorBox>{problem}</ErrorBox><SaveButton busy={busy || remove.busy} onClick={save}>Save changes</SaveButton></Stack>}>
      <Stack>
        <Hint>{p.paymentId + (p.source ? ' · ' + p.source : '')}</Hint>
        <Two>
          <Field label="Amount" id="pAmount"><Input id="pAmount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
          <Field label="Date" id="pDate"><Input id="pDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Method" id="pMethod">
            <NativeSelect id="pMethod" value={method} onChange={e => setMethod(e.target.value)}>
              {method ? null : <NativeSelectOption value="">Not recorded</NativeSelectOption>}
              <Options list={methods} />
            </NativeSelect>
          </Field>
          <Field label="Transaction ID" id="pTrx"><Input id="pTrx" autoComplete="off" value={trx} onChange={e => setTrx(e.target.value)} /></Field>
        </Two>
        <Field label="Applied to" id="pApply" hint="Money above what the line still owes is kept as credit.">
          <NativeSelect id="pApply" value={saleId} onChange={e => setSaleId(e.target.value)}>
            <NativeSelectOption value="">Credit (not applied to a line)</NativeSelectOption>
            {lines.map(l => <NativeSelectOption key={l.saleId} value={String(l.saleId)}>{'#' + l.saleId + ' ' + productShort(l.productName) + ' · ' + l.subCode + (l.owes ? ' · owes ' + tk(l.owes) : '')}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <div className="border-t border-border pt-4">
          <ConfirmButton id="pDelete" label="Delete this payment" icon={Trash2} className="text-bad hover:text-bad" title={credit ? 'Delete this credit?' : 'Delete this payment?'}
            confirmLabel="Delete" description="The customer's balance is recomputed without it. You can undo this right after from the toast." onConfirm={remove.save} />
        </div>
      </Stack>
    </SheetShell>
  );
}
