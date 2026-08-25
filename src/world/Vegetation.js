/**
 * BORDERLINE 4 — VEGETATION
 * =============================================================================
 * Three layers, all instanced:
 *   • grass  — cross-quad tufts, hand-drawn alpha sheet with the ink outline
 *              baked into the texture, wind in the vertex shader, distance
 *              collapse so far instances cost nothing but a vertex.
 *   • scrub  — displaced low-poly bush blobs with leaf cards
 *   • trees  — the reference's gnarled alien tree: bulbous tapering trunk,
 *              knuckled branches, a wide flat canopy of clustered blobs.
 *
 * Grass opts out of the ink G-buffer on purpose: the outline pass renders an
 * un-animated copy of the geometry, so a wind-swayed blade would get a ghost
 * line beside it. The blades carry their contour in the texture instead.
 * =============================================================================
 */

import * as THREE from 'three';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCelInstancedMaterial } from '../render/index.js';
import {
  heightAt, normalAt, slopeAt, clamp, lerp, smoothstep, hash2, fbm2,
  canvasOf, finishTex, roadX, washZ, washWeight, inSightCorridor, ARENA, CAMP,
} from './Terrain.js';

/** Shared wind uniforms — World.update() advances uWindTime. */
export const WIND = {
  uWindTime: { value: 0 },
  uWindAmp: { value: 0.30 },
  uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
  uVegFade: { value: new THREE.Vector2(24, 44) },
};

/* ------------------------------------------------------------- textures --- */

