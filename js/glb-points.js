/*
  traces — shared GLB(mesh) -> point-cloud extractor

  Reads a GLB and returns its mesh surface as a point BufferGeometry:
  positions from every primitive's POSITION accessor, world-transformed
  through the node tree, with per-point colour sampled from COLOR_0 or the
  baseColorTexture (webp included) at each vertex UV. KHR_draco_mesh_compression
  is decoded on the fly (the wasm decoder in vendor/draco) so ready-made
  uploads exported with Draco get a cloud too.
  Async: yields to the main thread every 60k points so a big mesh never
  freezes the page. Returns a Promise resolving to the geometry, or null
  when it can't (malformed, empty).

  Used by object.html (mesh/points toggle, the history collage) and
  processing.html (every NEW mesh capture gets its cloud generated and
  saved at capture time, so particles exist for it everywhere, instantly).
*/
import * as THREE from "./vendor/three/three.module.js?v=20260727bq";

// Draco decoder — loaded once, on demand, only when a GLB actually carries
// KHR_draco_mesh_compression (most Tripo scans do NOT; ready-made uploads
// exported from Blender/other tools often do). The wrapper is a plain global
// script (not a module), so it's injected once and the wasm fetched beside it.
var _dracoModule = null;
function loadDraco() {
  if (_dracoModule) return _dracoModule;
  var wrapUrl = new URL("./vendor/draco/draco_wasm_wrapper.js", import.meta.url).href;
  var wasmUrl = new URL("./vendor/draco/draco_decoder.wasm", import.meta.url).href;
  _dracoModule = new Promise(function (resolve, reject) {
    function build() {
      fetch(wasmUrl).then(function (r) { return r.arrayBuffer(); })
        .then(function (wasmBinary) { return self.DracoDecoderModule({ wasmBinary: wasmBinary }); })
        .then(resolve, reject);
    }
    if (self.DracoDecoderModule) { build(); return; }
    var s = document.createElement("script");
    s.src = wrapUrl;
    s.onload = build;
    s.onerror = function () { reject(new Error("draco wrapper failed to load")); };
    document.head.appendChild(s);
  }).catch(function (e) { _dracoModule = null; throw e; });
  return _dracoModule;
}

