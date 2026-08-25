/**
 * BORDERLINE 4 — TERRAIN
 * =============================================================================
 * A hand-composed wasteland heightfield.
 *
 * heightAt(x,z) is a pure analytic function (no lookup tables, no baked grid) so
 * it is exact everywhere, cheap enough for the player controller to call every
 * frame, and identical for every module that needs to plant something on the
 * ground. The mesh is three nested grids (core / mid / far) that all sample the
 * same function, so LOD seams line up and the horizon reads genuinely far.
 *
 * The layout is authored, not random: the capture camera sits at (6, ~3.2, 42)
 * looking down -Z, and every landform below is placed in that frame on purpose —
 * a graded dirt road leading the eye in, a dry wash crossing the midground, a
 * hero mesa left of centre, stacked buttes stepping back into the haze.
 *
 * EXPORTS used by the rest of src/world:
 *   heightAt(x,z)          exact ground height
 *   normalAt(x,z,out)      analytic normal
 *   slopeAt(x,z)           0 flat .. 1 vertical
 *   roadX(z) / roadWeight  the dirt track
 *   washZ(x) / washWeight  the dry riverbed
 *   arenaWeight(x,z)       spawn arena flatten mask
 *   fbm2/vnoise2/ridged2/hash2  shared deterministic noise
 *   canvasOf/finishTex/heightToNormal  shared procedural-texture helpers
 * =============================================================================
 */

import * as THREE from 'three';
import { makeCel } from '../render/index.js';

/* ------------------------------------------------------------------ math --- */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ----------------------------------------------------------------- noise --- */

export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, period-free, ~0..1. */
export function vnoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Rotate between octaves so ridges don't align to the world axes.
const R_C = Math.cos(0.7853981634), R_S = Math.sin(0.7853981634);

export function fbm2(x, y, oct = 4, seed = 0) {
  let s = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise2(x, y, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    const nx = (x * R_C - y * R_S) * 2.02;
    y = (x * R_S + y * R_C) * 2.02;
    x = nx;
  }
  return s / norm;
}

export function ridged2(x, y, oct = 4, seed = 0) {
  let s = 0, amp = 0.5, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise2(x, y, seed + i * 31) * 2 - 1);
    n *= n;
    s += amp * n * prev;
    prev = clamp(n, 0, 1);
    norm += amp;
    amp *= 0.5;
    const nx = (x * R_C - y * R_S) * 2.06;
    y = (x * R_S + y * R_C) * 2.06;
    x = nx;
  }
  return s / norm;
}

/* --------------------------------------------------------------- layout --- */

/** Spawn arena — flat combat ground the player drops into. */
export const ARENA = { x: 0, z: 14, inner: 24, outer: 52, h: 1.25 };

/** Where the bandit camp sits (Structures.js reads this). */
export const CAMP = { x: 24, z: -32, r: 26, rot: -0.42, h: 0 };

/**
 * Hero landforms. Each is a terraced butte; stacking two entries with the same
 * centre and shrinking radii gives the Borderlands "wedding cake" spire.
 */
const MESAS = [
  // hero, left of centre
  { x: -96, z: -112, r: 58, h: 62, e: 1.42, rot: 0.55, t: 4, s: 11, flute: 0.20 },
  { x: -88, z: -118, r: 30, h: 30, e: 1.15, rot: 1.20, t: 3, s: 23, flute: 0.16 },
  { x: -80, z: -124, r: 13, h: 20, e: 1.05, rot: 0.20, t: 2, s: 47, flute: 0.12 },
  // right shoulder, behind the camp
  { x: 74, z: -152, r: 50, h: 54, e: 1.30, rot: -0.7, t: 4, s: 71, flute: 0.22 },
  { x: 86, z: -160, r: 24, h: 26, e: 1.1, rot: 0.4, t: 3, s: 83, flute: 0.14 },
  // far centre — the silhouette that anchors the horizon
  { x: -92, z: -262, r: 76, h: 92, e: 1.5, rot: 0.25, t: 5, s: 97, flute: 0.24 },
  { x: -104, z: -274, r: 34, h: 40, e: 1.2, rot: -0.9, t: 3, s: 113, flute: 0.18 },
  // far left wall
  { x: -206, z: -172, r: 70, h: 68, e: 1.8, rot: -0.35, t: 4, s: 131, flute: 0.22 },
  // far right, hazy
  { x: 196, z: -246, r: 84, h: 78, e: 1.6, rot: 0.9, t: 4, s: 149, flute: 0.20 },
  // low table near the road, midground interest
  { x: -54, z: -66, r: 22, h: 15, e: 1.25, rot: 1.6, t: 3, s: 163, flute: 0.15 },
  { x: 128, z: -74, r: 30, h: 22, e: 1.35, rot: -1.1, t: 3, s: 179, flute: 0.18 },
];

