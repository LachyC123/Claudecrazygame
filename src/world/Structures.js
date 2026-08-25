/**
 * BORDERLINE 4 — BANDIT SETTLEMENT
 * =============================================================================
 * A modular scrap kit assembled procedurally into a readable arena: shacks with
 * real corrugated ribs (geometry, not a normal map — the ink pass needs the
 * creases), a watchtower that breaks the horizon, fuel tanks, catwalks, a
 * hanging cable run and tattered banners.
 *
 * Layout rule: nothing taller than 2 m in the middle, cover on the flanks,
 * verticality on the outside. You can see the fight from the road.
 * =============================================================================
 */

import * as THREE from 'three';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCelMaterial } from '../render/index.js';
import {
  heightAt, clamp, lerp, smoothstep, hash2, fbm2, canvasOf, finishTex,
  tileFbm, tileWorley, heightToNormal, CAMP,
} from './Terrain.js';

/* ------------------------------------------------------------- textures --- */

function metalTex(assets) {
  return assets.get('str.metal', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    // base paint — faded bandit teal / grey
    g.fillStyle = '#7e8384'; g.fillRect(0, 0, N, N);
    const rust = tileFbm(N, 6, 4, 901);
    const grime = tileFbm(N, 20, 3, 903);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const r = clamp(rust[i] * 1.5 - 0.35, 0, 1);
      const gr = grime[i];
      const o = i * 4;
      let R = d[o], G = d[o + 1], B = d[o + 2];
      // rust bloom
      R = lerp(R, 150 + gr * 60, r); G = lerp(G, 74 + gr * 40, r); B = lerp(B, 40 + gr * 26, r);
      // paint mottle
      const m = 0.82 + gr * 0.36;
      d[o] = clamp(R * m, 0, 255); d[o + 1] = clamp(G * m, 0, 255); d[o + 2] = clamp(B * m, 0, 255);
    }
    g.putImageData(img, 0, 0);
    // vertical rust streaks
    for (let i = 0; i < 90; i++) {
      const x = hash2(i, 1, 905) * N;
      const y0 = hash2(i, 2, 907) * N * 0.7;
      const h = 40 + hash2(i, 3, 909) * 260;
      const grd = g.createLinearGradient(0, y0, 0, y0 + h);
      grd.addColorStop(0, 'rgba(112,54,26,0.55)');
      grd.addColorStop(1, 'rgba(112,54,26,0)');
      g.fillStyle = grd;
      g.fillRect(x, y0, 2 + hash2(i, 4, 911) * 8, h);
    }
    // rivet rows
    g.fillStyle = 'rgba(40,38,36,0.65)';
    for (let ry = 0; ry < 6; ry++) {
      const y = 24 + ry * (N / 6);
      for (let rx = 0; rx < 22; rx++) {
        const x = 12 + rx * (N / 22);
        g.beginPath(); g.arc(x, y, 2.4, 0, 6.283); g.fill();
        g.fillStyle = 'rgba(190,186,178,0.35)';
        g.beginPath(); g.arc(x - 0.7, y - 0.8, 1.2, 0, 6.283); g.fill();
        g.fillStyle = 'rgba(40,38,36,0.65)';
      }
    }
    // scratches
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = `rgba(${180 + hash2(i, 5, 913) * 50 | 0},${170 + hash2(i, 6, 915) * 50 | 0},160,0.28)`;
      g.lineWidth = 0.8 + hash2(i, 7, 917) * 1.6;
      g.beginPath();
      const x = hash2(i, 8, 919) * N, y = hash2(i, 9, 921) * N;
      g.moveTo(x, y);
      g.lineTo(x + (hash2(i, 10, 923) - 0.5) * 120, y + (hash2(i, 11, 925) - 0.5) * 40);
      g.stroke();
    }
    return finishTex(c, { srgb: true });
  });
}

