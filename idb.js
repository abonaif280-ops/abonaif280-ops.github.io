// تخزين محلي داخل الجهاز (IndexedDB) — مشترك بين الواجهة وعامل Python وعامل الخدمة.
// kv:    المفتاح المشتق من كلمة السر + نسخة قاعدة البيانات
// files: مرفقات التوثيق (صور/فيديو) — كل ملف {type, data: ArrayBuffer}
var SRBDB = (function () {
  var NAME = "srb-data", VER = 1, _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
      };
      rq.onsuccess = function () {
        _db = rq.result;
        _db.onversionchange = function () { _db.close(); _db = null; };
        res(_db);
      };
      rq.onerror = function () { rej(rq.error); };
    });
  }

  function tx(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        var r = fn(s);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }

  return {
    get: function (store, key) { return tx(store, "readonly", function (s) { return s.get(key); }); },
    put: function (store, key, val) { return tx(store, "readwrite", function (s) { return s.put(val, key); }); },
    del: function (store, key) { return tx(store, "readwrite", function (s) { return s.delete(key); }); },
    keys: function (store) { return tx(store, "readonly", function (s) { return s.getAllKeys(); }); },
    clear: function (store) { return tx(store, "readwrite", function (s) { return s.clear(); }); },
  };
})();
self.SRBDB = SRBDB;  // يُتاح أيضًا عند تحميله كوحدة (module) في عامل Python
