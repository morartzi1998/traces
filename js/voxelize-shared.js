// Shared point-cloud -> small-cube voxelizer, used by both upload.html
// (converting a freshly-picked .ply) and processing.html (re-voxelizing at
// a different density before the capture is saved). glTF has no notion of
// "point size" — a raw POINTS primitive always renders at a fixed, tiny
// pixel size no matter how dense the source scan is. Snapping points to a
// 3D grid and emitting one small cube per occupied cell gives real geometry
// whose size is ours to control. Cubes are sized SMALLER than the grid
// pitch (gaps between neighbours) on purpose — solid touching cubes read as
// a dense mass from a distance but turn into an opaque sealed wall up close,
// hiding everything behind them; a bit of a gap keeps the grainy, see-through
// "dust" look up close while still reading as solid-ish from further away.
import * as THREE from "three";
import { GLTFExporter } from "./vendor/three/GLTFExporter.js";

var CUBE_OVERLAP = 0.6;

export function voxelize(geometry, targetCount) {
  var pos = geometry.getAttribute("position");
  var col = geometry.getAttribute("color");
  var count = pos.count;

  var minX = Infinity, minY = Infinity, minZ = Infinity;
  var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (var i = 0; i < count; i++) {
    var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // a real scan's points sit on surfaces (walls, furniture), not spread
  // through the full volume of their bounding box — so guessing a grid
  // pitch from bbox-volume/targetCount way overshoots (too few, too big
  // cubes), and a handful of stray far-flung points make it worse. Binary
  // search the pitch directly against the actual resulting cube count instead.
  function occupiedCount(edge) {
    var seen = new Set();
    for (var i = 0; i < count; i++) {
      var ix = Math.floor((pos.getX(i) - minX) / edge);
      var iy = Math.floor((pos.getY(i) - minY) / edge);
      var iz = Math.floor((pos.getZ(i) - minZ) / edge);
      seen.add(ix + "_" + iy + "_" + iz);
    }
    return seen.size;
  }
  var hiEdge = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  var loEdge = hiEdge / 100000;
  var edge = hiEdge;
  for (var iter = 0; iter < 14; iter++) {
    edge = Math.sqrt(loEdge * hiEdge);
    if (occupiedCount(edge) > targetCount) loEdge = edge; else hiEdge = edge;
  }
  edge = Math.sqrt(loEdge * hiEdge);

  var cells = new Map();
  for (var i = 0; i < count; i++) {
    var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    var ix = Math.floor((x - minX) / edge);
    var iy = Math.floor((y - minY) / edge);
    var iz = Math.floor((z - minZ) / edge);
    var key = ix + "_" + iy + "_" + iz;
    var cell = cells.get(key);
    var r = 0.8, g = 0.8, b = 0.8;
    if (col) { r = col.getX(i); g = col.getY(i); b = col.getZ(i); }
    if (!cell) {
      cells.set(key, { x: x, y: y, z: z, r: r, g: g, b: b, n: 1 });
    } else {
      cell.x += x; cell.y += y; cell.z += z;
      cell.r += r; cell.g += g; cell.b += b;
      cell.n++;
    }
  }

  var n = cells.size;
  var positions = new Float32Array(n * 24 * 3);
  var colors = new Float32Array(n * 24 * 3);
  var indices = new Uint32Array(n * 36);
  var half = (edge * CUBE_OVERLAP) / 2;
  // 6 faces, 4 unique verts each (unshared, so computeVertexNormals gives flat cube shading)
  var faceCorners = [
    [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],     // +z
    [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]], // -z
    [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]],     // +y
    [[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]], // -y
    [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]],     // +x
    [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]  // -x
  ];
  var vi = 0, ii = 0, cubeIdx = 0;
  cells.forEach(function (cell) {
    var cx = cell.x / cell.n, cy = cell.y / cell.n, cz = cell.z / cell.n;
    var cr = cell.r / cell.n, cg = cell.g / cell.n, cb = cell.b / cell.n;
    var base = cubeIdx * 24;
    for (var f = 0; f < 6; f++) {
      var corners = faceCorners[f];
      var faceBase = base + f * 4;
      for (var c = 0; c < 4; c++) {
        positions[vi]     = cx + corners[c][0] * half;
        positions[vi + 1] = cy + corners[c][1] * half;
        positions[vi + 2] = cz + corners[c][2] * half;
        colors[vi] = cr; colors[vi + 1] = cg; colors[vi + 2] = cb;
        vi += 3;
      }
      indices[ii]     = faceBase;     indices[ii + 1] = faceBase + 1; indices[ii + 2] = faceBase + 2;
      indices[ii + 3] = faceBase;     indices[ii + 4] = faceBase + 2; indices[ii + 5] = faceBase + 3;
      ii += 6;
    }
    cubeIdx++;
  });

  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeVertexNormals();
  return out;
}

export function exportScene(scene) {
  return new Promise(function (resolve, reject) {
    new GLTFExporter().parse(
      scene,
      function (glb) { resolve(glb); },
      function (err) { reject(err); },
      { binary: true }
    );
  });
}

export function buildVoxelGlb(rawGeometry, targetCount) {
  var geometry = voxelize(rawGeometry, targetCount);
  var cubeMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  var scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, cubeMaterial));
  return exportScene(scene);
}

// a raw point cloud (position + optional color) needs to survive a full
// page navigation (upload.html -> processing.html) so the density slider
// can keep working there — serialize it into one small binary blob instead
// of re-parsing the original (possibly huge) source file on the next page.
export function serializeGeometry(geometry) {
  var pos = geometry.getAttribute("position");
  var col = geometry.getAttribute("color");
  var count = pos.count;
  var header = new Uint32Array([col ? 1 : 0, count]);
  var parts = [header, pos.array];
  if (col) parts.push(col.array);
  return new Blob(parts);
}

export function deserializeGeometry(arrayBuffer) {
  var header = new Uint32Array(arrayBuffer, 0, 2);
  var hasColor = header[0] === 1;
  var count = header[1];
  var offset = 8;
  var positions = new Float32Array(arrayBuffer.slice(offset, offset + count * 3 * 4));
  offset += count * 3 * 4;
  var geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (hasColor) {
    var colors = new Float32Array(arrayBuffer.slice(offset, offset + count * 3 * 4));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  return geometry;
}
