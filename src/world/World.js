import * as THREE from 'three';
import { cfg } from '../core/Config.js';

// INTERFACE (do not change): new World(ctx); world.build(); world.update(dt);
// world.heightAt(x,z) -> number ; world.raycastGround(origin,dir) -> hit|null
export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'World';
    ctx.scene.add(this.group);
    this.colliders = [];       // {type:'box'|'sphere', ...} consumed by Player/Physics
  }
  async build() {
    const { scene } = this.ctx;
    scene.background = new THREE.Color(0x9dc6d8);
    scene.fog = new THREE.FogExp2(0xb9d3dd, 0.0016);

    const hemi = new THREE.HemisphereLight(0xbfd9e8, 0x6b5636, 1.1);
    scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
    this.sun.position.set(120, 160, 90);
    this.sun.castShadow = cfg.shadows;
    this.sun.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
    const c = this.sun.shadow.camera;
    c.left = -120; c.right = 120; c.top = 120; c.bottom = -120; c.near = 1; c.far = 500;
    this.sun.shadow.bias = -0.0006;
    scene.add(this.sun, this.sun.target);

    const geo = new THREE.PlaneGeometry(cfg.terrain.size, cfg.terrain.size, 64, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb08a53, roughness: 0.95 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
  }
  heightAt() { return 0; }
  raycastGround() { return null; }
  update() {}
  dispose() { this.ctx.scene.remove(this.group); }
}
