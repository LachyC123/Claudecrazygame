/**
 * BORDERLINE 4 — PROPS & SET DRESSING
 * =============================================================================
 * The storytelling layer: a telephone line marching into the haze (the single
 * strongest depth cue in the reference frame), red barrels, supply crates,
 * rusted drums, stacked tyres, roadside signage and scrap antennae.
 *
 * Everything repeated is an InstancedMesh with per-instance colour; everything
 * unique is merged per material into one draw call.
 * =============================================================================
 */

import * as THREE from 'three';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCelMaterial, createCelInstancedMaterial } from '../render/index.js';
import {
  heightAt, normalAt, slopeAt, clamp, lerp, smoothstep, hash2, fbm2,
  canvasOf, finishTex, tileFbm, tileWorley, heightToNormal, roadX, ARENA, CAMP,
} from './Terrain.js';

/* ------------------------------------------------------------- textures --- */

function barrelTex(assets) {
  return assets.get('prop.barrel', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#b32a1e'; g.fillRect(0, 0, N, N);
    // hazard chevron band
    g.save();
    g.beginPath(); g.rect(0, N * 0.34, N, N * 0.20); g.clip();
    g.fillStyle = '#e8b021'; g.fillRect(0, N * 0.34, N, N * 0.20);
    g.fillStyle = '#20201c';
    for (let i = -2; i < 26; i++) {
      g.beginPath();
      const x = i * (N / 12);
      g.moveTo(x, N * 0.34); g.lineTo(x + N / 24, N * 0.34);
      g.lineTo(x + N / 24 - 30, N * 0.54); g.lineTo(x - 30, N * 0.54);
      g.closePath(); g.fill();
    }
    g.restore();
    // stencilled warning
    g.fillStyle = 'rgba(245,235,210,0.9)';
    g.font = '700 46px "Saira Condensed", Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText('EXPLOSIVE', N * 0.5, N * 0.24);
    g.strokeStyle = 'rgba(245,235,210,0.85)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(N * 0.5, N * 0.74, 44, 0, 6.283); g.stroke();
    g.beginPath();
    g.moveTo(N * 0.5, N * 0.74 - 28); g.lineTo(N * 0.5 - 24, N * 0.74 + 20);
    g.lineTo(N * 0.5 + 24, N * 0.74 + 20); g.closePath(); g.lineWidth = 6; g.stroke();
    g.font = '700 34px "Saira Condensed", Impact, sans-serif';
    g.fillText('!', N * 0.5, N * 0.74 + 18);
    // rust + grime
    const rust = tileFbm(N, 8, 4, 1201);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const r = clamp(rust[i] * 1.7 - 0.72, 0, 1);
      const o = i * 4;
      d[o] = lerp(d[o], 118, r); d[o + 1] = lerp(d[o + 1], 62, r); d[o + 2] = lerp(d[o + 2], 36, r);
      const m = 0.82 + rust[i] * 0.4;
      d[o] *= m; d[o + 1] *= m; d[o + 2] *= m;
    }
    g.putImageData(img, 0, 0);
    return finishTex(c, { srgb: true });
  });
}

function drumTex(assets) {
  return assets.get('prop.drum', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#5d6f63'; g.fillRect(0, 0, N, N);
    const rust = tileFbm(N, 7, 4, 1211);
    const grit = tileFbm(N, 26, 3, 1213);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const r = clamp(rust[i] * 1.9 - 0.55, 0, 1);
      const o = i * 4;
      d[o] = lerp(d[o], 146 + grit[i] * 50, r);
      d[o + 1] = lerp(d[o + 1], 76 + grit[i] * 34, r);
      d[o + 2] = lerp(d[o + 2], 40 + grit[i] * 22, r);
      const m = 0.78 + grit[i] * 0.46;
      d[o] *= m; d[o + 1] *= m; d[o + 2] *= m;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 60; i++) {
      const x = hash2(i, 1, 1215) * N, y0 = hash2(i, 2, 1217) * N * 0.6;
      const h = 40 + hash2(i, 3, 1219) * 220;
      const grd = g.createLinearGradient(0, y0, 0, y0 + h);
      grd.addColorStop(0, 'rgba(120,58,26,0.5)');
      grd.addColorStop(1, 'rgba(120,58,26,0)');
      g.fillStyle = grd; g.fillRect(x, y0, 2 + hash2(i, 4, 1221) * 7, h);
    }
    return finishTex(c, { srgb: true });
  });
}