export const MESA_LIST = MESAS;

/** Dirt road centreline: x as a function of z. */
export function roadX(z) {
  const t = 42 - z;
  return 6 - 0.30 * t + 10 * Math.sin(t * 0.0118) + 3.6 * Math.sin(t * 0.0372 + 1.3);
}
export function roadWeight(x, z) {
  const d = Math.abs(x - roadX(z)) + (fbm2(x * 0.06, z * 0.06, 2, 5) - 0.5) * 2.4;
  return smoothstep(9.0, 3.6, d);
}

/** Dry riverbed: z as a function of x, so it crosses the frame. */
export function washZ(x) {
  return -84 + 32 * Math.sin(x * 0.0102) + 12 * Math.sin(x * 0.0315 + 2.1);
}
export function washWeight(x, z) {
  const d = Math.abs(z - washZ(x)) + (fbm2(x * 0.05, z * 0.05, 2, 9) - 0.5) * 4.0;
  return smoothstep(21.0, 6.0, d);
}

export function arenaWeight(x, z) {
  const d = Math.hypot(x - ARENA.x, z - ARENA.z);
  return smoothstep(ARENA.outer, ARENA.inner, d);
}

/* ------------------------------------------------------------ height fn --- */

function terrace(p, tiers) {
  const s = p * tiers;
  const i = Math.floor(s);
  const f = s - i;
  return (i + smoothstep(0.30, 0.72, f)) / tiers;
}

function mesaAt(m, x, z) {
  const dx = x - m.x, dz = z - m.z;
  const c = Math.cos(m.rot), s = Math.sin(m.rot);
  const px = (dx * c + dz * s) / m.e;
  const pz = -dx * s + dz * c;
  const d2 = px * px + pz * pz;
  const rmax = m.r * 1.35;
  if (d2 > rmax * rmax) return 0;
  const d = Math.sqrt(d2);
  const ang = Math.atan2(pz, px);
  // erosion flutes: the radius wobbles with angle, cutting vertical gullies
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const rr = m.r * (1
    + m.flute * (fbm2(ca * 2.3 + m.s, sa * 2.3 - m.s, 3, m.s) - 0.5) * 2
    + 0.055 * Math.sin(ang * 7 + m.s)
    + 0.035 * Math.sin(ang * 17 - m.s * 0.5));
  const t = 1 - d / rr;
  if (t <= 0) return 0;
  // steep terraced flank over the outer band, plateau inside
  let p = smoothstep(0, 0.26, t);
  p = terrace(p, m.t) * 0.90 + p * 0.10;
  // broken plateau top
  const top = (fbm2(x * 0.028, z * 0.028, 3, m.s + 3) - 0.5) * 5.5;
  return m.h * p + top * smoothstep(0.10, 0.55, p);
}

function dunes(x, z) {
  const w = fbm2(x * 0.0035, z * 0.0035, 3, 41) * 6.0;
  const a = Math.sin(x * 0.026 + z * 0.010 + w) * 0.5 + 0.5;
  const b = Math.sin(x * 0.011 - z * 0.019 + w * 0.6) * 0.5 + 0.5;
  const crest = Math.pow(a, 1.6) * 0.7 + Math.pow(b, 2.0) * 0.5;
  return crest * 7.5;
}

/** Distant mountain ridge that only exists past the playable bowl. */
function distantRidge(x, z) {
  const r = Math.hypot(x, z);
  const m = smoothstep(290, 620, r);
  if (m <= 0) return 0;
  const rg = ridged2(x * 0.00135, z * 0.00135, 5, 7);
  const big = ridged2(x * 0.00046, z * 0.00046, 3, 19);
  const band = smoothstep(0.14, 0.80, rg * 0.62 + big * 0.72);
  return m * (band * 320 * (0.30 + 0.70 * big) + m * m * 70);
}

