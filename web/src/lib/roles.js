// Panel-side role rules. Display only: the Edge Function refuses what a role may not do, whatever the panel shows.
// role comes from init (me.role): 'owner', 'staff' or 'viewer'. Before init it is '' and nothing is hidden.

// Sheets that change sales, payments or customers. A viewer gets a "view only" note instead of the sheet.
export const VIEW_ONLY_SHEETS = ['newSale', 'pay', 'renew', 'match', 'editSale', 'editPayment', 'endLine', 'editCustomer',
  'mergeCustomer', 'customerNote', 'payRequest', 'gotPaidRequest', 'expense', 'purchase', 'editAccount'];

/** canOpenSheet(role, name) -> false only for a viewer opening one of the write sheets. */
export function canOpenSheet(role, name) {
  if (role !== 'viewer') return true;
  return VIEW_ONLY_SHEETS.indexOf(name) < 0;
}
