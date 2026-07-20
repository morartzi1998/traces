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

  // load the actual bytes an "idb:" ref points at. A ref that's already a
  // plain URL (e.g. a Tripo /proxy link) or missing needs no upload, so
  // there's nothing to load (null).
  function loadBlob(ref) {
    if (!ref || ref.indexOf("idb:") !== 0) return Promise.resolve(null);
    if (!(window.BlobStore && api())) return Promise.resolve(null);
    return window.BlobStore.get(ref.slice(4)).catch(function () { return null; });
  }

  // upload one blob, resolving to the worker's fetchable URL for it (or
  // null on any failure). onProgress (optional) gets a 0..1 fraction of
  // THIS blob's own bytes.
  function uploadBlob(blob, onProgress) {
    // Cloudflare rejects a request body over ~100MB at the edge, before
    // the worker (or this upload) ever sees it - confirmed by hand: 100MB
    // went through cleanly, 120MB came back a clean 413. Fail it here,
    // instantly, instead of leaving it to a round-trip that never resolves.
    if (blob.size > 100 * 1024 * 1024) { if (onProgress) onProgress(1); return Promise.resolve(null); }
    // XHR (not fetch) so upload progress is actually observable - a real
    // point-cloud file is tens of MB, and a flat "saving..." reads the same
    // whether it's about to finish or has silently stalled
    return new Promise(function (resolve) {
      var form = new FormData();
      form.append("file", blob, "file");
      var xhr = new XMLHttpRequest();
      xhr.open("POST", api() + "/captures/upload");
      // a genuinely stalled connection (weak signal, a proxy that silently
      // drops the request mid-flight) never fires onload/onerror at all -
      // the sync-status badge was left showing "uploading… X%" forever with
      // no way to ever resolve as failed. But xhr.timeout is a TOTAL-time
      // limit, which would wrongly kill a large file that's genuinely still
      // uploading, just slowly, on an ordinary home connection. Instead,
      // watch for a real STALL: reset a 45s timer on every progress event,
      // so it only gives up when the bytes actually stop flowing - a slow
      // but progressing upload is left to finish however long it needs.
      var STALL_MS = 45000;
      var stallTimer = null;
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        if (onProgress) onProgress(1);
        resolve(v);
      }
      function armStall() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () { try { xhr.abort(); } catch (e) {} done(null); }, STALL_MS);
      }
      xhr.upload.addEventListener("progress", function (e) {
        armStall();
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.onload = function () {
        if (stallTimer) clearTimeout(stallTimer);
        if (xhr.status >= 200 && xhr.status < 300) {
          var url = null;
          try { url = JSON.parse(xhr.responseText).url; } catch (e) {}
          done(url);
        } else {
          done(null);
        }
      };
      xhr.onerror = function () { done(null); };
      xhr.onabort = function () { done(null); };
      armStall(); // in case not even the first progress event ever fires
      xhr.send(form);
    });
  }

  // pushes one capture under the given scope ("archive" or "community").
  // Fire-and-forget from the caller's point of view — never throws, never
  // blocks the local save that already happened. onProgress (optional),
  // if given, is called repeatedly with a 0..1 fraction across all the
  // capture's blob uploads combined.
  function publish(cap, scope, onProgress) {
    if (!api()) return Promise.resolve(null);
    var refs = [cap.img, cap.model, cap.points];
    // a ref that started as "idb:" genuinely needed its bytes uploaded -
    // if that upload comes back empty, the record would land on the server
    // with a broken/missing file. Treat that as the whole publish failing
    // rather than reporting success just because the metadata write alone
    // went through.
    var neededUpload = refs.map(function (r) { return !!(r && r.indexOf("idb:") === 0); });
    return Promise.all(refs.map(loadBlob)).then(function (blobs) {
      // weight the combined progress by each blob's real byte size. The old
      // naive (a+b+c)/3 average made a point-cloud capture (a tiny thumbnail
      // + no model + one big 50-80MB cloud) jump to ~67% the instant the two
      // small/absent files "finished", then crawl the last third while the
      // one big file actually uploaded - it read as frozen at ~70% even
      // while working. Weighting by size makes the number track the file
      // that's actually taking the time.
      var sizes = blobs.map(function (b) { return b ? b.size : 0; });
      var total = (sizes[0] + sizes[1] + sizes[2]) || 1;
      var frac = [0, 0, 0];
      function report() {
        if (!onProgress) return;
        onProgress((frac[0] * sizes[0] + frac[1] * sizes[1] + frac[2] * sizes[2]) / total);
      }
      return Promise.all([0, 1, 2].map(function (i) {
        var blob = blobs[i];
        // nothing to upload for this slot: a passthrough URL stays as-is, a
        // null ref (or a failed idb load) stays null
        if (!blob) { frac[i] = 1; report(); return Promise.resolve(neededUpload[i] ? null : refs[i]); }
        return uploadBlob(blob, function (p) { frac[i] = p; report(); });
      })).then(function (out) {
        if (neededUpload.some(function (was, i) { return was && !out[i]; })) return null;
        var record = {
          id: scope === "community" ? cap.id + "-community" : cap.id,
          scope: scope,
          title: cap.title, feeling: cap.feeling || "", kind: cap.kind || "object",
          by: cap.by || "", country: cap.country || "", created: cap.created || Date.now(),
          img: out[0], model: out[1], points: out[2],
          annotations: cap.annotations || [],
        };
        return fetch(api() + "/captures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }).then(function (r) { return r.ok ? r.json() : null; });
      });
    }).catch(function () { return null; });
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
