/**
 * BORDERLINE 4 — ROCK FORMATIONS
 * =============================================================================
 * Silhouette is the whole job here. Every rock starts as an icosphere, gets
 * ridged-noise displacement, then is *carved by random half-spaces* — pushing
 * any vertex past a plane back onto it produces genuinely flat facets with hard
 * creases, which is what the ink pass needs to bite on. Flat shading finishes it.
 *
 * Three tiers ship:
 *   • hero stacks  — 3-5 boulders piled into a leaning spire, unique meshes
 *   • an arch      — the reference's signature eroded bridge
 *   • boulder / scree fields — InstancedMesh, per-instance colour + scale
 *
 * EXPORTS: Rocks, makeRockGeo, applyTriplanarRock
 * =============================================================================
 */

import * as THREE from 'three';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCelMaterial, createCelInstancedMaterial, makeCel } from '../render/index.js';
import {
  heightAt, normalAt, slopeAt, clamp, lerp, smoothstep, hash2, fbm2,
  canvasOf, finishTex, tileFbm, tileWorley, heightToNormal, roadX, ARENA, CAMP,
} from './Terrain.js';

/* --------------------------------------------------------------- 3d noise -- */

function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^
          Math.imul(iz | 0, 2147483647) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (a, b, cc) => hash3(xi + a, yi + b, zi + cc, seed);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
function fbm3(x, y, z, oct, seed) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise3(x * f, y * f, z * f, seed + i * 37);
    n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}

/* ------------------------------------------------------------- geometry --- */

const _v = new THREE.Vector3();
const _pn = new THREE.Vector3();

/**
 * A stylized boulder.
 * @param {number} seed
 * @param {object} o  detail, noise, ridge, planes, squash(Vector3-ish array), taper
 */
