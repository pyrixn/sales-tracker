import { useState } from 'react';
import { CHANNELS } from '@/lib/format';
import { useHoldRefresh, useSaver } from '@/lib/store';
import { CustomerDetail, useCustomerData } from '@/components/CustomerDetail';
import { CustomerCombobox, ErrorBox, Field, Hint, NoteBox, SaveButton, SheetShell, Stack, Two } from '@/components/kit';
import { Options } from '@/sheets/sale';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

// The customer sheet: the body lives in components/CustomerDetail.jsx, shared with the desktop customer workspace.
export function CustomerSheet({ id, openers }) {
  const cs = useCustomerData(id);
  if (cs.loading) {
    return <SheetShell title="Customer"><Stack><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></Stack></SheetShell>;
  }
  if (cs.error) return <SheetShell title="Customer"><ErrorBox>{cs.error}</ErrorBox></SheetShell>;
  const c = cs.data.customer;
  return (
    <SheetShell title={c.Name} description="Customer details, subscriptions and payments">
      <CustomerDetail data={cs.data} openers={openers} />
    </SheetShell>
  );
}

export function EditCustomerSheet({ customer: c }) {
  useHoldRefresh();
  const [name, setName] = useState(c.Name);
  const [channel, setChannel] = useState(c.Channel || '');
  const [handle, setHandle] = useState(c.Handle || '');
  const [notes, setNotes] = useState(c.Notes || '');
  const { save, busy, error } = useSaver('edit', () => ({
    kind: 'customer', id: c.Customer_ID, values: { Name: name, Channel: channel, Handle: handle, Notes: notes }
  }));
  return (
    <SheetShell title="Edit customer" description="Change a customer's details"
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save changes</SaveButton></Stack>}>
      <Stack>
        <Field label="Name" id="eName"><Input id="eName" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Two>
          <Field label="Contact via" id="eChannel">
            <NativeSelect id="eChannel" value={channel} onChange={e => setChannel(e.target.value)}>
              <NativeSelectOption value="">—</NativeSelectOption>
              <Options list={CHANNELS} />
            </NativeSelect>
          </Field>
          <Field label="Number or username" id="eHandle"><Input id="eHandle" value={handle} onChange={e => setHandle(e.target.value)} /></Field>
        </Two>
        <Field label="Notes" id="eNotes"><Textarea id="eNotes" rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

/** Just the note on a customer. */
export function CustomerNoteSheet({ customer: c }) {
  const [notes, setNotes] = useState(c.Notes || '');
  const { save, busy, error } = useSaver('edit', () => {
    if (notes === (c.Notes || '')) throw new Error('Nothing changed.');
    return { kind: 'customer', id: c.Customer_ID, values: { Notes: notes } };
  }, { keepParent: true });
  return (
    <SheetShell title="Customer note" description={'A private note on ' + c.Name}
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save note</SaveButton></Stack>}>
      <Stack>
        <Field label={'Note on ' + c.Name} id="cnNotes"><Textarea id="cnNotes" rows={5} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

/** Merge a duplicate customer into the one to keep. customer: {Customer_ID, Name, sales?, payments?}. */
export function MergeCustomerSheet({ customer: c }) {
  const [target, setTarget] = useState(null);
  const { save, busy, error } = useSaver('mergeCustomers', () => {
    if (!target || target.isNew) throw new Error('Pick the customer to keep.');
    if (target.id === c.Customer_ID) throw new Error('Pick a different customer to keep.');
    return { fromId: c.Customer_ID, intoId: target.id };
  });
  const counts = (c.sales !== undefined && c.payments !== undefined)
    ? c.sales + (c.sales === 1 ? ' sale' : ' sales') + ' and ' + c.payments + (c.payments === 1 ? ' payment' : ' payments')
    : 'all sales and payments';
  return (
    <SheetShell title="Merge customers" description={'Merge ' + c.Name + ' into another customer'}
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Merge customers</SaveButton></Stack>}>
      <Stack>
        <Hint>{'Use this when ' + c.Name + ' is a duplicate of someone you already have.'}</Hint>
        <CustomerCombobox id="mgTarget" label="Keep this customer" placeholder="Type a name" exclude={c.Customer_ID} value={target} onChange={t => setTarget(t && !t.isNew ? t : null)} />
        <NoteBox testId="merge-text">
          <span id="mgText">
            {target
              ? 'Moves ' + counts + ' from "' + c.Name + '" to "' + target.name + '". "' + c.Name + '" is then removed, and a note on "' + target.name + '" records the merge.'
              : 'Moves ' + counts + ' from "' + c.Name + '" to the customer you pick. "' + c.Name + '" is then removed.'}
          </span>
        </NoteBox>
        <Hint>You can undo this right after from the toast.</Hint>
      </Stack>
    </SheetShell>
  );
}
