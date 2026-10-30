// Preloaded with NODE_OPTIONS=--require to prove a script makes no network call.
globalThis.fetch = function () { throw new Error('network blocked'); };
