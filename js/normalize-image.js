/*
  traces — normalize a picked photo to a plain JPEG before it reaches Tripo.
  iPhones save photos as HEIC by default; Tripo's API rejects that outright
  ("This image file type is not supported", code 2004). A canvas re-encode
  would be the obvious fix, but Chrome can only *display* HEIC (via macOS's
  own image codecs) — it refuses to hand HEIC pixels to canvas or
  createImageBitmap, so that path fails silently for exactly the files that
  need it most. heic2any (vendored, WASM-based, no network calls) decodes
  HEIC itself instead of relying on the browser's codec support; everything
  else still goes through the plain canvas path.

  Also caps the long edge at MAX_DIM. A phone's camera shoots at whatever its
  sensor natively is — 12 to 48+ megapixels, a 10-20MB JPEG — and none of
  that resolution reaches Tripo's reconstruction or ever gets displayed
  anywhere in the interface at more than a small preview. An unresized photo
  used to go out over the network byte-for-byte: on a slow phone connection
  the upload alone took minutes with nothing on screen to say why ("takes
  forever to reach the computer"). 2048px is comfortably above what any
  photogrammetry step here actually uses.
*/
var NORMALIZE_MAX_DIM = 2048;

function decodeToBitmap(file) {
  return window.createImageBitmap
    ? createImageBitmap(file).catch(decodeViaImgTag)
    : decodeViaImgTag();

  function decodeViaImgTag() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.src = URL.createObjectURL(file);
      img.decode().then(function () { resolve(img); }, reject);
    });
  }
}

function resizeToJpeg(bitmap, maxDim) {
  var w = bitmap.width || bitmap.naturalWidth;
  var h = bitmap.height || bitmap.naturalHeight;
  var scale = Math.min(1, maxDim / Math.max(w, h));
  var canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (blob) resolve(blob); else reject(new Error("could not encode image"));
    }, "image/jpeg", 0.88);
  });
}

function normalizeImageToJpeg(file) {
  var isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "");
  var decoded = (isHeic && window.heic2any)
    ? window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 })
        .then(function (out) { return Array.isArray(out) ? out[0] : out; })
    : Promise.resolve(file);

  return decoded.then(function (jpegOrOrig) {
    return decodeToBitmap(jpegOrOrig).then(function (bitmap) {
      var w = bitmap.width || bitmap.naturalWidth;
      var h = bitmap.height || bitmap.naturalHeight;
      // already a plain jpeg AND already within the cap — nothing to gain by
      // re-encoding it, which would only cost quality for no size benefit
      if (jpegOrOrig.type === "image/jpeg" && w <= NORMALIZE_MAX_DIM && h <= NORMALIZE_MAX_DIM) {
        return jpegOrOrig;
      }
      return resizeToJpeg(bitmap, NORMALIZE_MAX_DIM);
    }, function () {
      // couldn't decode dimensions (a format canvas won't touch, e.g. HEIC
      // with heic2any unavailable) — fall back to the original behaviour
      // rather than losing the photo entirely
      return jpegOrOrig;
    });
  });
}
window.normalizeImageToJpeg = normalizeImageToJpeg;

// heic2any (and some browser APIs) reject with a plain {code, message}
// object instead of a real Error — String(e) on those prints the useless
// "[object Object]" instead of the actual reason. Pull the real text out
// wherever it lives.
function describeError(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try {
    var s = JSON.stringify(e);
    if (s && s !== "{}") return s;
  } catch (err) {}
  return String(e);
}
window.describeError = describeError;
