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
*/
function normalizeImageToJpeg(file) {
  if (file && file.type === "image/jpeg") return Promise.resolve(file);

  var isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "");
  if (isHeic && window.heic2any) {
    return window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 })
      .then(function (out) { return Array.isArray(out) ? out[0] : out; });
  }

  var decode = window.createImageBitmap
    ? createImageBitmap(file).catch(decodeViaImgTag)
    : decodeViaImgTag();

  function decodeViaImgTag() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.src = URL.createObjectURL(file);
      img.decode().then(function () { resolve(img); }, reject);
    });
  }

  return decode.then(function (bitmap) {
    var canvas = document.createElement("canvas");
    canvas.width = bitmap.width || bitmap.naturalWidth;
    canvas.height = bitmap.height || bitmap.naturalHeight;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error("could not encode image"));
      }, "image/jpeg", 0.92);
    });
  });
}
window.normalizeImageToJpeg = normalizeImageToJpeg;
