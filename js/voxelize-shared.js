// Shared point-cloud -> small-particle voxelizer, used by both upload.html
// (converting a freshly-picked .ply) and processing.html (re-voxelizing at
// a different density before the capture is saved). glTF has no notion of
// "point size" — a raw POINTS primitive always renders at a fixed, tiny
// pixel size no matter how dense the source scan is. Snapping points to a
// 3D grid and emitting one small particle per occupied cell gives real
// geometry whose size is ours to control. Two things matter for it to read
// as an organic scan rather than a Minecraft-style grid: (1) particles are
// octahedra, not cubes — cube faces chain into long straight edges with
// their grid-aligned neighbours, which is exactly the rigid, "glitched"
// look that reads as artificial; a rounder shape breaks that up. (2) each
// particle gets randomized position jitter and size, so the underlying
// uniform grid doesn't show through as a repeating pattern.
import * as THREE from "three";
import { GLTFExporter } from "./vendor/three/GLTFExporter.js";

var PARTICLE_SCALE = 0.6;
var JITTER = 0.35; // fraction of cell edge to randomly offset each particle by

export function voxelize(geometry, targetCount) {
  var pos = geometry.getAttribute("position");
  var col = geometry.getAttribute("color");
  var count = pos.count;
  // occupiedCount(edge) can never exceed the number of source points — an
  // unreachable target (denser than the scan actually resolves) makes the
  // search below degenerate, collapsing to its smallest testable edge
  // (near zero) since it never finds anything small enough to hit the
  // target. Capping the target below the input count keeps it honest.
  targetCount = Math.min(targetCount, Math.floor(count * 0.9));

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
  // if targetCount is unreachable (the scan's actual point density plateaus
  // below it), letting the search range go all the way to hi/100000 makes
  // it collapse to that pathologically tiny floor chasing a count that
  // doesn't exist. hi/5000 is still far finer than any real target needs,
  // without going degenerate when one isn't reachable.
  var hiEdge = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  var loEdge = hiEdge / 5000;
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
  // an octahedron: 6 shared vertices, 8 triangular faces — rounder than a
  // cube (no long flat edges to chain with grid-aligned neighbours) and
  // lighter (6 verts/24 indices vs a cube's 24 verts/36 indices)
  var octaVerts = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  var octaFaces = [
    [0,2,4],[2,1,4],[1,3,4],[3,0,4],
    [2,0,5],[1,2,5],[3,1,5],[0,3,5]
  ];
  var positions = new Float32Array(n * 6 * 3);
  var colors = new Float32Array(n * 6 * 3);
  var indices = new Uint32Array(n * 8 * 3);
  var baseRadius = (edge * PARTICLE_SCALE) / 2;
  var vi = 0, ii = 0, pIdx = 0;
  cells.forEach(function (cell) {
    var cx = cell.x / cell.n, cy = cell.y / cell.n, cz = cell.z / cell.n;
    var cr = cell.r / cell.n, cg = cell.g / cell.n, cb = cell.b / cell.n;
    // randomize position (within the cell) and size so the uniform grid
    // the cells came from doesn't show through as a repeating pattern
    var jx = (Math.random() - 0.5) * 2 * JITTER * edge;
    var jy = (Math.random() - 0.5) * 2 * JITTER * edge;
    var jz = (Math.random() - 0.5) * 2 * JITTER * edge;
    var radius = baseRadius * (0.6 + Math.random() * 0.6);
    var base = pIdx * 6;
    for (var v = 0; v < 6; v++) {
      positions[vi]     = cx + jx + octaVerts[v][0] * radius;
      positions[vi + 1] = cy + jy + octaVerts[v][1] * radius;
      positions[vi + 2] = cz + jz + octaVerts[v][2] * radius;
      colors[vi] = cr; colors[vi + 1] = cg; colors[vi + 2] = cb;
      vi += 3;
    }
    for (var f = 0; f < 8; f++) {
      indices[ii]     = base + octaFaces[f][0];
      indices[ii + 1] = base + octaFaces[f][1];
      indices[ii + 2] = base + octaFaces[f][2];
      ii += 3;
    }
    pIdx++;
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
  // unlit: a shaded (MeshStandardMaterial) particle reads as a tiny 3D
  // object with its own visible facets and shadow, which is exactly the
  // "blocky" look point-cloud viewers avoid by drawing flat, unlit dots.
  // Flat vertex color removes that shading cue so neighbouring particles
  // blend into a smooth surface instead of a field of little dice.
  var cubeMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
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