export function glbToPoints(arrayBuffer) {
  try {
    var dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, true) !== 0x46546c67) return null; // "glTF"
    var jsonLen = dv.getUint32(12, true);
    var gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLen)));
    var binStart = 20 + jsonLen;
    if (binStart % 4) binStart += 4 - (binStart % 4);
    var bin = null;
    if (binStart + 8 <= arrayBuffer.byteLength) {
      var binLen = dv.getUint32(binStart, true);
      bin = new Uint8Array(arrayBuffer, binStart + 8, binLen);
    }
    if (!bin) return null;
    // Draco-decoded attributes/indices land here, keyed by glTF accessor
    // index, so the rest of the pipeline reads them through accessorData
    // exactly like an uncompressed buffer view.
    var dracoAccessorCache = {};
    function accessorData(ai) {
      if (dracoAccessorCache[ai]) return dracoAccessorCache[ai];
      var acc = gltf.accessors[ai];
      // a Draco accessor has no bufferView of its own — if we reach here for
      // one it means its primitive never got decoded, so there's nothing to read
      if (acc.bufferView == null) return null;
      var bv = gltf.bufferViews[acc.bufferView];
      var comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
      var CT = { 5126: Float32Array, 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array,
                 5120: Int8Array, 5122: Int16Array }[acc.componentType];
      if (!CT || !comps) return null;
      var elemBytes = CT.BYTES_PER_ELEMENT * comps;
      var stride = bv.byteStride || elemBytes;
      var base = bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      var out = new Float32Array(acc.count * comps);
      // KHR_mesh_quantization stores positions as normalized (u)ints, undone
      // here; the node matrices then rescale them into real space
      var norm = acc.normalized
        ? ({ 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 })[acc.componentType] || 1
        : 1;
      if (stride === elemBytes && base % CT.BYTES_PER_ELEMENT === 0) {
        // tightly packed (the overwhelmingly common case): ONE typed-array
        // view over the whole run — the old per-vertex `new TypedArray`
        // allocated millions of throwaway objects and froze the machine
        // for seconds on a big scan
        var view = new CT(bin.buffer, base, acc.count * comps);
        if (norm === 1 && CT === Float32Array) {
          out.set(view);
        } else {
          for (var i0 = 0; i0 < out.length; i0++) out[i0] = view[i0] / norm;
        }
      } else {
        var dvw = new DataView(bin.buffer);
        var readers = { 5126: dvw.getFloat32, 5121: dvw.getUint8, 5123: dvw.getUint16,
                        5125: dvw.getUint32, 5120: dvw.getInt8, 5122: dvw.getInt16 };
        var rd = readers[acc.componentType].bind(dvw);
        var cb = CT.BYTES_PER_ELEMENT;
        for (var i = 0; i < acc.count; i++) {
          var o = base + i * stride;
          for (var c = 0; c < comps; c++) out[i * comps + c] = rd(o + c * cb, true) / norm;
        }
      }
      return { data: out, comps: comps, count: acc.count };
    }
    function nodeMatrix(node) {
      var m = new THREE.Matrix4();
      if (node.matrix) m.fromArray(node.matrix);
      else {
        var t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
        m.compose(new THREE.Vector3(t[0], t[1], t[2]),
                  new THREE.Quaternion(r[0], r[1], r[2], r[3]),
                  new THREE.Vector3(s[0], s[1], s[2]));
      }
      return m;
    }
    // collect every drawable primitive with its world transform first, so a
    // global sampling stride can cap the output (huge Tripo meshes carry a
    // million+ vertices per version)
    var prims = [];
    function walk(ni, parent) {
      var node = gltf.nodes[ni];
      var world = parent.clone().multiply(nodeMatrix(node));
      if (node.mesh != null) {
        (gltf.meshes[node.mesh].primitives || []).forEach(function (prim) {
          if (prim.attributes && prim.attributes.POSITION != null) prims.push({ prim: prim, world: world });
        });
      }
      (node.children || []).forEach(function (c) { walk(c, world); });
    }
    var scene = gltf.scenes[gltf.scene || 0];
    (scene.nodes || []).forEach(function (n) { walk(n, new THREE.Matrix4()); });
    if (!prims.length) return null;

    // a mesh's colour usually lives in its TEXTURE, not on the vertices —
    // decode each material's base-colour image once, then sample it at every
    // vertex's UV, so the derived points carry the real look of the object
    // (this is what was rendering as flat white before)
    var texCache = {};
    function imageData(imgIdx) {
      if (texCache[imgIdx]) return texCache[imgIdx];
      texCache[imgIdx] = Promise.resolve(null).then(function () {
        var img = (gltf.images || [])[imgIdx];
        if (!img || img.bufferView == null) return null;
        var bv = gltf.bufferViews[img.bufferView];
        var bytes = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset || 0), bv.byteLength);
        return createImageBitmap(new Blob([bytes], { type: img.mimeType || "image/png" })).then(function (bmp) {
          // cap the sampling canvas — colour fidelity doesn't need 4K
          var w = Math.min(bmp.width, 1024), h = Math.min(bmp.height, 1024);
          var cnv = document.createElement("canvas");
          cnv.width = w; cnv.height = h;
          var cx = cnv.getContext("2d");
          cx.drawImage(bmp, 0, 0, w, h);
          return cx.getImageData(0, 0, w, h);
        }).catch(function () { return null; });
      });
      return texCache[imgIdx];
    }
    function materialColour(prim) {
      var mat = (gltf.materials || [])[prim.material];
      var pbr = (mat && mat.pbrMetallicRoughness) || {};
      var factor = pbr.baseColorFactor || [1, 1, 1, 1];
      var texInfo = pbr.baseColorTexture;
      var imgIdx = null;
      if (texInfo && (gltf.textures || [])[texInfo.index]) {
        var tex = gltf.textures[texInfo.index];
        imgIdx = tex.source;
        // a webp-packed texture (EXT_texture_webp) keeps its image index
        // inside the extension, not in the regular source field
        if (imgIdx == null && tex.extensions && tex.extensions.EXT_texture_webp) {
          imgIdx = tex.extensions.EXT_texture_webp.source;
        }
      }
      return { factor: factor, imgIdx: imgIdx, uvSet: texInfo ? (texInfo.texCoord || 0) : 0 };
    }
    var imgPromises = prims.map(function (p) {
      var mc = materialColour(p.prim);
      return mc.imgIdx != null ? imageData(mc.imgIdx) : Promise.resolve(null);
    });

    // KHR_draco_mesh_compression: the primitive's real POSITION / TEXCOORD /
    // COLOR / index data lives compressed in one bufferView, not the plain
    // accessors. Decode each such primitive up front and drop the results into
    // dracoAccessorCache so accessorData() serves them transparently below.
    function decodeDracoPrim(draco, prim) {
      var ext = prim.extensions.KHR_draco_mesh_compression;
      var bv = gltf.bufferViews[ext.bufferView];
      if (!bv) return;
      var bytes = new Int8Array(bin.buffer, bin.byteOffset + (bv.byteOffset || 0), bv.byteLength);
      var decoder = new draco.Decoder();
      var db = new draco.DecoderBuffer();
      var mesh = null;
      try {
        db.Init(bytes, bytes.length);
        if (decoder.GetEncodedGeometryType(bytes) !== draco.TRIANGULAR_MESH) return;
        mesh = new draco.Mesh();
        var status = decoder.DecodeBufferToMesh(db, mesh);
        if (!status.ok() || mesh.ptr === 0) return;
        var numPoints = mesh.num_points();
        var attrs = ext.attributes || {};
        Object.keys(attrs).forEach(function (name) {
          var accIdx = prim.attributes[name];
          if (accIdx == null) return;
          var attr = decoder.GetAttributeByUniqueId(mesh, attrs[name]);
          if (!attr || attr.ptr === 0) return;
          var numComp = attr.num_components();
          var numValues = numPoints * numComp;
          var byteLen = numValues * 4;
          var ptr = draco._malloc(byteLen);
          decoder.GetAttributeDataArrayForAllPoints(mesh, attr, draco.DT_FLOAT32, byteLen, ptr);
          var out = new Float32Array(numValues);
          out.set(new Float32Array(draco.HEAPF32.buffer, ptr, numValues));
          draco._free(ptr);
          // Draco hands colour back as raw 0..255 (or 0..65535); match the
          // 0..1 range the rest of the code assumes when the accessor is normalized
          var acc = gltf.accessors[accIdx];
          var norm = acc && acc.normalized
            ? ({ 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 })[acc.componentType] || 1
            : 1;
          if (norm !== 1) for (var k = 0; k < out.length; k++) out[k] /= norm;
          dracoAccessorCache[accIdx] = { data: out, comps: numComp, count: numPoints };
        });
        if (prim.indices != null) {
          var numFaces = mesh.num_faces();
          var numIndices = numFaces * 3;
          var ib = numIndices * 4;
          var iptr = draco._malloc(ib);
          decoder.GetTrianglesUInt32Array(mesh, ib, iptr);
          var idx = new Uint32Array(numIndices);
          idx.set(new Uint32Array(draco.HEAPU32.buffer, iptr, numIndices));
          draco._free(iptr);
          dracoAccessorCache[prim.indices] = { data: idx, comps: 1, count: numIndices };
        }
      } catch (e) { /* leave this primitive undecoded; it just yields no points */ }
      finally {
        if (mesh) draco.destroy(mesh);
        draco.destroy(db);
        draco.destroy(decoder);
      }
    }
    function decodeAllDraco() {
      var seen = [], dracoPrims = [];
      prims.forEach(function (p) {
        var pr = p.prim;
        if (pr.extensions && pr.extensions.KHR_draco_mesh_compression && seen.indexOf(pr) === -1) {
          seen.push(pr); dracoPrims.push(pr);
        }
      });
      if (!dracoPrims.length) return Promise.resolve();
      return loadDraco().then(function (draco) {
        dracoPrims.forEach(function (pr) { decodeDracoPrim(draco, pr); });
      }).catch(function () { /* decoder unavailable — those prims stay empty */ });
    }

    return decodeAllDraco().then(function () {
    return Promise.all(imgPromises).then(async function (images) {
      var total = 0;
      prims.forEach(function (p) { total += gltf.accessors[p.prim.attributes.POSITION].count; });
      var step = Math.max(1, Math.floor(total / 600000));
      var positions = [], colors = [];
      var sinceYield = 0;
      for (var pi = 0; pi < prims.length; pi++) {
        var prim = prims[pi].prim, world = prims[pi].world;
        var pos = accessorData(prim.attributes.POSITION);
        if (!pos) continue;
        var col = prim.attributes.COLOR_0 != null ? accessorData(prim.attributes.COLOR_0) : null;
        var mc = materialColour(prim);
        var uvAttr = "TEXCOORD_" + mc.uvSet;
        var uv = (images[pi] && prim.attributes[uvAttr] != null) ? accessorData(prim.attributes[uvAttr]) : null;
        var idata = uv ? images[pi] : null;
        var v = new THREE.Vector3();
        for (var i = 0; i < pos.count; i += step) {
          v.set(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]).applyMatrix4(world);
          positions.push(v.x, v.y, v.z);
          if (col) {
            colors.push(col.data[i * col.comps] * mc.factor[0],
                        col.data[i * col.comps + 1] * mc.factor[1],
                        col.data[i * col.comps + 2] * mc.factor[2]);
          } else if (idata) {
            // repeat-wrap the UV, then read the pixel straight out of the image
            var u = uv.data[i * uv.comps], vv = uv.data[i * uv.comps + 1];
            u = ((u % 1) + 1) % 1; vv = ((vv % 1) + 1) % 1;
            var px = Math.min(idata.width - 1, Math.floor(u * idata.width));
            var py = Math.min(idata.height - 1, Math.floor(vv * idata.height));
            var o = (py * idata.width + px) * 4;
            colors.push((idata.data[o] / 255) * mc.factor[0],
                        (idata.data[o + 1] / 255) * mc.factor[1],
                        (idata.data[o + 2] / 255) * mc.factor[2]);
          } else {
            colors.push(0.94 * mc.factor[0], 0.93 * mc.factor[1], 0.9 * mc.factor[2]);
          }
          // breathe every ~60k points so the page (loader animation, the
          // whole machine) never freezes for seconds on a huge mesh
          if (++sinceYield >= 60000) {
            sinceYield = 0;
            await new Promise(function (r) { setTimeout(r, 0); });
          }
        }
      }
      // a low-poly mesh yields only a few thousand vertex points — sparse,
      // see-through, "not really particles". Densify by sampling extra
      // points ON the triangle faces (area-weighted, colours interpolated
      // from the texture at the sampled UV) up to a healthy target.
      var TARGET = 300000;
      if (positions.length / 3 < TARGET) {
        var want = TARGET - positions.length / 3;
        // total surface area across prims, for fair distribution
        var primAreas = [];
        var areaSum = 0;
        var va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
        var ab = new THREE.Vector3(), ac = new THREE.Vector3();
        for (var qi = 0; qi < prims.length; qi++) {
          var qp = prims[qi].prim;
          var qidx = qp.indices != null ? accessorData(qp.indices) : null;
          if (!qidx) { primAreas.push(null); continue; }
          var qpos = accessorData(qp.attributes.POSITION);
          if (!qpos) { primAreas.push(null); continue; }
          var faceN = Math.floor(qidx.count / 3);
          var cum = new Float64Array(faceN);
          var acc2 = 0;
          for (var f = 0; f < faceN; f++) {
            var ia = qidx.data[f * 3], ib = qidx.data[f * 3 + 1], ic = qidx.data[f * 3 + 2];
            va.fromArray(qpos.data, ia * 3); vb.fromArray(qpos.data, ib * 3); vc.fromArray(qpos.data, ic * 3);
            ab.subVectors(vb, va); ac.subVectors(vc, va);
            acc2 += ab.cross(ac).length() * 0.5;
            cum[f] = acc2;
          }
          primAreas.push({ idx: qidx, pos: qpos, cum: cum, area: acc2 });
          areaSum += acc2;
        }
        if (areaSum > 0) {
          for (var qi2 = 0; qi2 < prims.length; qi2++) {
            var pa = primAreas[qi2];
            if (!pa) continue;
            var prim2 = prims[qi2].prim, world2 = prims[qi2].world;
            var mc2 = materialColour(prim2);
            var uvAttr2 = "TEXCOORD_" + mc2.uvSet;
            var uv2 = (images[qi2] && prim2.attributes[uvAttr2] != null) ? accessorData(prim2.attributes[uvAttr2]) : null;
            var idata2 = uv2 ? images[qi2] : null;
            var col2 = prim2.attributes.COLOR_0 != null ? accessorData(prim2.attributes.COLOR_0) : null;
            var n2 = Math.round(want * pa.area / areaSum);
            for (var s2 = 0; s2 < n2; s2++) {
              // area-weighted face pick (binary search the cumulative areas)
              var target = Math.random() * pa.area;
              var lo = 0, hi = pa.cum.length - 1;
              while (lo < hi) { var mid = (lo + hi) >> 1; if (pa.cum[mid] < target) lo = mid + 1; else hi = mid; }
              var fa = pa.idx.data[lo * 3], fb = pa.idx.data[lo * 3 + 1], fc = pa.idx.data[lo * 3 + 2];
              // uniform barycentric point on the triangle
              var r1 = Math.sqrt(Math.random()), r2v = Math.random();
              var w0 = 1 - r1, w1 = r1 * (1 - r2v), w2 = r1 * r2v;
              v.set(
                pa.pos.data[fa * 3] * w0 + pa.pos.data[fb * 3] * w1 + pa.pos.data[fc * 3] * w2,
                pa.pos.data[fa * 3 + 1] * w0 + pa.pos.data[fb * 3 + 1] * w1 + pa.pos.data[fc * 3 + 1] * w2,
                pa.pos.data[fa * 3 + 2] * w0 + pa.pos.data[fb * 3 + 2] * w1 + pa.pos.data[fc * 3 + 2] * w2
              ).applyMatrix4(world2);
              positions.push(v.x, v.y, v.z);
              if (col2) {
                colors.push(
                  (col2.data[fa * col2.comps] * w0 + col2.data[fb * col2.comps] * w1 + col2.data[fc * col2.comps] * w2) * mc2.factor[0],
                  (col2.data[fa * col2.comps + 1] * w0 + col2.data[fb * col2.comps + 1] * w1 + col2.data[fc * col2.comps + 1] * w2) * mc2.factor[1],
                  (col2.data[fa * col2.comps + 2] * w0 + col2.data[fb * col2.comps + 2] * w1 + col2.data[fc * col2.comps + 2] * w2) * mc2.factor[2]);
              } else if (idata2) {
                var uS = uv2.data[fa * uv2.comps] * w0 + uv2.data[fb * uv2.comps] * w1 + uv2.data[fc * uv2.comps] * w2;
                var vS = uv2.data[fa * uv2.comps + 1] * w0 + uv2.data[fb * uv2.comps + 1] * w1 + uv2.data[fc * uv2.comps + 1] * w2;
                uS = ((uS % 1) + 1) % 1; vS = ((vS % 1) + 1) % 1;
                var px2 = Math.min(idata2.width - 1, Math.floor(uS * idata2.width));
                var py2 = Math.min(idata2.height - 1, Math.floor(vS * idata2.height));
                var o2 = (py2 * idata2.width + px2) * 4;
                colors.push((idata2.data[o2] / 255) * mc2.factor[0],
                            (idata2.data[o2 + 1] / 255) * mc2.factor[1],
                            (idata2.data[o2 + 2] / 255) * mc2.factor[2]);
              } else {
                colors.push(0.94 * mc2.factor[0], 0.93 * mc2.factor[1], 0.9 * mc2.factor[2]);
              }
              if (++sinceYield >= 60000) {
                sinceYield = 0;
                await new Promise(function (r) { setTimeout(r, 0); });
              }
            }
          }
        }
      }
      if (!positions.length) return null;
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      return g;
    }).catch(function () { return null; });
    }).catch(function () { return null; });
  } catch (e) { return null; }
}
