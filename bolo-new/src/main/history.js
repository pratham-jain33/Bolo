const Store = require('electron-store');

let store = null;
function init() {
  store = new Store({ name: 'bolo-history', defaults: { items: [] } });
  return store;
}

function push(entry) {
  if (!store) init();
  const items = store.get('items') || [];
  items.unshift({ at: new Date().toISOString(), ...entry });
  store.set('items', items.slice(0, 200));
  return items[0];
}

function list(limit = 50) {
  if (!store) init();
  return (store.get('items') || []).slice(0, limit);
}

function clear() {
  if (!store) init();
  store.set('items', []);
  return { ok: true };
}

module.exports = { init, push, list, clear };
