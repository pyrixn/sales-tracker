import { useState } from 'react';
import { useApp, useSaver } from '@/lib/store';
import { ErrorBox, Field, Hint, SaveButton, SheetShell, Stack } from '@/components/kit';
import { productShort } from '@/lib/format';
import { Input } from '@/components/ui/input';

/**
 * End one subscription line on a date. Payments and cost stay on record; the line moves to the
 * Retired log in Accounts, which shows collected, cost and net. (No preview here: the figures are
 * computed by the server when the line ends and shown in Accounts.)
 */
export function EndLineSheet({ sale }) {
  const { today } = useApp();
  const [date, setDate] = useState(today);
  const { save, busy, error } = useSaver('endLine', () => {
    if (!date) throw new Error('Pick the last day of the line.');
    return { saleId: Number(sale.saleId), date };
  }, { keepParent: true });
  return (
    <SheetShell title="End line" description="Stop a subscription line and keep its history"
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>End line</SaveButton></Stack>}>
      <Stack>
        <Hint>{sale.name + ' · ' + productShort(sale.productName) + ' · ref ' + sale.subCode}</Hint>
        <Field label="Last day" id="elDate"><Input id="elDate" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Hint>The line stops here and leaves the active lists. Its payments and cost stay on record, and it shows under Retired in Accounts. An ended line cannot be renewed; sell a new one instead.</Hint>
      </Stack>
    </SheetShell>
  );
}
