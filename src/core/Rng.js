// Deterministic seeded RNG (mulberry32) — reproducible worlds & loot.
export class Rng {
  constructor(seed = 1337) { this.seed = seed >>> 0; this.s = this.seed; }
  reset(seed = this.seed) { this.s = seed >>> 0; return this; }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  // Weighted pick: entries [{w, ...}, ...]
  weighted(entries) {
    let total = 0; for (const e of entries) total += e.w;
    let r = this.next() * total;
    for (const e of entries) { r -= e.w; if (r <= 0) return e; }
    return entries[entries.length - 1];
  }
  fork(salt = 0) { return new Rng((this.s ^ (salt * 0x9e3779b9)) >>> 0); }
}
export const rng = new Rng(20260824);
