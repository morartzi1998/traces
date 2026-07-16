/*
  traces — a tiny IndexedDB-backed blob store.

  sessionStorage/localStorage can only hold a few MB of text, but a real
  3D scan is routinely tens of megabytes — encoding it as a base64 data:
  URL and trying to persist that silently fails (the write throws and is
  swallowed), leaving whatever was there before. IndexedDB has no such
  practical limit and stores Blobs directly, so capture files ride here
  instead.
*/
window.BlobStore = (function () {
  var DB_NAME = "traces-blobs", STORE = "files", VERSION = 1, dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function set(key, blob) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(blob, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function get(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function del(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // resolve a stored reference to something an <img>/<model-viewer> src can
  // use: an "idb:KEY" reference becomes a live object URL from the blob it
  // points at; anything else (a real path, a plain URL) passes through
  // untouched. Returns a Promise<string|null>.
  function url(ref) {
    if (!ref) return Promise.resolve(ref || null);
    if (ref.indexOf("idb:") !== 0) return Promise.resolve(ref);
    return get(ref.slice(4)).then(function (blob) {
      return blob ? URL.createObjectURL(blob) : null;
    });
  }

  // a data: URL is base64 text; turn it back into a real Blob so it can live
  // in IndexedDB instead of bloating localStorage
  function dataURLToBlob(dataURL) {
    var comma = dataURL.indexOf(",");
    var header = dataURL.slice(0, comma);
    var body = dataURL.slice(comma + 1);
    var mime = (header.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
    var bytes;
    if (header.indexOf("base64") !== -1) {
      var bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new Blob([bytes], { type: mime });
  }

  return { set: set, get: get, del: del, url: url, dataURLToBlob: dataURLToBlob };
})();
