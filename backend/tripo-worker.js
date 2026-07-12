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

  Deploy: see backend/README.md. Set the secret TRIPO_API_KEY in the Worker.

  The Tripo v3 API shape is taken from the official Quick Start:
    POST https://openapi.tripo3d.ai/v3/generation/<type>   -> { data: { task_id } }
    GET  https://openapi.tripo3d.ai/v3/tasks/<task_id>      -> { data: { status, progress, output } }
  If Tripo ever adjusts the upload path or token field, only the constants below
  need to change — every Tripo response is passed through in `raw` for debugging.
*/

const TRIPO_BASE = "https://openapi.tripo3d.ai/v3";
const UPLOAD_PATH = "/generation/upload";        // multipart image upload
const IMAGE_TASK_PATH = "/generation/image-to-model";
const MODEL = "tripo-v3.1";                        // matches the Quick Start example

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    const key = env.TRIPO_API_KEY;
    if (!key) return json({ error: "TRIPO_API_KEY is not set on the worker" }, 500);
    const auth = { Authorization: `Bearer ${key}` };

    try {
      // ---- 1) image -> task -------------------------------------------------
      if (url.pathname === "/generate" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("image");
        if (!file) return json({ error: "no image provided" }, 400);

        // upload the image to Tripo, get a token
        const up = new FormData();
        up.append("file", file, file.name || "capture.jpg");
        const upRes = await fetch(TRIPO_BASE + UPLOAD_PATH, {
          method: "POST",
          headers: auth,
          body: up,
        });
        const upData = await upRes.json().catch(() => ({}));
        const token =
          upData?.data?.image_token || upData?.data?.file_token || upData?.data?.token;
        if (!token) return json({ error: "upload failed", raw: upData }, 502);

        const ext = (file.name || "").toLowerCase().endsWith(".png") ? "png" : "jpg";

        // create the image-to-model task
        const taskRes = await fetch(TRIPO_BASE + IMAGE_TASK_PATH, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "image_to_model",
            model: MODEL,
            file: { type: ext, file_token: token },
          }),
        });
        const taskData = await taskRes.json().catch(() => ({}));
        const taskId = taskData?.data?.task_id;
        if (!taskId) return json({ error: "task creation failed", raw: taskData }, 502);
        return json({ task_id: taskId });
      }

      // ---- 2) poll task status ---------------------------------------------
      if (url.pathname === "/status" && request.method === "GET") {
        const taskId = url.searchParams.get("task_id");
        if (!taskId) return json({ error: "task_id required" }, 400);
        const res = await fetch(`${TRIPO_BASE}/tasks/${taskId}`, { headers: auth });
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

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
