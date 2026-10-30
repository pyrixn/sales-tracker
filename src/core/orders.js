/**
 * Core.orders: an order is one product for one customer. Creating it opens a pay request (with no product on it, so no code is
 * reserved and no sale exists yet). Fulfilling a Paid order creates the sale through Core.sales.planNewSale and attaches the payments
 * the pay link recorded to that sale. Catalog rules for the website (public products, web address, public price) live here too.
 * Pure: planners return {ops, result, errors}; the server reads the rows and applies the ops.
 */
var Core = Core || {};
Core.orders = (function () {
  var STATUSES = ['New', 'AwaitingPayment', 'Paid', 'Fulfilled', 'Cancelled'];
  // Allowed moves. A Paid order only goes to Fulfilled: the money is taken, so cancelling it would need a refund, which is a separate step.
  var TRANSITIONS = {
    New: ['AwaitingPayment', 'Paid', 'Cancelled'],
    AwaitingPayment: ['Paid', 'Cancelled'],
    Paid: ['Fulfilled'],
    Fulfilled: [],
    Cancelled: []
  };
  var SOURCES = ['panel', 'website'];
  var NOTE_MAX = 500, CONTACT_MAX = 120, NAME_MAX = 120, CHANNEL_MAX = 40, DESC_MAX = 2000, SLUG_MAX = 80, IMAGE_MAX = 200;
  var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

  function fail(msg, code) { return { ops: [], result: null, errors: [msg], code: code }; }
  function done(ops, result) { return { ops: ops, result: result, errors: [] }; }
  function find(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function blank(v) { return v === '' || v === null || v === undefined; }
  function text(v) { return String(v === null || v === undefined ? '' : v).trim(); }
  function nowOf(state, input) { return Number((input && input.nowMs) || (state && state.nowMs) || Date.now()); }
  function round2(n) { return Core.util.round2(n); }
  function orderKey(id) { return String(id || '').toUpperCase(); }
  function asNumber(v) {
    if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return v;
  }

  /** A product a website may show and sell: switched on, with a web address, and not deactivated. */
  function isPublic(p) {
    return !!p && p.Public === true && !!text(p.Slug) && String(p.Active || 'Yes') !== 'No';
  }

  /** One month on the catalog: the public price when one is set, else the default price. */
  function catalogPrice(p) {
    if (blank(p.Public_Price)) return Number(p.Default_Price) || 0;
    return Number(p.Public_Price) || 0;
  }

  function payRequestOf(state, o) { return find(state.payRequests, 'Request_ID', o.Pay_Request_ID) || null; }

  /**
   * New order: the customer (a customer id, or a typed name for a new customer), a product, months, the price they saw.
   * input: { source: 'panel'|'website', productId, months, customerId?, customerName?, contact?, contactChannel?, price?, note?,
   *          hours?, apiKeyId?, idempotencyKey?, requestHash?, accessToken?, _gen?, nowMs? }. A website order must carry the price it
   * showed and a way to reach the customer.
   */
  function planCreateOrder(state, input) {
    input = input || {};
    var source = SOURCES.indexOf(input.source) >= 0 ? input.source : 'panel';
    var product = find(state.products, 'Product_ID', text(input.productId));
    if (!product) return fail('Unknown product ' + text(input.productId) + '.', 'unknown_product');
    if (source === 'website' && !isPublic(product)) return fail('That product is not on sale.', 'not_public');
    if (Core.sales.deliversAs(product) === 'custom') return fail(product.Product_Name + ' is a custom item and cannot be ordered.');

    var months = blank(input.months) ? 1 : asNumber(input.months);
    if (typeof months !== 'number' || months !== Math.floor(months) || months < 1 || months > 12) return fail('Months must be a whole number from 1 to 12.');
    if (Core.sales.deliversAs(product) === 'code' && months !== 1) return fail('Codes are sold one at a time; months must be 1.');

    var unit = catalogPrice(product);
    if (!blank(input.price)) {
      var given = asNumber(input.price);
      if (typeof given !== 'number' || !isFinite(given)) return fail('Price must be a number.');
      if (round2(given) !== round2(unit)) return fail('The price is now ' + round2(unit) + ' per month. Check it and try again.', 'price_changed');
    } else if (source === 'website') {
      return fail('Send the price you saw, so it can be checked.', 'price_missing');
    }
    var total = round2(unit * months);
    if (!(total > 0)) return fail(product.Product_Name + ' has no price. Set one first.', 'no_price');

    var customer = null, name = text(input.customerName).replace(/\s+/g, ' ');
    if (!blank(input.customerId)) {
      customer = find(state.customers, 'Customer_ID', text(input.customerId));
      if (!customer) return fail('Unknown customer ' + text(input.customerId) + '.', 'unknown_customer');
      name = customer.Name;
    } else if (!name) {
      return fail('Pick a customer or type a name.');
    }
    if (name.length > NAME_MAX) return fail('The customer name can be up to ' + NAME_MAX + ' characters.');
    var contact = text(input.contact), channel = text(input.contactChannel), note = text(input.note);
    if (contact.length > CONTACT_MAX) return fail('The contact can be up to ' + CONTACT_MAX + ' characters.');
    if (channel.length > CHANNEL_MAX) return fail('The contact channel can be up to ' + CHANNEL_MAX + ' characters.');
    if (note.length > NOTE_MAX) return fail('The note can be up to ' + NOTE_MAX + ' characters.');
    if (source === 'website' && !contact) return fail('Send a phone number or email so we can reach you.');

    var now = nowOf(state, input);
    var gen = input._gen || Core.ids.IdGen(state);
    var orderId = gen.order();
    var title = product.Product_Name + (months > 1 ? ' x ' + months + ' months' : '');
    var rq = Core.paylinks.planCreateRequest(state, { title: title, amount: total, customerId: customer ? customer.Customer_ID : '',
      customerName: customer ? '' : name, note: 'Order ' + orderId, hours: input.hours, nowMs: now, _gen: gen, _rand: input._rand });
    if (rq.errors && rq.errors.length) return fail(rq.errors[0], rq.code);

    // The API fields are set for a website order only: the key that placed it, its Idempotency-Key, a fingerprint of the body, and the token
    // the customer reads the order with. A panel order leaves them blank.
    var row = { Order_ID: orderId, Created: new Date(now).toISOString(), Source: source, Status: 'New',
      Customer_ID: customer ? customer.Customer_ID : '', Customer_Name: name, Contact: contact, Contact_Channel: channel,
      Product_ID: product.Product_ID, Months: months, Unit_Price: unit, Total: total, Pay_Request_ID: rq.result.requestId,
      Sale_ID: '', Note: note, Api_Key_ID: text(input.apiKeyId), Idem_Key: text(input.idempotencyKey),
      Request_Hash: text(input.requestHash), Access_Token: text(input.accessToken) };
    return done(rq.ops.concat([{ op: 'append', tab: 'Orders', values: row }]),
      { orderId: orderId, requestId: rq.result.requestId, token: rq.result.token, total: total, status: 'New' });
  }

  /**
   * Moves an order to another status (not Fulfilled: that is planFulfil). Paid needs its pay link Paid. Cancelling an order cancels its
   * open pay link too. input: { id, status }.
   */
  function planOrderStatus(state, input) {
    input = input || {};
    var o = find(state.orders, 'Order_ID', orderKey(input.id));
    if (!o) return fail('Unknown order ' + text(input.id) + '.', 'unknown_order');
    var to = text(input.status);
    if (STATUSES.indexOf(to) < 0) return fail('Unknown status ' + to + '.');
    if (to === 'Fulfilled') return fail('Use Fulfil to make the sale.', 'use_fulfil');
    if (TRANSITIONS[o.Status].indexOf(to) < 0) return fail(o.Order_ID + ' is ' + o.Status + ', so it cannot become ' + to + '.', 'bad_transition');

    var rq = payRequestOf(state, o), ops = [];
    if (to === 'Paid' && !(rq && rq.Status === 'Paid')) {
      return fail('Mark the pay link ' + (rq ? rq.Request_ID : '') + ' as paid first' + (rq ? ' (it is ' + rq.Status + ').' : ': there is none.'), 'not_paid');
    }
    if (to === 'Cancelled' && rq && rq.Status === 'Paid') return fail('The pay link is paid, so ' + o.Order_ID + ' cannot be cancelled. Refund the money first.', 'paid_link');
    if (to === 'Cancelled' && rq && rq.Status === 'Open') {
      var c = Core.paylinks.planCancelRequest(state, { id: rq.Request_ID });
      if (c.errors && c.errors.length) return fail(c.errors[0]);
      ops = ops.concat(c.ops);
    }
    ops.push({ op: 'update', tab: 'Orders', key: 'Order_ID', id: o.Order_ID, values: { Status: to } });
    return done(ops, { orderId: o.Order_ID, status: to, requestId: rq ? rq.Request_ID : '' });
  }

  // Payments the pay link recorded before any sale existed: confirmed with no product, so they carry no sale and (unless
  // overpaid) no customer. Matched by the notes Core.delivery writes.
  function isLinkPayment(p, requestId) {
    var n = String(p.Note || '');
    return n.indexOf('Pay link ' + requestId + ':') === 0 || n === 'Overpaid on ' + requestId || n.indexOf('Overpaid on ' + requestId + ',') === 0;
  }

  /**
   * Fulfil a Paid order: the sale (planNewSale, with the customer, the product and the months it was sold for), its code marked Sold
   * for a code product, a delivery row, the link payments attached to the sale, and the order and pay link pointing at it.
   * input: { orderId, codeId? (code products), accountId? (account products), customerId? (overrides the order's customer), _gen?, _rand? }.
   */
  function planFulfil(state, input) {
    input = input || {};
    var o = find(state.orders, 'Order_ID', orderKey(input.orderId));
    if (!o) return fail('Unknown order ' + text(input.orderId) + '.', 'unknown_order');
    if (o.Status !== 'Paid') return fail(o.Order_ID + ' is ' + o.Status + '. Mark it paid before fulfilling.', 'bad_transition');
    var rq = payRequestOf(state, o);
    if (!rq || rq.Status !== 'Paid') return fail('The pay link ' + (rq ? rq.Request_ID : '') + ' is not paid.', 'not_paid');
    var product = find(state.products, 'Product_ID', o.Product_ID);
    if (!product) return fail('Unknown product ' + o.Product_ID + ' on ' + o.Order_ID + '.', 'unknown_product');

    var gen = input._gen || Core.ids.IdGen(state);
    var isCode = Core.sales.deliversAs(product) === 'code';
    var who = {};
    if (!blank(input.customerId)) who.customerId = text(input.customerId);
    else if (!blank(o.Customer_ID)) who.customerId = o.Customer_ID;
    else who.newCustomer = { name: o.Customer_Name, channel: o.Contact_Channel, handle: o.Contact };
    var sale = Core.sales.planNewSale(state, Object.assign(who, {
      productId: product.Product_ID, codeId: isCode ? input.codeId : undefined, accountId: isCode ? undefined : input.accountId,
      months: Number(o.Months) || 1, price: Number(o.Unit_Price) || 0, notes: 'Order ' + o.Order_ID, _gen: gen, _rand: input._rand }));
    if (sale.errors && sale.errors.length) return fail(sale.errors[0]);

    var r = sale.result, ops = sale.ops.slice(), now = nowOf(state, input);
    if (isCode) ops.push({ op: 'update', tab: 'Code_Inventory', key: 'Code_ID', id: text(input.codeId), values: { Status: 'Sold' } });
    var deliveryId = gen.delivery();
    ops.push({ op: 'append', tab: 'Deliveries', values: { Delivery_ID: deliveryId, Sale_ID: r.saleId, Request_ID: rq.Request_ID,
      Customer_ID: r.customerId, Product_ID: product.Product_ID, Code_ID: isCode ? text(input.codeId) : '', Kind: isCode ? 'code' : 'seat',
      Status: isCode ? 'Delivered' : 'Pending', Delivered_At: isCode ? new Date(now).toISOString() : '', Note: 'Order ' + o.Order_ID } });
    (state.payments || []).forEach(function (p) {
      if (blank(p.Sale_ID) && isLinkPayment(p, rq.Request_ID)) {
        ops.push({ op: 'update', tab: 'Payments', key: 'Payment_ID', id: p.Payment_ID, values: { Customer_ID: r.customerId, Sale_ID: r.saleId } });
      }
    });
    ops.push({ op: 'update', tab: 'Pay_Requests', key: 'Request_ID', id: rq.Request_ID, values: { Sale_ID: r.saleId } });
    ops.push({ op: 'update', tab: 'Orders', key: 'Order_ID', id: o.Order_ID, values: { Status: 'Fulfilled', Sale_ID: r.saleId,
      Customer_ID: r.customerId, Fulfilled: new Date(now).toISOString() } });
    return done(ops, { orderId: o.Order_ID, saleId: r.saleId, customerId: r.customerId, subCode: r.subCode, accountId: r.accountId,
      requestId: rq.Request_ID, deliveryId: deliveryId, delivered: isCode });
  }

  /**
   * Catalog fields for the website. Only the fields given are changed. input: { productId, slug?, public?, description?, imagePath?,
   * sortOrder?, publicPrice? }. A blank publicPrice clears it (the default price applies again).
   */
  function planEditPublic(state, input) {
    input = input || {};
    var cur = find(state.products, 'Product_ID', text(input.productId));
    if (!cur) return fail('Unknown product ' + text(input.productId) + '.', 'unknown_product');
    var values = {};
    if (input.slug !== undefined) {
      var slug = text(input.slug).toLowerCase();
      if (slug && (slug.length > SLUG_MAX || !SLUG_RE.test(slug))) return fail('The web address can use lowercase letters and numbers, with single hyphens between them (up to ' + SLUG_MAX + ' characters).');
      if (slug && (state.products || []).some(function (p) { return p.Product_ID !== cur.Product_ID && text(p.Slug).toLowerCase() === slug; })) {
        return fail('Another product already uses the web address ' + slug + '.');
      }
      values.Slug = slug;
    }
    if (input.public !== undefined) {
      if (typeof input.public !== 'boolean') return fail('Public must be on or off.');
      var slugNow = values.Slug !== undefined ? values.Slug : text(cur.Slug);
      if (input.public && !slugNow) return fail('Give the product a web address before showing it on the website.');
      if (input.public && String(cur.Active || 'Yes') === 'No') return fail('An inactive product cannot be shown on the website.');
      values.Public = input.public;
    }
    if (input.description !== undefined) {
      var description = text(input.description);
      if (description.length > DESC_MAX) return fail('The description can be up to ' + DESC_MAX + ' characters.');
      values.Description = description;
    }
    if (input.imagePath !== undefined) {
      var image = text(input.imagePath);
      if (image && (image.length > IMAGE_MAX || image.indexOf('..') >= 0 || !IMAGE_RE.test(image))) {
        return fail('The image path is a storage path such as products/netflix.png.');
      }
      values.Image_Path = image;
    }
    if (input.sortOrder !== undefined) {
      var order = asNumber(input.sortOrder);
      if (typeof order !== 'number' || order !== Math.floor(order) || order < 0 || order > 9999) return fail('Sort order must be a whole number from 0 to 9999.');
      values.Sort_Order = order;
    }
    if (input.publicPrice !== undefined) {
      if (blank(input.publicPrice) || input.publicPrice === '') {
        values.Public_Price = '';
      } else {
        var price = asNumber(input.publicPrice);
        if (typeof price !== 'number' || !isFinite(price) || price < 0 || price >= 1000000) return fail('The public price must be 0 or more.');
        values.Public_Price = round2(price);
      }
    }
    if (!Object.keys(values).length) return done([], { productId: cur.Product_ID });
    return done([{ op: 'update', tab: 'Product_Catalog', key: 'Product_ID', id: cur.Product_ID, values: values }], { productId: cur.Product_ID });
  }

  /** Orders for the panel, newest first. The pay link URL is included so the owner can copy it again. */
  function list(state) {
    var rqs = {}, prod = {}, cust = {};
    (state.payRequests || []).forEach(function (r) { rqs[r.Request_ID] = r; });
    (state.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    (state.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    return (state.orders || []).map(function (o) {
      var rq = rqs[o.Pay_Request_ID] || null, p = prod[o.Product_ID], c = cust[o.Customer_ID];
      return { id: o.Order_ID, created: o.Created, source: o.Source, status: o.Status,
        customerId: o.Customer_ID, customerName: c ? c.Name : o.Customer_Name, contact: o.Contact, contactChannel: o.Contact_Channel,
        productId: o.Product_ID, productName: p ? p.Product_Name : o.Product_ID, months: Number(o.Months) || 1,
        unitPrice: Number(o.Unit_Price) || 0, total: Number(o.Total) || 0,
        payRequestId: o.Pay_Request_ID, payRequestStatus: rq ? rq.Status : '', payUrl: rq ? Core.paylinks.requestUrl(state.settings, rq) : '',
        saleId: blank(o.Sale_ID) ? '' : Number(o.Sale_ID), note: o.Note, fulfilled: o.Fulfilled || '' };
    }).sort(function (a, b) {
      return Number(String(b.id).replace(/\D/g, '')) - Number(String(a.id).replace(/\D/g, ''));
    });
  }

  return { STATUSES: STATUSES, TRANSITIONS: TRANSITIONS, SOURCES: SOURCES, isPublic: isPublic, catalogPrice: catalogPrice,
    planCreateOrder: planCreateOrder, planOrderStatus: planOrderStatus, planFulfil: planFulfil, planEditPublic: planEditPublic, list: list };
})();
if (typeof module !== 'undefined') module.exports = Core.orders;
