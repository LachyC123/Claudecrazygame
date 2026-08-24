import * as THREE from 'three';
import { Rng } from './Rng.js';

// Procedural texture factory. Everything is generated on canvas — zero external assets.
// Textures are cached by key so repeated requests are free.
export class TextureLab {
  constructor() { this.cache = new Map(); this.rng = new Rng(99); }

  canvas(size = 512) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }
  finish(canvas, { repeat = 1, srgb = false, aniso = 8 } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }
  get(key, factory) {
    if (!this.cache.has(key)) this.cache.set(key, factory());
    return this.cache.get(key);
  }
  // Value-noise helper usable by all texture generators.
  noise2D(seed = 1) {
    const r = new Rng(seed);
    const G = 256, grid = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) grid[i] = r.next();
    const smooth = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const idx = (a, b) => grid[(((b % G) + G) % G) * G + (((a % G) + G) % G)];
      const u = smooth(xf), v = smooth(yf);
      const a = idx(xi, yi), b = idx(xi + 1, yi), c = idx(xi, yi + 1), d = idx(xi + 1, yi + 1);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
  }
  fbm(seed = 1, octaves = 5) {
    const n = this.noise2D(seed);
    return (x, y) => {
      let s = 0, amp = 0.5, f = 1, norm = 0;
      for (let i = 0; i < octaves; i++) { s += amp * n(x * f, y * f); norm += amp; amp *= 0.5; f *= 2; }
      return s / norm;
    };
  }
  dispose() { for (const t of this.cache.values()) t.dispose?.(); this.cache.clear(); }
}