function crateTex(assets) {
  return assets.get('prop.crate', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#9c7746'; g.fillRect(0, 0, N, N);
    for (let p = 0; p < 5; p++) {
      const y = p * (N / 5);
      const sh = 0.8 + hash2(p, 1, 1231) * 0.4;
      g.fillStyle = `rgb(${(168 * sh) | 0},${(128 * sh) | 0},${(76 * sh) | 0})`;
      g.fillRect(0, y + 2, N, N / 5 - 4);
      for (let i = 0; i < 20; i++) {
        g.strokeStyle = `rgba(${(78 * sh) | 0},${(56 * sh) | 0},${(32 * sh) | 0},${0.15 + hash2(p, i, 1233) * 0.3})`;
        g.lineWidth = 0.8 + hash2(p, i, 1235) * 2;
        const yy = y + 4 + hash2(p, i, 1237) * (N / 5 - 8);
        g.beginPath(); g.moveTo(0, yy);
        for (let x = 0; x <= N; x += 40) g.lineTo(x, yy + Math.sin(x * 0.02 + p + i) * 2.6);
        g.stroke();
      }
      g.fillStyle = 'rgba(28,18,10,0.5)';
      g.fillRect(0, y, N, 3);
    }
    // stencil
    g.fillStyle = 'rgba(40,52,58,0.75)';
    g.font = '700 52px "Saira Condensed", Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText('AMMO', N * 0.5, N * 0.46);
    g.font = '700 30px Oswald, sans-serif';
    g.fillText('7.62 x 51', N * 0.5, N * 0.62);
    g.strokeStyle = 'rgba(40,52,58,0.6)'; g.lineWidth = 5;
    g.strokeRect(N * 0.18, N * 0.24, N * 0.64, N * 0.5);
    const gr = tileFbm(N, 10, 3, 1239);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const m = 0.74 + gr[i] * 0.5;
      d[i * 4] *= m; d[i * 4 + 1] *= m; d[i * 4 + 2] *= m;
    }
    g.putImageData(img, 0, 0);
    return finishTex(c, { srgb: true });
  });
}

function poleTex(assets) {
  return assets.get('prop.pole', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#6c5b48'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 200; i++) {
      const x = hash2(i, 1, 1241) * N;
      g.strokeStyle = hash2(i, 2, 1243) > 0.5
        ? `rgba(44,34,24,${0.12 + hash2(i, 3, 1245) * 0.32})`
        : `rgba(150,132,110,${0.10 + hash2(i, 4, 1247) * 0.26})`;
      g.lineWidth = 0.7 + hash2(i, 5, 1249) * 3;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (hash2(i, 6, 1251) - 0.5) * 18, N); g.stroke();
    }
    return finishTex(c, { srgb: true });
  });
}

function signTex(assets) {
  return assets.get('prop.sign', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#c8b48a'; g.fillRect(0, 0, N, N);
    g.strokeStyle = 'rgba(48,36,22,0.6)'; g.lineWidth = 8;
    g.strokeRect(10, 10, N - 20, N - 20);
    g.fillStyle = '#2f2a22';
    g.textAlign = 'center';
    g.font = '400 92px Anton, Impact, sans-serif';
    g.fillText('DUST', N * 0.5, N * 0.36);
    g.fillText('BASIN', N * 0.5, N * 0.60);
    g.font = '700 40px Oswald, sans-serif';
    g.fillStyle = '#7c2a1c';
    g.fillText('TURN BACK', N * 0.5, N * 0.82);
    // splinters + bullet holes
    for (let i = 0; i < 9; i++) {
      const x = 40 + hash2(i, 1, 1261) * (N - 80);
      const y = 40 + hash2(i, 2, 1263) * (N - 80);
      const r = 6 + hash2(i, 3, 1265) * 9;
      g.fillStyle = 'rgba(30,24,16,0.92)';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(120,102,72,0.6)';
      g.beginPath(); g.arc(x, y, r * 1.7, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(30,24,16,0.92)';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    const gr = tileFbm(N, 8, 3, 1267);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const m = 0.72 + gr[i] * 0.54;
      d[i * 4] *= m; d[i * 4 + 1] *= m; d[i * 4 + 2] *= m;
    }
    g.putImageData(img, 0, 0);
    return finishTex(c, { srgb: true });
  });
}