function metalNormal(assets) {
  return assets.get('str.metalN', () => {
    const N = 256;
    const a = tileFbm(N, 22, 3, 931);
    const w = tileWorley(N, 7, 933);
    const h = new Float32Array(N * N);
    for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.55 + smoothstep(0.3, 0.9, w.f1[i]) * 0.45;
    return finishTex(heightToNormal(h, N, 1.1), { srgb: false });
  });
}

function woodTex(assets) {
  return assets.get('str.wood', () => {
    const N = 512;
    const c = canvasOf(N), g = c.getContext('2d');
    g.fillStyle = '#8a6b45'; g.fillRect(0, 0, N, N);
    const planks = 7;
    for (let p = 0; p < planks; p++) {
      const y = p * (N / planks);
      const hgt = N / planks;
      const shade = 0.78 + hash2(p, 1, 941) * 0.42;
      g.fillStyle = `rgb(${(150 * shade) | 0},${(112 * shade) | 0},${(70 * shade) | 0})`;
      g.fillRect(0, y + 1, N, hgt - 2);
      // grain
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = `rgba(${(72 * shade) | 0},${(52 * shade) | 0},${(32 * shade) | 0},${0.16 + hash2(p, i, 943) * 0.3})`;
        g.lineWidth = 0.7 + hash2(p, i, 945) * 2.0;
        g.beginPath();
        const yy = y + 3 + hash2(p, i, 947) * (hgt - 6);
        g.moveTo(0, yy);
        for (let x = 0; x <= N; x += 32) {
          g.lineTo(x, yy + Math.sin(x * 0.03 + p * 2 + i) * 2.4);
        }
        g.stroke();
      }
      // seam shadow
      g.fillStyle = 'rgba(30,20,12,0.55)';
      g.fillRect(0, y, N, 2);
    }
    // knots + splits
    for (let i = 0; i < 12; i++) {
      const x = hash2(i, 2, 949) * N, y = hash2(i, 3, 951) * N;
      g.strokeStyle = 'rgba(50,34,20,0.5)'; g.lineWidth = 1.6;
      for (let k = 0; k < 4; k++) {
        g.beginPath(); g.ellipse(x, y, 3 + k * 3, 2 + k * 2, hash2(i, k, 953) * 3, 0, 6.283); g.stroke();
      }
    }
    return finishTex(c, { srgb: true });
  });
}