/** Everything except the road, so the road can flatten against it. */
function baseHeight(x, z) {
  let h = (fbm2(x * 0.0034, z * 0.0034, 4, 1) - 0.47) * 26;
  h += (fbm2(x * 0.0125 + 31, z * 0.0125 - 12, 3, 3) - 0.5) * 4.6;
  h += (fbm2(x * 0.052, z * 0.052, 2, 13) - 0.5) * 1.15;

  // wind-blown dune field on the right / far side
  const dm = smoothstep(46, 150, x) * smoothstep(60, -20, z) +
             smoothstep(-60, -190, z) * 0.55;
  if (dm > 0.001) h += dunes(x, z) * clamp(dm, 0, 1);

  for (let i = 0; i < MESAS.length; i++) h += mesaAt(MESAS[i], x, z);

  h += distantRidge(x, z);

  // dry wash carve
  const ww = washWeight(x, z);
  if (ww > 0.001) {
    const bank = ww * ww * (3 - 2 * ww);
    h = h - bank * 5.2 + (fbm2(x * 0.09, z * 0.09, 2, 21) - 0.5) * 0.9 * bank;
  }

  // spawn arena flatten
  const aw = arenaWeight(x, z);
  if (aw > 0.001) {
    const flat = ARENA.h + (fbm2(x * 0.035, z * 0.035, 2, 27) - 0.5) * 0.55;
    h = lerp(h, flat, aw * aw * (3 - 2 * aw));
  }

  // bandit camp shelf
  const cd = Math.hypot(x - CAMP.x, z - CAMP.z);
  const cw = smoothstep(CAMP.r + 20, CAMP.r - 6, cd);
  if (cw > 0.001) h = lerp(h, CAMP.h + 2.4, cw * cw * (3 - 2 * cw));

  return h;
}

/** Exact ground height. Cheap enough to call per-frame. */
export function heightAt(x, z) {
  let h = baseHeight(x, z);
  const rw = roadWeight(x, z);
  if (rw > 0.001) {
    const hc = baseHeight(roadX(z), z);
    h = lerp(h, hc - 0.28, rw * rw * (3 - 2 * rw));
  }
  return h;
}

const _n = new THREE.Vector3();
export function normalAt(x, z, out = _n) {
  const e = 0.9;
  const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
  const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
  out.set(hL - hR, 2 * e, hD - hU).normalize();
  return out;
}

export function slopeAt(x, z) {
  const n = normalAt(x, z, _n);
  return 1 - clamp(n.y, 0, 1);
}

/* ------------------------------------------------ procedural texture kit --- */

export function canvasOf(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

export function finishTex(canvas, { srgb = true, repeat = 1, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise on an N x N pixel grid (wraps exactly). */
export function tileNoise(N, freq, seed) {
  const out = new Float32Array(N * N);
  const g = new Float32Array(freq * freq);
  for (let i = 0; i < freq * freq; i++) g[i] = hash2(i % freq, (i / freq) | 0, seed);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) {
    const fy = (y / N) * freq, y0 = Math.floor(fy), yf = sm(fy - y0);
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * freq, x0 = Math.floor(fx), xf = sm(fx - x0);
      const i00 = g[(y0 % freq) * freq + (x0 % freq)];
      const i10 = g[(y0 % freq) * freq + ((x0 + 1) % freq)];
      const i01 = g[((y0 + 1) % freq) * freq + (x0 % freq)];
      const i11 = g[((y0 + 1) % freq) * freq + ((x0 + 1) % freq)];
      out[y * N + x] = (i00 + (i10 - i00) * xf) + ((i01 - i00) + (i00 - i10 - i01 + i11) * xf) * yf;
    }
  }
  return out;
}

export function tileFbm(N, baseFreq, octaves, seed) {
  const out = new Float32Array(N * N);
  let amp = 0.5, f = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = tileNoise(N, f, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Tileable Worley (cellular) — returns {f1, edge} where edge peaks on cell borders. */
export function tileWorley(N, cells, seed) {
  const pts = new Float32Array(cells * cells * 2);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = (cy * cells + cx) * 2;
      pts[i] = (cx + hash2(cx, cy, seed)) / cells;
      pts[i + 1] = (cy + hash2(cx, cy, seed + 977)) / cells;
    }
  }
  const f1 = new Float32Array(N * N), edge = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const py = y / N;
    const cy = Math.floor(py * cells);
    for (let x = 0; x < N; x++) {
      const px = x / N;
      const cx = Math.floor(px * cells);
      let a = 1e9, b = 1e9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % cells + cells) % cells;
          const gy = ((cy + oy) % cells + cells) % cells;
          const i = (gy * cells + gx) * 2;
          let dx = pts[i] + (cx + ox - gx) / cells - px;
          let dy = pts[i + 1] + (cy + oy - gy) / cells - py;
          const d = dx * dx + dy * dy;
          if (d < a) { b = a; a = d; } else if (d < b) { b = d; }
        }
      }
      f1[y * N + x] = Math.sqrt(a) * cells;
      edge[y * N + x] = (Math.sqrt(b) - Math.sqrt(a)) * cells;
    }
  }
  return { f1, edge };
}

