/**
 * Payment SMS relay v9 (final, any mobile-money sender): iPhone SMS -> "Payment_Inbox" tab as PENDING rows.
 *
 * The iPhone sends:  POST <web app URL>?src=bkash
 *   JSON body: { "token": "<RELAY_TOKEN>", "sender": "<sender number or name>", "text": "<the SMS text>" }
 *
 * WHAT'S NEW vs v4-v7
 *  - Rows are written to the first empty row of column A (never appendRow), so the formula columns that fill down
 *    to row 1000 (Logged_As_Sale, Source) can't push new rows below the visible area.
 *  - ?src= is now OPTIONAL. An unknown sender or missing ?src= never rejects the message: it is stored
 *    (Method is blank unless the sender/text says bKash or Nagad; use the Source column instead). Names/people are resolved live by the "Source" formula column from the
 *    Sources tab, so adding people there needs NO script change and NO redeploy.
 *  - Messages with no TrxID (Unrecognised format) are de-duplicated by their full text.
 *  - Transaction_ID and Counterparty are stored as text (leading zeros kept, no number conversion).
 *  - Request log tab "Relay_Log" (switch off with LOG_ENABLED = false once everything works). Written only AFTER the
 *    token is verified, trimmed to the newest 300 lines, and the GET health check never writes.
 *
 * AFTER PASTING: Save, then Deploy > Manage deployments > pencil > Version: New version > Deploy (same URL).
 * To change anything in this file later you must redeploy. Changes on the sheet (Sources tab etc.) are live.
 */

