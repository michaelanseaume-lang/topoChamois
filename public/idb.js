'use strict';
// Petite couche IndexedDB partagée par la page et le service worker.
//  - magasin "kv"    : copies des dernières réponses du serveur (topo, profil, classements…) pour l'affichage hors ligne
//  - magasin "queue" : actions du grimpeur en attente de synchronisation (conservées même si le téléphone redémarre)
// Si IndexedDB est indisponible (certaines navigations privées), on retombe sur la mémoire : l'appli marche, sans persistance.
var TopoDB = (function () {
  var dbp, mem = { kv: new Map(), queue: new Map() };
  function open() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('topo-offline', 1);
      r.onupgradeneeded = function () { ['kv', 'queue'].forEach(function (n) { if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function run(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), req = fn(t.objectStore(store));
        t.oncomplete = function () { res(req ? req.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  return {
    get: function (s, k) { return run(s, 'readonly', function (o) { return o.get(k); }).catch(function () { return mem[s].get(k); }); },
    put: function (s, k, v) { mem[s].set(k, v); return run(s, 'readwrite', function (o) { o.put(v, k); }).catch(function () { }); },
    del: function (s, k) { mem[s].delete(k); return run(s, 'readwrite', function (o) { o.delete(k); }).catch(function () { }); },
    all: function (s) { return run(s, 'readonly', function (o) { return o.getAll(); }).catch(function () { return Array.from(mem[s].values()); }); },
    clear: function (s) { mem[s].clear(); return run(s, 'readwrite', function (o) { o.clear(); }).catch(function () { }); }
  };
})();
