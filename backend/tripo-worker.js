/*
  traces — Tripo backend (Cloudflare Worker)

  A tiny proxy that keeps the Tripo API key secret and turns an uploaded image
  into a 3D model. The static site (GitHub Pages) never sees the key.

  Endpoints (all CORS-enabled):
    POST /generate     multipart form field "image" (the photo to reconstruct)
                       -> { task_id }
    GET  /status?task_id=...   -> { status, progress, model_url, thumb, raw }
    GET  /proxy?url=...         streams a Tripo asset back same-origin (used so
                                model-viewer can load the GLB without CORS issues)
    GET  /debug                 -> { hasKey1, hasKey2, hasSessions, activeSlot, ... }
                                (no secrets, just whether each is set — open this
                                URL directly in a browser to sanity-check a deploy)

    -- phone hand-off: the desktop shows a QR code for a random session id;
       the phone scans it, takes a photo, and calls /generate itself, then
       drops the resulting task_id in this tiny relay for the desktop to pick
       up — the desktop never needs its own connection to the phone --
    POST /session/<id>   body { task_id, thumb? }        -> { ok: true }
    GET  /session/<id>                                  -> { task_id, thumb }  (null until set)
    Requires a KV namespace bound as SESSIONS (see backend/README.md).

    -- shared captures: a provisional stopgap so anything captured through
       the site is visible from any device, not just the browser that made
       it. No per-visitor separation yet — everything is world-readable and
       world-writable. `scope` ("community" or "archive") is carried on each
       record now so that distinction can be enforced later without a
       reshape. Files live in the same KV namespace as the records
       (deliberately, not R2 — R2 requires adding a payment method to a
       Cloudflare account even to stay within its free tier; KV's free tier
       needs none) — a large upload is split into several ~24MB chunks and
       reassembled on GET, so there's no meaningful per-file size limit,
       just KV's own free-tier storage total (1GB). Requires a KV namespace
       bound as CAPTURES (see backend/README.md) --
    POST /captures/upload   multipart form field "file" -> { fileId, url }
    GET  /captures/file/<fileId>                        -> streams the blob back
    POST /captures          JSON capture record          -> { id }
    GET  /captures                                       -> { captures: [...] }
    DELETE /captures/<id>                                -> { ok: true }

  -- two Tripo accounts, automatic handoff --
  TRIPO_API_KEY is the everyday/testing account. An optional second secret,
  TRIPO_API_KEY_2, is reserved for the real exhibition. Every /generate call
  uses the first key until EITHER it runs out of credit (Tripo error code
  2010) OR PRIMARY_KEY_WINDOW_MS elapses since its first use, whichever comes
  first — then it switches to the second key automatically, permanently, no
  code change or redeploy needed. Which key made a given task is remembered
  (in the same SESSIONS store) so a later /status poll queries the right
  account even if the switch happens while a task is still in flight.

  Deploy: see backend/README.md. Set the secret TRIPO_API_KEY (and, once you
  have a second Tripo account for the exhibition, TRIPO_API_KEY_2) on the Worker.

  The Tripo v2 openapi shape, confirmed live against the real API:
    POST https://api.tripo3d.ai/v2/openapi/upload           (multipart "file") -> { data: { image_token } }
    POST https://api.tripo3d.ai/v2/openapi/task              -> { data: { task_id } }
    GET  https://api.tripo3d.ai/v2/openapi/task/<task_id>    -> { data: { status, progress, output } }
  If Tripo ever adjusts the upload path or token field, only the constants below
  need to change — every Tripo response is passed through in `raw` for debugging.
*/

const TRIPO_BASE = "https://api.tripo3d.ai/v2/openapi";
const UPLOAD_PATH = "/upload";        // multipart image upload
const IMAGE_TASK_PATH = "/task";
const INSUFFICIENT_CREDIT_CODE = 2010; // Tripo's "not enough credit" error code
const PRIMARY_KEY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// KV values top out around 25MB — deliberately not R2 (see backend/README.md
// for why), so an upload larger than one KV value gets split across several
// "file:<id>:0", "file:<id>:1", ... entries and reassembled on GET, capped
// only by KV's own free-tier storage total (1GB), not by any single file's
// size
const MAX_CHUNK_BYTES = 24 * 1024 * 1024;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: cors({ "Content-Type": "application/json" }),
  });
}

