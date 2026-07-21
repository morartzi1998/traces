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
  // a Tripo /proxy link points at Tripo's own CDN with a short-lived signed
  // URL — great for the live preview, useless once saved because it 403s within
  // hours. Detect it so publish() can re-host its bytes permanently instead.
  function isTripoProxy(ref) {
    return typeof ref === "string" && ref.indexOf("/proxy?url=") !== -1;
  }

  function loadBlob(ref) {
    if (ref && ref.indexOf("idb:") === 0) {
      if (!(window.BlobStore && api())) return Promise.resolve(null);
      return window.BlobStore.get(ref.slice(4)).catch(function () { return null; });
    }
    // download the Tripo model now (the link is still fresh at publish time)
    // so its bytes get uploaded to our own store and the saved record keeps a
    // permanent /captures/file URL, not an expiring one
    if (isTripoProxy(ref)) {
      return fetch(ref).then(function (r) { return r.ok ? r.blob() : null; }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  // upload one blob, resolving to the worker's fetchable URL for it (or
  // null after every retry fails). A big point-cloud upload that stalls is
  // usually a transient weak moment on the connection, not a permanent error —
  // dropping it there is exactly how a paid-for scan silently failed to save
  // (the "living room chandelier" stuck at 17%). So retry the whole upload a
  // few times with growing backoff before giving up.
  function uploadBlob(blob, onProgress, attempt) {
    attempt = attempt || 0;
    return uploadBlobOnce(blob, onProgress).then(function (url) {
      if (url || attempt >= 3) return url;
      return new Promise(function (r) { setTimeout(r, 1500 * (attempt + 1)); }).then(function () {
        if (onProgress) onProgress(0); // this blob starts over from 0%
        return uploadBlob(blob, onProgress, attempt + 1);
      });
    });
  }

  // a file past Cloudflare's ~100MB per-request edge limit can't go up in one
  // POST at all, so a big scan silently never saved. Send it in <=20MB pieces
  // to the worker's chunked-upload endpoints instead (added in tripo-worker.js),
  // which reassembles them under one fileId. If those endpoints aren't there
  // yet (worker not redeployed), the fetches 404 and this resolves null, same
  // as before — nothing else breaks.
  function uploadBlobChunked(blob, onProgress) {
    var base = api();
    var CHUNK = 20 * 1024 * 1024;
    var total = Math.ceil(blob.size / CHUNK);
    var fileId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : ("f" + Date.now() + "-" + Math.random().toString(36).slice(2)).replace(/[^a-f0-9-]/gi, "");
    var uploaded = 0;
    // each piece retries on its own — one transient hiccup used to fail the
    // WHOLE file, throwing away every chunk that had already made it up
    function putOne(i, part, attempt) {
      return fetch(base + "/captures/upload-chunk?fileId=" + fileId + "&index=" + i, { method: "POST", body: part })
        .then(function (r) { return r.ok ? true : null; })
        .catch(function () { return null; })
        .then(function (okr) {
          if (okr) return true;
          if ((attempt || 0) >= 2) return null;
          return new Promise(function (r) { setTimeout(r, 1200 * ((attempt || 0) + 1)); })
            .then(function () { return putOne(i, part, (attempt || 0) + 1); });
        });
    }
    function finalize(attempt) {
      return fetch(base + "/captures/upload-finalize?fileId=" + fileId + "&chunks=" + total +
        "&size=" + blob.size + "&type=" + encodeURIComponent(blob.type || "application/octet-stream"),
        { method: "POST" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (d) {
          if (d && d.url) { if (onProgress) onProgress(1); return d.url; }
          if ((attempt || 0) >= 2) return null;
          return new Promise(function (r) { setTimeout(r, 1200 * ((attempt || 0) + 1)); })
            .then(function () { return finalize((attempt || 0) + 1); });
        });
    }
    function putChunk(i) {
      if (i >= total) return finalize(0);
      var part = blob.slice(i * CHUNK, Math.min(blob.size, (i + 1) * CHUNK));
      return putOne(i, part, 0).then(function (okr) {
        if (!okr) return null;
        uploaded += part.size;
        if (onProgress) onProgress(Math.min(0.99, uploaded / blob.size));
        return putChunk(i + 1);
      });
    }
    return putChunk(0);
  }

  // one upload attempt, resolving to the worker's fetchable URL for the blob
  // (or null on any failure). onProgress (optional) gets a 0..1 fraction of
  // THIS blob's own bytes.
  function uploadBlobOnce(blob, onProgress) {
    // anything sizable goes up in pieces, not just files past the ~100MB edge
    // limit: a single giant POST forces the worker to swallow the whole body
    // at once (several sequential storage writes on its side while the
    // client hangs at "100%"), and one hiccup costs the entire file. Small
    // pieces each complete in seconds, retry individually, and give real
    // granular progress. The threshold matches the worker's own 24MB
    // per-stored-piece design.
    if (blob.size > 24 * 1024 * 1024) return uploadBlobChunked(blob, onProgress);
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
      // once the body is FULLY sent, no further progress events will ever
      // fire while the worker stores the file — a big blob means several
      // sequential storage writes server-side, which can genuinely take
      // longer than the stall window. Re-arming the short stall timer on
      // that last progress event was aborting perfectly good uploads AT
      // 100% and restarting them from zero, over and over. After the last
      // byte leaves, the server gets its own much more generous window.
      var RESPONSE_MS = 240000;
      var stallTimer = null;
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        if (onProgress) onProgress(1);
        resolve(v);
      }
      function armStall(ms) {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () { try { xhr.abort(); } catch (e) {} done(null); }, ms || STALL_MS);
      }
      xhr.upload.addEventListener("progress", function (e) {
        if (e.lengthComputable && e.loaded >= e.total) {
          armStall(RESPONSE_MS); // body sent — now we're waiting on the server, not the pipe
        } else {
          armStall();
        }
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

  // how many publishes are currently mid-flight — the kiosk idle reset
  // (js/flow.js) checks this so it never navigates away from a tab that's
  // still uploading, which silently killed the big timeline syncs every
  // time the archive tab sat untouched for ten minutes
  var inflightPublishes = 0;
  function busy() { return inflightPublishes > 0; }

  // pushes one capture under the given scope ("archive" or "community").
  // Fire-and-forget from the caller's point of view — never throws, never
  // blocks the local save that already happened. onProgress (optional),
  // if given, is called repeatedly with a 0..1 fraction across all the
  // capture's blob uploads combined.
  function publish(cap, scope, onProgress) {
    if (!api()) return Promise.resolve(null);
    inflightPublishes++;
    var settled = false;
    function done() { if (!settled) { settled = true; inflightPublishes--; } }
    var refs = [cap.img, cap.model, cap.points];
    // a ref that started as "idb:" genuinely needed its bytes uploaded -
    // if that upload comes back empty, the record would land on the server
    // with a broken/missing file. Treat that as the whole publish failing
    // rather than reporting success just because the metadata write alone
    // went through.
    var neededUpload = refs.map(function (r) { return !!(r && (r.indexOf("idb:") === 0 || isTripoProxy(r))); });
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
        // reuse the just-uploaded top-level URLs when a timeline version points
        // at the same source blob, so nothing is uploaded twice
        var rehostCache = {};
        refs.forEach(function (r, i) { if (r) rehostCache[r] = Promise.resolve(out[i]); });
        // re-host each dated version's own blobs too, so a visitor loading this
        // capture from the server gets the full timeline (its dated history),
        // not just the latest scan — this is why the timeline showed in owner
        // mode (local record has the versions) but never for visitors (the
        // server record dropped them entirely).
        var versions = Array.isArray(cap.versions) ? cap.versions : [];
        // the version blobs are the megabytes that actually take the time
        // here (the base refs above are usually already hosted), and they
        // used to upload with NO progress reporting at all — the status
        // label sat frozen for minutes, which read as "nothing is moving"
        // every single time. Track a count-weighted fraction across every
        // version ref that still needs uploading.
        var vRefs = [];
        versions.forEach(function (v) {
          [["img", "hostedImg"], ["model", "hostedModel"], ["points", "hostedPoints"]].forEach(function (p) {
            var ref = v[p[0]];
            if (!v[p[1]] && ref && (ref.indexOf("idb:") === 0 || isTripoProxy(ref)) && !rehostCache[ref]) vRefs.push(ref);
          });
        });
        var vFrac = {};
        function reportVersions() {
          if (!onProgress || !vRefs.length) return;
          var sum = 0;
          vRefs.forEach(function (r) { sum += vFrac[r] || 0; });
          onProgress(sum / vRefs.length);
        }
        function rehost(ref) {
          if (!ref) return Promise.resolve(ref || null);
          if (!(ref.indexOf("idb:") === 0 || isTripoProxy(ref))) return Promise.resolve(ref);
          if (rehostCache[ref]) return rehostCache[ref];
          var p = loadBlob(ref).then(function (b) {
            if (!b) return null;
            return uploadBlob(b, function (f) { vFrac[ref] = f; reportVersions(); });
          });
          rehostCache[ref] = p;
          return p;
        }
        return Promise.all(versions.map(function (v) {
          return Promise.all([
            // a version whose upload already finished in an earlier attempt
            // carries its hosted URL on the local record — skip it entirely
            v.hostedImg ? Promise.resolve(v.hostedImg) : rehost(v.img),
            v.hostedModel ? Promise.resolve(v.hostedModel) : rehost(v.model),
            v.hostedPoints ? Promise.resolve(v.hostedPoints) : rehost(v.points),
          ]).then(function (rv) {
            // remember each finished upload ON the local record immediately —
            // closing the tab mid-way used to restart ALL the megabytes from
            // zero on the next attempt, so a big timeline could never finish
            // across normal browsing. Now every completed piece sticks, and
            // a restart only uploads what's still missing.
            try {
              if (rv[0]) v.hostedImg = rv[0];
              if (rv[1]) v.hostedModel = rv[1];
              if (rv[2]) v.hostedPoints = rv[2];
              if (window.Archive && window.Archive.get(cap.id)) window.Archive.update(cap.id, { versions: versions });
              if (window.Community && window.Community.get(cap.id)) window.Community.update(cap.id, { versions: versions });
            } catch (e) {}
            return { created: v.created, title: v.title, img: rv[0], model: rv[1], points: rv[2] };
          });
        })).then(function (rehostedVersions) {
          var record = {
            id: scope === "community" ? cap.id + "-community" : cap.id,
            scope: scope,
            title: cap.title, feeling: cap.feeling || "", kind: cap.kind || "object",
            by: cap.by || "", country: cap.country || "", created: cap.created || Date.now(),
            img: out[0], model: out[1], points: out[2],
            annotations: cap.annotations || [],
            versions: rehostedVersions,
          };
          // carry the framing/render choices so visitors see the same angle
          if (cap.defaultView != null) record.defaultView = cap.defaultView;
          if (cap.pointSize != null) record.pointSize = cap.pointSize;
          if (cap.tilt != null) record.tilt = cap.tilt;
          if (cap.dual) record.dual = true; // open on the mesh, not the voxel cloud
          return fetch(api() + "/captures", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(record),
          }).then(function (r) { return r.ok ? r.json() : null; });
        });
      });
    }).then(function (r) { done(); return r; }, function () { done(); return null; });
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
  // All fired at once, by request — a batch of these can include several
  // large raw point clouds, and an earlier version of this ran them one at a
  // time after launching a dozen-plus concurrently on an ordinary connection
  // meant most of them silently lost the race (fire-and-forget swallows the
  // failure) while only a couple of the smallest actually finished. Each
  // upload already retries itself a few times on its own (see uploadBlob),
  // which is what makes firing them all together survivable rather than a
  // repeat of that same failure.
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
    pending.forEach(function (cap) {
      publish(cap, scope, onItem ? function (p) { onItem(cap.id, p, false); } : null)
        .then(function (result) {
          if (onItem) onItem(cap.id, 1, true, !!result);
        }, function () {
          if (onItem) onItem(cap.id, 1, true, false);
        });
    });
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
    publish: publish, list: list, syncMissing: syncMissing, busy: busy,
    listHiddenShowcase: listHiddenShowcase,
    hideShowcaseGlobally: hideShowcaseGlobally,
    restoreShowcaseGlobally: restoreShowcaseGlobally,
  };
})();