/* ------------------------------------------------------------ geometry ---- */

function barrelGeo() {
  const parts = [];
  const R = 0.32, H = 0.92;
  const body = new THREE.CylinderGeometry(R, R, H, 16, 1, true);
  parts.push(body);
  for (const y of [-H * 0.22, H * 0.22]) {
    const t = new THREE.TorusGeometry(R * 1.03, R * 0.055, 5, 16);
    t.rotateX(Math.PI / 2); t.translate(0, y, 0); parts.push(t);
  }
  for (const y of [-H / 2, H / 2]) {
    const rim = new THREE.TorusGeometry(R * 1.02, R * 0.07, 5, 16);
    rim.rotateX(Math.PI / 2); rim.translate(0, y, 0); parts.push(rim);
    const cap = new THREE.CylinderGeometry(R * 1.0, R * 1.0, 0.03, 16);
    cap.translate(0, y, 0); parts.push(cap);
  }
  const g = BGU.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.translate(0, H / 2, 0);
  return g;
}

function crateGeo(seed) {
  const parts = [];
  const w = 0.78, h = 0.62, d = 0.78;
  parts.push(new THREE.BoxGeometry(w, h, d));
  // corner battens
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const b = new THREE.BoxGeometry(0.09, h * 1.02, 0.09);
    b.translate(sx * (w / 2 - 0.03), 0, sz * (d / 2 - 0.03));
    parts.push(b);
  }
  for (const sy of [-1, 1]) {
    const b1 = new THREE.BoxGeometry(w * 1.02, 0.07, 0.07);
    b1.translate(0, sy * (h / 2 - 0.05), d / 2 - 0.02); parts.push(b1);
    const b2 = b1.clone(); b2.translate(0, 0, -(d - 0.04)); parts.push(b2);
  }
  const g = BGU.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.translate(0, h / 2, 0);
  return g;
}

function tyreGeo() {
  const g = new THREE.TorusGeometry(0.42, 0.16, 7, 14);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.16, 0);
  return g;
}

/* ---------------------------------------------------------------- class --- */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();

export class Props {
  constructor(ctx, world) {
    this.ctx = ctx;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Props';
    this.meshes = [];
    this.barrels = [];
  }

  build() {
    const A = this.ctx.assets;
    this.matPole = createCelMaterial({
      map: poleTex(A), color: 0xffffff, roughness: 0.95, metalness: 0,
      bands: 3, bandFloor: 0.26, warm: 0xfff0d6, cool: 0x88a8cc,
      rimStrength: 0.4, rimColor: 0xffd9a8, hatch: 0.55, hatchScale: 3.0,
      grain: 0.7, specBand: 0.2, outlineWidth: 1.45,
    });
    this.matWire = createCelMaterial({
      color: 0x23262a, roughness: 0.55, metalness: 0.4,
      bands: 2, bandFloor: 0.35, rimStrength: 0.55, hatch: 0, grain: 0.3,
      specBand: 1.0, outlineWidth: 1.0,
    });
    this.matSign = createCelMaterial({
      map: signTex(A), color: 0xffffff, roughness: 0.93, metalness: 0,
      side: THREE.DoubleSide, bands: 3, bandFloor: 0.3, rimStrength: 0.35,
      hatch: 0.4, grain: 0.6, specBand: 0.2, outlineWidth: 1.3,
    });

    this._poleLine();
    this._barrels();
    this._crates();
    this._drums();
    this._tyres();
    this._signage();
    this._antennae();
    this._debris();
    return this.group;
  }

