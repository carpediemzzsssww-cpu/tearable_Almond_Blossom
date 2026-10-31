import * as THREE from 'three';

type Weights = Map<number, number>;
type Quad = [number, number, number, number];
interface SurfaceData {
  weights: Weights[];
  quads: Quad[];
  origins: number[];
}
interface Edge {
  a: number;
  b: number;
  faces: number[];
}

const addWeights = (out: Weights, source: Weights, scale: number) => {
  for (const [node, weight] of source) out.set(node, (out.get(node) || 0) + weight * scale);
};

/**
 * A smooth rendering surface over the simulation mesh. All interpolation is
 * compiled on topology changes; the frame loop only visits packed sparse rows.
 * Particle IDs, rather than coincident positions/UVs, define adjacency, so the
 * two sides of a torn seam are never welded back together.
 */
export class ClothSurface {
  readonly geometry = new THREE.BufferGeometry();
  readonly maxVertices: number;
  levels = 0;
  private offsets = new Uint32Array(1);
  private nodes = new Uint32Array(0);
  private coefficients = new Float32Array(0);
  private positions = new Float32Array(0);
  private physicsNodeIds = new Uint32Array(0);
  private triangleFaces = new Int32Array(0);
  private sourceQuads: Quad[] = [];

  constructor(maxVertices = 20_000) {
    this.maxVertices = Math.max(4, Math.floor(maxVertices));
  }