/** Grayscale height buffer -> RGB tangent-space normal map canvas. */
export function heightToNormal(height, N, strength = 2.4) {
  const c = canvasOf(N);
  const ctx2 = c.getContext('2d');
  const img = ctx2.createImageData(N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const l = height[y * N + ((x - 1 + N) % N)];
      const r = height[y * N + ((x + 1) % N)];
      const u = height[((y - 1 + N) % N) * N + x];
      const dn = height[((y + 1) % N) * N + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * N + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx2.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------- textures --- */

function makeDetailTex(assets) {
  return assets.get('ter.detail', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    const img = g.createImageData(N, N), d = img.data;
    const crackW = tileWorley(N, 9, 3);
    const crackW2 = tileWorley(N, 20, 17);
    const warp = tileFbm(N, 5, 3, 61);
    const grit = tileFbm(N, 40, 2, 71);
    const med = tileFbm(N, 12, 4, 83);
    const macro = tileFbm(N, 3, 4, 91);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        // R : cracked hardpan — dark polygon borders, plates slightly varied
        const e = Math.min(crackW.edge[i], crackW2.edge[i] * 1.4);
        let crack = smoothstep(0.02, 0.14, e);
        crack = crack * 0.82 + 0.18;
        crack *= 0.86 + 0.28 * crackW.f1[i] * (0.5 + warp[i]);
        // G : wind ripples in sand
        const ph = x / N * 26 + (warp[i] - 0.5) * 9 + med[i] * 3.2;
        let ripple = Math.sin(ph * Math.PI) * 0.5 + 0.5;
        ripple = Math.pow(ripple, 1.5) * 0.72 + med[i] * 0.28;
        // B : gravel / pebble speckle
        let peb = smoothstep(0.55, 0.85, crackW2.f1[i]) * 0.5 + grit[i] * 0.55 + med[i] * 0.25;
        // A : hand-drawn cross-hatch strokes, blended into every material below
        const sx = x / N, sy = y / N;
        const s1 = Math.abs(((sx * 15 + sy * 9 + (warp[i] - 0.5) * 2.2) % 1 + 1) % 1 - 0.5) * 2;
        const s2 = Math.abs(((sx * -11 + sy * 13 + (med[i] - 0.5) * 2.6) % 1 + 1) % 1 - 0.5) * 2;
        const mac = clamp(smoothstep(0.16, 0.62, s1) * 0.55 + smoothstep(0.22, 0.7, s2) * 0.45, 0, 1);
        const o = i * 4;
        d[o] = clamp(crack, 0, 1) * 255;
        d[o + 1] = clamp(ripple, 0, 1) * 255;
        d[o + 2] = clamp(peb, 0, 1) * 255;
        d[o + 3] = mac * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const t = finishTex(c, { srgb: false });
    return t;
  });
}

function makeRockTex(assets) {
  return assets.get('ter.rock', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    const img = g.createImageData(N, N), d = img.data;
    const warp = tileFbm(N, 4, 4, 211);
    const fine = tileFbm(N, 18, 3, 223);
    const frac = tileWorley(N, 7, 233);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        // sedimentary bands running horizontally in texture space (v == world Y)
        const v = y / N * 13 + (warp[i] - 0.5) * 2.6;
        const band = Math.abs(((v % 1) + 1) % 1 - 0.5) * 2;
        let strata = smoothstep(0.12, 0.62, band);
        strata = strata * 0.68 + 0.32;
        // fracture lines
        const fr = smoothstep(0.015, 0.16, frac.edge[i]);
        const val = strata * (0.72 + 0.4 * fine[i]) * (0.55 + 0.45 * fr);
        const o = i * 4;
        d[o] = clamp(val, 0, 1) * 255;
        d[o + 1] = clamp(((v % 1) + 1) % 1, 0, 1) * 255;   // band phase -> hue mix
        d[o + 2] = clamp(fine[i] * 0.7 + fr * 0.3, 0, 1) * 255;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finishTex(c, { srgb: false });
  });
}

function makeGroundNormal(assets) {
  return assets.get('ter.norm', () => {
    const N = 512;
    const a = tileFbm(N, 18, 4, 301);
    const b = tileWorley(N, 30, 311);
    const h = new Float32Array(N * N);
    for (let i = 0; i < h.length; i++) {
      h[i] = a[i] * 0.62 + smoothstep(0.25, 0.95, b.f1[i]) * 0.38;
    }
    return finishTex(heightToNormal(h, N, 2.1), { srgb: false });
  });
}

/* --------------------------------------------------------------- shader --- */

const TER_HEAD = /* glsl */ `
uniform sampler2D tDetail;
uniform sampler2D tRock;
uniform vec3 cSand, cHard, cRock, cRock2, cGrass, cGrass2, cGravel, cRoad, cWash;
uniform float uBumpStrength;
varying vec4 vTer;
varying vec2 vTer2;
varying vec3 vTerWN;
float gTerRough = 1.0;
vec3  gTerWN = vec3(0.0, 1.0, 0.0);
float gTerRockW = 0.0;
float gTerBumpH = 0.0;
`;

const TER_SPLAT = /* glsl */ `
{
  vec3 wp = vCelWorldPos;
  vec3 wn = normalize(vTerWN);
  gTerWN = wn;
  float slope = 1.0 - clamp(wn.y, 0.0, 1.0);

  vec4 dA = texture2D(tDetail, wp.xz * 0.135);
  // macro material variation is baked per-vertex: it is 70 m wavelength, so vertex
  // rate is plenty and it saves a full texture fetch on every ground pixel.
  float macro  = vTer.z;
  float macro2 = vTer2.x;

  vec3 an = abs(wn);
  vec2 ruv;
  if (an.y >= max(an.x, an.z))      ruv = wp.xz * 0.145;
  else if (an.x >= an.z)            ruv = wp.zy * 0.145;
  else                              ruv = wp.xy * 0.145;
  float wRock  = smoothstep(0.26, 0.52, slope + (dA.r - 0.5) * 0.20 + (macro - 0.5) * 0.10);
  // The strata fetch only matters on cliffs; the desert floor never pays for it.
  vec3 rk = vec3(0.5);
  if (wRock > 0.004) rk = texture2D(tRock, ruv).rgb;
  float wRoad  = clamp(vTer.x, 0.0, 1.0);
  float wWash  = clamp(vTer.y, 0.0, 1.0) * (1.0 - wRock);
  float wGrass = (1.0 - wRock) * (1.0 - wRoad) * smoothstep(0.26, 0.05, slope)
               * smoothstep(0.46, 0.80, macro * 0.7 + macro2 * 0.5);

  // --- base: cracked hardpan drifting into wind-blown sand -------------------
  float sandAmt = clamp(smoothstep(0.36, 0.70, macro2) * (1.0 - slope * 1.7), 0.0, 1.0);
  vec3 col = mix(cHard, cSand, sandAmt);
  col *= mix(1.0, 0.68 + 0.36 * dA.r, (1.0 - sandAmt) * 0.9);          // crack polygons
  col *= mix(1.0, 0.90 + 0.19 * dA.g, sandAmt * 0.65);                 // wind ripples
  col *= 0.89 + 0.22 * dA.b;                                           // grit
  col *= 0.90 + 0.22 * macro;                                          // macro breakup
  // hand-inked hatching baked into the atlas: painterly feel with no extra fetch
  col *= mix(1.0, 0.80 + 0.26 * dA.a, 0.55);

  // --- dry wash: pale silt + rounded gravel ---------------------------------
  col = mix(col, mix(cWash, cGravel, smoothstep(0.35, 0.8, dA.b)) * (0.88 + 0.26 * dA.g), wWash * 0.9);

  // --- graded dirt road ------------------------------------------------------
  vec3 roadCol = cRoad * (0.80 + 0.34 * dA.b) * (0.92 + 0.16 * dA.g);
  float lat = (wp.x - (6.0 - 0.30 * (42.0 - wp.z) + 10.0 * sin((42.0 - wp.z) * 0.0118))) * 0.42;
  float rut = smoothstep(0.30, 0.62, abs(fract(lat) - 0.5) * 2.0);
  roadCol *= mix(0.82, 1.05, rut);
  col = mix(col, roadCol, wRoad);

  // --- dry scrub grass -------------------------------------------------------
  vec3 gcol = mix(cGrass, cGrass2, smoothstep(0.3, 0.75, dA.g * 0.6 + dA.b * 0.5));
  col = mix(col, gcol * (0.82 + 0.34 * dA.r), wGrass * 0.85);

  // --- ochre cliff rock ------------------------------------------------------
  vec3 rockCol = mix(cRock, cRock2, smoothstep(0.30, 0.70, rk.g)) * (0.66 + 0.62 * rk.r);
  rockCol *= 0.88 + 0.24 * rk.b;
  col = mix(col, rockCol, wRock);
  gTerRockW = wRock;

  // --- baked cavity from the heightfield laplacian ---------------------------
  col *= mix(0.55, 1.06, clamp(vTer.w, 0.0, 1.0));

  gTerRough = mix(mix(0.99, 0.86, wRock), 0.93, wRoad);
  // relief height for the derivative bump below — no extra fetch
  gTerBumpH = mix(dA.r * 0.55 + dA.b * 0.45, rk.r * 0.7 + rk.b * 0.3, wRock)
            + (dA.g - 0.5) * 0.35 * sandAmt;
  diffuseColor.rgb *= col;
}
`;

const TER_NORMAL = /* glsl */ `
{
  // Mikkelsen-style derivative bump. Cheaper than a second sampler in software,
  // and it tracks whatever the splat just decided this surface is made of.
  float dcam = length(cameraPosition - vCelWorldPos);
  float bf = uBumpStrength * (1.0 - smoothstep(28.0, 82.0, dcam));
  if (bf > 0.004) {
    vec3 n0 = gTerWN;
    vec3 dpx = dFdx(vCelWorldPos), dpy = dFdy(vCelWorldPos);
    vec3 r1 = cross(dpy, n0), r2 = cross(n0, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dFdx(gTerBumpH) * r1 + dFdy(gTerBumpH) * r2);
    vec3 pert = normalize(abs(det) * n0 - bf * mix(0.32, 0.85, gTerRockW) * grad);
    normal = normalize((viewMatrix * vec4(pert, 0.0)).xyz);
  }
}
`;

const TER_DBG = (typeof location !== 'undefined')
  ? parseInt(new URLSearchParams(location.search).get('terdbg') || '0', 10) : 0;

function makeTerrainMaterial(ctx) {
  const uniforms = {
    tDetail: { value: makeDetailTex(ctx.assets) },
    tRock: { value: makeRockTex(ctx.assets) },
    cSand: { value: new THREE.Color(0xe3cb9c).convertSRGBToLinear() },
    cHard: { value: new THREE.Color(0xc8a473).convertSRGBToLinear() },
    cRock: { value: new THREE.Color(0xb08361).convertSRGBToLinear() },
    cRock2: { value: new THREE.Color(0xdcbb8b).convertSRGBToLinear() },
    cGrass: { value: new THREE.Color(0xa8a361).convertSRGBToLinear() },
    cGrass2: { value: new THREE.Color(0x79854a).convertSRGBToLinear() },
    cGravel: { value: new THREE.Color(0x9c9382).convertSRGBToLinear() },
    cRoad: { value: new THREE.Color(0xd8bd93).convertSRGBToLinear() },
    cWash: { value: new THREE.Color(0xd6c3a3).convertSRGBToLinear() },
    uBumpStrength: { value: (typeof location !== 'undefined' && location.search.includes('nobump')) ? 0.0 : 1.0 },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.97, metalness: 0.0, dithering: true,
  });
  const PLAIN = typeof location !== 'undefined' && location.search.includes('terplain');
  if (!PLAIN) mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aTer;\nattribute vec2 aTer2;\nvarying vec4 vTer;\nvarying vec2 vTer2;\nvarying vec3 vTerWN;')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vTer = aTer;\n  vTer2 = aTer2;\n  vTerWN = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TER_HEAD)
      .replace('#include <map_fragment>',
        TER_DBG === 1 ? '{ diffuseColor.rgb *= mix(cHard, cSand, vTer2.x) * mix(0.6,1.05,vTer.w); }'
        : TER_DBG === 2 ? TER_SPLAT.replace('if (wRock > 0.004) rk = texture2D(tRock, ruv).rgb;', '')
        : TER_SPLAT)
      .replace('#include <normal_fragment_maps>', TER_DBG ? '' : TER_NORMAL)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = gTerRough;');
  };
  if (!PLAIN) mat.customProgramCacheKey = () => 'bl4-terrain';

  const Q = typeof location !== 'undefined' ? location.search : '';
  if (Q.includes('nocel')) { mat.userData.noCel = true; return mat; }
  const fx = Q.includes('nocelfx') ? 0 : 1;
  makeCel(mat, {
    bands: 3, bandSoftness: 0.030, bandFloor: 0.30,
    warm: 0xfff0d2, cool: 0x8fb0d4,
    rimStrength: 0.11 * fx, rimRange: 70,
    // hatch / grain / wobble all cost a multi-octave 3D noise per pixel and the
    // terrain owns most of the frame — its hand-painted detail is in the splat.
    hatch: 0.0, grain: 0.0, wobble: 0.0,
    specBand: 0.0, outlineWidth: 0.55,
  });
  mat.userData.terrainUniforms = uniforms;
  return mat;
}