function grassTex(assets) {
  return assets.get('veg.grass', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    g.clearRect(0, 0, N, N);
    const blade = (x0, w, h, bend, hue, dark) => {
      const tipX = x0 + bend;
      g.beginPath();
      g.moveTo(x0 - w, N);
      g.quadraticCurveTo(x0 - w * 0.65 + bend * 0.35, N - h * 0.55, tipX, N - h);
      g.quadraticCurveTo(x0 + w * 0.65 + bend * 0.35, N - h * 0.5, x0 + w, N);
      g.closePath();
      const grad = g.createLinearGradient(0, N, 0, N - h);
      grad.addColorStop(0, dark);
      grad.addColorStop(0.55, hue);
      grad.addColorStop(1, '#e2d79a');
      g.fillStyle = grad;
      g.fill();
      g.lineWidth = 3.0;
      g.strokeStyle = 'rgba(38,30,16,0.92)';
      g.stroke();
    };
    const hues = ['#9d9550', '#8a8a45', '#b2a15c', '#7d8341', '#a89a55'];
    const darks = ['#4d4623', '#3f4520', '#5b4f26', '#38401d', '#524a24'];
    for (let i = 0; i < 11; i++) {
      const r = hash2(i, 3, 91);
      const x0 = 18 + r * (N - 36);
      const h = N * (0.42 + hash2(i, 7, 93) * 0.55);
      const w = 5 + hash2(i, 11, 95) * 7;
      const bend = (hash2(i, 13, 97) - 0.5) * 88;
      const k = i % 5;
      blade(x0, w, h, bend, hues[k], darks[k]);
    }
    // a couple of dry seed heads
    for (let i = 0; i < 3; i++) {
      const x = 40 + hash2(i, 17, 99) * (N - 80);
      const h = N * (0.66 + hash2(i, 19, 101) * 0.25);
      g.strokeStyle = 'rgba(40,32,18,0.9)';
      g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(x, N); g.quadraticCurveTo(x + 8, N - h * 0.6, x + 16, N - h); g.stroke();
      g.fillStyle = '#c9b46e';
      g.beginPath(); g.ellipse(x + 16, N - h, 4.5, 10, 0.4, 0, 6.283); g.fill();
      g.lineWidth = 2.0; g.strokeStyle = 'rgba(40,32,18,0.85)'; g.stroke();
    }
    const t = finishTex(c, { srgb: true, aniso: 4 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

function barkTex(assets) {
  return assets.get('veg.bark', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#a99a86'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 240; i++) {
      const x = hash2(i, 1, 111) * N;
      const y0 = hash2(i, 2, 113) * N;
      const len = 30 + hash2(i, 3, 115) * 150;
      const wob = (hash2(i, 4, 117) - 0.5) * 26;
      const dark = hash2(i, 5, 119) > 0.5;
      g.strokeStyle = dark ? `rgba(62,52,42,${0.16 + hash2(i, 6, 121) * 0.3})`
                           : `rgba(214,203,182,${0.14 + hash2(i, 7, 123) * 0.28})`;
      g.lineWidth = 1 + hash2(i, 8, 125) * 4.5;
      g.beginPath();
      g.moveTo(x, y0);
      g.quadraticCurveTo(x + wob, y0 + len * 0.5, x + wob * 0.4, y0 + len);
      g.stroke();
    }
    return finishTex(c, { srgb: true, repeat: 1 });
  });
}

/* ------------------------------------------------------- wind injection --- */

function windPatch(mat, ampScale = 1, bendPower = 2.0) {
  const u = {
    uWindTime: WIND.uWindTime, uWindAmp: WIND.uWindAmp,
    uWindDir: WIND.uWindDir, uVegFade: WIND.uVegFade,
    uAmpScale: { value: ampScale }, uBendPow: { value: bendPower },
  };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, r) {
    if (prev) prev.call(this, shader, r);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aWind;
uniform float uWindTime; uniform float uWindAmp; uniform vec2 uWindDir;
uniform vec2 uVegFade; uniform float uAmpScale; uniform float uBendPow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
    ip = instanceMatrix[3].xyz;
  #endif
  ip += modelMatrix[3].xyz;
  float fade = 1.0 - smoothstep(uVegFade.x, uVegFade.y, distance(cameraPosition, ip));
  float ph = ip.x * 0.31 + ip.z * 0.27;
  float gust = 0.55 + 0.45 * sin(uWindTime * 0.55 + ip.x * 0.022 + ip.z * 0.017);
  float sway = sin(uWindTime * 2.05 + ph) * 0.62 + sin(uWindTime * 3.55 + ph * 1.83) * 0.38;
  float k = pow(clamp(aWind, 0.0, 1.0), uBendPow) * uWindAmp * uAmpScale * gust;
  transformed.x += (sway * uWindDir.x + 0.35 * uWindDir.y) * k;
  transformed.z += (sway * uWindDir.y - 0.35 * uWindDir.x) * k;
  transformed.y -= abs(sway) * k * 0.30;
  transformed *= fade;
}`);
  };
  const pk = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () { return (pk ? pk.call(this) : '') + '|wind' + ampScale; };
  return mat;
}

/* ------------------------------------------------------------ geometry ---- */

/** Cross-quad tuft: two intersecting planes, pivot at the base. */
function tuftGeo() {
  const pos = [], uv = [], nor = [], win = [], idx = [];
  const planes = [0, Math.PI / 2];
  let v = 0;
  for (let p = 0; p < planes.length; p++) {
    const a = planes[p];
    const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const nx = -Math.sin(a), nz = Math.cos(a);
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) nor.push(nx * 0.25, 0.94, nz * 0.25);
    win.push(0, 0, 1, 1);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(win, 1));
  g.setIndex(idx);
  return g;
}

function noisyBlob(seed, detail, squash, amount) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm2(v.x * 1.7 + v.y * 2.3 + seed, v.z * 1.7 - v.y * 1.1, 3, seed);
    const r = 1 + (n - 0.5) * amount * 2;
    v.multiplyScalar(r);
    v.x *= squash[0]; v.y *= squash[1]; v.z *= squash[2];
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  return g;
}

function colorize(geo, colFn) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    colFn(c, p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 1, i);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function setWindAttr(geo, fn) {
  const p = geo.attributes.position;
  const a = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) a[i] = fn(p.getX(i), p.getY(i), p.getZ(i));
  geo.setAttribute('aWind', new THREE.BufferAttribute(a, 1));
  return geo;
}

/** Gnarled trunk: a lofted tube with a bulbous base and a knuckled profile. */
function trunkGeo(seed, height, baseR, sides = 11, rings = 12) {
  const pos = [], nor = [], uv = [], idx = [];
  const lean = (hash2(seed, 1, 5) - 0.5) * 0.5;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const y = t * height;
    const cx = lean * height * t * t * 0.6 + Math.sin(t * 3.1 + seed) * height * 0.035;
    const cz = Math.cos(t * 2.4 + seed * 1.7) * height * 0.03;
    // bulb at the base, pinch, then swell again — very BL silhouette
    let r = baseR * (0.34 + 0.86 * Math.exp(-t * 3.4) + 0.20 * Math.exp(-Math.pow((t - 0.62) * 3.2, 2)));
    r *= 1 + (fbm2(t * 6 + seed, 2.5, 3, seed + 3) - 0.5) * 0.34;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const rib = 1 + Math.sin(a * 5 + t * 4 + seed) * 0.11 + (fbm2(Math.cos(a) * 2 + seed, Math.sin(a) * 2 + t * 3, 2, seed + 7) - 0.5) * 0.24;
      pos.push(cx + Math.cos(a) * r * rib, y, cz + Math.sin(a) * r * rib);
      nor.push(Math.cos(a), 0.18, Math.sin(a));
      uv.push(i / sides * 2.2, t * height * 0.35);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sides; i++) {
      const a = j * (sides + 1) + i, b = a + 1, c = a + sides + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function branchGeo(seed, len, r0, dir, rings = 5, sides = 7) {
  const pos = [], nor = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const d = dir.clone().normalize();
  const t1 = new THREE.Vector3().crossVectors(up, d).normalize();
  if (!isFinite(t1.x)) t1.set(1, 0, 0);
  const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const r = r0 * (1 - t * 0.72) * (1 + (fbm2(t * 5 + seed, 1.2, 2, seed) - 0.5) * 0.4);
    const bend = Math.sin(t * 2.2) * len * 0.16;
    const c = d.clone().multiplyScalar(len * t).addScaledVector(up, bend).addScaledVector(t1, Math.sin(t * 3 + seed) * len * 0.08);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const off = t1.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r);
      pos.push(c.x + off.x, c.y + off.y, c.z + off.z);
      nor.push(off.x, off.y, off.z);
      uv.push(i / sides * 1.6, t * len * 0.4);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sides; i++) {
      const a = j * (sides + 1) + i, b = a + 1, c2 = a + sides + 1, dd = c2 + 1;
      idx.push(a, c2, b, b, c2, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** One alien tree -> { bark, leaf, height, radius } */
function makeTree(seed) {
  const H = 5.6 + hash2(seed, 1, 3) * 4.2;
  const baseR = H * (0.085 + hash2(seed, 2, 5) * 0.05);
  const barkParts = [trunkGeo(seed, H, baseR * 3.0)];
  const leafParts = [];
  const nB = 3 + Math.floor(hash2(seed, 3, 7) * 2);
  for (let i = 0; i < nB; i++) {
    const a = (i / nB) * Math.PI * 2 + hash2(seed, i, 11) * 1.4;
    const up = 0.55 + hash2(seed, i, 13) * 0.7;
    const dir = new THREE.Vector3(Math.cos(a), up, Math.sin(a));
    const len = H * (0.26 + hash2(seed, i, 17) * 0.20);
    const bg = branchGeo(seed + i * 7, len, baseR * 0.95, dir);
    const anchorY = H * (0.74 + hash2(seed, i, 19) * 0.18);
    bg.translate(Math.sin(seed + i) * baseR * 0.5, anchorY, Math.cos(seed * 1.3 + i) * baseR * 0.5);
    barkParts.push(bg);
    // wide flat canopy pad at the branch tip
    const tip = dir.clone().normalize().multiplyScalar(len * 0.98);
    const tx = tip.x + Math.sin(seed + i) * baseR * 0.5;
    const ty = tip.y + anchorY + len * 0.12;
    const tz = tip.z + Math.cos(seed * 1.3 + i) * baseR * 0.5;
    const pads = 2;
    for (let k = 0; k < pads; k++) {
      const rr = H * (0.20 + hash2(seed, i * 5 + k, 29) * 0.16);
      const blob = noisyBlob(seed * 3 + i * 11 + k, 1, [1.0, 0.34 + hash2(seed, k, 31) * 0.14, 1.0], 0.30);
      blob.scale(rr, rr, rr);
      blob.translate(
        tx + (hash2(seed, i * 3 + k, 37) - 0.5) * rr * 1.5,
        ty + (hash2(seed, i * 3 + k, 41) - 0.2) * rr * 0.7,
        tz + (hash2(seed, i * 3 + k, 43) - 0.5) * rr * 1.5
      );
      leafParts.push(blob);
    }
  }
  // crown pad right on top
  const crownR = H * 0.30;
  const crown = noisyBlob(seed * 5 + 1, 1, [1.15, 0.30, 1.15], 0.26);
  crown.scale(crownR, crownR, crownR);
  crown.translate(0, H * 1.02, 0);
  leafParts.push(crown);

  const bark = BGU.mergeGeometries(barkParts, false);
  const leaf = BGU.mergeGeometries(leafParts, false);
  for (const g of barkParts) g.dispose();
  for (const g of leafParts) g.dispose();

  const barkA = new THREE.Color(0xb0a48d).convertSRGBToLinear();
  const barkB = new THREE.Color(0x6f6252).convertSRGBToLinear();
  colorize(bark, (c, x, y, z, ny) => {
    const g2 = fbm2(x * 1.6 + seed, y * 0.8, 3, seed + 3);
    c.copy(barkA).lerp(barkB, clamp(g2 * 1.25 - 0.1, 0, 1) * 0.8);
    c.multiplyScalar(lerp(0.62, 1.05, smoothstep(0, H * 0.35, y)));
  });
  const leafA = new THREE.Color(0x8fa055).convertSRGBToLinear();
  const leafB = new THREE.Color(0x4e6134).convertSRGBToLinear();
  const leafC = new THREE.Color(0xc7c07a).convertSRGBToLinear();
  leaf.computeVertexNormals();
  colorize(leaf, (c, x, y, z, ny) => {
    const g2 = fbm2(x * 2.4 + seed, z * 2.4 - y, 3, seed + 9);
    c.copy(leafB).lerp(leafA, clamp(g2 * 1.3, 0, 1));
    c.lerp(leafC, clamp(ny, 0, 1) * 0.45);
    c.multiplyScalar(0.86 + 0.28 * clamp(ny, 0, 1));
  });
  setWindAttr(leaf, (x, y) => clamp((y - H * 0.55) / (H * 0.6), 0, 1));
  setWindAttr(bark, (x, y) => clamp((y - H * 0.6) / (H * 0.7), 0, 1) * 0.4);
  return { bark, leaf, height: H, radius: baseR * 3.2 };
}

/** Scrub bush: a squashed noisy blob plus leaf cards. */
function makeBush(seed) {
  const parts = [];
  const n = 2 + Math.floor(hash2(seed, 1, 3) * 2);
  for (let i = 0; i < n; i++) {
    const r = 0.55 + hash2(seed, i, 5) * 0.55;
    const b = noisyBlob(seed * 7 + i, 1, [1.0, 0.62 + hash2(seed, i, 7) * 0.3, 1.0], 0.36);
    b.scale(r, r, r);
    b.translate((hash2(seed, i, 11) - 0.5) * 0.9, r * (0.55 + hash2(seed, i, 13) * 0.3), (hash2(seed, i, 17) - 0.5) * 0.9);
    parts.push(b);
  }
  const g = BGU.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  const a = new THREE.Color(0x7f8a46).convertSRGBToLinear();
  const b2 = new THREE.Color(0x4a5530).convertSRGBToLinear();
  const c3 = new THREE.Color(0xb9ac63).convertSRGBToLinear();
  colorize(g, (c, x, y, z, ny) => {
    const v = fbm2(x * 3.4 + seed, z * 3.4 - y * 2, 3, seed + 5);
    c.copy(b2).lerp(a, clamp(v * 1.35, 0, 1));
    c.lerp(c3, clamp(ny, 0, 1) * 0.4 * v);
    c.multiplyScalar(0.78 + 0.34 * clamp(ny, 0, 1));
  });
  setWindAttr(g, (x, y) => clamp(y / 1.4, 0, 1));
  return g;
}

/* -------------------------------------------------------------- density --- */

/** 0..1 how much stuff wants to grow here. */
export function fertility(x, z) {
  const s = slopeAt(x, z);
  if (s > 0.42) return 0;
  const h = heightAt(x, z);
  const wash = washWeight(x, z);
  let f = fbm2(x * 0.013, z * 0.013, 4, 55);
  f = smoothstep(0.40, 0.78, f);
  // water memory: things grow along the dry wash and the road shoulder
  f = clamp(f + wash * 0.55 + smoothstep(14, 7, Math.abs(x - roadX(z))) * 0.16, 0, 1);
  f *= 1 - smoothstep(0.18, 0.42, s);
  f *= 1 - smoothstep(26, 48, h);         // nothing on the mesa tops
  f *= 1 - smoothstep(4.0, 8.0, Math.abs(x - roadX(z))) * 0 + 1;
  if (Math.abs(x - roadX(z)) < 4.2) f *= 0.06;
  return f;
}

/* ----------------------------------------------------------------- class -- */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();

export class Vegetation {
  constructor(ctx, world, off) {
    this.ctx = ctx;
    this.world = world;
    this.off = off || new Set();
    this.group = new THREE.Group();
    this.group.name = 'Vegetation';
    this.meshes = [];
  }

  build() {
    if (!this.off.has('grass')) this._grass();
    if (!this.off.has('bush')) this._bushes();
    if (!this.off.has('tree')) this._trees();
    return this.group;
  }

  _grass() {
    const cap = this.ctx.cfg?.capture;
    const want = cap ? 6500 : (this.ctx.cfg?.vegetation?.grass ?? 60000);
    const mat = createCelInstancedMaterial({
      map: grassTex(this.ctx.assets),
      color: 0xffffff, roughness: 0.95, metalness: 0,
      alphaTest: 0.42, side: THREE.DoubleSide, transparent: false,
      bands: 3, bandFloor: 0.34, warm: 0xfff4dc, cool: 0x93b5d6,
      rimStrength: 0.5, rimColor: 0xffe0a8, rimPower: 2.2,
      hatch: 0.0, grain: 0.0, specBand: 0.2, wobble: 0.0,
    });
    mat.userData.noGBuffer = true;   // contour is painted into the sheet
    windPatch(mat, 1.0, 2.0);
    this.grassMat = mat;

    const geo = tuftGeo();
    const inst = new THREE.InstancedMesh(geo, mat, want);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    let n = 0;
    const R = 105;
    for (let i = 0; n < want && i < want * 8; i++) {
      const ang = hash2(i, 1, 601) * Math.PI * 2;
      const rad = Math.sqrt(hash2(i, 2, 603)) * R;
      const x = 0 + Math.cos(ang) * rad;
      const z = -22 + Math.sin(ang) * rad;
      const f = fertility(x, z);
      if (f <= 0.02) continue;
      if (hash2(i, 3, 605) > f * 1.15) continue;
      if (Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.r * 0.75) continue;
      const gy = heightAt(x, z);
      const s = (0.26 + hash2(i, 4, 607) * 0.30) * (0.74 + f * 0.5);
      _e.set(0, hash2(i, 5, 609) * 6.28, 0);
      _q.setFromEuler(_e);
      _sc.set(s * (0.9 + hash2(i, 6, 611) * 0.6), s * (0.85 + hash2(i, 7, 613) * 0.8), s);
      _v3.set(x, gy - 0.05, z);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(n, _m4);
      const tint = hash2(i, 8, 615);
      _col.setRGB(0.80 + tint * 0.42, 0.84 + tint * 0.32, 0.62 + tint * 0.42);
      inst.setColorAt(n, _col);
      n++;
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.userData.noShadowCast = true;
    inst.frustumCulled = false;
    inst.renderOrder = 1;
    this.group.add(inst);
    this.meshes.push(inst);
  }

  _bushes() {
    const cap = this.ctx.cfg?.capture;
    const want = cap ? 150 : (this.ctx.cfg?.vegetation?.bushes ?? 700);
    const mat = createCelInstancedMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.92, flatShading: true,
      bands: 3, bandFloor: 0.30, warm: 0xfff2d8, cool: 0x8db2d6,
      rimStrength: 0.42, rimColor: 0xffe2ac, hatch: 0.0,
      grain: 0.30, grainScale: 2.0, specBand: 0.3, wobble: 0.0, outlineWidth: 1.1,
    });
    windPatch(mat, 0.16, 2.4);
    this.bushMat = mat;

    const variants = [makeBush(3), makeBush(17), makeBush(29)];
    const per = Math.ceil(want / 3);
    for (let v = 0; v < 3; v++) {
      const inst = new THREE.InstancedMesh(variants[v], mat, per);
      let n = 0;
      for (let i = 0; n < per && i < per * 24; i++) {
        const s = v * 3121 + i;
        const ang = hash2(s, 1, 701) * Math.PI * 2;
        const rad = Math.sqrt(hash2(s, 2, 703)) * 175;
        const x = -6 + Math.cos(ang) * rad;
        const z = -44 + Math.sin(ang) * rad;
        const f = fertility(x, z);
        if (f <= 0.12) continue;
        if (hash2(s, 3, 705) > f * 0.85) continue;
        if (Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.r * 0.8) continue;
        const gy = heightAt(x, z);
        const sc = 0.7 + hash2(s, 4, 707) * 1.1;
        _e.set((hash2(s, 5, 709) - 0.5) * 0.16, hash2(s, 6, 711) * 6.28, (hash2(s, 7, 713) - 0.5) * 0.16);
        _q.setFromEuler(_e);
        _sc.set(sc * (0.85 + hash2(s, 8, 715) * 0.4), sc * (0.75 + hash2(s, 9, 717) * 0.5), sc * (0.85 + hash2(s, 10, 719) * 0.4));
        _v3.set(x, gy - 0.12 * sc, z);
        _m4.compose(_v3, _q, _sc);
        inst.setMatrixAt(n, _m4);
        const tint = hash2(s, 11, 721);
        _col.setRGB(0.84 + tint * 0.34, 0.88 + tint * 0.24, 0.72 + tint * 0.4);
        inst.setColorAt(n, _col);
        n++;
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = true; inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
      this.meshes.push(inst);
    }
  }

  _trees() {
    const barkMat = createCelInstancedMaterial({
      vertexColors: true, map: barkTex(this.ctx.assets), color: 0xffffff,
      roughness: 0.94, bands: 3, bandFloor: 0.28,
      warm: 0xfff1d6, cool: 0x8aaed3, rimStrength: 0.34, rimColor: 0xffd7a2,
      hatch: 0.0, grain: 0.30, specBand: 0.3, wobble: 0.0, outlineWidth: 1.4,
    });
    const leafMat = createCelInstancedMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.9, flatShading: true,
      bands: 3, bandFloor: 0.32, warm: 0xfff4d8, cool: 0x86aed6,
      rimStrength: 0.55, rimColor: 0xffe6b0, rimPower: 2.6,
      hatch: 0.0, grain: 0.24, grainScale: 1.4,
      specBand: 0.25, wobble: 0.0, outlineWidth: 1.5,
    });
    windPatch(leafMat, 0.09, 1.6);
    this.barkMat = barkMat;
    this.leafMat = leafMat;

    const variants = [makeTree(5), makeTree(23), makeTree(41), makeTree(67)];

    // Hand-placed hero trees frame the capture shot; the rest scatter by fertility.
    // Placed against the vista camera at (6, 42) looking down -Z: two framing
    // trees at the frame edges, the rest kept outside a +/-24 deg sight corridor
    // so the road and the mesas stay legible.
    const HERO = [
      [-21.0, 29.0, 3, 1.00], [22.3, 12.2, 0, 0.92], [-33.0, 34.0, 1, 0.85],
      [-51.7, -5.9, 2, 1.05], [50.1, -58.7, 1, 1.10], [-99.5, -91.4, 0, 1.15],
      [62.0, -20.0, 3, 0.95], [-72.0, -140.0, 2, 1.20], [18.0, -150.0, 1, 1.05],
      [-140.0, -40.0, 0, 1.05], [-118.0, -186.0, 3, 1.15], [88.0, -104.0, 2, 1.0],
    ];
    const slots = [[], [], [], []];
    for (const [x, z, v, s] of HERO) slots[v].push({ x, z, s, r: hash2(x | 0, z | 0, 31) * 6.28 });

    const cap = this.ctx.cfg?.capture;
    const want = cap ? 16 : (this.ctx.cfg?.vegetation?.trees ?? 90);
    let placed = 0;
    for (let i = 0; placed < want && i < want * 40; i++) {
      const ang = hash2(i, 1, 801) * Math.PI * 2;
      const rad = 26 + Math.sqrt(hash2(i, 2, 803)) * 200;
      const x = -10 + Math.cos(ang) * rad;
      const z = -60 + Math.sin(ang) * rad;
      const f = fertility(x, z);
      if (f <= 0.35) continue;
      if (hash2(i, 3, 805) > f * 0.5) continue;
      if (Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.r + 8) continue;
      if (Math.abs(x - roadX(z)) < 7) continue;
      if (inSightCorridor(x, z, 24, 150)) continue;
      const v = Math.floor(hash2(i, 4, 807) * 4) % 4;
      slots[v].push({ x, z, s: 0.75 + hash2(i, 5, 809) * 0.7, r: hash2(i, 6, 811) * 6.28 });
      placed++;
    }

    for (let v = 0; v < 4; v++) {
      const list = slots[v];
      if (!list.length) continue;
      const T = variants[v];
      const bi = new THREE.InstancedMesh(T.bark, barkMat, list.length);
      const li = new THREE.InstancedMesh(T.leaf, leafMat, list.length);
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const gy = heightAt(t.x, t.z);
        _e.set(0, t.r, 0);
        _q.setFromEuler(_e);
        _sc.set(t.s * (0.92 + hash2(i, v, 813) * 0.16), t.s, t.s * (0.92 + hash2(i, v, 815) * 0.16));
        _v3.set(t.x, gy - 0.25, t.z);
        _m4.compose(_v3, _q, _sc);
        bi.setMatrixAt(i, _m4);
        li.setMatrixAt(i, _m4);
        const tint = hash2(i, v, 817);
        _col.setRGB(0.90 + tint * 0.2, 0.92 + tint * 0.16, 0.86 + tint * 0.24);
        bi.setColorAt(i, _col);
        _col.setRGB(0.80 + tint * 0.42, 0.86 + tint * 0.3, 0.72 + tint * 0.36);
        li.setColorAt(i, _col);
        this.world.colliders.push({
          type: 'sphere',
          center: new THREE.Vector3(t.x, gy + T.height * t.s * 0.3, t.z),
          radius: T.radius * t.s * 0.9,
        });
      }
      for (const m of [bi, li]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.castShadow = true; m.receiveShadow = true;
        m.frustumCulled = false;
        this.group.add(m);
        this.meshes.push(m);
      }
    }
  }

  update(dt) {
    WIND.uWindTime.value += dt;
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
  }
}