  /**
   * `faces` uses TearTopology's row-major quad order [top-left, top-right,
   * bottom-left, bottom-right]. `physicsUV` is its flat, two-component buffer.
   * Call update() after rebuilding, before rendering/raycasting this geometry.
   * The same geometry object survives rebuilds, so mesh.geometry stays valid.
   */
  rebuild(faces: ArrayLike<number>, active: ArrayLike<number>, physicsUV: ArrayLike<number>, requestedLevels = 1) {
    if (faces.length % 4 !== 0) throw new Error('ClothSurface requires complete quads');
    const compact = new Map<number, number>();
    const weights: Weights[] = [], quads: Quad[] = [], origins: number[] = [];
    this.sourceQuads = [];
    const vertex = (node: number) => {
      let index = compact.get(node);
      if (index === undefined) {
        index = weights.length;
        compact.set(node, index);
        weights.push(new Map([[node, 1]]));
      }
      return index;
    };
    for (let at = 0; at < faces.length; at += 4) {
      const a = faces[at], b = faces[at + 1], c = faces[at + 2], d = faces[at + 3];
      this.sourceQuads.push([a, b, c, d]);
      if (!active[a] || !active[b] || !active[c] || !active[d]) continue;
      // Perimeter order, with the same front-facing winding as the physics mesh.
      quads.push([vertex(a), vertex(c), vertex(d), vertex(b)]);
      origins.push(at / 4);
    }
    // Each subdivision keeps updated old vertices first and appends edge/face
    // points, so these compact indices stay stable through every level.
    this.physicsNodeIds = Uint32Array.from(compact.keys());
    let data: SurfaceData = { weights, quads, origins };
    this.levels = 0;
    const requested = Math.max(0, Math.min(2, Math.floor(requestedLevels)));
    for (let level = 0; level < requested; level++) {
      const next = this.subdivide(data);
      if (!next) break;
      data = next;
      this.levels++;
    }

    // CSR interpolation rows: no Maps, temporary arrays or vectors per frame.
    this.offsets = new Uint32Array(data.weights.length + 1);
    let entries = 0;
    for (let i = 0; i < data.weights.length; i++) {
      this.offsets[i] = entries;
      entries += data.weights[i].size;
    }
    this.offsets[data.weights.length] = entries;
    this.nodes = new Uint32Array(entries);
    this.coefficients = new Float32Array(entries);
    this.positions = new Float32Array(data.weights.length * 3);
    const uv = new Float32Array(data.weights.length * 2);
    let cursor = 0;
    for (let i = 0; i < data.weights.length; i++) {
      let u = 0, v = 0;
      for (const [node, weight] of data.weights[i]) {
        this.nodes[cursor] = node;
        this.coefficients[cursor++] = weight;
        u += physicsUV[node * 2] * weight;
        v += physicsUV[node * 2 + 1] * weight;
      }
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
    const indices = new Uint16Array(data.quads.length * 6);
    this.triangleFaces = new Int32Array(data.quads.length * 2);
    for (let i = 0; i < data.quads.length; i++) {
      const [a, b, c, d] = data.quads[i];
      indices.set([a, b, d, b, c, d], i * 6);
      this.triangleFaces[i * 2] = this.triangleFaces[i * 2 + 1] = data.origins[i];
    }
    // Release old WebGL buffers before replacing attributes on this stable object.
    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.positions.length), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, indices.length);
    this.geometry.boundingSphere = null;
    this.geometry.boundingBox = null;
  }

  private subdivide(data: SurfaceData): SurfaceData | null {
    const edges: Edge[] = [], lookup = new Map<number, number>();
    const vertexEdges: number[][] = Array.from({ length: data.weights.length }, () => []);
    const vertexFaces: number[][] = Array.from({ length: data.weights.length }, () => []);
    const faceEdges: Quad[] = [];
    const count = data.weights.length;
    for (let fi = 0; fi < data.quads.length; fi++) {
      const q = data.quads[fi], qe: Quad = [0, 0, 0, 0];
      for (let corner = 0; corner < 4; corner++) {
        const a = q[corner], b = q[(corner + 1) % 4];
        const key = Math.min(a, b) * count + Math.max(a, b);
        let edge = lookup.get(key);
        if (edge === undefined) {
          edge = edges.length;
          edges.push({ a, b, faces: [] });
          lookup.set(key, edge);
          vertexEdges[a].push(edge);
          vertexEdges[b].push(edge);
        }
        edges[edge].faces.push(fi);
        vertexFaces[a].push(fi);
        qe[corner] = edge;
      }
      faceEdges.push(qe);
    }
    if (count + edges.length + data.quads.length > this.maxVertices) return null;

    const facePoints: Weights[] = data.quads.map(q => {
      const out: Weights = new Map();
      for (const v of q) addWeights(out, data.weights[v], 0.25);
      return out;
    });
    const nextWeights: Weights[] = [];
    for (let vi = 0; vi < count; vi++) {
      const boundary = vertexEdges[vi].filter(e => edges[e].faces.length !== 2);
      const out: Weights = new Map();
      if (boundary.length === 2) {
        // Cubic boundary rule rounds each independent lip, without filling it.
        addWeights(out, data.weights[vi], 0.75);
        for (const edge of boundary) {
          const e = edges[edge];
          addWeights(out, data.weights[e.a === vi ? e.b : e.a], 0.125);
        }
      } else if (boundary.length !== 0 || vertexFaces[vi].length < 3) {
        // Hold a non-manifold/corner fan rather than averaging across a crack.
        addWeights(out, data.weights[vi], 1);
      } else {
        const n = vertexEdges[vi].length;
        addWeights(out, data.weights[vi], (n - 3) / n);
        for (const fi of vertexFaces[vi]) addWeights(out, facePoints[fi], 1 / (n * vertexFaces[vi].length));
        // 2 * mean(edge midpoints) / n.
        for (const ei of vertexEdges[vi]) {
          const e = edges[ei];
          addWeights(out, data.weights[e.a], 1 / (n * n));
          addWeights(out, data.weights[e.b], 1 / (n * n));
        }
      }
      nextWeights.push(out);
    }
    for (const e of edges) {
      const out: Weights = new Map();
      if (e.faces.length === 2) {
        addWeights(out, data.weights[e.a], 0.25);
        addWeights(out, data.weights[e.b], 0.25);
        addWeights(out, facePoints[e.faces[0]], 0.25);
        addWeights(out, facePoints[e.faces[1]], 0.25);
      } else {
        addWeights(out, data.weights[e.a], 0.5);
        addWeights(out, data.weights[e.b], 0.5);
      }
      nextWeights.push(out);
    }
    nextWeights.push(...facePoints);
    const quads: Quad[] = [], origins: number[] = [];
    for (let fi = 0; fi < data.quads.length; fi++) {
      const q = data.quads[fi], e = faceEdges[fi], center = count + edges.length + fi;
      for (let c = 0; c < 4; c++) {
        quads.push([q[c], count + e[c], center, count + e[(c + 3) % 4]]);
        origins.push(data.origins[fi]);
      }
    }
    return { weights: nextWeights, quads, origins };
  }

  update(physicsPos: Float32Array) {
    const { offsets, nodes, coefficients, positions } = this;
    for (let i = 0; i < offsets.length - 1; i++) {
      let x = 0, y = 0, z = 0;
      for (let at = offsets[i]; at < offsets[i + 1]; at++) {
        const p = nodes[at] * 3, w = coefficients[at];
        x += physicsPos[p] * w;
        y += physicsPos[p + 1] * w;
        z += physicsPos[p + 2] * w;
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeVertexNormals();
    // Frustum culling should be off; Three raycasting recomputes this on demand.
    this.geometry.boundingSphere = null;
    this.geometry.boundingBox = null;
  }

  /** Original quad ordinal (multiply by four for an offset into topology.faces). */
  physicsFaceForTriangle(triangleIndex: number) {
    return Number.isInteger(triangleIndex) && triangleIndex >= 0 && triangleIndex < this.triangleFaces.length
      ? this.triangleFaces[triangleIndex] : -1;
  }

  /** Use hit.faceIndex, never hit.face.a/b/c (those belong to the render mesh). */
  physicsVerticesForTriangle(triangleIndex: number): readonly number[] {
    const face = this.physicsFaceForTriangle(triangleIndex);
    return face < 0 ? [] : this.sourceQuads[face];
  }

  /**
   * After update(), copy each original particle's smoothed old-vertex position
   * back to its physics index. Nodes absent from the render mesh stay untouched.
   * This lets fringe endpoints follow the rounded boundary without changing the
   * physical simulation or accidentally joining duplicate seam particles.
   */
  smoothedPhysicsPositions(out: Float32Array): void {
    for (let i = 0; i < this.physicsNodeIds.length; i++) {
      const source = i * 3, target = this.physicsNodeIds[i] * 3;
      out[target] = this.positions[source];
      out[target + 1] = this.positions[source + 1];
      out[target + 2] = this.positions[source + 2];
    }
  }

  /** hitPoint is in the cloth's local space; the current cloth mesh is identity. */
  nearestPhysicsVertex(triangleIndex: number, hitPoint: { x: number; y: number; z: number }, physicsPos: Float32Array) {
    let best = -1, distance = Infinity;
    for (const node of this.physicsVerticesForTriangle(triangleIndex)) {
      const p = node * 3;
      const d = (physicsPos[p] - hitPoint.x) ** 2 + (physicsPos[p + 1] - hitPoint.y) ** 2 + (physicsPos[p + 2] - hitPoint.z) ** 2;
      if (d < distance) { best = node; distance = d; }
    }
    return best;
  }

  dispose() {
    this.geometry.dispose();
  }
}
