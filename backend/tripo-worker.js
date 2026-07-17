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
    POST /session/<id>   body { task_id }               -> { ok: true }
    GET  /session/<id>                                  -> { task_id }  (null until set)
    Requires a KV namespace bound as SESSIONS (see backend/README.md).

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
    body: JSON.stringify({ type: "image_to_model", file: { type: ext, file_token: token } }),
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
        const res = await fetch(`${TRIPO_BASE}/task/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        const data = await res.json().catch(() => ({}));
        const d = data?.data || {};
        const out = d.output || {};
        return json({
          status: d.status,
          progress: d.progress || 0,
          model_url: out.model_url || out.pbr_model || out.model || null,
          thumb: out.rendered_image_url || null,
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
          // capture, not kept around
          await env.SESSIONS.put(sessionId, JSON.stringify({ task_id: body.task_id }), {
            expirationTtl: 600,
          });
          return json({ ok: true });
        }
        if (request.method === "GET") {
          const stored = await env.SESSIONS.get(sessionId);
          return json(stored ? JSON.parse(stored) : { task_id: null });
        }
      }

      // ---- 5) diagnostics: which keys/bindings does this worker actually see? -
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
