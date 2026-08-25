import * as THREE from 'three';

/**
 * BORDERLINE 4 — player collision.
 *
 * Capsule-vs-world solver: swept (sub-stepped) motion, iterative depenetration,
 * surface sliding, step-up, ground probing over the heightfield, and a coarse ray
 * marcher used by the camera rig for depth-of-field focus.
 *
 * Consumes `ctx.world.colliders` — an array of loosely-typed shape descriptors.
 * We normalise a wide range of authoring spellings so the World agent can emit
 * whatever shape record it likes:
 *
 *   { type:'box',     center|position, half|halfExtents|size, yaw|rotationY|quaternion }
 *   { type:'box',     min, max }                      // or { box: THREE.Box3 }
 *   { type:'sphere',  center|position, radius }
 *   { type:'capsule', center|position, radius, halfHeight|height }
 *   { type:'cylinder',center|position, radius, halfHeight|height }
 *
 * Optional per-shape flags honoured: `trigger` / `noPlayer` (ignored), `surface`
 * (string fed to the footstep event), `slippery`.
 *
 * Everything below is allocation-free per frame: all vector scratch lives at
 * module scope and the broadphase reuses preallocated typed arrays.
 */

// ─────────────────────────────────────────────────────────────────────────────
// scratch — module scope, never allocated in a hot loop
// ─────────────────────────────────────────────────────────────────────────────
const _pa = new THREE.Vector3();   // capsule segment a
const _pb = new THREE.Vector3();   // capsule segment b
const _sp = new THREE.Vector3();   // closest point on segment
const _cp = new THREE.Vector3();   // closest point on shape
const _n  = new THREE.Vector3();   // contact normal
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _faceN = new THREE.Vector3();
const _su0 = new THREE.Vector3();
const _su1 = new THREE.Vector3();
const _euler = new THREE.Euler();

const TYPE_BOX = 0, TYPE_SPHERE = 1, TYPE_CAPSULE = 2, TYPE_CYL = 3;
const CELL = 6;                    // broadphase cell size, metres
const CELL_INV = 1 / CELL;
const BIG_SPAN = 96;               // shapes covering more cells than this go in the always-list
const SLOP = 0.0015;               // push-out epsilon so we never rest exactly on the surface

