/**
 * Core.jobs: planners for the scheduled jobs behind POST /cron/<job>. Pure: no I/O. A clock is passed in as `now` (ms).
 * The runners in src/server/edge.js read the state, ask these planners what to do, then do the I/O (writes, Storage, fetch).
 */
var Core = Core || {};
Core.jobs = (function () {
  var JOBS = ['match-sweep', 'rate', 'backup', 'cleanup', 'relay-check', 'webhooks', 'notify'];
  var DAY_MS = 24 * 60 * 60 * 1000;
  var DHAKA_MS = 6 * 60 * 60 * 1000;          // Asia/Dhaka has no daylight saving: a fixed +06:00
  var MATCH_SWEEP_LIMIT = 25;                 // Pending rows retried per run, oldest first
  var BACKUP_KEEP = 30;                       // newest backups kept in the bucket
  var REQUEST_LOG_DAYS = 30;
  var JOB_RUN_DAYS = 30;
  var RELAY_HOURS = 6;
  var BACKUP_NAME = /^sales-tracker-\d{4}-\d{2}-\d{2}\.json$/;

  function isJob(name) { return JOBS.indexOf(name) >= 0; }

  /** Pending inbox rows a sweep retries: a TrxID (autoMatch works on it), a payment type, still Pending. Oldest first, capped. */
  function planMatchSweep(st, limit) {
    var max = limit || MATCH_SWEEP_LIMIT;
    return (st.inbox || []).filter(function (r) {
      return r.Status === 'Pending' && String(r.Transaction_ID || '') !== '' && r.Type !== 'Unrecognised' && r.Type !== 'TopUp';
    }).sort(function (a, b) {
      var x = String(a.Received || ''), y = String(b.Received || '');
      return x < y ? -1 : x > y ? 1 : 0;
    }).slice(0, max).map(function (r) { return String(r.Transaction_ID); });
  }

  /** The rate is refreshed when the cached one is stale. A manual rate is never fetched over. */
  function planRate(st, now) {
    var cur = Core.rates.resolveRate({ liveRates: st.liveRates, settings: st.settings || {} }, now);
    return { refresh: cur.source !== 'manual' && cur.stale === true };
  }

  /** Object name for the day's backup (Dhaka date). Re-running the same day replaces that day's file, so the job is idempotent. */
  function backupName(now) {
    return 'sales-tracker-' + new Date(now + DHAKA_MS).toISOString().slice(0, 10) + '.json';
  }

  /** Names to delete so that only the newest `keep` backups remain. Only files this job writes are ever listed. */
  function planBackupPrune(names, keep) {
    var max = keep || BACKUP_KEEP;
    var mine = (names || []).filter(function (n) { return BACKUP_NAME.test(String(n)); })
      .sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; });
    return mine.slice(max);
  }

  /** The JSON document a backup holds: the whole state the panel reads, stamped with the export time. */
  function backupDocument(st, exportedIso, vault) {
    var doc = { format: 'sales-tracker-backup', version: 1, exported: exportedIso, state: st };
    // vault: { secrets (ciphertext and IV only, never plaintext), templates }. Useless without the VAULT_KEY, which is never in a backup.
    if (vault) { doc.account_secrets = vault.secrets || []; doc.delivery_templates = vault.templates || []; }
    return doc;
  }

  /** Cutoffs (ISO text) for the cleanup job: request_log rows and job_runs older than their retention. */
  function planCleanup(now) {
    var before = new Date(now - REQUEST_LOG_DAYS * DAY_MS).toISOString();
    return { requestLogBefore: before, jobRunsBefore: new Date(now - JOB_RUN_DAYS * DAY_MS).toISOString() };
  }

  // Inbox Received is Dhaka wall time as 'YYYY-MM-DD HH:MM' (see nowDhaka_ in edge.js).
  function dhakaMs(s) {
    var t = Date.parse(String(s || '').replace(' ', 'T') + ':00+06:00');
    return isFinite(t) ? t : 0;
  }

  /**
   * Relay silence check. Healthy when either an SMS arrived or a heartbeat came in within `hours`. A missing heartbeat alone is
   * not an alarm while SMS keep arriving, and a quiet inbox alone is not one while the phone still checks in.
   */
  function planRelayCheck(st, now, hours) {
    var h = hours || RELAY_HOURS;
    var last = 0;
    (st.inbox || []).forEach(function (r) { var t = dhakaMs(r.Received); if (t > last) last = t; });
    var hb = Date.parse(String((st.settings || {}).relay_heartbeat || ''));
    var lastHeartbeat = isFinite(hb) ? hb : 0;
    var seen = Math.max(last, lastHeartbeat);
    return { alert: !seen || now - seen > h * 60 * 60 * 1000, hours: h, lastSmsMs: last, lastHeartbeatMs: lastHeartbeat };
  }

  /**
   * One entry per known job, in JOBS order, from the newest job_runs row of each job ({ job, started_at, finished_at, ok, detail }).
   * A job that never ran has lastRun null and is not failed.
   */
  function summarize(latest) {
    var byJob = {};
    (latest || []).forEach(function (r) { byJob[r.job] = r; });
    return JOBS.map(function (job) {
      var r = byJob[job] || null;
      return {
        job: job,
        lastRun: r ? { startedAt: String(r.started_at || ''), finishedAt: String(r.finished_at || ''), ok: r.ok === true, detail: String(r.detail || '') } : null,
        failed: !!r && r.ok !== true
      };
    });
  }

  return {
    JOBS: JOBS, MATCH_SWEEP_LIMIT: MATCH_SWEEP_LIMIT, BACKUP_KEEP: BACKUP_KEEP, RELAY_HOURS: RELAY_HOURS,
    isJob: isJob, planMatchSweep: planMatchSweep, planRate: planRate, backupName: backupName, planBackupPrune: planBackupPrune,
    backupDocument: backupDocument, planCleanup: planCleanup, planRelayCheck: planRelayCheck, summarize: summarize
  };
})();
if (typeof module !== 'undefined') module.exports = Core.jobs;