export function makeRockGeo(seed, o = {}) {
  const detail = o.detail ?? 1;
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const rnd = (i) => hash2(seed, i * 7919, 5501);

  // random carving half-spaces
  const nPlanes = o.planes ?? 5;
  const planes = [];
  for (let i = 0; i < nPlanes; i++) {
    const a = rnd(i * 3) * Math.PI * 2;
    const b = (rnd(i * 3 + 1) - 0.5) * Math.PI;
    _pn.set(Math.cos(a) * Math.cos(b), Math.sin(b) * (o.flatTop ? 1.4 : 1.0), Math.sin(a) * Math.cos(b)).normalize();
    planes.push({ n: _pn.clone(), d: 0.62 + rnd(i * 3 + 2) * 0.30 });
  }
  if (o.flatTop) planes.push({ n: new THREE.Vector3(0, 1, 0), d: 0.55 + rnd(99) * 0.2 });

  const sq = o.squash || [1, 1, 1];
  const noise = o.noise ?? 0.26;
  const ridge = o.ridge ?? 0.16;

  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const nx = _v.x, ny = _v.y, nz = _v.z;
    // layered erosion: broad lumps + horizontal strata ridging
    const lump = fbm3(nx * 1.35 + seed, ny * 1.35, nz * 1.35, 3, seed) - 0.5;
    const strat = Math.abs(Math.sin(ny * 5.2 + fbm3(nx * 2, ny * 2, nz * 2, 2, seed + 5) * 4)) ;
    let r = 1 + lump * noise * 2 + (strat - 0.5) * ridge;
    r *= o.taper ? lerp(1, o.taper, clamp(ny * 0.5 + 0.5, 0, 1)) : 1;
    _v.set(nx * r * sq[0], ny * r * sq[1], nz * r * sq[2]);
    // carve
    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const dd = _v.dot(pl.n) - pl.d;
      if (dd > 0) _v.addScaledVector(pl.n, -dd);
    }
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  geo.deleteAttribute('uv');
  const out = geo.toNonIndexed();
  geo.dispose();
  out.computeVertexNormals();

  // bake strata + cavity into vertex colours (sedimentary banding, free richness)
  const p2 = out.attributes.position, n2 = out.attributes.normal;
  const col = new Float32Array(p2.count * 3);
  const c1 = new THREE.Color(o.colA ?? 0x9a6a44).convertSRGBToLinear();
  const c2 = new THREE.Color(o.colB ?? 0xcfa670).convertSRGBToLinear();
  const c3 = new THREE.Color(o.colC ?? 0x6d5540).convertSRGBToLinear();
  const tmp = new THREE.Color();
  let minY = 1e9, maxY = -1e9;
  for (let i = 0; i < p2.count; i++) { const y = p2.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  for (let i = 0; i < p2.count; i++) {
    const y = p2.getY(i), ny2 = n2.getY(i);
    const t = (y - minY) / Math.max(maxY - minY, 1e-4);
    const band = Math.abs(((t * (o.bands ?? 5) + fbm3(p2.getX(i) * 2, y * 2, p2.getZ(i) * 2, 2, seed + 9) * 0.7) % 1) - 0.5) * 2;
    tmp.copy(c1).lerp(c2, smoothstep(0.25, 0.85, band) * 0.85);
    // dark at the base (contact grime), bright on up-facing ledges
    tmp.lerp(c3, smoothstep(0.35, 0.0, t) * 0.55);
    const up = clamp(ny2, 0, 1);
    tmp.multiplyScalar(0.80 + 0.34 * up);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* ------------------------------------------------- triplanar rock texture -- */

function rockDetailTex(assets) {
  return assets.get('rock.detail', () => {
    const N = 192;
    const a = tileFbm(N, 14, 4, 401);
    const w = tileWorley(N, 8, 411);
    const c = canvasOf(N), g = c.getContext('2d');
    const img = g.createImageData(N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const chip = smoothstep(0.02, 0.22, w.edge[i]);
      const v = a[i] * 0.65 + chip * 0.35;
      const o = i * 4;
      d[o] = clamp(v, 0, 1) * 255;
      d[o + 1] = clamp(a[i], 0, 1) * 255;
      d[o + 2] = clamp(chip, 0, 1) * 255;
      d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return finishTex(c, { srgb: false });
  });
}
function rockNormalTex(assets) {
  return assets.get('rock.norm', () => {
    const N = 192;
    const a = tileFbm(N, 20, 4, 421);
    const w = tileWorley(N, 9, 431);
    const h = new Float32Array(N * N);
    for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.6 + smoothstep(0.05, 0.6, w.edge[i]) * 0.4;
    return finishTex(heightToNormal(h, N, 1.7), { srgb: false });
  });
}

/**
 * Add a world-space triplanar detail layer to any cel material. Because rocks are
 * instanced and rotated, UVs are useless — this projects on the dominant world
 * axis instead, so neighbouring instances never share a visible pattern.
 */
export function applyTriplanarRock(mat, assets, scale = 0.55, strength = 0.85) {
  const u = {
    tRD: { value: rockDetailTex(assets) },
    tRN: { value: rockNormalTex(assets) },
    uRScale: { value: scale },
    uRStr: { value: strength },
  };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, r) {
    if (prev) prev.call(this, shader, r);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkWN;')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vRkWN = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tRD; uniform sampler2D tRN; uniform float uRScale; uniform float uRStr;
varying vec3 vRkWN;
vec2 gRkUv = vec2(0.0); vec3 gRkWN = vec3(0.0,1.0,0.0);`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec3 wn = normalize(vRkWN); gRkWN = wn;
  vec3 an = abs(wn);
  vec2 uv;
  if (an.y >= max(an.x, an.z))      uv = vCelWorldPos.xz * uRScale;
  else if (an.x >= an.z)            uv = vCelWorldPos.zy * uRScale;
  else                              uv = vCelWorldPos.xy * uRScale;
  gRkUv = uv;
  vec3 t = texture2D(tRD, uv).rgb;
  vec3 t2 = texture2D(tRD, uv * 0.213 + 0.41).rgb;
  float v = mix(0.74, 1.24, t.r) * mix(0.86, 1.12, t2.g);
  diffuseColor.rgb *= v;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.06, 0.99, 0.90), (t.b - 0.5) * 0.9);
}`)
      .replace('#include <normal_fragment_maps>', `
{
  float dd = length(cameraPosition - vCelWorldPos);
  float bf = uRStr * (1.0 - smoothstep(45.0, 160.0, dd));
  if (bf > 0.004) {
    vec3 nm = texture2D(tRN, gRkUv).xyz * 2.0 - 1.0;
    vec3 an = abs(gRkWN); vec3 T, B;
    if (an.y >= max(an.x, an.z))      { T = vec3(1.0,0.0,0.0); B = vec3(0.0,0.0,1.0); }
    else if (an.x >= an.z)            { T = vec3(0.0,0.0,1.0); B = vec3(0.0,1.0,0.0); }
    else                              { T = vec3(1.0,0.0,0.0); B = vec3(0.0,1.0,0.0); }
    vec3 pert = normalize(gRkWN + (T*nm.x + B*nm.y) * bf);
    normal = normalize((viewMatrix * vec4(pert, 0.0)).xyz);
  }
}`);
  };
  const pk = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () { return (pk ? pk.call(this) : '') + '|rk'; };
  return mat;
}

/* ------------------------------------------------------------- placement -- */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

export class Rocks {
  constructor(ctx, world) {
    this.ctx = ctx;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Rocks';
    this.meshes = [];
  }

  build() {
    const { ctx } = this;
    const rock = createCelMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.93, metalness: 0.0,
      flatShading: true, bands: 3, bandSoftness: 0.028, bandFloor: 0.28,
      warm: 0xfff0d4, cool: 0x8badd0, rimStrength: 0.34, rimColor: 0xffd39a,
      hatch: 0.0, grain: 0.22, grainScale: 1.0,
      specBand: 0.5, wobble: 0.0, outlineWidth: 1.35,
    });
    applyTriplanarRock(rock, ctx.assets, 0.5, 0.8);
    this.material = rock;

    const rockInst = createCelInstancedMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.93, flatShading: true,
      bands: 3, bandFloor: 0.28, warm: 0xfff0d4, cool: 0x8badd0,
      rimStrength: 0.32, hatch: 0.0, grain: 0.22,
      specBand: 0.45, wobble: 0.0, outlineWidth: 1.15,
    });
    applyTriplanarRock(rockInst, ctx.assets, 0.55, 0.8);
    this.instMaterial = rockInst;

    this._buildHeroes(rock);
    this._buildArch(rock);
    this._buildFields(rockInst);
    return this.group;
  }

  /* --- leaning stacked spires ------------------------------------------- */
  _buildHeroes(mat) {
    // (x, z, height, lean, seed) — placed to read against the sky from spawn
    const SPIRES = [
      [-63, -58, 13.5, 0.13, 3],
      [-72, -44, 9.0, -0.09, 8],
      [46, -86, 17.0, 0.10, 14],
      [-28, -124, 21.0, -0.12, 21],
      [104, -34, 11.0, 0.14, 27],
      [-142, -96, 16.0, 0.08, 33],
      [8, -196, 26.0, -0.07, 39],
      [-176, -34, 12.0, 0.11, 45],
    ];
    for (let i = 0; i < SPIRES.length; i++) {
      const [x, z, H, lean, seed] = SPIRES[i];
      const parts = [];
      const n = 3 + Math.floor(hash2(seed, 1, 3) * 3);
      let y = 0;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const rad = H * (0.30 - 0.16 * t) * (0.85 + hash2(seed, k, 7) * 0.4);
        const hgt = H * (0.34 - 0.10 * t) * (0.8 + hash2(seed, k, 11) * 0.5);
        const g = makeRockGeo(seed * 31 + k, {
          detail: 2, planes: 6, noise: 0.22, ridge: 0.20, bands: 6,
          squash: [1, hgt / rad, 1], flatTop: k < n - 1,
          colA: 0x9c6f47, colB: 0xd3ac74, colC: 0x69513c,
        });
        g.scale(rad, rad, rad);
        const dx = lean * y * 1.6 + (hash2(seed, k, 13) - 0.5) * rad * 0.45;
        const dz = lean * y * 0.8 + (hash2(seed, k, 17) - 0.5) * rad * 0.45;
        g.rotateY(hash2(seed, k, 19) * 6.28);
        g.translate(dx, y + hgt * 0.55, dz);
        y += hgt * 1.42;
        parts.push(g);
      }
      const merged = BGU.mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      const gy = heightAt(x, z);
      mesh.position.set(x, gy - H * 0.10, z);
      mesh.rotation.y = hash2(seed, 0, 23) * 6.28;
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.world.colliders.push({
        type: 'sphere', center: new THREE.Vector3(x, gy + H * 0.35, z), radius: H * 0.34,
      });
    }
  }

  /* --- eroded natural arch ----------------------------------------------- */
  _buildArch(mat) {
    const SPAN = 34, RISE = 22, THICK = 5.4;
    const U = 26, V = 10;
    const pos = [], col = [], idx = [];
    const c1 = new THREE.Color(0x9a6a44).convertSRGBToLinear();
    const c2 = new THREE.Color(0xd0a76f).convertSRGBToLinear();
    const tmp = new THREE.Color();
    for (let i = 0; i <= U; i++) {
      const t = i / U;
      const a = Math.PI * t;
      const cx = -Math.cos(a) * SPAN * 0.5;
      const cy = Math.sin(a) * RISE;
      // tangent
      const tx = Math.sin(a) * SPAN * 0.5, ty = Math.cos(a) * RISE;
      const tl = Math.hypot(tx, ty);
      const nx = -ty / tl, ny = tx / tl;
      const th = THICK * (0.75 + 0.55 * Math.sin(a) + fbm2(t * 5, 0.5, 3, 55) * 0.6);
      const wd = THICK * (0.9 + fbm2(t * 4 + 9, 2.2, 3, 57) * 0.7);
      for (let j = 0; j <= V; j++) {
        const b = (j / V) * Math.PI * 2;
        const ca = Math.cos(b), sa = Math.sin(b);
        const bump = 1 + (fbm3(t * 6, ca * 2, sa * 2, 3, 61) - 0.5) * 0.42;
        const px = cx + nx * ca * th * bump;
        const py = cy + ny * ca * th * bump;
        const pz = sa * wd * bump;
        pos.push(px, py, pz);
        const band = Math.abs(((py / RISE * 5 + fbm2(px * 0.4, pz * 0.4, 2, 63) * 0.8) % 1) - 0.5) * 2;
        tmp.copy(c1).lerp(c2, smoothstep(0.2, 0.85, band) * 0.9);
        tmp.multiplyScalar(0.78 + 0.3 * clamp(ca * 0.5 + 0.5, 0, 1));
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let i = 0; i < U; i++) {
      for (let j = 0; j < V; j++) {
        const a = i * (V + 1) + j, b = a + 1, c = a + (V + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();

    // Two arches: a hero one left of the road, a small hazy one far right.
    const place = [
      { x: -128, z: -148, ry: 0.55, s: 1.25 },
      { x: 168, z: -212, ry: -0.9, s: 1.55 },
    ];
    for (const p of place) {
      const mesh = new THREE.Mesh(p === place[0] ? flat : flat.clone(), mat);
      mesh.scale.setScalar(p.s);
      mesh.rotation.y = p.ry;
      mesh.position.set(p.x, heightAt(p.x, p.z) - 1.5, p.z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      const half = SPAN * 0.5 * p.s;
      this.world.colliders.push({
        type: 'box',
        center: new THREE.Vector3(p.x - Math.cos(p.ry) * half, heightAt(p.x, p.z) + 4, p.z + Math.sin(p.ry) * half),
        half: new THREE.Vector3(3.5, 8, 3.5),
      });
      this.world.colliders.push({
        type: 'box',
        center: new THREE.Vector3(p.x + Math.cos(p.ry) * half, heightAt(p.x, p.z) + 4, p.z - Math.sin(p.ry) * half),
        half: new THREE.Vector3(3.5, 8, 3.5),
      });
    }
  }

  /* --- boulder + scree fields -------------------------------------------- */
  _buildFields(mat) {
    const cap = this.ctx.cfg?.capture;
    const tiers = [
      { count: cap ? 40 : 64, detail: 2, min: 1.5, max: 4.4, seed: 100, planes: 6, big: true },
      { count: cap ? 110 : 190, detail: 1, min: 0.6, max: 1.7, seed: 200, planes: 5, big: false },
      { count: cap ? 170 : 340, detail: 1, min: 0.18, max: 0.6, seed: 300, planes: 4, big: false },
    ];
    const R = 220;
    for (let ti = 0; ti < tiers.length; ti++) {
      const t = tiers[ti];
      // 3 geometry variants per tier so the field never repeats visibly
      const variants = [];
      for (let v = 0; v < 3; v++) {
        variants.push(makeRockGeo(t.seed + v * 13, {
          detail: t.detail, planes: t.planes, noise: 0.28, ridge: 0.18, bands: 4,
          squash: [1, 0.62 + v * 0.16, 1],
          colA: 0x96683f, colB: 0xceA36c, colC: 0x64513e,
        }));
      }
      const per = Math.ceil(t.count / 3);
      for (let v = 0; v < 3; v++) {
        const inst = new THREE.InstancedMesh(variants[v], mat, per);
        inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        let n = 0;
        for (let i = 0; n < per && i < per * 24; i++) {
          const s = t.seed + v * 977 + i;
          const ang = hash2(s, 1, 7) * Math.PI * 2;
          const rad = Math.pow(hash2(s, 2, 11), 0.62) * R;
          const x = -10 + Math.cos(ang) * rad;
          const z = -50 + Math.sin(ang) * rad * 1.05;
          // keep the arena floor and the road surface clear
          const dArena = Math.hypot(x - ARENA.x, z - ARENA.z);
          if (dArena < 15 && t.big) continue;
          if (Math.abs(x - roadX(z)) < (t.big ? 8.5 : 5.0)) continue;
          if (Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.r + (t.big ? 6 : 0)) continue;
          if (slopeAt(x, z) > 0.34) continue;
          // cluster: rocks like company
          const clump = fbm2(x * 0.022, z * 0.022, 3, 71);
          if (hash2(s, 3, 13) > 0.20 + clump * 1.15) continue;

          const sc = lerp(t.min, t.max, Math.pow(hash2(s, 4, 17), 1.5));
          const gy = heightAt(x, z);
          normalAt(x, z, _p);
          _e.set(
            (hash2(s, 5, 19) - 0.5) * 0.5 + Math.atan2(-_p.z, 1) * 0.4,
            hash2(s, 6, 23) * 6.28,
            (hash2(s, 7, 29) - 0.5) * 0.5 + Math.atan2(_p.x, 1) * 0.4
          );
          _q.setFromEuler(_e);
          _s.set(sc * (0.85 + hash2(s, 8, 31) * 0.4), sc * (0.8 + hash2(s, 9, 37) * 0.45), sc * (0.85 + hash2(s, 10, 41) * 0.4));
          _v.set(x, gy - sc * 0.34, z);
          _m4.compose(_v, _q, _s);
          inst.setMatrixAt(n, _m4);
          const warm = hash2(s, 11, 43);
          _c.setRGB(1, 1, 1).multiplyScalar(0.78 + warm * 0.44);
          _c.r *= 1.0 + (warm - 0.5) * 0.16;
          _c.b *= 1.0 - (warm - 0.5) * 0.20;
          inst.setColorAt(n, _c);
          n++;
          if (t.big && sc > 2.2) {
            this.world.colliders.push({
              type: 'sphere', center: new THREE.Vector3(x, gy + sc * 0.35, z), radius: sc * 0.78,
            });
          }
        }
        inst.count = n;
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.castShadow = ti < 2;
        inst.receiveShadow = true;
        if (ti === 2) inst.userData.noShadowCast = true;
        inst.frustumCulled = false;
        this.group.add(inst);
        this.meshes.push(inst);
      }
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.material?.dispose();
    this.instMaterial?.dispose();
  }
}