const INBOX = 'Payment_Inbox';
const LOG_TAB = 'Relay_Log';
const LOG_ENABLED = true;
const LOG_KEEP = 300;
const BLOCK_WORDS = /\b(otp|pin|password|passcode|do not share|don'?t share)\b/i;
const SOURCES = {
  bkash: { method: 'bKash', sender: '16247' },
  nagad: { method: 'Nagad', sender: '16167' }
};

function doGet() {
  return json_({ ok: true, service: 'payment relay', hint: 'POST only' }, true);
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.token || body.token !== PropertiesService.getScriptProperties().getProperty('RELAY_TOKEN')) {
      return json_({ ok: false, error: 'bad token' }, true);          // never written to the sheet
    }
    const tag = (e.parameter && e.parameter.src) || '';
    const text = String(body.text || '').trim();
    const sender = String(body.sender || '').trim();
    log_('IN', { sender: sender, src: tag, text: text.slice(0, 200) });

    if (!text) return json_({ ok: false, error: 'empty message' });
    if (BLOCK_WORDS.test(text)) return json_({ ok: true, result: 'dropped: sensitive keyword' });

    const src = resolveSource_(tag, sender, text);
    const p = parseSms_(text);
    if (p.skip) return json_({ ok: true, result: 'skipped: ' + p.skip });

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const sh = getInbox_();
      if (isDuplicate_(sh, p.trxId, text)) {
        return json_({ ok: true, result: 'duplicate ' + (p.trxId || 'message') });
      }
      const row = nextRow_(sh);
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
      sh.getRange(row, 6).setNumberFormat('@');   // Transaction_ID as text
      sh.getRange(row, 7).setNumberFormat('@');   // Counterparty as text (keeps leading 0)
      sh.getRange(row, 1, 1, 11).setValues([[
        new Date(), p.type, src.method, sender || src.sender, p.amount, p.trxId,
        p.counterparty, p.reference, p.type === 'Unrecognised' ? 'Review' : 'Pending', '', text
      ]]);
      return json_({ ok: true, result: 'stored', row: row, type: p.type, trxId: p.trxId, amount: p.amount });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Method hint: ?src= first (optional), then known bKash/Nagad senders, then 'Nagad' in the SMS text. Anything else
 *  (Upay, Cellfin, a person...) gets a blank Method: who it came from is shown by the Source column (Sources tab). */
function resolveSource_(tag, sender, text) {
  const t = String(tag).toLowerCase();
  if (SOURCES[t]) return SOURCES[t];
  const x = String(sender);
  if (/16247|bkash/i.test(x)) return SOURCES.bkash;
  if (/16167|nagad/i.test(x)) return SOURCES.nagad;
  if (/nagad/i.test(String(text))) return SOURCES.nagad;
  return { method: '', sender: '' };
}

function parseSms_(text) {
  const out = { type: '', amount: '', trxId: '', counterparty: '', reference: '', skip: '' };

  const trx = text.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[\s:.#-]*([A-Z0-9]{6,20})/i);
  out.trxId = trx ? trx[1].toUpperCase() : '';
  const amt = text.match(/(?:Tk\.?|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.amount = amt ? Number(amt[1].replace(/,/g, '')) : '';

  if (/incentive/i.test(text)) { out.skip = 'government incentive (not a sale)'; return out; }
  if (!out.trxId && !/received/i.test(text)) { out.skip = 'no TrxID (notice, not a payment)'; return out; }

  if (/remittance/i.test(text)) out.type = 'Remittance';
  else if (/you have received|money received|cash in/i.test(text)) out.type = 'Received';
  else if (/sent|send money|cash out|payment|paid|bill|recharge/i.test(text)) { out.skip = 'outgoing or other transaction'; return out; }
  else out.type = 'Unrecognised';   // kept for review so nothing is lost (e.g. a Nagad format not seen yet)

  const from = text.match(/(?:from|sender:?)\s*(\+?8801\d{9}|01\d{9})/i);
  out.counterparty = from ? from[1] : '';
  const ref = text.match(/(?:Ref\.?|Reference|Comments?:?)\s+([^.\n]+?)\s*(?:\.|\n|$)/i);
  out.reference = ref ? ref[1].trim() : '';
  return out;
}

function getInbox_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(INBOX);
  if (!sh) {
    sh = ss.insertSheet(INBOX);
    sh.getRange(1, 1, 1, 11).setValues([['Received','Type','Method','Sender','Amount','Transaction_ID','Counterparty','Reference','Status','Matched_Sale_ID','Raw_SMS']]);
    sh.getRange(1, 1, 1, 11).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** First empty row in column A (rows 2+). Ignores formula columns that fill down to row 1000. */
function nextRow_(sh) {
  const a = sh.getRange(1, 1, sh.getMaxRows(), 1).getValues();
  let i = a.length;
  while (i > 1 && String(a[i - 1][0]) === '') i--;
  return i + 1;
}

/** Same TrxID already stored, or (no TrxID) the same full SMS text already stored. */
function isDuplicate_(sh, trx, text) {
  const last = nextRow_(sh) - 1;
  if (last < 2) return false;
  const n = last - 1;
  if (trx) return sh.getRange(2, 6, n, 1).getValues().some(r => String(r[0]).toUpperCase() === trx);
  return sh.getRange(2, 11, n, 1).getValues().some(r => String(r[0]).trim() === text);
}

/** Appends one line to the Relay_Log tab (and the Executions log). Never throws, never blocks the relay. */
function log_(kind, data) {
  const line = JSON.stringify(data);
  Logger.log(kind + ' ' + line);
  if (!LOG_ENABLED) return;
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(LOG_TAB);
    if (!sh) { sh = ss.insertSheet(LOG_TAB); sh.appendRow(['Time', 'Kind', 'Data']); sh.setFrozenRows(1); }
    sh.appendRow([new Date(), kind, line]);
    const extra = sh.getLastRow() - 1 - LOG_KEEP;
    if (extra > 50) sh.deleteRows(2, extra);   // trim in batches of 50+
  } catch (err) { /* logging must never break the relay */ }
}

function json_(obj, noLog) {
  if (!noLog) log_('OUT', obj);
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run from the editor: checks the parser on sample formats (numbers and IDs are fake). Writes nothing. */
function testParse() {
  [
    'You have received Tk 120.00 from 017XXXXXXXX. Ref netflix. Fee Tk 0.00. Balance Tk 1,709.97. TrxID TESTTRX01 at 18/10/2026 14:17',
    'You have received remittance.\nAmount: Tk 400.00\nTrxID TESTTRX02 at 17/10/2026 22:44.',
    'You have received govt. incentive for remittance.\nIncentive Amount: Tk 10.00\nTrxID TESTTRX03 at 17/10/2026 22:44.',
    'Remittance Cash Out charge only 7 Tk/thousand from ATM\nDetails: https://bka.sh/ATMCO'
  ].forEach(t => Logger.log(JSON.stringify(parseSms_(t))));
}
