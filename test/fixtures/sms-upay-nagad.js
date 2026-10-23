// SYNTHETIC samples. The six real messages the spec refers to (3 Upay, 3 Nagad, pasted on 2026-10-23) were not
// available when this was written, so these are built from the spec's described wording with invented numbers and IDs.
// Replace `text` with the real messages when you have them; the assertions state the intended behaviour.
module.exports = [
  { name: 'upay received (no phone number)', sender: '16268', src: 'upay',
    text: 'Tk 250.00 has been received in your Upay account. TrxID UPAY1A2B3C at 20/10/2026 10:15',
    want: { skip: '', type: 'Received', method: 'Upay', amount: 250, trxId: 'UPAY1A2B3C', counterparty: '', reference: '', status: 'Review' } },
  { name: 'upay fund transfer to bank is outgoing', sender: '16268', src: 'upay',
    text: 'Fund Transfer Successful. Tk 5,000.00 to Example Bank A/C XXXX1234. TrxID UPAY9Z8Y7X at 20/10/2026 11:00',
    want: { skip: 'outgoing transfer' } },
  { name: 'upay received with colon reference', sender: '16268', src: 'upay',
    text: 'Tk 120.00 has been received. Ref : N44. TrxID UPAYQ1W2E3 at 21/10/2026 09:00',
    want: { skip: '', type: 'Received', method: 'Upay', amount: 120, trxId: 'UPAYQ1W2E3', counterparty: '', reference: 'N44', status: 'Review' } },
  { name: 'nagad money received with reference', sender: '16167', src: 'nagad',
    text: 'Money Received.\nAmount: Tk 290.00\nSender: 01712345678\nRef: X45\nTxnID: NGD4K5L6M7\nBalance: Tk 1,000.00\n21/10/2026 12:30',
    want: { skip: '', type: 'Received', method: 'Nagad', amount: 290, trxId: 'NGD4K5L6M7', counterparty: '01712345678', reference: 'X45', status: 'Pending' } },
  { name: 'nagad cash in received uses the Uddokta number', sender: '16167', src: 'nagad',
    text: 'Cash In Received.\nAmount: Tk 500.00\nUddokta: 01898765432\nRef: N/A\nTxnID: NGD8P9Q0R1\n22/10/2026 15:45',
    want: { skip: '', type: 'Received', method: 'Nagad', amount: 500, trxId: 'NGD8P9Q0R1', counterparty: '01898765432', reference: '', status: 'Pending' } },
  { name: 'nagad money received with empty reference', sender: '16167', src: 'nagad',
    text: 'Money Received.\nAmount: Tk 100.00\nSender: 01611122233\nRef:\nTxnID: NGD2S3T4U5\n22/10/2026 16:10',
    want: { skip: '', type: 'Received', method: 'Nagad', amount: 100, trxId: 'NGD2S3T4U5', counterparty: '01611122233', reference: '', status: 'Pending' } }
];
