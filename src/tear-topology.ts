/** Split the vertex fans on either side of a cut; faces remain real cloth. */
export class TearTopology {
  readonly faces: Int32Array;
  readonly vertical: Uint8Array;
  readonly horizontal: Uint8Array;
  readonly count: number;
  cuts = 0;
  constructor(readonly cols: number, readonly rows: number) {
    this.count = (cols - 1) * (rows - 1);
    this.faces = new Int32Array(this.count * 4);
    this.vertical = new Uint8Array(cols * (rows - 1));
    this.horizontal = new Uint8Array((cols - 1) * rows);
    for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
      const f = (y * (cols - 1) + x) * 4, k = y * cols + x;
      this.faces.set([k, k + 1, k + cols, k + cols + 1], f);
    }
  }
  cutV(x: number, y: number) {
    if (x <= 0 || x >= this.cols - 1 || y < 0 || y >= this.rows - 1) return false;
    const k = y * this.cols + x;
    if (this.vertical[k]) return false;
    this.vertical[k] = 1; this.cuts++; return true;
  }
  cutH(x: number, y: number) {
    if (x < 0 || x >= this.cols - 1 || y <= 0 || y >= this.rows - 1) return false;
    const k = y * (this.cols - 1) + x;
    if (this.horizontal[k]) return false;
    this.horizontal[k] = 1; this.cuts++; return true;
  }
  /** Existing particle ids stay stable; only a newly separated fan gets a copy. */
  split(copy: (source: number) => number) {
    const { faces, cols, rows } = this;
    const roots = Int32Array.from({ length: faces.length }, (_, i) => i);
    const find = (i: number): number => {
      while (roots[i] !== i) { roots[i] = roots[roots[i]]; i = roots[i]; }
      return i;
    };
    const join = (a: number, b: number) => { roots[find(b)] = find(a); };
    for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
      const f = (y * (cols - 1) + x) * 4;
      if (x < cols - 2 && !this.vertical[y * cols + x + 1]) {
        join(f + 1, f + 4); join(f + 3, f + 6);
      }
      if (y < rows - 2 && !this.horizontal[(y + 1) * (cols - 1) + x]) {
        const next = f + (cols - 1) * 4;
        join(f + 2, next); join(f + 3, next + 1);
      }
    }
    const mapped = new Map<number, number>(), used = new Set<number>();
    for (let q = 0; q < faces.length; q++) {
      const root = find(q);
      let k = mapped.get(root);
      if (k === undefined) {
        k = faces[q];
        if (used.has(k)) k = copy(k);
        mapped.set(root, k); used.add(k);
      }
      faces[q] = k;
    }
  }
  /** Both actual sides of every tear, for fraying and local impulses. */
  edges() {
    const e: number[] = [], { cols, rows, faces } = this;
    for (let y = 0; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
      if (!this.vertical[y * cols + x]) continue;
      const l = (y * (cols - 1) + x - 1) * 4, r = l + 4;
      e.push(faces[l + 1], faces[l + 3], faces[r], faces[r + 2]);
    }
    for (let y = 1; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
      if (!this.horizontal[y * (cols - 1) + x]) continue;
      const t = ((y - 1) * (cols - 1) + x) * 4, b = t + (cols - 1) * 4;
      e.push(faces[t + 2], faces[t + 3], faces[b], faces[b + 1]);
    }
    return e;
  }
}
