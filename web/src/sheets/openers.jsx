import { useMemo } from 'react';
import { notify, useApp, useSheets } from '@/lib/store';
import { VIEW_ONLY_SHEETS, canOpenSheet } from '@/lib/roles';
import { CustomerNoteSheet, CustomerSheet, EditCustomerSheet, MergeCustomerSheet } from '@/sheets/customer';
import { EntrySheet } from '@/sheets/entry';
import { EndLineSheet } from '@/sheets/line';
import { EditPaymentSheet } from '@/sheets/payment';
import { EditSaleSheet, NewSaleSheet, RenewSheet } from '@/sheets/sale';
import { ExpenseSheet, MatchSheet, PaySheet, PurchaseSheet } from '@/sheets/money';
import {
  AccountsSheet, AddAccountSheet, AddBatchSheet, AddSupplierSheet, BatchesSheet, CodesSheet,
  EditAccountSheet, EditBatchSheet, EditProductSheet, EditSupplierSheet, ProductSheet, RetireAccountSheet, SuppliersSheet, WalletsSheet
} from '@/sheets/catalog';
import { ReminderSheet } from '@/sheets/message';
import { GotPaidRequestSheet, PayRequestSheet } from '@/sheets/payrequest';
import { AddWidgetSheet, BudgetSheet, GoalSheet } from '@/sheets/goals';
import { MessageSheet, PayMethodsSheet, ProductTemplatesSheet, RateCalculatorSheet, SettingsSheet } from '@/sheets/misc';
import { ShortcutsSheet } from '@/sheets/shortcuts';
import { FulfilOrderSheet, NewOrderSheet } from '@/sheets/orders';
import { ApiKeysSheet, NewApiKeySheet, NewWebhookSheet, WebhooksSheet } from '@/sheets/api';

/** useOpeners() -> one function per sheet. Each pushes a panel onto the sheet stack. */
export function useOpeners() {
  const sheets = useSheets();
  const { role } = useApp();
  return useMemo(() => {
    const o = el => sheets.open(el);
    const api = {
      customer: id => o(<CustomerSheet id={id} openers={api} />),
      editCustomer: c => o(<EditCustomerSheet customer={c} />),
      newSale: preset => o(<NewSaleSheet preset={preset || {}} openers={api} />),
      pay: arg => o(<PaySheet arg={arg} />),
      renew: subCode => o(<RenewSheet subCode={subCode} />),
      match: trx => o(<MatchSheet trx={trx} />),
      editSale: h => o(<EditSaleSheet sale={h} />),
      editPayment: p => o(<EditPaymentSheet payment={p} />),
      endLine: sale => o(<EndLineSheet sale={sale} />),
      mergeCustomer: c => o(<MergeCustomerSheet customer={c} />),
      customerNote: c => o(<CustomerNoteSheet customer={c} />),
      entry: (kind, id) => o(<EntrySheet kind={kind} id={id} />),
      editProduct: id => o(<EditProductSheet productId={id} />),
      newOrder: () => o(<NewOrderSheet />),
      fulfilOrder: order => o(<FulfilOrderSheet order={order} />),
      expense: () => o(<ExpenseSheet />),
      shortcuts: () => o(<ShortcutsSheet />),
      purchase: accountId => o(<PurchaseSheet accountId={accountId} />),
      product: onCreated => o(<ProductSheet onCreated={onCreated} />),
      editAccount: a => o(<EditAccountSheet account={a} />),
      retireAccount: a => o(<RetireAccountSheet account={a} />),
      accounts: () => o(<AccountsSheet openers={api} />),
      addAccount: productId => o(<AddAccountSheet productId={productId} />),
      wallets: () => o(<WalletsSheet />),
      suppliers: () => o(<SuppliersSheet openers={api} />),
      addSupplier: () => o(<AddSupplierSheet />),
      editSupplier: id => o(<EditSupplierSheet id={id} />),
      batches: () => o(<BatchesSheet openers={api} />),
      addBatch: () => o(<AddBatchSheet />),
      editBatch: id => o(<EditBatchSheet id={id} />),
      codes: () => o(<CodesSheet />),
      settings: () => o(<SettingsSheet />),
      payRequest: () => o(<PayRequestSheet />),
      gotPaidRequest: r => o(<GotPaidRequestSheet request={r} />),
      payMethods: () => o(<PayMethodsSheet />),
      calculator: () => o(<RateCalculatorSheet />),
      reminder: arg => o(<ReminderSheet saleId={arg.saleId} kind={arg.kind} customerId={arg.customerId} />),
      productTemplates: id => o(<ProductTemplatesSheet productId={id} />),
      addWidget: (items, onAdd) => o(<AddWidgetSheet items={items} onAdd={onAdd} />),
      goal: g => o(<GoalSheet goal={g} />),
      budget: b => o(<BudgetSheet budget={b} />),
      message: text => o(<MessageSheet text={text} />),
      apiKeys: () => o(<ApiKeysSheet openers={api} />),
      newApiKey: after => o(<NewApiKeySheet after={after} />),
      webhooks: () => o(<WebhooksSheet openers={api} />),
      newWebhook: after => o(<NewWebhookSheet after={after} />)
    };
    // A viewer opens no sale, payment or edit sheet: every such entry point goes through here (src/lib/roles.js).
    VIEW_ONLY_SHEETS.forEach(name => {
      const open = api[name];
      if (!open) return;
      api[name] = (...args) => (canOpenSheet(role, name) ? open(...args) : notify('View only: this login cannot change sales or payments.'));
    });
    return api;
  }, [sheets, role]);
}
