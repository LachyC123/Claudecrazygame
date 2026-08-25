import * as THREE from 'three';
import { cfg } from '../core/Config.js';
import { installLightRig } from '../render/index.js';
import { Terrain, heightAt, normalAt, slopeAt, ARENA, CAMP, roadX } from './Terrain.js';
import { Rocks } from './Rocks.js';
import { Vegetation, WIND } from './Vegetation.js';
import { Structures } from './Structures.js';
import { Props } from './Props.js';

// INTERFACE (do not change): new World(ctx); world.build(); world.update(dt);
// world.heightAt(x,z) -> number ; world.raycastGround(origin,dir) -> hit|null
// world.colliders -> [{type:'box',center,half} | {type:'sphere',center,radius}]

const _rn = new THREE.Vector3();
const _rp = new THREE.Vector3();

export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'World';
    ctx.scene.add(this.group);
    this.colliders = [];
    this.spawn = new THREE.Vector3(ARENA.x, 0, ARENA.z);
    this.time = 0;
  }

  async build() {
    const { ctx } = this;
    ctx.scene.background = null;
    // dev: ?worldoff=grass,bush,tree,rocks,props,camp,terrain — isolate a layer's cost
    const off = new Set((new URLSearchParams(location.search).get('worldoff') || '')
      .split(',').map((s) => s.trim()).filter(Boolean));
    this.off = off;

    // One call installs sun + cascades + sky + IBL + aerial fog. Never make lights here.
    this.lighting = installLightRig(ctx, {
      timeOfDay: 0.72,
      shadowMapSize: 1024,
      shadowDistance: 260,
      shadowSplits: [0.035, 0.16, 1.0],
      fogScale: 0.92,
    });
    this.lighting.setStyle({ detailNear: 40, detailFar: 150 });
    this.lighting.sky?.setParams({ coverage: 0.53, cloudScale: 1.15, skyGain: 1.02 });

    if (!off.has('terrain')) {
      this.terrain = new Terrain(ctx);
      this.group.add(this.terrain.build());
    }
    if (!off.has('rocks')) {
      this.rocks = new Rocks(ctx, this);
      this.group.add(this.rocks.build());
    }
    if (!off.has('camp')) {
      this.structures = new Structures(ctx, this);
      this.group.add(this.structures.build());
    }
    if (!off.has('props')) {
      this.props = new Props(ctx, this);
      this.group.add(this.props.build());
    }
    this.vegetation = new Vegetation(ctx, this, off);
    this.group.add(this.vegetation.build());

    this.spawn.set(ARENA.x, heightAt(ARENA.x, ARENA.z) + 1.7, ARENA.z);

    // Focus the DOF on the midground so the establishing shot has real depth.
    ctx.postfx?.setDofFocus?.(70);
    return this;
  }

  /* --------------------------------------------------------------- query -- */

  heightAt(x, z) { return heightAt(x, z); }
  normalAt(x, z, out) { return normalAt(x, z, out); }
  slopeAt(x, z) { return slopeAt(x, z); }

  /** Ray-march the heightfield. Returns {point, normal, distance} or null. */
  raycastGround(origin, dir, maxDist = 400) {
    let t = 0;
    let prevGap = origin.y - heightAt(origin.x, origin.z);
    if (prevGap <= 0) {
      return { point: origin.clone(), normal: normalAt(origin.x, origin.z, new THREE.Vector3()), distance: 0 };
    }
    const step = Math.max(0.35, maxDist / 512);
    while (t < maxDist) {
      t += step * (1 + t * 0.02);
      _rp.copy(dir).multiplyScalar(t).add(origin);
      const gap = _rp.y - heightAt(_rp.x, _rp.z);
      if (gap <= 0) {
        // bisect for a clean hit
        let lo = t - step * (1 + t * 0.02), hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          _rp.copy(dir).multiplyScalar(mid).add(origin);
          if (_rp.y - heightAt(_rp.x, _rp.z) <= 0) hi = mid; else lo = mid;
        }
        _rp.copy(dir).multiplyScalar(hi).add(origin);
        return {
          point: _rp.clone(),
          normal: normalAt(_rp.x, _rp.z, new THREE.Vector3()).clone(),
          distance: hi,
        };
      }
      prevGap = gap;
    }
    return null;
  }

  /** Cheap sphere-vs-world resolve for the player/enemy controllers. */
  resolveSphere(pos, radius) {
    let hit = false;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (c.type === 'sphere') {
        _rn.copy(pos).sub(c.center);
        const d = _rn.length();
        const min = c.radius + radius;
        if (d < min && d > 1e-4) { _rn.multiplyScalar((min - d) / d); pos.add(_rn); hit = true; }
      } else {
        const dx = pos.x - c.center.x, dy = pos.y - c.center.y, dz = pos.z - c.center.z;
        const px = c.half.x + radius - Math.abs(dx);
        const py = c.half.y + radius - Math.abs(dy);
        const pz = c.half.z + radius - Math.abs(dz);
        if (px > 0 && py > 0 && pz > 0) {
          if (px < py && px < pz) pos.x += dx > 0 ? px : -px;
          else if (pz < py) pos.z += dz > 0 ? pz : -pz;
          else pos.y += dy > 0 ? py : -py;
          hit = true;
        }
      }
    }
    return hit;
  }

  get sunDirection() { return this.lighting?.sunDirection; }

  update(dt) {
    this.time += dt;
    this.vegetation?.update(dt);
    // slow breathing gust so the field never looks looped
    WIND.uWindAmp.value = 0.26 + 0.10 * Math.sin(this.time * 0.23) + 0.05 * Math.sin(this.time * 0.71);
  }

  dispose() {
    this.terrain?.dispose();
    this.rocks?.dispose();
    this.vegetation?.dispose();
    this.structures?.dispose();
    this.props?.dispose();
    this.ctx.scene.remove(this.group);
  }
}

export { heightAt, normalAt, slopeAt, roadX, ARENA, CAMP };