function fnum(o, names, def) {
  for (let i = 0; i < names.length; i++) {
    const v = o[names[i]];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return def;
}
function fvec(o, names, out, def) {
  for (let i = 0; i < names.length; i++) {
    const v = o[names[i]];
    if (!v) continue;
    if (typeof v.x === 'number') { out.set(v.x, v.y ?? 0, v.z ?? 0); return true; }
    if (Array.isArray(v) && v.length >= 3) { out.set(v[0], v[1], v[2]); return true; }
    if (typeof v === 'number') { out.set(v, v, v); return true; }
  }
  if (def) out.copy(def); else out.set(0, 0, 0);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// primitive distance queries
// ─────────────────────────────────────────────────────────────────────────────
function closestOnSegment(ax, ay, az, bx, by, bz, px, py, pz, out) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return out.set(ax + dx * t, ay + dy * t, az + dz * t);
}

/**
 * Closest point on `s` to world point p. Writes into `out`.
 * Returns penetration depth if p is *inside* the shape (0 otherwise); when
 * inside, `_faceN` holds the minimum-translation escape normal.
 */
function closestOnShape(s, px, py, pz, out) {
  switch (s.t) {
    case TYPE_SPHERE: {
      const dx = px - s.cx, dy = py - s.cy, dz = pz - s.cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-6) { out.set(s.cx, s.cy + s.r, s.cz); _faceN.set(0, 1, 0); return s.r; }
      const inv = 1 / d;
      out.set(s.cx + dx * inv * s.r, s.cy + dy * inv * s.r, s.cz + dz * inv * s.r);
      if (d < s.r) { _faceN.set(dx * inv, dy * inv, dz * inv); return s.r - d; }
      return 0;
    }
    case TYPE_CAPSULE:
    case TYPE_CYL: {
      // local (yaw does not matter for a vertical body of revolution)
      const ly = py - s.cy;
      const dx = px - s.cx, dz = pz - s.cz;
      const rad = Math.sqrt(dx * dx + dz * dz);
      if (s.t === TYPE_CAPSULE) {
        const cy = ly < -s.hh ? -s.hh : ly > s.hh ? s.hh : ly;
        const ox = px - s.cx, oy = py - (s.cy + cy), oz = pz - s.cz;
        const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (d < 1e-6) { out.set(s.cx + s.r, s.cy + cy, s.cz); _faceN.set(1, 0, 0); return s.r; }
        const inv = 1 / d;
        out.set(s.cx + ox * inv * s.r, s.cy + cy + oy * inv * s.r, s.cz + oz * inv * s.r);
        if (d < s.r) { _faceN.set(ox * inv, oy * inv, oz * inv); return s.r - d; }
        return 0;
      }
      // cylinder: flat caps
      const clampedY = ly < -s.hh ? -s.hh : ly > s.hh ? s.hh : ly;
      const insideY = ly > -s.hh && ly < s.hh;
      if (rad <= s.r && insideY) {
        const dTop = s.hh - ly, dBot = ly + s.hh, dSide = s.r - rad;
        if (dSide <= dTop && dSide <= dBot) {
          const inv = rad > 1e-6 ? 1 / rad : 0;
          const nx = rad > 1e-6 ? dx * inv : 1, nz = rad > 1e-6 ? dz * inv : 0;
          out.set(s.cx + nx * s.r, py, s.cz + nz * s.r);
          _faceN.set(nx, 0, nz);
          return dSide;
        }
        if (dTop <= dBot) { out.set(px, s.cy + s.hh, pz); _faceN.set(0, 1, 0); return dTop; }
        out.set(px, s.cy - s.hh, pz); _faceN.set(0, -1, 0); return dBot;
      }
      const rr = rad > s.r ? s.r / Math.max(rad, 1e-6) : 1;
      out.set(s.cx + dx * rr, s.cy + clampedY, s.cz + dz * rr);
      return 0;
    }
    default: {
      // box, possibly yaw-rotated
      let lx = px - s.cx, ly = py - s.cy, lz = pz - s.cz;
      if (s.rot) { const t = lx * s.cos + lz * s.sin; lz = -lx * s.sin + lz * s.cos; lx = t; }
      const qx = lx < -s.hx ? -s.hx : lx > s.hx ? s.hx : lx;
      const qy = ly < -s.hy ? -s.hy : ly > s.hy ? s.hy : ly;
      const qz = lz < -s.hz ? -s.hz : lz > s.hz ? s.hz : lz;
      const inside = qx === lx && qy === ly && qz === lz;
      let ox = qx, oy = qy, oz = qz, depth = 0;
      if (inside) {
        const dxp = s.hx - lx, dxn = lx + s.hx;
        const dyp = s.hy - ly, dyn = ly + s.hy;
        const dzp = s.hz - lz, dzn = lz + s.hz;
        let best = dxp; let nx = 1, ny = 0, nz = 0;
        if (dxn < best) { best = dxn; nx = -1; ny = 0; nz = 0; }
        if (dyp < best) { best = dyp; nx = 0; ny = 1; nz = 0; }
        if (dyn < best) { best = dyn; nx = 0; ny = -1; nz = 0; }
        if (dzp < best) { best = dzp; nx = 0; ny = 0; nz = 1; }
        if (dzn < best) { best = dzn; nx = 0; ny = 0; nz = -1; }
        depth = best;
        ox = lx + nx * best; oy = ly + ny * best; oz = lz + nz * best;
        if (s.rot) { const t = nx * s.cos - nz * s.sin; _faceN.set(t, ny, nx * s.sin + nz * s.cos); }
        else _faceN.set(nx, ny, nz);
      }
      if (s.rot) { const t = ox * s.cos - oz * s.sin; oz = ox * s.sin + oz * s.cos; ox = t; }
      out.set(s.cx + ox, s.cy + oy, s.cz + oz);
      return depth;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// contact result (reused, never allocated)
// ─────────────────────────────────────────────────────────────────────────────
export class MoveResult {
  constructor() {
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundY = 0;
    this.groundSurface = 'sand';
    this.groundSlippery = 0;
    this.hitWall = false;
    this.wallNormal = new THREE.Vector3();
    this.hitCeiling = false;
    this.stepped = 0;
    this.contacts = 0;
    this.impact = 0;              // downward speed absorbed by the floor this move
  }
  reset() {
    this.grounded = false; this.groundNormal.set(0, 1, 0); this.groundY = -Infinity;
    this.groundSurface = 'sand'; this.groundSlippery = 0;
    this.hitWall = false; this.wallNormal.set(0, 0, 0); this.hitCeiling = false;
    this.stepped = 0; this.contacts = 0; this.impact = 0;
  }
}

export class Collision {
  constructor(ctx) {
    this.ctx = ctx;
    this.shapes = [];
    this.big = [];
    this.cells = new Map();

    this.groundCos = 0.55;         // ~56° walkable
    this.stepHeight = 0.55;

    this._srcLen = -1;
    this._srcVer = -1;
    this._stamps = new Int32Array(256);
    this._stamp = 0;
    this._cand = new Int32Array(1024);
    this._candN = 0;

    // ground-probe cache (avoids re-sampling the heightfield 5× per iteration)
    this._gx = NaN; this._gz = NaN; this._gy = 0;
    this._gn = new THREE.Vector3(0, 1, 0);

    this.stats = { shapes: 0, rebuilds: 0, contacts: 0 };
  }

  // ── broadphase ────────────────────────────────────────────────────────────
  refresh(force = false) {
    const list = this.ctx.world?.colliders;
    if (!Array.isArray(list)) return;
    const ver = this.ctx.world.collidersVersion ?? -1;
    if (!force && list.length === this._srcLen && ver === this._srcVer) return;
    this._srcLen = list.length; this._srcVer = ver;
    this._build(list);
  }

  _build(list) {
    const shapes = this.shapes; shapes.length = 0;
    this.big.length = 0;
    this.cells.clear();
    for (let i = 0; i < list.length; i++) {
      const s = this._normalise(list[i]);
      if (s) shapes.push(s);
    }
    if (this._stamps.length < shapes.length) this._stamps = new Int32Array(shapes.length + 64);
    this._stamps.fill(0); this._stamp = 0;

    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      const x0 = Math.floor(s.minX * CELL_INV), x1 = Math.floor(s.maxX * CELL_INV);
      const z0 = Math.floor(s.minZ * CELL_INV), z1 = Math.floor(s.maxZ * CELL_INV);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > BIG_SPAN) { this.big.push(i); continue; }
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = (x + 32768) * 65536 + (z + 32768);
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          arr.push(i);
        }
      }
    }
    this.stats.shapes = shapes.length;
    this.stats.rebuilds++;
  }

  _normalise(c) {
    if (!c || typeof c !== 'object') return null;
    if (c.trigger || c.noPlayer || c.isTrigger || c.enabled === false) return null;

    const type = String(c.type || c.shape || '').toLowerCase();
    const s = {
      t: TYPE_BOX, cx: 0, cy: 0, cz: 0, hx: 0.5, hy: 0.5, hz: 0.5, r: 0.5, hh: 0.5,
      rot: 0, sin: 0, cos: 1,
      minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
      surface: typeof c.surface === 'string' ? c.surface
        : typeof c.mat === 'string' ? c.mat
          : typeof c.material === 'string' ? c.material : 'rock',
      slippery: c.slippery ? 1 : 0,
    };

    // ── box from min/max or Box3
    const b3 = c.box && c.box.isBox3 ? c.box : (c.isBox3 ? c : null);
    const mn = b3 ? b3.min : c.min, mx = b3 ? b3.max : c.max;
    if (!type.startsWith('sph') && !type.startsWith('cap') && !type.startsWith('cyl') && mn && mx && typeof mn.x === 'number') {
      s.t = TYPE_BOX;
      s.cx = (mn.x + mx.x) * 0.5; s.cy = (mn.y + mx.y) * 0.5; s.cz = (mn.z + mx.z) * 0.5;
      s.hx = Math.abs(mx.x - mn.x) * 0.5; s.hy = Math.abs(mx.y - mn.y) * 0.5; s.hz = Math.abs(mx.z - mn.z) * 0.5;
    } else {
      fvec(c, ['center', 'position', 'pos', 'p', 'origin'], _t0);
      s.cx = _t0.x; s.cy = _t0.y; s.cz = _t0.z;
      const radius = fnum(c, ['radius', 'r'], NaN);
      const half = fnum(c, ['halfHeight', 'halfheight', 'hh'], NaN);
      const hgt = fnum(c, ['height', 'h'], NaN);
      if (type.startsWith('sph') || (!type && Number.isFinite(radius) && !Number.isFinite(half) && !Number.isFinite(hgt))) {
        s.t = TYPE_SPHERE; s.r = Number.isFinite(radius) ? radius : 0.5;
      } else if (type.startsWith('cap') || type.startsWith('cyl')) {
        s.t = type.startsWith('cap') ? TYPE_CAPSULE : TYPE_CYL;
        s.r = Number.isFinite(radius) ? radius : 0.5;
        s.hh = Number.isFinite(half) ? half : Number.isFinite(hgt) ? hgt * 0.5 : 1;
        if (s.t === TYPE_CAPSULE) s.hh = Math.max(0.001, s.hh - s.r);
      } else {
        s.t = TYPE_BOX;
        if (!fvec(c, ['half', 'halfExtents', 'halfExtent', 'he', 'extents'], _t1)) {
          if (fvec(c, ['size', 'dim', 'dimensions', 'scale'], _t1)) _t1.multiplyScalar(0.5);
          else _t1.set(
            fnum(c, ['width', 'w', 'sx'], 1) * 0.5,
            fnum(c, ['height', 'h', 'sy'], 1) * 0.5,
            fnum(c, ['depth', 'd', 'sz'], 1) * 0.5,
          );
        }
        s.hx = Math.abs(_t1.x); s.hy = Math.abs(_t1.y); s.hz = Math.abs(_t1.z);
      }
    }

    // ── yaw
    let yaw = fnum(c, ['yaw', 'rotationY', 'rotY', 'angle', 'ry'], NaN);
    if (!Number.isFinite(yaw) && c.quaternion && typeof c.quaternion.x === 'number') {
      _euler.setFromQuaternion(c.quaternion, 'YXZ'); yaw = _euler.y;
    }
    if (!Number.isFinite(yaw) && c.rotation && typeof c.rotation.y === 'number') yaw = c.rotation.y;
    if (Number.isFinite(yaw) && Math.abs(yaw) > 1e-4 && s.t === TYPE_BOX) {
      s.rot = 1; s.sin = Math.sin(yaw); s.cos = Math.cos(yaw);
    }

    // ── world AABB
    if (s.t === TYPE_BOX) {
      const ex = s.rot ? Math.abs(s.hx * s.cos) + Math.abs(s.hz * s.sin) : s.hx;
      const ez = s.rot ? Math.abs(s.hx * s.sin) + Math.abs(s.hz * s.cos) : s.hz;
      s.minX = s.cx - ex; s.maxX = s.cx + ex;
      s.minY = s.cy - s.hy; s.maxY = s.cy + s.hy;
      s.minZ = s.cz - ez; s.maxZ = s.cz + ez;
    } else {
      const vy = s.t === TYPE_SPHERE ? s.r : s.hh + (s.t === TYPE_CAPSULE ? s.r : 0);
      s.minX = s.cx - s.r; s.maxX = s.cx + s.r;
      s.minY = s.cy - vy; s.maxY = s.cy + vy;
      s.minZ = s.cz - s.r; s.maxZ = s.cz + s.r;
    }
    if (!Number.isFinite(s.minX) || !Number.isFinite(s.minY) || !Number.isFinite(s.minZ)) return null;
    if (s.maxX - s.minX < 1e-4 && s.maxY - s.minY < 1e-4) return null;
    return s;
  }

  /** Gather shape indices whose AABB overlaps the query box. Returns a count; results in `this._cand`. */
  query(minX, minY, minZ, maxX, maxY, maxZ) {
    const cand = this._cand, shapes = this.shapes;
    let n = 0;
    const stamp = ++this._stamp;
    const stamps = this._stamps;
    for (let i = 0; i < this.big.length && n < cand.length; i++) {
      const idx = this.big[i]; const s = shapes[idx];
      if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY || s.maxZ < minZ || s.minZ > maxZ) continue;
      stamps[idx] = stamp; cand[n++] = idx;
    }
    const x0 = Math.floor(minX * CELL_INV), x1 = Math.floor(maxX * CELL_INV);
    const z0 = Math.floor(minZ * CELL_INV), z1 = Math.floor(maxZ * CELL_INV);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const arr = this.cells.get((x + 32768) * 65536 + (z + 32768));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const idx = arr[i];
          if (stamps[idx] === stamp) continue;
          const s = shapes[idx];
          if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY || s.maxZ < minZ || s.minZ > maxZ) continue;
          stamps[idx] = stamp; cand[n++] = idx;
          if (n >= cand.length) return n;
        }
      }
    }
    this._candN = n;
    return n;
  }

  // ── heightfield ───────────────────────────────────────────────────────────
  heightAt(x, z) {
    const w = this.ctx.world;
    if (!w || typeof w.heightAt !== 'function') return 0;
    const h = w.heightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  /**
   * Terrain height + normal + surface under (x,z). Cached per position so the
   * depenetration loop can call it freely.
   */
  sampleGround(x, z) {
    if (x === this._gx && z === this._gz) return this._gy;
    const e = 0.45;
    const h = this.heightAt(x, z);
    const hx0 = this.heightAt(x - e, z), hx1 = this.heightAt(x + e, z);
    const hz0 = this.heightAt(x, z - e), hz1 = this.heightAt(x, z + e);
    this._gn.set(hx0 - hx1, 2 * e, hz0 - hz1).normalize();
    this._gx = x; this._gz = z; this._gy = h;
    return h;
  }
  groundNormal() { return this._gn; }

  surfaceAt(x, z, normalY) {
    const w = this.ctx.world;
    if (w && typeof w.surfaceAt === 'function') {
      const s = w.surfaceAt(x, z);
      if (typeof s === 'string') return s;
    }
    if (normalY !== undefined && normalY < 0.82) return 'rock';
    return 'sand';
  }

  // ── narrow phase ──────────────────────────────────────────────────────────
  /**
   * Push a capsule (feet at `pos`, total `height`, `radius`) out of every shape
   * it overlaps and slide `vel` along the contact planes.
   */
  depenetrate(pos, radius, height, vel, res, iterations = 4) {
    const shapes = this.shapes;
    const segLo = radius, segHi = Math.max(radius + 0.01, height - radius);
    for (let it = 0; it < iterations; it++) {
      _pa.set(pos.x, pos.y + segLo, pos.z);
      _pb.set(pos.x, pos.y + segHi, pos.z);
      const n = this.query(pos.x - radius, pos.y - 0.02, pos.z - radius,
        pos.x + radius, pos.y + height + 0.02, pos.z + radius);
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const s = shapes[this._cand[i]];
        // seed with the segment point nearest the shape centre, then refine
        closestOnSegment(_pa.x, _pa.y, _pa.z, _pb.x, _pb.y, _pb.z, s.cx, s.cy, s.cz, _sp);
        let depth = 0;
        for (let k = 0; k < 3; k++) {
          depth = closestOnShape(s, _sp.x, _sp.y, _sp.z, _cp);
          closestOnSegment(_pa.x, _pa.y, _pa.z, _pb.x, _pb.y, _pb.z, _cp.x, _cp.y, _cp.z, _sp);
        }
        depth = closestOnShape(s, _sp.x, _sp.y, _sp.z, _cp);
        let pen;
        if (depth > 0) { _n.copy(_faceN); pen = radius + depth; }
        else {
          _n.set(_sp.x - _cp.x, _sp.y - _cp.y, _sp.z - _cp.z);
          const d = _n.length();
          if (d >= radius) continue;
          if (d < 1e-5) { _n.set(0, 1, 0); pen = radius; }
          else { _n.multiplyScalar(1 / d); pen = radius - d; }
        }
        if (pen <= 0) continue;

        pos.addScaledVector(_n, pen + SLOP);
        _pa.set(pos.x, pos.y + segLo, pos.z);
        _pb.set(pos.x, pos.y + segHi, pos.z);
        moved++; res.contacts++;

        if (_n.y >= this.groundCos) {
          if (!res.grounded || _n.y > res.groundNormal.y) { res.groundNormal.copy(_n); }
          res.grounded = true;
          res.groundY = Math.max(res.groundY, pos.y);
          res.groundSurface = s.surface;
          res.groundSlippery = s.slippery;
          if (vel && vel.y < 0) { res.impact = Math.max(res.impact, -vel.y); vel.y = 0; }
        } else if (_n.y < -0.4) {
          res.hitCeiling = true;
          if (vel && vel.y > 0) vel.y = 0;
        } else {
          res.hitWall = true;
          res.wallNormal.copy(_n);
        }
        if (vel) {
          const dot = vel.dot(_n);
          if (dot < 0) vel.addScaledVector(_n, -dot);
        }
      }
      if (!moved) break;
    }
  }

  /** true if a capsule at `pos` overlaps nothing solid (used to validate mantle targets) */
  capsuleFree(pos, radius, height, shrink = 0.04) {
    const r = radius - shrink;
    const segLo = r + shrink, segHi = Math.max(segLo + 0.01, height - r - shrink);
    _pa.set(pos.x, pos.y + segLo, pos.z);
    _pb.set(pos.x, pos.y + segHi, pos.z);
    const n = this.query(pos.x - r, pos.y, pos.z - r, pos.x + r, pos.y + height, pos.z + r);
    for (let i = 0; i < n; i++) {
      const s = this.shapes[this._cand[i]];
      closestOnSegment(_pa.x, _pa.y, _pa.z, _pb.x, _pb.y, _pb.z, s.cx, s.cy, s.cz, _sp);
      for (let k = 0; k < 3; k++) {
        closestOnShape(s, _sp.x, _sp.y, _sp.z, _cp);
        closestOnSegment(_pa.x, _pa.y, _pa.z, _pb.x, _pb.y, _pb.z, _cp.x, _cp.y, _cp.z, _sp);
      }
      const depth = closestOnShape(s, _sp.x, _sp.y, _sp.z, _cp);
      if (depth > 0) return false;
      if (_sp.distanceTo(_cp) < r) return false;
    }
    if (pos.y < this.sampleGround(pos.x, pos.z) - 0.02) return false;
    return true;
  }

  /**
   * Highest solid surface under (x,z) between yTop and yBottom — terrain or the
   * top face of any collider. Returns -Infinity when nothing is found.
   * Fills `outNormal` and returns the surface tag through `this.probeSurface`.
   */
  surfaceUnder(x, z, yTop, yBottom, outNormal) {
    let best = -Infinity;
    this.probeSurface = 'sand';
    const g = this.sampleGround(x, z);
    if (g <= yTop + 0.001 && g >= yBottom - 0.001) {
      best = g;
      if (outNormal) outNormal.copy(this._gn);
      this.probeSurface = this.surfaceAt(x, z, this._gn.y);
    }
    const n = this.query(x - 0.02, yBottom, z - 0.02, x + 0.02, yTop, z + 0.02);
    for (let i = 0; i < n; i++) {
      const s = this.shapes[this._cand[i]];
      // sample the shape's surface directly above/below the probe point
      closestOnShape(s, x, yTop + 4, z, _cp);
      const dx = _cp.x - x, dz = _cp.z - z;
      if (dx * dx + dz * dz > 0.09) continue;             // not actually overhead
      const top = _cp.y;
      if (top > best && top <= yTop + 0.001 && top >= yBottom - 0.001) {
        best = top;
        this.probeSurface = s.surface;
        if (outNormal) {
          // finite-difference the shape surface for a proper normal
          closestOnShape(s, x + 0.12, top + 2, z, _su0);
          closestOnShape(s, x, top + 2, z + 0.12, _su1);
          _su0.sub(_cp); _su1.sub(_cp);
          outNormal.crossVectors(_su1, _su0).normalize();
          if (outNormal.y < 0) outNormal.negate();
          if (!Number.isFinite(outNormal.y) || outNormal.y < 0.2) outNormal.set(0, 1, 0);
        }
      }
    }
    return best;
  }

  // ── swept move ────────────────────────────────────────────────────────────
  /**
   * Advance a capsule by `delta`, sub-stepped so we can never tunnel, with
   * depenetration + sliding at every step. `vel` is projected along contacts.
   */
  slide(pos, delta, radius, height, vel, res) {
    const len = delta.length();
    const maxStep = radius * 0.45;
    const steps = Math.max(1, Math.min(24, Math.ceil(len / maxStep)));
    const inv = 1 / steps;
    _t0.copy(delta).multiplyScalar(inv);
    for (let i = 0; i < steps; i++) {
      pos.add(_t0);
      this.depenetrate(pos, radius, height, vel, res, 4);
    }
    // terrain floor — after the shape pass so a bridge over a valley still wins
    const g = this.sampleGround(pos.x, pos.z);
    if (pos.y < g) {
      const gn = this._gn;
      pos.y = g;
      if (gn.y >= this.groundCos) {
        if (!res.grounded || g >= res.groundY) {
          res.grounded = true; res.groundNormal.copy(gn); res.groundY = g;
          res.groundSurface = this.surfaceAt(pos.x, pos.z, gn.y);
          res.groundSlippery = 0;
        }
        if (vel && vel.y < 0) { res.impact = Math.max(res.impact, -vel.y); vel.y = 0; }
      } else if (vel) {
        const dot = vel.dot(gn);
        if (dot < 0) vel.addScaledVector(gn, -dot);
        res.hitWall = true; res.wallNormal.copy(gn);
      }
    }
  }

  /**
   * Full character move with step-up. Tries the direct slide; if it was blocked
   * while grounded, retries lifted by `stepHeight` and drops back down, keeping
   * whichever attempt travelled further.
   */
  move(pos, delta, radius, height, vel, res, allowStep) {
    res.reset();
    this.refresh();

    _t1.copy(pos);                            // start
    _t2.copy(vel);                            // start velocity
    const wantX = delta.x, wantZ = delta.z;
    const wantLen = Math.sqrt(wantX * wantX + wantZ * wantZ);

    this.slide(pos, delta, radius, height, vel, res);

    if (allowStep && wantLen > 1e-4 && res.hitWall) {
      const gotX = pos.x - _t1.x, gotZ = pos.z - _t1.z;
      const got = Math.sqrt(gotX * gotX + gotZ * gotZ);
      if (got < wantLen * 0.92) {
        // Remember the blocked attempt, then look for a tread to climb.
        _t3.copy(pos);
        const v1x = vel.x, v1y = vel.y, v1z = vel.z;

        // Sweeping a capsule downward onto a ledge catches its bottom sphere on
        // the edge and pushes it back out, so instead probe the surface just
        // ahead and lift the capsule straight onto it before re-running the move.
        const inv = 1 / wantLen;
        const px = _t1.x + wantX * inv * (radius + 0.16);
        const pz = _t1.z + wantZ * inv * (radius + 0.16);
        const top = this.surfaceUnder(px, pz, _t1.y + this.stepHeight, _t1.y + 0.025, _stepN);
        let took = false;
        if (Number.isFinite(top) && top > _t1.y + 0.02 && _stepN.y >= this.groundCos) {
          pos.set(_t1.x, top + 0.03, _t1.z);
          if (this.capsuleFree(pos, radius, height, 0.05)) {
            // Restore the velocity we arrived with, not the one the wall ate —
            // otherwise every step-up bleeds the speed that carries us onto the
            // tread and the character stalls against the riser.
            vel.copy(_t2);
            if (vel.y < 0) vel.y = 0;
            const res2 = _stepRes; res2.reset();
            _t0.set(delta.x, 0, delta.z);
            this.slide(pos, _t0, radius, height, vel, res2);
            const nx = pos.x - _t1.x, nz = pos.z - _t1.z;
            void v1x; void v1y; void v1z;
            if (Math.sqrt(nx * nx + nz * nz) > got + 0.002) {
              took = true;
              res.grounded = true;
              res.groundNormal.copy(res2.grounded ? res2.groundNormal : _stepN);
              res.groundY = pos.y;
              res.groundSurface = res2.grounded ? res2.groundSurface : this.probeSurface;
              res.hitWall = res2.hitWall;
              res.wallNormal.copy(res2.wallNormal);
              res.stepped = pos.y - _t1.y;
              if (vel.y < 0) vel.y = 0;
            }
          }
        }
        if (!took) { pos.copy(_t3); vel.set(v1x, v1y, v1z); }
      }
    }
    this.stats.contacts = res.contacts;
    return res;
  }

  /**
   * Snap to the floor when walking off a small lip so we don't pop airborne on
   * every terrain ripple. Returns true if it stuck.
   */
  snapDown(pos, radius, height, maxDrop, res) {
    const startY = pos.y;
    _t0.set(0, -maxDrop, 0);
    const probe = _snapRes; probe.reset();
    _t1.copy(pos);
    this.slide(pos, _t0, radius, height, null, probe);
    if (probe.grounded && startY - pos.y <= maxDrop + 0.01) {
      res.grounded = true;
      res.groundNormal.copy(probe.groundNormal);
      res.groundY = probe.groundY;
      res.groundSurface = probe.groundSurface;
      return true;
    }
    pos.copy(_t1);
    return false;
  }

  /** Coarse ray march used for camera DOF focus. Returns hit distance or maxDist. */
  rayDistance(origin, dir, maxDist = 220, steps = 26) {
    this.refresh();
    let prev = 0;
    for (let i = 1; i <= steps; i++) {
      const t = maxDist * (i / steps) * (i / steps);   // quadratic — dense up close
      _t0.copy(dir).multiplyScalar(t).add(origin);
      if (_t0.y <= this.heightAt(_t0.x, _t0.z)) return this._refine(origin, dir, prev, t, 6);
      const n = this.query(_t0.x - 0.01, _t0.y - 0.01, _t0.z - 0.01, _t0.x + 0.01, _t0.y + 0.01, _t0.z + 0.01);
      for (let k = 0; k < n; k++) {
        const s = this.shapes[this._cand[k]];
        if (closestOnShape(s, _t0.x, _t0.y, _t0.z, _cp) > 0) return this._refine(origin, dir, prev, t, 6);
      }
      prev = t;
    }
    return maxDist;
  }
  _refine(origin, dir, lo, hi, iter) {
    for (let i = 0; i < iter; i++) {
      const mid = (lo + hi) * 0.5;
      _t0.copy(dir).multiplyScalar(mid).add(origin);
      let hit = _t0.y <= this.heightAt(_t0.x, _t0.z);
      if (!hit) {
        const n = this.query(_t0.x - 0.01, _t0.y - 0.01, _t0.z - 0.01, _t0.x + 0.01, _t0.y + 0.01, _t0.z + 0.01);
        for (let k = 0; k < n; k++) {
          if (closestOnShape(this.shapes[this._cand[k]], _t0.x, _t0.y, _t0.z, _cp) > 0) { hit = true; break; }
        }
      }
      if (hit) hi = mid; else lo = mid;
    }
    return hi;
  }

  dispose() { this.shapes.length = 0; this.big.length = 0; this.cells.clear(); }
}

const _stepRes = new MoveResult();
const _stepN = new THREE.Vector3(0, 1, 0);
const _snapRes = new MoveResult();