  /* --- telephone poles + sagging wires ----------------------------------- */
  _poleLine() {
    const poleParts = [], wireParts = [];
    const tops = [];
    const H = 8.2;
    for (let i = 0; i < 15; i++) {
      const t = 6 + i * 27;
      const z = 42 - t;
      const x = roadX(z) - 8.5 - Math.sin(i * 1.7) * 1.2;
      const gy = heightAt(x, z);
      const lean = (hash2(i, 1, 1301) - 0.5) * 0.10;
      const g = new THREE.CylinderGeometry(0.14, 0.20, H, 8);
      g.rotateZ(lean);
      g.translate(x, gy + H / 2 - 0.3, z);
      poleParts.push(g);
      // crossarm + insulators
      const arm = new THREE.BoxGeometry(2.3, 0.13, 0.13);
      arm.translate(x + lean * H * 0.5, gy + H - 0.9, z);
      poleParts.push(arm);
      const arm2 = new THREE.BoxGeometry(1.5, 0.11, 0.11);
      arm2.translate(x + lean * H * 0.5, gy + H - 1.9, z);
      poleParts.push(arm2);
      const brace = new THREE.BoxGeometry(0.9, 0.09, 0.09);
      brace.rotateZ(0.7);
      brace.translate(x + lean * H * 0.5 + 0.35, gy + H - 1.25, z);
      poleParts.push(brace);
      const top = [];
      for (const off of [-1.0, 0, 1.0]) {
        const ins = new THREE.CylinderGeometry(0.07, 0.09, 0.16, 6);
        ins.translate(x + off + lean * H * 0.5, gy + H - 0.78, z);
        poleParts.push(ins);
        top.push(new THREE.Vector3(x + off + lean * H * 0.5, gy + H - 0.72, z));
      }
      tops.push(top);
      this.world.colliders.push({
        type: 'box',
        center: new THREE.Vector3(x, gy + H / 2, z),
        half: new THREE.Vector3(0.24, H / 2, 0.24),
      });
    }
    for (let i = 0; i < tops.length - 1; i++) {
      for (let w = 0; w < 3; w++) {
        const a = tops[i][w], b = tops[i + 1][w];
        const sag = a.distanceTo(b) * 0.075;
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          const p = a.clone().lerp(b, t);
          p.y -= Math.sin(t * Math.PI) * sag;
          pts.push(p);
        }
        wireParts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.028, 3, false));
      }
    }
    const pm = new THREE.Mesh(BGU.mergeGeometries(poleParts, false), this.matPole);
    pm.castShadow = true; pm.receiveShadow = true; pm.name = 'Props.poles';
    const wm = new THREE.Mesh(BGU.mergeGeometries(wireParts, false), this.matWire);
    wm.castShadow = false; wm.receiveShadow = false;
    wm.userData.noShadow = true; wm.name = 'Props.wires';
    for (const g of [...poleParts, ...wireParts]) g.dispose();
    this.group.add(pm, wm);
    this.meshes.push(pm, wm);
  }

  /* --- explosive barrels -------------------------------------------------- */
  _barrels() {
    const mat = createCelInstancedMaterial({
      map: barrelTex(this.ctx.assets), color: 0xffffff,
      roughness: 0.62, metalness: 0.32, emissive: 0x220600, emissiveIntensity: 0.35,
      bands: 3, bandFloor: 0.28, warm: 0xfff0d6, cool: 0x8aa8cc,
      rimStrength: 0.55, rimColor: 0xffb27a, hatch: 0.35, grain: 0.5,
      specBand: 1.0, outlineWidth: 1.4,
    });
    const spots = [
      [8, 6], [10.5, 5.2], [9.2, 3.4], [-6, 2], [-5.2, 0.4],
      [30, -26], [31.8, -27.4], [28.5, -24.2], [18, -40], [16.5, -41.6],
      [-14, -18], [-30, -50], [-28.6, -51.8], [4, -14], [40, -12],
      [-2, 30], [-3.6, 31.2], [22, -8],
    ];
    const inst = new THREE.InstancedMesh(barrelGeo(), mat, spots.length);
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      const gy = heightAt(x, z);
      _e.set(0, hash2(i, 1, 1311) * 6.28, 0);
      _q.setFromEuler(_e);
      _sc.setScalar(1);
      _v3.set(x, gy, z);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(i, _m4);
      _col.setRGB(0.9 + hash2(i, 2, 1313) * 0.24, 0.88 + hash2(i, 3, 1315) * 0.2, 0.86 + hash2(i, 4, 1317) * 0.2);
      inst.setColorAt(i, _col);
      this.world.colliders.push({
        type: 'sphere', center: new THREE.Vector3(x, gy + 0.46, z), radius: 0.42,
      });
      this.barrels.push({ position: new THREE.Vector3(x, gy + 0.46, z), index: i });
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    inst.name = 'Props.barrels';
    this.group.add(inst);
    this.meshes.push(inst);
    this.barrelMesh = inst;
  }

  /* --- supply crates ------------------------------------------------------ */
  _crates() {
    const mat = createCelInstancedMaterial({
      map: crateTex(this.ctx.assets), color: 0xffffff, roughness: 0.94, metalness: 0,
      bands: 3, bandFloor: 0.28, warm: 0xfff0d6, cool: 0x8aa8cc,
      rimStrength: 0.38, hatch: 0.5, grain: 0.6, specBand: 0.25, outlineWidth: 1.35,
    });
    const stacks = [
      [6.5, 8.5, 3], [-8.5, 4.2, 2], [27, -30, 3], [33, -22, 2], [20, -36, 1],
      [-3, 22, 2], [12, -2, 1], [-18, -30, 2], [36, -34, 3], [1.5, -22, 1],
    ];
    const items = [];
    for (let s = 0; s < stacks.length; s++) {
      const [bx, bz, n] = stacks[s];
      for (let k = 0; k < n; k++) {
        items.push({
          x: bx + (hash2(s, k, 1321) - 0.5) * 0.55,
          z: bz + (hash2(s, k, 1323) - 0.5) * 0.55,
          y: k * 0.62,
          r: hash2(s, k, 1325) * 6.28,
          s: 0.85 + hash2(s, k, 1327) * 0.42,
        });
      }
      this.world.colliders.push({
        type: 'box',
        center: new THREE.Vector3(bx, heightAt(bx, bz) + n * 0.31, bz),
        half: new THREE.Vector3(0.55, n * 0.32, 0.55),
      });
    }
    const inst = new THREE.InstancedMesh(crateGeo(1), mat, items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const gy = heightAt(it.x, it.z);
      _e.set(0, it.r, 0); _q.setFromEuler(_e);
      _sc.setScalar(it.s);
      _v3.set(it.x, gy + it.y * it.s, it.z);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(i, _m4);
      _col.setRGB(0.86 + hash2(i, 1, 1329) * 0.3, 0.88 + hash2(i, 2, 1331) * 0.24, 0.84 + hash2(i, 3, 1333) * 0.28);
      inst.setColorAt(i, _col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    this.group.add(inst); this.meshes.push(inst);
  }

  /* --- fuel drums --------------------------------------------------------- */
  _drums() {
    const mat = createCelInstancedMaterial({
      map: drumTex(this.ctx.assets), color: 0xffffff, roughness: 0.68, metalness: 0.4,
      bands: 3, bandFloor: 0.26, warm: 0xfff0d6, cool: 0x86a6cc,
      rimStrength: 0.48, hatch: 0.4, grain: 0.5, specBand: 1.0, outlineWidth: 1.35,
    });
    const spots = [
      [11.8, 7.2, 0], [12.9, 6.1, 0], [12.3, 6.7, 1], [-9.5, -2, 0],
      [25, -20, 0], [26.2, -19.2, 0], [38, -28, 0], [37, -29.5, 2],
      [-24, -8, 0], [-25.4, -9.1, 2], [3, 26, 0], [46, -50, 0], [-40, -66, 0],
    ];
    const inst = new THREE.InstancedMesh(barrelGeo(), mat, spots.length);
    for (let i = 0; i < spots.length; i++) {
      const [x, z, mode] = spots[i];
      const gy = heightAt(x, z);
      if (mode === 1) {              // stacked upright on another
        _e.set(0, hash2(i, 1, 1341) * 6.28, 0);
        _v3.set(x, gy + 0.94, z);
      } else if (mode === 2) {       // lying on its side
        _e.set(Math.PI / 2, hash2(i, 2, 1343) * 6.28, 0);
        _v3.set(x, gy + 0.33, z);
      } else {
        _e.set(0, hash2(i, 3, 1345) * 6.28, 0);
        _v3.set(x, gy, z);
      }
      _q.setFromEuler(_e); _sc.setScalar(1);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(i, _m4);
      _col.setRGB(0.82 + hash2(i, 4, 1347) * 0.4, 0.86 + hash2(i, 5, 1349) * 0.3, 0.82 + hash2(i, 6, 1351) * 0.3);
      inst.setColorAt(i, _col);
      this.world.colliders.push({
        type: 'sphere', center: new THREE.Vector3(x, gy + 0.46, z), radius: 0.45,
      });
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    this.group.add(inst); this.meshes.push(inst);
  }

  /* --- tyres -------------------------------------------------------------- */
  _tyres() {
    const mat = createCelInstancedMaterial({
      color: 0x2c2b2a, roughness: 0.92, metalness: 0.0,
      bands: 3, bandFloor: 0.34, warm: 0xfff0d6, cool: 0x8aa8cc,
      rimStrength: 0.55, hatch: 0.4, grain: 0.7, specBand: 0.3, outlineWidth: 1.25,
    });
    const spots = [];
    const bases = [[14.5, 9.0], [-11, 1.2], [29, -34], [4.5, -6], [-16, -24], [34, -18]];
    for (let b = 0; b < bases.length; b++) {
      const n = 1 + Math.floor(hash2(b, 1, 1361) * 4);
      for (let k = 0; k < n; k++) {
        spots.push({
          x: bases[b][0] + (hash2(b, k, 1363) - 0.5) * 0.4,
          z: bases[b][1] + (hash2(b, k, 1365) - 0.5) * 0.4,
          y: k * 0.30, r: hash2(b, k, 1367) * 6.28,
          tilt: k === n - 1 ? (hash2(b, k, 1369) - 0.5) * 0.5 : 0,
        });
      }
    }
    const inst = new THREE.InstancedMesh(tyreGeo(), mat, spots.length);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const gy = heightAt(s.x, s.z);
      _e.set(s.tilt, s.r, s.tilt * 0.6);
      _q.setFromEuler(_e); _sc.setScalar(0.9 + hash2(i, 1, 1371) * 0.3);
      _v3.set(s.x, gy + s.y, s.z);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(i, _m4);
      _col.setRGB(0.82 + hash2(i, 2, 1373) * 0.34, 0.84 + hash2(i, 3, 1375) * 0.3, 0.86 + hash2(i, 4, 1377) * 0.3);
      inst.setColorAt(i, _col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    this.group.add(inst); this.meshes.push(inst);
  }

  /* --- roadside signage ---------------------------------------------------- */
  _signage() {
    const posts = [], boards = [];
    const list = [
      { z: 20, side: 1, ry: -0.5, s: 1.0 },
      { z: -46, side: -1, ry: 0.4, s: 0.85 },
      { z: -118, side: 1, ry: -0.3, s: 1.1 },
    ];
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      const x = roadX(L.z) + L.side * 7.5;
      const gy = heightAt(x, L.z);
      const H = 2.6 * L.s;
      for (const off of [-0.62 * L.s, 0.62 * L.s]) {
        const p = new THREE.CylinderGeometry(0.075, 0.09, H, 6);
        p.rotateY(L.ry);
        p.translate(x + Math.cos(L.ry) * off, gy + H / 2, L.z + Math.sin(L.ry) * off);
        posts.push(p);
      }
      const b = new THREE.PlaneGeometry(1.75 * L.s, 1.3 * L.s, 1, 1);
      b.rotateY(L.ry + Math.PI / 2);
      b.translate(x, gy + H - 0.75 * L.s, L.z);
      boards.push(b);
      this.world.colliders.push({
        type: 'box', center: new THREE.Vector3(x, gy + H / 2, L.z),
        half: new THREE.Vector3(0.9, H / 2, 0.9),
      });
    }
    const pm = new THREE.Mesh(BGU.mergeGeometries(posts, false), this.matPole);
    const bm = new THREE.Mesh(BGU.mergeGeometries(boards, false), this.matSign);
    pm.castShadow = bm.castShadow = true;
    pm.receiveShadow = bm.receiveShadow = true;
    for (const g of [...posts, ...boards]) g.dispose();
    this.group.add(pm, bm); this.meshes.push(pm, bm);
  }

  /* --- scrap antennae on the skyline --------------------------------------- */
  _antennae() {
    const parts = [];
    const spots = [[21, -18], [30, -40], [12, -30], [-9, -24]];
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      const gy = heightAt(x, z);
      const H = 4.5 + hash2(i, 1, 1381) * 4.0;
      const mast = new THREE.CylinderGeometry(0.035, 0.06, H, 5);
      mast.translate(x, gy + H / 2, z); parts.push(mast);
      for (let k = 0; k < 4; k++) {
        const y = gy + H * (0.45 + k * 0.14);
        const len = 1.4 - k * 0.24;
        const bar = new THREE.CylinderGeometry(0.022, 0.022, len, 4);
        bar.rotateZ(Math.PI / 2);
        bar.rotateY(hash2(i, k, 1383) * 3.14);
        bar.translate(x, y, z);
        parts.push(bar);
      }
      // guy wires
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + i;
        const ex = x + Math.cos(a) * H * 0.42, ez = z + Math.sin(a) * H * 0.42;
        const pts = [new THREE.Vector3(x, gy + H * 0.9, z), new THREE.Vector3(ex, heightAt(ex, ez), ez)];
        parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 2, 0.014, 3, false));
      }
    }
    const m = new THREE.Mesh(BGU.mergeGeometries(parts, false), this.matWire);
    m.castShadow = true; m.receiveShadow = false;
    for (const g of parts) g.dispose();
    this.group.add(m); this.meshes.push(m);
  }

  /* --- ground debris: planks, sheet scrap, bones ---------------------------- */
  _debris() {
    const mat = createCelInstancedMaterial({
      color: 0x8f7d63, roughness: 0.95, metalness: 0.05, flatShading: true,
      bands: 3, bandFloor: 0.3, warm: 0xfff0d6, cool: 0x8aa8cc,
      rimStrength: 0.35, hatch: 0.4, grain: 0.8, specBand: 0.2, outlineWidth: 1.0,
    });
    const geo = new THREE.BoxGeometry(1, 0.06, 0.22);
    const N = 150;
    const inst = new THREE.InstancedMesh(geo, mat, N);
    let n = 0;
    for (let i = 0; n < N && i < N * 20; i++) {
      const ang = hash2(i, 1, 1391) * 6.283;
      const rad = Math.sqrt(hash2(i, 2, 1393)) * 90;
      const x = 4 + Math.cos(ang) * rad;
      const z = -14 + Math.sin(ang) * rad;
      if (slopeAt(x, z) > 0.34) continue;
      const near = Math.min(
        Math.hypot(x - CAMP.x, z - CAMP.z) / 30,
        Math.abs(x - roadX(z)) / 16,
        Math.hypot(x - ARENA.x, z - ARENA.z) / 34);
      if (hash2(i, 3, 1395) > 1.05 - clamp(near, 0, 1)) continue;
      const gy = heightAt(x, z);
      _e.set((hash2(i, 4, 1397) - 0.5) * 0.3, hash2(i, 5, 1399) * 6.28, (hash2(i, 6, 1401) - 0.5) * 0.3);
      _q.setFromEuler(_e);
      const s = 0.5 + hash2(i, 7, 1403) * 1.4;
      _sc.set(s, 0.7 + hash2(i, 8, 1405) * 1.6, 0.6 + hash2(i, 9, 1407) * 1.5);
      _v3.set(x, gy + 0.03, z);
      _m4.compose(_v3, _q, _sc);
      inst.setMatrixAt(n, _m4);
      const t = hash2(i, 10, 1409);
      if (t > 0.6) _col.setRGB(0.72, 0.76, 0.80);        // sheet scrap
      else if (t > 0.25) _col.setRGB(1.0, 0.86, 0.62);   // dry timber
      else _col.setRGB(1.15, 1.12, 0.98);                // bleached bone
      inst.setColorAt(n, _col);
      n++;
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    this.group.add(inst); this.meshes.push(inst);
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
  }
}
