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
    // iOS/WebKit can invalidate a Blob stored in IndexedDB once the page that
    // created it is torn down by a navigation — reading it back on the next
    // screen then yields a missing/unreadable entry (desktop keeps it fine,
    // which is exactly why a captured scan opened on the computer but failed
    // on the phone). Storing the raw bytes as an ArrayBuffer, which IDB copies
    // by value, sidesteps that entirely so a scan/photo survives the hop.
    var bytesReady = (blob && typeof blob.arrayBuffer === "function")
      ? blob.arrayBuffer().then(function (buf) { return { buf: buf, type: blob.type || "application/octet-stream" }; })
      : Promise.resolve(blob);
    return bytesReady.then(function (record) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(record, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    });
  }

  function get(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () {
          var r = req.result;
          if (!r) { resolve(null); return; }
          // new records wrap the bytes as { buf, type }; older entries (and the
          // no-arrayBuffer fallback above) were stored as raw Blobs
          if (r.buf) { resolve(new Blob([r.buf], { type: r.type || "application/octet-stream" })); return; }
          resolve(r);
        };
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

  // like url(), but for a REMOTE file (a hosted http[s] thumbnail/model on the
  // captures worker) it downloads the bytes ONCE and caches them in IndexedDB
  // keyed by the URL, then hands back an object URL — so a grid of polaroids
  // stops re-downloading every thumbnail on every scroll/navigation (the worker
  // sends no cache header, so the browser wouldn't keep them otherwise).
  // idb: refs resolve locally as before; bundled/static paths pass through
  // untouched (the browser already caches those normally).
  function cachedUrl(ref) {
    if (!ref) return Promise.resolve(null);
    if (ref.indexOf("idb:") === 0) return url(ref);
    if (ref.indexOf("http") !== 0) return Promise.resolve(ref);
    var key = "urlcache:" + ref;
    return get(key).then(function (blob) {
      if (blob) return URL.createObjectURL(blob);
      return fetch(ref).then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) {
          if (!b) return ref; // fall back to the live URL
          set(key, b).catch(function () {});
          return URL.createObjectURL(b);
        }).catch(function () { return ref; });
    }).catch(function () { return ref; });
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

  return { set: set, get: get, del: del, url: url, cachedUrl: cachedUrl, dataURLToBlob: dataURLToBlob };
})();
