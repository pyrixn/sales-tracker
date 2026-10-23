// Runs the real Edge Function router (src/server/edge.js) in Node against a given db.
//
// Core comes from test/load-core.js (same realm as the tests, so deepStrictEqual works) and Adapter
// from src/adapters/postgres.js. edge.js is written for the Deno bundle, where `Core`, `Adapter`,
// `db`, `Deno` and `crypto` are globals and its own functions are top-level declarations. Here each
// loadEdge() call compiles edge.js inside a fresh function scope that binds those names as
// parameters, so its declarations (api, today_, ...) are locals of that instance: two hosts with
// different dbs or dates never share or overwrite each other's state.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Core } = require('../load-core');
const Adapter = require('../../src/adapters/postgres.js');

const EDGE_FILE = path.join(__dirname, '..', '..', 'src', 'server', 'edge.js');
const DENO_STUB = { env: { get: () => undefined } };

let factory = null;
function edgeFactory() {
  if (factory) return factory;
  const src = fs.readFileSync(EDGE_FILE, 'utf8');
  factory = vm.runInThisContext(
    '(function (Core, Adapter, db, Deno, crypto, TODAY, FETCH_ADS) {\n' + src +
    '\n;today_ = function () { return TODAY; };\nif (FETCH_ADS) fetchAds_ = FETCH_ADS;\nreturn { api: api, relayIngest: relayIngest, handle: handle };\n})',
    { filename: EDGE_FILE });
  return factory;
}

/** loadEdge(db, { today, env }) -> { api(action, payload), relayIngest(body, src) } bound to this db; today defaults to '2026-10-18'. */
function loadEdge(db, opts) {
  const today = (opts && opts.today) || '2026-10-18';
  const env = (opts && opts.env) || {};
  const deno = { env: { get: (k) => env[k] } };
  const edge = edgeFactory()(Core, Adapter, db, deno, globalThis.crypto, today, opts && opts.fetchAds);
  return { api: (action, payload) => edge.api(action, payload, db), relayIngest: (body, src) => edge.relayIngest(body, src || ''),
    handle: (req) => edge.handle(req) };
}

module.exports = { loadEdge };
