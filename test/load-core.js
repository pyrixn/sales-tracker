// Loads every src/core/*.js into this realm's global scope for tests, one shared scope like a single script.
// Same realm on purpose: objects from a separate vm context fail assert.deepStrictEqual on their prototype.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORDER = ['util', 'rates', 'ids', 'refs', 'ledger', 'sales', 'matching', 'views', 'reminders', 'undo', 'migrate', 'exporter'];

function loadCore() {
  for (const name of ORDER) {
    const file = path.join(__dirname, '..', 'src', 'core', name + '.js');
    if (!fs.existsSync(file)) continue;
    // Hide `module` so each file keeps to the Apps Script path (global Core) instead of exporting.
    vm.runInThisContext('(function(module, Core){' + fs.readFileSync(file, 'utf8') + '\n;globalThis.Core = Core;})(undefined, globalThis.Core)', { filename: file });
  }
  return globalThis.Core || {};
}

module.exports = { loadCore, ORDER, Core: loadCore() };