function bannerTex(assets) {
  return assets.get('str.banner', () => {
    const N = 256;
    const c = canvasOf(N), g = c.getContext('2d');
    g.clearRect(0, 0, N, N);
    g.fillStyle = '#b8402c';
    g.fillRect(0, 0, N, N);
    // tattered bottom edge
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(0, N);
    for (let x = 0; x <= N; x += 16) {
      g.lineTo(x, N - 6 - hash2(x, 1, 961) * 42);
    }
    g.lineTo(N, N); g.closePath(); g.fill();
    for (let i = 0; i < 14; i++) {
      g.beginPath();
      g.arc(hash2(i, 2, 963) * N, 40 + hash2(i, 3, 965) * (N - 60), 3 + hash2(i, 4, 967) * 11, 0, 6.283);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // painted bandit sigil
    g.strokeStyle = '#f3e2c0'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(N * 0.3, N * 0.22); g.lineTo(N * 0.7, N * 0.62); g.stroke();
    g.beginPath(); g.moveTo(N * 0.7, N * 0.22); g.lineTo(N * 0.3, N * 0.62); g.stroke();
    g.beginPath(); g.arc(N * 0.5, N * 0.42, N * 0.30, 0, 6.283); g.lineWidth = 7; g.stroke();
    // grime
    const gr = tileFbm(N, 9, 3, 969);
    const img = g.getImageData(0, 0, N, N), d = img.data;
    for (let i = 0; i < N * N; i++) {
      const m = 0.62 + gr[i] * 0.6;
      d[i * 4] *= m; d[i * 4 + 1] *= m; d[i * 4 + 2] *= m;
    }
    g.putImageData(img, 0, 0);
    const t = finishTex(c, { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/* -------------------------------------------------------------- kit ------- */

/** Corrugated sheet in the XY plane, ribs running along Y. Real geometry. */
function corrugated(w, h, ribs = 10, depth = 0.055, segY = 2) {
  const segX = ribs * 4;
  const g = new THREE.PlaneGeometry(w, h, segX, segY);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, Math.sin((x / w + 0.5) * Math.PI * 2 * ribs) * depth);
  }
  g.computeVertexNormals();
  return g;
}

function boxGeo(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

function beam(len, t, axis = 'y') {
  const g = new THREE.BoxGeometry(axis === 'x' ? len : t, axis === 'y' ? len : t, axis === 'z' ? len : t);
  return g;
}

/** Rusty drum / tank body: ribbed cylinder. */
function tankGeo(r, h, ribs = 3) {
  const parts = [new THREE.CylinderGeometry(r, r, h, 18, 1, false)];
  for (let i = 0; i < ribs; i++) {
    const y = -h / 2 + h * ((i + 1) / (ribs + 1));
    const t = new THREE.TorusGeometry(r * 1.01, r * 0.045, 6, 18);
    t.rotateX(Math.PI / 2); t.translate(0, y, 0);
    parts.push(t);
  }
  const cap = new THREE.CylinderGeometry(r * 0.98, r * 0.98, h * 0.03, 18);
  const c1 = cap.clone(); c1.translate(0, h / 2, 0);
  const c2 = cap.clone(); c2.translate(0, -h / 2, 0);
  cap.dispose();
  parts.push(c1, c2);
  const m = BGU.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return m;
}

/* ------------------------------------------------------------- class ------ */

const _v = new THREE.Vector3();

export class Structures {
  constructor(ctx, world) {
    this.ctx = ctx;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'Structures';
    this.meshes = [];
    this.parts = { metal: [], wood: [], dark: [], accent: [] };
  }

  build() {
    const A = this.ctx.assets;
    this.matMetal = createCelMaterial({
      map: metalTex(A), normalMap: metalNormal(A), color: 0xffffff,
      roughness: 0.72, metalness: 0.35, bands: 3, bandFloor: 0.26,
      warm: 0xfff0d6, cool: 0x86a9cf, rimStrength: 0.42, rimColor: 0xffd9a6,
      hatch: 0.55, hatchScale: 2.4, grain: 0.55, specBand: 0.95, outlineWidth: 1.3,
    });
    this.matMetal.normalScale.set(0.55, 0.55);
    this.matWood = createCelMaterial({
      map: woodTex(A), color: 0xffffff, roughness: 0.94, metalness: 0.0,
      bands: 3, bandFloor: 0.26, warm: 0xfff0d6, cool: 0x8aa8c8,
      rimStrength: 0.3, hatch: 0.6, hatchScale: 2.6, grain: 0.7, specBand: 0.2,
      outlineWidth: 1.2,
    });
    this.matDark = createCelMaterial({
      color: 0x40474c, roughness: 0.6, metalness: 0.55,
      bands: 3, bandFloor: 0.24, warm: 0xffeed2, cool: 0x7d9ec4,
      rimStrength: 0.5, hatch: 0.4, grain: 0.5, specBand: 1.0, outlineWidth: 1.2,
    });
    this.matAccent = createCelMaterial({
      color: 0xc4562a, roughness: 0.68, metalness: 0.2,
      bands: 3, bandFloor: 0.26, warm: 0xfff0d6, cool: 0x8aa8c8,
      rimStrength: 0.5, hatch: 0.35, grain: 0.6, specBand: 0.8, outlineWidth: 1.3,
    });
    this.matBanner = createCelMaterial({
      map: bannerTex(A), color: 0xffffff, roughness: 0.95, metalness: 0,
      side: THREE.DoubleSide, alphaTest: 0.5, transparent: false,
      bands: 3, bandFloor: 0.4, rimStrength: 0.4, hatch: 0.3, grain: 0.6,
      specBand: 0.1, outlineWidth: 1.0,
    });

    const c = Math.cos(CAMP.rot), s = Math.sin(CAMP.rot);
    // local (u,v) -> world
    this.L = (u, v) => _v.set(CAMP.x + u * c - v * s, 0, CAMP.z + u * s + v * c);

    this._shack(-13, 5, 7.2, 5.6, 3.3, 0.2);
    this._shack(9, 10, 6.0, 5.0, 2.9, -0.5);
    this._shack(13, -9, 8.0, 6.0, 3.6, 1.35);
    this._shack(-8, -14, 5.2, 4.4, 2.6, 2.5);
    this._watchtower(-2, 15, 11.5);
    this._tanks(16, 4);
    this._catwalk(-13, 5, 9, 10, 3.4);
    this._barricades();
    this._cables();
    this._banners();
    this._signMast(-20, -6);

    // merge each material bucket into one draw call
    for (const key of Object.keys(this.parts)) {
      const list = this.parts[key];
      if (!list.length) continue;
      const merged = BGU.mergeGeometries(list, false);
      for (const g of list) g.dispose();
      const mat = key === 'metal' ? this.matMetal : key === 'wood' ? this.matWood
        : key === 'dark' ? this.matDark : this.matAccent;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'Camp.' + key;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    return this.group;
  }

  /* --- helpers --- */
  _add(bucket, geo, u, v, y, ry = 0, rx = 0, rz = 0) {
    const p = this.L(u, v);
    const g = geo;
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    if (ry || CAMP.rot) g.rotateY(ry + CAMP.rot);
    g.translate(p.x, y, p.z);
    this.parts[bucket].push(g);
    return g;
  }
  _ground(u, v) {
    const p = this.L(u, v);
    return heightAt(p.x, p.z);
  }
  _collideBox(u, v, y, hw, hh, hd, ry = 0) {
    const p = this.L(u, v);
    // axis-aligned approximation, inflated to cover the rotation
    const cr = Math.abs(Math.cos(ry + CAMP.rot)), sr = Math.abs(Math.sin(ry + CAMP.rot));
    this.world.colliders.push({
      type: 'box',
      center: new THREE.Vector3(p.x, y, p.z),
      half: new THREE.Vector3(hw * cr + hd * sr, hh, hw * sr + hd * cr),
    });
  }

  /* --- shack: corrugated box with a lean-to roof and a timber frame ------- */
  _shack(u, v, w, d, h, ry) {
    const gy = this._ground(u, v) + 0.02;
    const seed = (u * 31 + v * 17) | 0;
    const ribs = Math.max(6, Math.round(w * 2));

    const wall = (ww, hh, ox, oz, rot) => {
      const g = corrugated(ww, hh, Math.max(5, Math.round(ww * 2)), 0.05);
      g.rotateY(rot);
      g.translate(ox, 0, oz);
      return g;
    };
    // front wall with a doorway: two narrow panels + a lintel
    const doorW = Math.min(1.35, w * 0.3);
    const sideW = (w - doorW) / 2;
    const front = [];
    front.push(wall(sideW, h, -(doorW / 2 + sideW / 2), d / 2, 0));
    front.push(wall(sideW, h, (doorW / 2 + sideW / 2), d / 2, 0));
    const lint = corrugated(doorW, h - 2.05, Math.max(3, Math.round(doorW * 3)), 0.05);
    lint.translate(0, (h - 2.05) / 2 + 0.0, d / 2);
    lint.translate(0, 2.05 - h / 2, 0);
    front.push(lint);
    const shell = [
      wall(w, h, 0, -d / 2, Math.PI),
      wall(d, h, -w / 2, 0, -Math.PI / 2),
      wall(d, h, w / 2, 0, Math.PI / 2),
      ...front,
    ];
    for (const g of shell) g.translate(0, h / 2, 0);
    // sloped roof
    const roofPitch = 0.20;
    const roof = corrugated(w + 0.6, Math.hypot(d + 0.6, d * roofPitch), Math.max(8, Math.round(w * 2)), 0.075);
    roof.rotateX(-Math.PI / 2 + Math.atan(roofPitch));
    roof.translate(0, h + d * roofPitch * 0.5 + 0.06, 0);
    shell.push(roof);
    // timber frame + corner posts
    for (const [px, pz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      const post = boxGeo(0.18, h + 0.5, 0.18);
      post.translate(px, (h + 0.5) / 2, pz);
      this._add('wood', post.clone(), u, v, gy, ry);
      post.dispose();
    }
    // patched plates
    for (let i = 0; i < 4; i++) {
      const pw = 0.7 + hash2(seed, i, 971) * 1.1;
      const ph = 0.5 + hash2(seed, i, 973) * 0.9;
      const plate = boxGeo(pw, ph, 0.06);
      const side = i % 2 === 0 ? 1 : -1;
      plate.rotateZ((hash2(seed, i, 975) - 0.5) * 0.5);
      plate.translate((hash2(seed, i, 977) - 0.5) * w * 0.7, 0.6 + hash2(seed, i, 979) * (h - 1.2), side * (d / 2 + 0.07));
      shell.push(plate);
    }
    const merged = BGU.mergeGeometries(shell, false);
    for (const g of shell) g.dispose();
    this._add('metal', merged, u, v, gy, ry);
    this._collideBox(u, v, gy + h / 2, w / 2, h / 2, d / 2, ry);
  }

  /* --- watchtower -------------------------------------------------------- */
  _watchtower(u, v, H) {
    const gy = this._ground(u, v);
    const foot = 2.5, top = 1.35;
    const wood = [], metal = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x0 = Math.cos(a) * foot, z0 = Math.sin(a) * foot;
      const x1 = Math.cos(a) * top, z1 = Math.sin(a) * top;
      const len = Math.hypot(x1 - x0, H, z1 - z0);
      const leg = boxGeo(0.22, len, 0.22);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(x1 - x0, H, z1 - z0).normalize());
      leg.applyQuaternion(q);
      leg.translate((x0 + x1) / 2, H / 2, (z0 + z1) / 2);
      wood.push(leg);
    }
    // cross braces
    for (let lvl = 1; lvl <= 3; lvl++) {
      const t = lvl / 4;
      const y = H * t;
      const rr = lerp(foot, top, t);
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        const p0 = new THREE.Vector3(Math.cos(a0) * rr, y, Math.sin(a0) * rr);
        const p1 = new THREE.Vector3(Math.cos(a1) * rr, y, Math.sin(a1) * rr);
        const len = p0.distanceTo(p1);
        const b = boxGeo(0.12, len, 0.12);
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
        b.applyQuaternion(q);
        b.translate((p0.x + p1.x) / 2, y, (p0.z + p1.z) / 2);
        wood.push(b);
        if (lvl < 3) {
          const dq = boxGeo(0.09, Math.hypot(len, H / 4), 0.09);
          const dir = p1.clone().sub(p0).setY(H / 4).normalize();
          dq.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
          dq.translate((p0.x + p1.x) / 2, y + H / 8, (p0.z + p1.z) / 2);
          wood.push(dq);
        }
      }
    }
    // deck
    const deck = boxGeo(3.4, 0.16, 3.4); deck.translate(0, H, 0); wood.push(deck);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const rail = boxGeo(3.4, 0.1, 0.1);
      rail.rotateY(a); rail.translate(Math.sin(a) * 1.65, H + 0.95, Math.cos(a) * 1.65);
      wood.push(rail);
      const rail2 = boxGeo(3.4, 0.08, 0.08);
      rail2.rotateY(a); rail2.translate(Math.sin(a) * 1.65, H + 0.5, Math.cos(a) * 1.65);
      wood.push(rail2);
      const post = boxGeo(0.12, 1.05, 0.12);
      post.translate(Math.cos(a + 0.78) * 1.6, H + 0.5, Math.sin(a + 0.78) * 1.6);
      wood.push(post);
    }
    // corrugated shade roof
    const roof = corrugated(4.0, 4.0, 9, 0.08);
    roof.rotateX(-Math.PI / 2 + 0.14);
    roof.translate(0, H + 2.35, 0);
    metal.push(roof);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const p = boxGeo(0.1, 1.5, 0.1);
      p.translate(Math.cos(a) * 1.5, H + 1.7, Math.sin(a) * 1.5);
      wood.push(p);
    }
    // ladder
    for (let r = 0; r < Math.floor(H / 0.42); r++) {
      const rung = boxGeo(0.86, 0.06, 0.06);
      rung.translate(0, 0.35 + r * 0.42, foot * 0.92);
      metal.push(rung);
    }
    const rail = boxGeo(0.06, H, 0.06);
    const rl = rail.clone(); rl.translate(-0.43, H / 2, foot * 0.92); metal.push(rl);
    const rr2 = rail.clone(); rr2.translate(0.43, H / 2, foot * 0.92); metal.push(rr2);
    rail.dispose();

    const mw = BGU.mergeGeometries(wood, false);
    const mm = BGU.mergeGeometries(metal, false);
    for (const g of wood) g.dispose();
    for (const g of metal) g.dispose();
    this._add('wood', mw, u, v, gy, 0.3);
    this._add('metal', mm, u, v, gy, 0.3);
    this._collideBox(u, v, gy + H / 2, foot, H / 2, foot);
    this.towerTop = this.L(u, v).clone();
    this.towerTop.y = gy + H;
  }

  /* --- fuel tanks -------------------------------------------------------- */
  _tanks(u, v) {
    const gy = this._ground(u, v);
    const metal = [], dark = [], accent = [];
    const R = 1.9, H = 4.6;
    for (let i = 0; i < 2; i++) {
      const t = tankGeo(R, H, 3);
      t.translate(i * 4.6, H / 2 + 0.55, 0);
      metal.push(t);
      // cradle legs
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.78;
        const leg = boxGeo(0.16, 0.9, 0.16);
        leg.translate(i * 4.6 + Math.cos(a) * R * 0.72, 0.45, Math.sin(a) * R * 0.72);
        dark.push(leg);
      }
      // top hatch + pipe
      const hatch = new THREE.CylinderGeometry(0.42, 0.42, 0.22, 10);
      hatch.translate(i * 4.6, H + 0.72, 0); dark.push(hatch);
      const pipe = new THREE.CylinderGeometry(0.13, 0.13, 2.4, 8);
      pipe.rotateZ(Math.PI / 2); pipe.translate(i * 4.6 + 2.3, H * 0.72, R * 0.6);
      dark.push(pipe);
      // hazard band
      const band = new THREE.CylinderGeometry(R * 1.015, R * 1.015, 0.5, 18, 1, true);
      band.translate(i * 4.6, H * 0.78, 0);
      accent.push(band);
      this.world.colliders.push({
        type: 'box',
        center: this.L(u + i * 4.6, v).clone().setY(gy + H / 2 + 0.55),
        half: new THREE.Vector3(R, H / 2 + 0.55, R),
      });
    }
    this._add('metal', BGU.mergeGeometries(metal, false), u, v, gy, 0);
    this._add('dark', BGU.mergeGeometries(dark, false), u, v, gy, 0);
    this._add('accent', BGU.mergeGeometries(accent, false), u, v, gy, 0);
    for (const g of [...metal, ...dark, ...accent]) g.dispose();
  }

  /* --- catwalk between two roofs ----------------------------------------- */
  _catwalk(u0, v0, u1, v1, y) {
    const wood = [], metal = [];
    const dx = u1 - u0, dz = v1 - v0;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    const gy0 = this._ground(u0, v0);
    const n = Math.floor(len / 0.5);
    for (let i = 0; i < n; i++) {
      const plank = boxGeo(0.42, 0.07, 1.3);
      plank.rotateY(-ang);
      plank.translate(Math.cos(ang) * (i * 0.5 - len / 2 + 0.25), 0, Math.sin(ang) * (i * 0.5 - len / 2 + 0.25));
      wood.push(plank);
    }
    for (const side of [-0.62, 0.62]) {
      const rail = boxGeo(len, 0.06, 0.06);
      rail.rotateY(-ang);
      rail.translate(-Math.sin(ang) * side, 0.9, Math.cos(ang) * side);
      metal.push(rail);
      for (let i = 0; i <= 4; i++) {
        const post = boxGeo(0.06, 0.95, 0.06);
        const t = i / 4 - 0.5;
        post.translate(Math.cos(ang) * len * t - Math.sin(ang) * side, 0.47, Math.sin(ang) * len * t + Math.cos(ang) * side);
        metal.push(post);
      }
    }
    // support legs
    for (let i = 0; i <= 2; i++) {
      const t = i / 2 - 0.5;
      const px = Math.cos(ang) * len * t, pz = Math.sin(ang) * len * t;
      const h = y - this._ground(u0 + (u1 - u0) * (t + 0.5), v0 + (v1 - v0) * (t + 0.5)) + gy0;
      const leg = boxGeo(0.16, Math.max(h, 0.5), 0.16);
      leg.translate(px, -Math.max(h, 0.5) / 2, pz);
      wood.push(leg);
    }
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    this._add('wood', BGU.mergeGeometries(wood, false), mu, mv, y + gy0 * 0, 0);
    this._add('metal', BGU.mergeGeometries(metal, false), mu, mv, y, 0);
    for (const g of [...wood, ...metal]) g.dispose();
  }

  /* --- scrap barricades and cover ---------------------------------------- */
  _barricades() {
    const spots = [
      [-4, 3, 0.4], [3, -2, 1.9], [-9, -4, 0.9], [6, 6, 2.6],
      [0, -8, 0.2], [-16, -1, 1.2], [11, 2, 2.2], [-2, -19, 0.7],
      [18, -14, 1.6], [-19, 12, 0.3],
    ];
    const metal = [], wood = [];
    for (let i = 0; i < spots.length; i++) {
      const [u, v, ry] = spots[i];
      const gy = this._ground(u, v);
      const w = 1.7 + hash2(i, 1, 981) * 1.8;
      const h = 1.0 + hash2(i, 2, 983) * 0.7;
      const sheet = corrugated(w, h, Math.max(4, Math.round(w * 2.5)), 0.05);
      sheet.rotateZ((hash2(i, 3, 985) - 0.5) * 0.22);
      sheet.rotateY(ry + CAMP.rot);
      const p = this.L(u, v);
      sheet.translate(p.x, gy + h / 2, p.z);
      metal.push(sheet);
      // props
      for (let k = 0; k < 2; k++) {
        const pl = boxGeo(0.12, h * 1.25, 0.12);
        pl.rotateX(0.35);
        pl.rotateY(ry + CAMP.rot);
        pl.translate(p.x + Math.cos(ry + CAMP.rot) * (k ? 0.6 : -0.6), gy + h * 0.55, p.z + Math.sin(ry + CAMP.rot) * (k ? 0.6 : -0.6) + 0.25);
        wood.push(pl);
      }
      this.world.colliders.push({
        type: 'box',
        center: new THREE.Vector3(p.x, gy + h / 2, p.z),
        half: new THREE.Vector3(w * 0.5, h * 0.5, 0.35),
      });
    }
    this.parts.metal.push(BGU.mergeGeometries(metal, false));
    this.parts.wood.push(BGU.mergeGeometries(wood, false));
    for (const g of [...metal, ...wood]) g.dispose();
  }

  /* --- hanging cables ----------------------------------------------------- */
  _cables() {
    const runs = [
      [[-2, 15, 11.0], [-13, 5, 4.4]],
      [[-2, 15, 11.0], [13, -9, 4.6]],
      [[-13, 5, 4.4], [9, 10, 4.0]],
      [[9, 10, 4.0], [16, 4, 5.2]],
    ];
    const parts = [];
    for (const [a, b] of runs) {
      const pa = this.L(a[0], a[1]).clone(); pa.y = this._ground(a[0], a[1]) + a[2];
      const pb = this.L(b[0], b[1]).clone(); pb.y = this._ground(b[0], b[1]) + b[2];
      const sag = pa.distanceTo(pb) * 0.11;
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const p = pa.clone().lerp(pb, t);
        p.y -= Math.sin(t * Math.PI) * sag;
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      parts.push(new THREE.TubeGeometry(curve, 14, 0.035, 4, false));
      // a couple of hanging lamps / rags
      for (let k = 1; k <= 2; k++) {
        const t = k / 3;
        const p = curve.getPoint(t);
        const bulb = new THREE.SphereGeometry(0.10, 6, 5);
        bulb.translate(p.x, p.y - 0.22, p.z);
        parts.push(bulb);
        const wire = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 4);
        wire.translate(p.x, p.y - 0.11, p.z);
        parts.push(wire);
      }
    }
    this.parts.dark.push(BGU.mergeGeometries(parts, false));
    for (const g of parts) g.dispose();
  }

  /* --- tattered banners --------------------------------------------------- */
  _banners() {
    const list = [
      [-13, 5, 3.5, 2.2, 1.9, 0.2],
      [13, -9, 3.9, 2.0, 1.7, 1.35],
      [-2, 15, 9.6, 2.6, 2.4, 0.9],
    ];
    const geos = [];
    for (let i = 0; i < list.length; i++) {
      const [u, v, y, w, h, ry] = list[i];
      const g = new THREE.PlaneGeometry(w, h, 8, 5);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), yy = p.getY(k);
        const t = (x / w + 0.5);
        p.setZ(k, Math.sin(t * 5.2 + i) * 0.13 * t + Math.sin(yy * 3 + i) * 0.05);
      }
      g.computeVertexNormals();
      g.rotateY(ry + CAMP.rot);
      const pos = this.L(u, v);
      g.translate(pos.x, this._ground(u, v) + y, pos.z);
      geos.push(g);
    }
    const merged = BGU.mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, this.matBanner);
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.userData.noShadowCast = true;
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  /* --- scrap sign mast (silhouette breaker) ------------------------------- */
  _signMast(u, v) {
    const gy = this._ground(u, v);
    const wood = [], metal = [], accent = [];
    const H = 7.4;
    const mast = boxGeo(0.24, H, 0.24); mast.translate(0, H / 2, 0); wood.push(mast);
    const arm = boxGeo(3.0, 0.16, 0.16); arm.translate(1.1, H - 0.6, 0); wood.push(arm);
    for (let i = 0; i < 3; i++) {
      const w = 1.6 + hash2(i, 1, 991) * 0.9;
      const board = boxGeo(w, 0.42, 0.07);
      board.rotateZ((hash2(i, 2, 993) - 0.5) * 0.3);
      board.translate(0.6 + hash2(i, 3, 995) * 0.9, H - 1.4 - i * 0.72, 0.14);
      (i === 1 ? accent : metal).push(board);
    }
    const brace = boxGeo(0.14, 2.4, 0.14);
    brace.rotateZ(0.7); brace.translate(-0.7, H * 0.35, 0); wood.push(brace);
    this._add('wood', BGU.mergeGeometries(wood, false), u, v, gy, 0.4);
    this._add('metal', BGU.mergeGeometries(metal, false), u, v, gy, 0.4);
    this._add('accent', BGU.mergeGeometries(accent, false), u, v, gy, 0.4);
    for (const g of [...wood, ...metal, ...accent]) g.dispose();
    this._collideBox(u, v, gy + H / 2, 0.2, H / 2, 0.2);
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
  }
}
