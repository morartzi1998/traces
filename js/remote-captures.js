/*
  traces — client for the worker's shared-captures store (see
  backend/tripo-worker.js). A provisional stopgap: without a real backend,
  anything a visitor captures only ever lives in their own browser. This
  pushes a capture to the shared worker store too (best-effort — if
  window.TRACES_API isn't configured, or the worker hasn't been redeployed
  with the CAPTURES/CAPTURE_FILES bindings yet, every call here just no-ops
  so the local-only experience keeps working exactly as before).
*/
(function () {
  function api() {
    return (window.TRACES_API || "").replace(/\/$/, "");
  }

  // an idb: ref only means anything in this browser — upload the actual
  // bytes so the worker can hand back a real, fetchable URL. A ref that's
  // already a plain URL (e.g. a Tripo /proxy link) needs no upload at all
  // (and is already "done" as far as onProgress is concerned).
  function resolveRef(ref, onProgress) {
    if (!ref) { if (onProgress) onProgress(1); return Promise.resolve(null); }
    if (ref.indexOf("idb:") !== 0) { if (onProgress) onProgress(1); return Promise.resolve(ref); }
    if (!(window.BlobStore && api())) { if (onProgress) onProgress(1); return Promise.resolve(null); }
    return window.BlobStore.get(ref.slice(4)).then(function (blob) {
      if (!blob) { if (onProgress) onProgress(1); return null; }
      // Cloudflare rejects a request body over ~100MB at the edge, before
      // the worker (or this upload) ever sees it - confirmed by hand:
      // 100MB went through cleanly, 120MB came back a clean 413. Anything
      // under that ceiling should upload exactly as before - this only
      // catches the case that was doomed to fail ambiguously anyway,
      // instead of leaving it to a network round-trip that may not
      // resolve cleanly
      if (blob.size > 100 * 1024 * 1024) { if (onProgress) onProgress(1); return null; }
      // XHR (not fetch) so upload progress is actually observable - the
      // model file alone can be tens of MB, and a flat "saving..." with no
      // sense of how far along it is reads the same whether it's about to
      // finish or has silently stalled
      return new Promise(function (resolve) {
        var form = new FormData();
        form.append("file", blob, "file");
        var xhr = new XMLHttpRequest();
        xhr.open("POST", api() + "/captures/upload");
        // without this, a genuinely stalled connection (weak signal, a
        // proxy that silently drops the request mid-flight) never fires
        // onload/onerror at all - the sync-status badge was left showing
        // "uploading… X%" forever with no way to ever resolve as failed.
        // Scaled to the file's own size (with a floor) - a flat 60s was
        // cutting off large real scans that were genuinely still
        // uploading on a normal connection, not actually stuck.
        xhr.timeout = Math.max(60000, blob.size / (256 * 1024) * 1000);
        if (onProgress) {
          xhr.upload.addEventListener("progress", function (e) {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
          });
        }
        xhr.onload = function () {
          if (onProgress) onProgress(1);
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText).url); } catch (e) { resolve(null); }
          } else {
            resolve(null);
          }
        };
        xhr.onerror = function () { if (onProgress) onProgress(1); resolve(null); };
        xhr.ontimeout = function () { if (onProgress) onProgress(1); resolve(null); };
        xhr.send(form);
      });
    }).catch(function () { if (onProgress) onProgress(1); return null; });
  }

  // pushes one capture under the given scope ("archive" or "community").
  // Fire-and-forget from the caller's point of view — never throws, never
  // blocks the local save that already happened. onProgress (optional),
  // if given, is called repeatedly with a 0..1 fraction across all three
  // possible blob uploads combined.
  function publish(cap, scope, onProgress) {
    if (!api()) return Promise.resolve(null);
    var stage = [0, 0, 0];
    function report() {
      if (!onProgress) return;
      onProgress((stage[0] + stage[1] + stage[2]) / 3);
    }
    // a ref that started as "idb:" genuinely needed its bytes uploaded -
    // if that upload comes back empty, the record would land on the server
    // with a broken/missing file. Treat that as the whole publish failing
    // rather than reporting success just because the metadata write alone
    // went through.
    var neededUpload = [
      !!(cap.img && cap.img.indexOf("idb:") === 0),
      !!(cap.model && cap.model.indexOf("idb:") === 0),
      !!(cap.points && cap.points.indexOf("idb:") === 0),
    ];
    return Promise.all([
      resolveRef(cap.img, function (p) { stage[0] = p; report(); }),
      resolveRef(cap.model, function (p) { stage[1] = p; report(); }),
      resolveRef(cap.points, function (p) { stage[2] = p; report(); }),
    ])
      .then(function (refs) {
        if (neededUpload.some(function (was, i) { return was && !refs[i]; })) return null;
        var record = {
          id: scope === "community" ? cap.id + "-community" : cap.id,
          scope: scope,
          title: cap.title, feeling: cap.feeling || "", kind: cap.kind || "object",
          by: cap.by || "", country: cap.country || "", created: cap.created || Date.now(),
          img: refs[0], model: refs[1], points: refs[2],
          annotations: cap.annotations || [],
        };
        return fetch(api() + "/captures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }).then(function (r) { return r.ok ? r.json() : null; });
      })
      .catch(function () { return null; });
  }

  // fetches every shared capture for one scope. Always resolves (to [] on
  // any failure) — callers should treat this the same as an empty result.
  function list(scope) {
    if (!api()) return Promise.resolve([]);
    return fetch(api() + "/captures")
      .then(function (r) { return r.ok ? r.json() : { captures: [] }; })
      .then(function (d) { return (d.captures || []).filter(function (c) { return c.scope === scope; }); })
      .catch(function () { return []; });
  }

  // one-time catch-up: a capture made in this browser before the shared
  // store existed (or before it was reachable) never got sent. Called after
  // list() resolves, so it only pushes what the server doesn't have yet.
  // One at a time, not all fired at once — a batch of these routinely
  // includes several large raw point clouds, and launching a dozen-plus
  // big uploads concurrently on an ordinary connection meant most of them
  // silently lost the race (fire-and-forget swallows the failure) while
  // only a couple of the smallest actually finished.
  // onItem (optional): called as (capId, fraction, done, success) - fraction
  // climbs 0..1 while that capture's blobs upload, then a final call with
  // done=true reports whether it actually made it (success) or not.
  function syncMissing(localList, remoteList, scope, onItem) {
    if (!api()) return;
    var remoteIds = {};
    (remoteList || []).forEach(function (c) {
      remoteIds[(c.id || "").replace(/-community$/, "")] = true;
    });
    var pending = (localList || []).filter(function (cap) { return !remoteIds[cap.id]; });
    (function next() {
      var cap = pending.shift();
      if (!cap) return;
      publish(cap, scope, onItem ? function (p) { onItem(cap.id, p, false); } : null)
        .then(function (result) {
          if (onItem) onItem(cap.id, 1, true, !!result);
          next();
        }, function () {
          if (onItem) onItem(cap.id, 1, true, false);
          next();
        });
    })();
  }

  // Mor hiding one of her own fixed demo pieces or public archive items is
  // a curation decision - it should disappear for every visitor, not just
  // her own browser. A regular visitor's own "hide" stays purely local
  // (js/owner.js gates who's allowed to call these at all) and never
  // touches this. Always resolves - a stale/unreachable worker just means
  // the hide falls back to being local-only for this browser.
  function listHiddenShowcase() {
    if (!api()) return Promise.resolve([]);
    return fetch(api() + "/hidden-showcase")
      .then(function (r) { return r.ok ? r.json() : { hidden: [] }; })
      .then(function (d) { return d.hidden || []; })
      .catch(function () { return []; });
  }

  function hideShowcaseGlobally(key) {
    if (!api()) return Promise.resolve(null);
    return fetch(api() + "/hidden-showcase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key }),
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function restoreShowcaseGlobally(key) {
    if (!api()) return Promise.resolve(null);
    return fetch(api() + "/hidden-showcase/" + encodeURIComponent(key), { method: "DELETE" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  window.RemoteCaptures = {
    publish: publish, list: list, syncMissing: syncMissing,
    listHiddenShowcase: listHiddenShowcase,
    hideShowcaseGlobally: hideShowcaseGlobally,
    restoreShowcaseGlobally: restoreShowcaseGlobally,
  };
})();