/* ----------------------------------------------------------------- mesh --- */

const _tmpN = new THREE.Vector3();

/**
 * Build one heightfield grid, optionally with a square hole in the middle so
 * outer LOD rings can nest around finer ones. Adds a downward skirt on both the
 * outer border and the hole border, which hides the sub-metre cracks that come
 * from sampling the same surface at two resolutions.
 */
function buildGrid(cx, cz, size, segs, holeQuads, withCavity) {
  const half = size / 2;
  const step = size / segs;
  const n = segs + 1;
  const hs = holeQuads > 0 ? holeQuads / 2 : 0;
  const lo = segs / 2 - hs, hi = segs / 2 + hs;

  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const ter = new Float32Array(n * n * 4);
  const ter2 = new Float32Array(n * n * 2);
  const hgt = new Float32Array(n * n);

  for (let j = 0; j < n; j++) {
    const z = cz - half + j * step;
    for (let i = 0; i < n; i++) {
      const x = cx - half + i * step;
      const k = j * n + i;
      const h = heightAt(x, z);
      hgt[k] = h;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 8; uv[k * 2 + 1] = z / 8;
      const rw = roadWeight(x, z);
      ter[k * 4] = rw;
      ter[k * 4 + 1] = washWeight(x, z) * (1 - rw * 0.75);
      ter[k * 4 + 2] = fbm2(x * 0.0142 + 41, z * 0.0142 - 17, 3, 33);   // macro
      ter[k * 4 + 3] = 1;
      ter2[k * 2] = fbm2(x * 0.0068 - 23, z * 0.0068 + 9, 3, 37);       // macro2
      ter2[k * 2 + 1] = 0;
    }
  }

  // analytic normals + a cavity term from the discrete laplacian
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const xL = pos[(j * n + Math.max(i - 1, 0)) * 3];
      const hL = hgt[j * n + Math.max(i - 1, 0)];
      const hR = hgt[j * n + Math.min(i + 1, n - 1)];
      const hD = hgt[Math.max(j - 1, 0) * n + i];
      const hU = hgt[Math.min(j + 1, n - 1) * n + i];
      const dx = (i > 0 && i < n - 1) ? step * 2 : step;
      const dz = (j > 0 && j < n - 1) ? step * 2 : step;
      _tmpN.set((hL - hR) / dx, 1, (hD - hU) / dz).normalize();
      nor[k * 3] = _tmpN.x; nor[k * 3 + 1] = _tmpN.y; nor[k * 3 + 2] = _tmpN.z;
      if (withCavity) {
        const lap = (hL + hR + hD + hU) * 0.25 - hgt[k];
        ter[k * 4 + 3] = clamp(0.5 - lap / (step * 0.9), 0, 1) * 0.55 + 0.45;
      }
      void xL;
    }
  }

  const idx = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      if (hs > 0 && i >= lo && i < hi && j >= lo && j < hi) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // skirts: a ring of downward-extruded verts around the outer edge and the hole
  const skirtVerts = [];
  const skirtNor = [];
  const skirtUv = [];
  const skirtTer = [];
  const skirtTer2 = [];
  const base = n * n;
  const addSkirt = (ring, drop) => {
    const start = base + skirtVerts.length / 3;
    for (let s = 0; s < ring.length; s++) {
      const k = ring[s];
      skirtVerts.push(pos[k * 3], pos[k * 3 + 1] - drop, pos[k * 3 + 2]);
      skirtNor.push(nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]);
      skirtUv.push(uv[k * 2], uv[k * 2 + 1]);
      skirtTer.push(ter[k * 4], ter[k * 4 + 1], ter[k * 4 + 2], ter[k * 4 + 3]);
      skirtTer2.push(ter2[k * 2], ter2[k * 2 + 1]);
    }
    for (let s = 0; s < ring.length - 1; s++) {
      const a = ring[s], b = ring[s + 1];
      const a2 = start + s, b2 = start + s + 1;
      idx.push(a, a2, b, b, a2, b2);
    }
  };
  const outer = [];
  for (let i = 0; i < n; i++) outer.push(i);
  for (let j = 1; j < n; j++) outer.push(j * n + n - 1);
  for (let i = n - 2; i >= 0; i--) outer.push((n - 1) * n + i);
  for (let j = n - 2; j >= 0; j--) outer.push(j * n);
  addSkirt(outer, size * 0.06 + 6);
  if (hs > 0) {
    const inner = [];
    for (let i = lo; i <= hi; i++) inner.push(lo * n + i);
    for (let j = lo + 1; j <= hi; j++) inner.push(j * n + hi);
    for (let i = hi - 1; i >= lo; i--) inner.push(hi * n + i);
    for (let j = hi - 1; j >= lo; j--) inner.push(j * n + lo);
    inner.reverse();
    addSkirt(inner, 4);
  }

  const vCount = n * n + skirtVerts.length / 3;
  const P = new Float32Array(vCount * 3);
  const N2 = new Float32Array(vCount * 3);
  const U = new Float32Array(vCount * 2);
  const T = new Float32Array(vCount * 4);
  const T2 = new Float32Array(vCount * 2);
  P.set(pos); N2.set(nor); U.set(uv); T.set(ter); T2.set(ter2);
  P.set(skirtVerts, n * n * 3);
  N2.set(skirtNor, n * n * 3);
  U.set(skirtUv, n * n * 2);
  T.set(skirtTer, n * n * 4);
  T2.set(skirtTer2, n * n * 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N2, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  geo.setAttribute('aTer', new THREE.BufferAttribute(T, 4));
  geo.setAttribute('aTer2', new THREE.BufferAttribute(T2, 2));
  geo.setIndex(vCount > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
                              : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.meshes = [];
  }

  build() {
    const Q2 = typeof location !== 'undefined' ? location.search : '';
    const mat = makeTerrainMaterial(this.ctx);
    this.material = mat;

    const CX = -10, CZ = -50;
    const cap = this.ctx.cfg?.capture;
    const coreSegs = cap ? 112 : 168;

    // core: 336 m @ 3 m — the ground you actually walk on
    const core = new THREE.Mesh(buildGrid(CX, CZ, 336, coreSegs, 0, true), mat);
    core.castShadow = !(typeof location !== 'undefined' && location.search.includes('notershadow'));
    core.receiveShadow = !Q2.includes('norecv');
    core.name = 'Terrain.core';
    // mid: 1200 m @ 12 m, hole where the core sits (336/12 = 28 quads)
    const mid = new THREE.Mesh(buildGrid(CX, CZ, 1200, 100, 28, false), mat);
    mid.receiveShadow = !Q2.includes('norecv'); mid.castShadow = false;
    mid.userData.noShadowCast = true;
    mid.name = 'Terrain.mid';
    // far: 2400 m @ 60 m, hole where mid sits (1200/60 = 20 quads)
    const far = new THREE.Mesh(buildGrid(CX, CZ, 2400, 40, 20, false), mat);
    far.receiveShadow = false; far.castShadow = false;
    far.userData.noShadow = true;
    far.name = 'Terrain.far';

    this.meshes.push(core, mid, far);
    this.group.add(core, mid, far);
    return this.group;
  }

  heightAt(x, z) { return heightAt(x, z); }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.material?.dispose();
  }
}

/* --------------------------------------------------------- shot framing --- */

// The vista capture camera. Landform and vegetation placement is authored
// against this pose, and tall things are kept out of its central corridor.
export const VISTA = { x: 6, z: 42, fx: -0.31457, fz: -0.94924, rx: 0.94924, rz: -0.31457 };

/** True if (x,z) sits inside a wedge of `halfDeg` around the vista sightline. */
export function inSightCorridor(x, z, halfDeg = 22, maxDist = 140) {
  const dx = x - VISTA.x, dz = z - VISTA.z;
  const f = dx * VISTA.fx + dz * VISTA.fz;
  if (f <= 2 || f > maxDist) return false;
  const r = dx * VISTA.rx + dz * VISTA.rz;
  return Math.abs(Math.atan2(r, f)) < halfDeg * Math.PI / 180;
}
