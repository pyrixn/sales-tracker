/** Core.permissions: which staff role may run which API action. Pure: no I/O. The Edge Function asks canDo(role, action) for every call.
 *  Roles: owner (everything), staff (sales, payments, customers; no settings, no delete, no money reports), viewer (read only, no money).
 *  An action missing from ACTIONS is owner only, so a new action is closed until someone lists it here. */
var Core = Core || {};
Core.permissions = (function () {
  var ROLES = ['owner', 'staff', 'viewer'];
  var OWNER = ['owner'];
  var STAFF = ['owner', 'staff'];
  var ALL = ROLES;
  var ACTIONS = {
    // Any signed-in role: who am I.
    me: ALL,
    // Operational reads. Init and home still carry some money tables for every role (see the phase 2 notes): this gate stops money actions, not those reads.
    init: ALL, home: ALL, lookups: ALL, customer: ALL, dues: ALL, payLinks: ALL, payRequests: ALL, deliveries: ALL, product: ALL,
    // Staff reads.
    accounts: STAFF, reminderMessage: STAFF, suggestCustomers: STAFF, inbox: STAFF, reminderLog: STAFF,
    // Money reads: owner only.
    moneyOverview: OWNER, moneyExport: OWNER, book: OWNER, entry: OWNER, profit: OWNER, profitMonthly: OWNER, importReview: OWNER,
    // Insights is a money report; Activity lists every change with old and new values (costs, expenses, settings) and drives Undo, which is owner only.
    insights: OWNER, activity: OWNER,
    // Sales, payments, customers and pay links: owner and staff.
    newSale: STAFF, customSale: OWNER, renew: STAFF, pay: STAFF, edit: STAFF, endLine: STAFF, mergeCustomers: STAFF, editPayment: STAFF,
    createPayRequest: STAFF, cancelPayRequest: STAFF, gotPaidRequest: STAFF, setDelivery: STAFF, match: STAFF, splitMatch: STAFF,
    ignoreInbox: OWNER, remindSent: STAFF,
    // Everything else writes or exports: owner only. Listed explicitly so the choice is visible.
    retireAccount: OWNER, deleteAccount: OWNER, deletePayment: OWNER, editExpense: OWNER, deleteExpense: OWNER, addExpense: OWNER,
    editPurchase: OWNER, deletePurchase: OWNER, addPurchase: OWNER, addAccount: OWNER, addCodes: OWNER, addCodesBatch: OWNER, addWallet: OWNER,
    editSupplier: OWNER, deleteSupplier: OWNER, addSupplier: OWNER, editBatch: OWNER, deleteBatch: OWNER, saveGoal: OWNER, deleteGoal: OWNER,
    saveBudget: OWNER, deleteBudget: OWNER, saveLayout: OWNER, snapshotIfDue: OWNER, refreshRate: OWNER, backfillPayTokens: OWNER,
    saveTemplate: OWNER, settings: OWNER, addProduct: OWNER, editProduct: OWNER, deleteInbox: OWNER,
    importStage: OWNER, importAdd: OWNER, importEdit: OWNER, importDelete: OWNER, importStatus: OWNER, importApply: OWNER,
    undo: OWNER, export: OWNER,
    // Login details vault: staff may list, add and reveal (with the PIN); only the owner deletes or changes the PIN. Viewers never.
    vaultList: STAFF, vaultSave: STAFF, vaultReveal: STAFF, vaultDelete: OWNER, vaultSetPin: OWNER,
    // Delivery messages: staff make one (PIN needed); only the owner writes the templates.
    deliveryTemplates: STAFF, deliveryMessage: STAFF, deliveryTemplateSave: OWNER, deliveryTemplateDelete: OWNER,
    staffList: OWNER, staffInvite: OWNER, staffUpdate: OWNER,
    // Orders, the public API, webhooks, notifications, scheduled jobs: owner only (staff see an order's pay link and sale through the normal actions).
    orders: OWNER, createOrder: OWNER, orderStatus: OWNER, fulfilOrder: OWNER, editProductPublic: OWNER,
    createApiKey: OWNER, revokeApiKey: OWNER, saveWebhook: OWNER, resendWebhook: OWNER, apiKeys: OWNER, webhooks: OWNER, sendWebhooks: OWNER,
    notifyStatus: OWNER, sendNotifications: OWNER, jobs: OWNER,
    // Names that edge.js also uses for cron job runners and public routes (not role-checked actions); closed to non-owners all the same.
    rate: OWNER, backup: OWNER, cleanup: OWNER, notify: OWNER, products: OWNER, order: OWNER, portal: OWNER
  };

  function isRole(role) { return ROLES.indexOf(role) >= 0; }
  /** canDo('staff', 'pay') -> true. Unknown role or unknown action: false for every role but owner on unlisted actions. */
  function canDo(role, action) {
    if (!isRole(role)) return false;
    var allowed = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : OWNER;
    return allowed.indexOf(role) >= 0;
  }
  // Money fields that a non-owner never receives in any answer (reads and write replies alike). Matched by key name at any depth,
  // so the rule holds for init, home, lookups, accounts, product and the rest without listing each action. `cycle` (billing days)
  // and `rate` (the USDT rate in use) are not money owed or spent and stay.
  var MONEY_KEYS = ['cost', 'costSnapshot', 'budgets', 'suppliers', 'expenseCategories', 'totals', 'net', 'collected', 'profit',
    'expenses', 'purchases', 'markup', 'margin',
    // Accrual (profitMonthly) and product-profit output, in case a later read embeds them in a staff-visible answer.
    'byProduct', 'byAccount', 'costMissing', 'rateMissing', 'marginPct', 'revenue'];
  var REDACT = { owner: [], staff: MONEY_KEYS, viewer: MONEY_KEYS };

  function stripKeys(v, keys) {
    if (Array.isArray(v)) return v.map(function (x) { return stripKeys(x, keys); });
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { if (keys.indexOf(k) < 0) o[k] = stripKeys(v[k], keys); });
      return o;
    }
    return v;
  }
  /** redactFor(role, action, data) -> a copy of data without the money fields this role may not see. The owner gets data unchanged.
   *  An unknown role gets the most restricted view. The action is kept for callers and future per-action rules. */
  function redactFor(role, action, data) {
    if (role === 'owner') return data;
    var keys = Object.prototype.hasOwnProperty.call(REDACT, role) ? REDACT[role] : MONEY_KEYS;
    return stripKeys(data, keys);
  }
  return { ROLES: ROLES, ACTIONS: ACTIONS, MONEY_KEYS: MONEY_KEYS, isRole: isRole, canDo: canDo, redactFor: redactFor };
})();
if (typeof module !== 'undefined') module.exports = Core.permissions;
