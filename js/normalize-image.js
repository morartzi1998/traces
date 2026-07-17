/*
  traces — normalize a picked photo to a plain JPEG before it reaches Tripo.
  iPhones save photos as HEIC by default; Tripo's API rejects that outright
  ("This image file type is not supported", code 2004) even though the
  browser itself can usually decode and display it just fine. Re-encoding
  through a canvas sidesteps the source format entirely — Tripo always
  receives a plain JPEG no matter what the original file was.
*/
function normalizeImageToJpeg(file) {
  if (file && file.type === "image/jpeg") return Promise.resolve(file);
  var decode = window.createImageBitmap
    ? createImageBitmap(file).catch(decodeViaImgTag)
    : decodeViaImgTag();

  function decodeViaImgTag() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("could not decode image")); };
      img.src = url;
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