// which account is "active" right now: key 1 until it's exhausted or its
// 14-day window is up, then key 2 — permanently (never switches back).
async function activeKeySlot(env) {
  if (!env.TRIPO_API_KEY_2 || !env.SESSIONS) return "1";
  let activatedAt = await env.SESSIONS.get("key1-activated-at");
  if (!activatedAt) {
    activatedAt = String(Date.now());
    await env.SESSIONS.put("key1-activated-at", activatedAt);
  }
  const expired = Date.now() - Number(activatedAt) > PRIMARY_KEY_WINDOW_MS;
  const exhausted = await env.SESSIONS.get("key1-exhausted");
  return (expired || exhausted) ? "2" : "1";
}

function keyForSlot(env, slot) {
  return slot === "2" ? env.TRIPO_API_KEY_2 : env.TRIPO_API_KEY;
}

// upload the image, then create the image-to-model task, with one account
async function callTripo(apiKey, file) {
  const auth = { Authorization: `Bearer ${apiKey}` };
  const up = new FormData();
  up.append("file", file, file.name || "capture.jpg");
  const upRes = await fetch(TRIPO_BASE + UPLOAD_PATH, { method: "POST", headers: auth, body: up });
  const upData = await upRes.json().catch(() => ({}));
  const token = upData?.data?.image_token || upData?.data?.file_token || upData?.data?.token;
  if (!token) return { error: "upload failed", raw: upData, code: upData?.code };

  const ext = (file.name || "").toLowerCase().endsWith(".png") ? "png" : "jpg";
  const taskRes = await fetch(TRIPO_BASE + IMAGE_TASK_PATH, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "image_to_model",
      file: { type: ext, file_token: token },
      // left unset, Tripo silently defaults to its OLDEST model
      // (v2.5-20250123) — confirmed by inspecting a completed task's own
      // `input.model_version` field. geometry_quality below only takes
      // effect on v3.0-20250812 or newer, so without this line, requesting
      // "detailed" geometry was being silently ignored the entire time
      model_version: "v3.0-20250812",
      // Tripo defaults to its coarsest settings if these are left out —
      // "detailed" texture and letting it size the model against the photo
      // both help on fine/textured surfaces (fur, fabric) that the
      // bare-bones default tends to smear into a blob. geometry_quality is
      // the separate mesh-shape counterpart — Tripo's own docs recommend
      // "detailed" specifically for organic/furry shapes (vs. "standard",
      // tuned for simple hard-surface objects), which is exactly where a
      // warped/melted face on a stuffed animal tends to come from
      texture_quality: "detailed",
      geometry_quality: "detailed",
      auto_size: true,
      // without this Tripo poses the model however it wants, often on its
      // side/back with the face turned away from the viewer — align it to
      // how the object was actually framed in the photo instead
      orientation: "align_image",
      // PBR generates real physically-based materials (roughness/metalness),
      // so fabric/upholstery reads as cloth with proper sheen instead of a
      // flat baked texture — the single best setting for furniture
      pbr: true,
      // keep the surface texture faithful to the actual photo instead of
      // letting Tripo re-invent the pattern/weave
      texture_alignment: "original_image",
    }),
  });
  const taskData = await taskRes.json().catch(() => ({}));
  const taskId = taskData?.data?.task_id;
  if (!taskId) return { error: "task creation failed", raw: taskData, code: taskData?.code };
  return { task_id: taskId };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    try {
      // ---- 1) image -> task -------------------------------------------------
      if (url.pathname === "/generate" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("image");
        if (!file) return json({ error: "no image provided" }, 400);

        let slot = await activeKeySlot(env);
        let apiKey = keyForSlot(env, slot);
        if (!apiKey) return json({ error: "TRIPO_API_KEY is not set on the worker" }, 500);

        let result = await callTripo(apiKey, file);
        // the everyday key just ran dry — remember that (so we don't retry
        // it forever) and fail over to the exhibition key immediately
        if (result.error && result.code === INSUFFICIENT_CREDIT_CODE && slot === "1" && env.TRIPO_API_KEY_2) {
          if (env.SESSIONS) await env.SESSIONS.put("key1-exhausted", "1");
          slot = "2";
          result = await callTripo(env.TRIPO_API_KEY_2, file);
        }
        if (result.error) return json(result, 502);

        // remember which account made this task, so /status polls the right one
        if (env.SESSIONS) {
          await env.SESSIONS.put("task-key:" + result.task_id, slot, { expirationTtl: 86400 });
        }
        return json({ task_id: result.task_id });
      }

      // ---- 2) poll task status ---------------------------------------------
      if (url.pathname === "/status" && request.method === "GET") {
        const taskId = url.searchParams.get("task_id");
        if (!taskId) return json({ error: "task_id required" }, 400);
        let slot = "1";
        if (env.SESSIONS) slot = (await env.SESSIONS.get("task-key:" + taskId)) || "1";
        const apiKey = keyForSlot(env, slot);
        let res = await fetch(`${TRIPO_BASE}/task/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        let data = await res.json().catch(() => ({}));
        // the task→key mapping only lives 24h; after that this guessed
        // slot 1 for every old task — and recovering a scan (see
        // recover-tasks.html) is exactly a query about an OLD task. When the
        // guessed account rejects the query or doesn't know the task, ask
        // the other account before giving up.
        if (!data?.data && env.SESSIONS !== undefined) {
          const otherSlot = slot === "1" ? "2" : "1";
          const otherKey = keyForSlot(env, otherSlot);
          if (otherKey && otherKey !== apiKey) {
            const res2 = await fetch(`${TRIPO_BASE}/task/${taskId}`, { headers: { Authorization: `Bearer ${otherKey}` } });
            const data2 = await res2.json().catch(() => ({}));
            if (data2?.data) data = data2;
          }
        }
        const d = data?.data || {};
        const out = d.output || {};
        return json({
          status: d.status,
          progress: d.progress || 0,
          model_url: out.model_url || out.pbr_model || out.model || null,
          // Tripo's actual field names, confirmed against a real completed
          // task's raw response — "rendered_image_url" (the guess this used
          // to use) doesn't exist, which is why every thumbnail has been
          // silently blank
          thumb: out.rendered_image || d.thumbnail || null,
          raw: data,
        });
      }

      // ---- 3) same-origin proxy for the finished GLB ------------------------
      if (url.pathname === "/proxy" && request.method === "GET") {
        const target = url.searchParams.get("url");
        if (!target) return json({ error: "url required" }, 400);
        const res = await fetch(target);
        return new Response(res.body, {
          status: res.status,
          headers: cors({
            "Content-Type": res.headers.get("Content-Type") || "model/gltf-binary",
          }),
        });
      }

      // ---- 4) phone hand-off relay (a tiny pigeonhole, not a live channel) --
      if (url.pathname.startsWith("/session/")) {
        const sessionId = url.pathname.slice("/session/".length);
        if (!sessionId) return json({ error: "session id required" }, 400);
        if (!env.SESSIONS) {
          return json({ error: "SESSIONS KV namespace is not bound on this worker" }, 500);
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (!body.task_id) return json({ error: "task_id required" }, 400);
          // sessions are single-use and short-lived — the QR is shown for one
          // capture, not kept around. The optional `thumb` is a small JPEG
          // data URL of the phone's shot, relayed so the desktop can show the
          // photo back for a final look before proceeding (older phone pages
          // simply don't send it, and the desktop falls back gracefully).
          await env.SESSIONS.put(
            sessionId,
            JSON.stringify({ task_id: body.task_id, thumb: body.thumb || null }),
            { expirationTtl: 600 }
          );
          return json({ ok: true });
        }
        if (request.method === "GET") {
          const stored = await env.SESSIONS.get(sessionId);
          return json(stored ? JSON.parse(stored) : { task_id: null });
        }
      }

      // ---- 5) shared captures — one global store, everyone reads and writes it ----
      // A provisional stopgap while the site has no real accounts: every
      // capture (whether marked "archive" or "community") is world-readable
      // and world-writable through this same store — there is no per-visitor
      // separation yet. The `scope` field on each record is carried through
      // now specifically so that distinction can be added later (e.g. only
      // serving "archive"-scoped records back to the device that made them)
      // without changing the record shape or re-touching every call site.
      //
      //   POST /captures/upload   multipart form field "file" (binary: a
      //                           point-cloud blob, a GLB, a thumbnail) ->
      //                           { fileId, url }  (url is same-origin,
      //                           streams the blob back via GET)
      //   GET  /captures/file/<fileId>   streams the stored binary back
      //   POST /captures         JSON body (see shape below) -> { id }
      //   GET  /captures                  -> { captures: [...] }  (everything,
      //                           both scopes — the client filters by scope)
      //   DELETE /captures/<id>           -> { ok: true }
      //
      // A capture record:
      //   { id, scope: "community"|"archive", title, feeling, kind,
      //     by, country, created, img, model, points, annotations: [...] }
      // `model`/`points`/`img` are each either an already-public URL (e.g. a
      // Tripo /proxy link) or one of this worker's own /captures/file/<id>
      // URLs from a prior /captures/upload call.
      if (url.pathname === "/captures/upload" && request.method === "POST") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const form = await request.formData();
        const file = form.get("file");
        if (!file) return json({ error: "no file provided" }, 400);
        const buf = await file.arrayBuffer();
        const fileId = crypto.randomUUID();
        const chunkCount = Math.max(1, Math.ceil(buf.byteLength / MAX_CHUNK_BYTES));
        const puts = [];
        for (let i = 0; i < chunkCount; i++) {
          const start = i * MAX_CHUNK_BYTES;
          puts.push(env.CAPTURES.put("file:" + fileId + ":" + i, buf.slice(start, start + MAX_CHUNK_BYTES)));
        }
        puts.push(env.CAPTURES.put("file:" + fileId + ":meta", JSON.stringify({
          chunks: chunkCount,
          contentType: file.type || "application/octet-stream",
          size: buf.byteLength,
        })));
        await Promise.all(puts);
        return json({ fileId, url: `${url.origin}/captures/file/${fileId}` });
      }

      // ---- chunked upload for files past Cloudflare's ~100MB per-request edge
      // limit. The client generates a fileId, PUTs each <=20MB chunk to
      // /captures/upload-chunk?fileId&index (raw body), then calls
      // /captures/upload-finalize to write the meta. The GET handler below
      // reassembles from the same chunk keys, so a big scan saves permanently
      // just like a small one. ----
      if (url.pathname === "/captures/upload-chunk" && request.method === "POST") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const fileId = url.searchParams.get("fileId");
        const index = parseInt(url.searchParams.get("index"), 10);
        if (!fileId || !/^[a-f0-9-]+$/i.test(fileId) || Number.isNaN(index)) return json({ error: "bad chunk" }, 400);
        const buf = await request.arrayBuffer();
        await env.CAPTURES.put("file:" + fileId + ":" + index, buf);
        return json({ ok: true });
      }

      if (url.pathname === "/captures/upload-finalize" && request.method === "POST") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const fileId = url.searchParams.get("fileId");
        const chunks = parseInt(url.searchParams.get("chunks"), 10);
        const size = parseInt(url.searchParams.get("size"), 10);
        const contentType = url.searchParams.get("type") || "application/octet-stream";
        if (!fileId || !/^[a-f0-9-]+$/i.test(fileId) || Number.isNaN(chunks) || Number.isNaN(size)) {
          return json({ error: "bad finalize" }, 400);
        }
        await env.CAPTURES.put("file:" + fileId + ":meta", JSON.stringify({ chunks, contentType, size }));
        return json({ fileId, url: `${url.origin}/captures/file/${fileId}` });
      }

      if (url.pathname.startsWith("/captures/file/") && request.method === "GET") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const fileId = url.pathname.slice("/captures/file/".length);
        const meta = await env.CAPTURES.get("file:" + fileId + ":meta", "json");
        if (!meta) return json({ error: "not found" }, 404);
        const chunks = await Promise.all(
          Array.from({ length: meta.chunks }, (_, i) => env.CAPTURES.get("file:" + fileId + ":" + i, "arrayBuffer"))
        );
        if (chunks.some((c) => !c)) return json({ error: "not found" }, 404);
        const whole = new Uint8Array(meta.size);
        let offset = 0;
        for (const chunk of chunks) {
          whole.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        return new Response(whole, {
          // each fileId is a fresh crypto.randomUUID at upload time and its
          // bytes never change, so the file is safely immutable — let the
          // browser cache it forever instead of re-downloading the whole
          // model / point cloud on every view and every reload (this was the
          // "everything loads forever" on a slow connection)
          headers: cors({
            "Content-Type": meta.contentType || "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          }),
        });
      }

      if (url.pathname === "/captures" && request.method === "POST") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const body = await request.json().catch(() => null);
        if (!body || !body.title) return json({ error: "title required" }, 400);
        const id = body.id || crypto.randomUUID();
        const record = {
          id,
          scope: body.scope === "archive" ? "archive" : "community",
          title: body.title,
          feeling: body.feeling || "",
          kind: body.kind || "object",
          by: body.by || "",
          country: body.country || "",
          created: body.created || Date.now(),
          img: body.img || null,
          model: body.model || null,
          points: body.points || null,
          annotations: Array.isArray(body.annotations) ? body.annotations : [],
          // the capture's dated re-scan history, and the framing/render choices
          // made in object.html — dropped here before, so every publish (and
          // every "patch just this field" resave) silently lost the timeline
          // and the visitor never saw the angle/point-size Mor picked
          versions: Array.isArray(body.versions) ? body.versions : [],
        };
        if (body.defaultView != null) record.defaultView = body.defaultView;
        if (body.pointSize != null) record.pointSize = body.pointSize;
        if (body.tilt != null) record.tilt = body.tilt;
        if (body.dual) record.dual = true;
        // link markers (where connected captures sit inside a space) and the
        // object->space connection itself — without these a visitor opening a
        // shared space never sees the objects marked inside it
        if (Array.isArray(body.links)) record.links = body.links;
        if (body.connected != null) record.connected = body.connected;
        if (body.connectedKey != null) record.connectedKey = body.connectedKey;
        // which representation the capture opens on ("points" = the light,
        // fast cloud first; the heavy mesh only when toggled to)
        if (body.openOn) record.openOn = body.openOn;
        await env.CAPTURES.put("capture:" + id, JSON.stringify(record));
        return json({ id });
      }

      if (url.pathname === "/captures" && request.method === "GET") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const list = await env.CAPTURES.list({ prefix: "capture:" });
        const records = await Promise.all(list.keys.map((k) => env.CAPTURES.get(k.name, "json")));
        return json({ captures: records.filter(Boolean) });
      }

      if (url.pathname.startsWith("/captures/") && request.method === "DELETE") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const id = url.pathname.slice("/captures/".length);
        await env.CAPTURES.delete("capture:" + id);
        return json({ ok: true });
      }

      // ---- 5b) shared showcase hides: when Mor hides one of her own fixed
      // demo pieces or public archive items, that's a curation decision -
      // it should disappear for every visitor, not just her own browser.
      // A regular visitor hiding something stays purely local (see
      // js/owner.js / the "traces-archive-hidden" localStorage list) and
      // never touches this endpoint at all.
      //   GET    /hidden-showcase        -> { hidden: ["key1", "key2", ...] }
      //   POST   /hidden-showcase        body { key }  -> { hidden: [...] }
      //   DELETE /hidden-showcase/<key>                -> { hidden: [...] }
      if (url.pathname === "/hidden-showcase" && request.method === "GET") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const hidden = (await env.CAPTURES.get("meta:hidden-showcase", "json")) || [];
        return json({ hidden });
      }

      if (url.pathname === "/hidden-showcase" && request.method === "POST") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const body = await request.json().catch(() => null);
        if (!body || !body.key) return json({ error: "key required" }, 400);
        const hidden = (await env.CAPTURES.get("meta:hidden-showcase", "json")) || [];
        if (hidden.indexOf(body.key) === -1) hidden.push(body.key);
        await env.CAPTURES.put("meta:hidden-showcase", JSON.stringify(hidden));
        return json({ hidden });
      }

      if (url.pathname.startsWith("/hidden-showcase/") && request.method === "DELETE") {
        if (!env.CAPTURES) return json({ error: "CAPTURES KV namespace is not bound on this worker" }, 500);
        const key = decodeURIComponent(url.pathname.slice("/hidden-showcase/".length));
        const hidden = ((await env.CAPTURES.get("meta:hidden-showcase", "json")) || []).filter((k) => k !== key);
        await env.CAPTURES.put("meta:hidden-showcase", JSON.stringify(hidden));
        return json({ hidden });
      }

      // ---- 6) diagnostics: which keys/bindings does this worker actually see? -
      // never returns the secrets themselves, only whether each is set — safe
      // to open straight in a browser to sanity-check a deploy
      if (url.pathname === "/debug" && request.method === "GET") {
        const hasKey1 = !!env.TRIPO_API_KEY;
        const hasKey2 = !!env.TRIPO_API_KEY_2;
        const hasSessions = !!env.SESSIONS;
        let activatedAt = null, exhausted = false, slot = "1";
        if (hasSessions) {
          activatedAt = await env.SESSIONS.get("key1-activated-at");
          exhausted = !!(await env.SESSIONS.get("key1-exhausted"));
        }
        slot = await activeKeySlot(env);
        return json({
          hasKey1, hasKey2, hasSessions,
          hasCaptures: !!env.CAPTURES,
          activeSlot: slot,
          key1ActivatedAt: activatedAt ? new Date(Number(activatedAt)).toISOString() : null,
          key1Exhausted: exhausted,
        });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
