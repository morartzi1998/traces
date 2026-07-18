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
  // already a plain URL (e.g. a Tripo /proxy link) needs no upload at all.
  function resolveRef(ref) {
    if (!ref) return Promise.resolve(null);
    if (ref.indexOf("idb:") !== 0) return Promise.resolve(ref);
    if (!(window.BlobStore && api())) return Promise.resolve(null);
    return window.BlobStore.get(ref.slice(4)).then(function (blob) {
      if (!blob) return null;
      var form = new FormData();
      form.append("file", blob, "file");
      return fetch(api() + "/captures/upload", { method: "POST", body: form })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d ? d.url : null; })
        .catch(function () { return null; });
    }).catch(function () { return null; });
  }

  // pushes one capture under the given scope ("archive" or "community").
  // Fire-and-forget from the caller's point of view — never throws, never
  // blocks the local save that already happened.
  function publish(cap, scope) {
    if (!api()) return Promise.resolve(null);
    return Promise.all([resolveRef(cap.img), resolveRef(cap.model), resolveRef(cap.points)])
      .then(function (refs) {
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
  function syncMissing(localList, remoteList, scope) {
    if (!api()) return;
    var remoteIds = {};
    (remoteList || []).forEach(function (c) {
      remoteIds[(c.id || "").replace(/-community$/, "")] = true;
    });
    var pending = (localList || []).filter(function (cap) { return !remoteIds[cap.id]; });
    (function next() {
      var cap = pending.shift();
      if (!cap) return;
      publish(cap, scope).then(next, next);
    })();
  }

  window.RemoteCaptures = { publish: publish, list: list, syncMissing: syncMissing };
})();
