import * as THREE from 'three';
import { cfg } from '../core/Config.js';

// INTERFACE: new Player(ctx); player.update(dt); player.position:Vector3; player.health
export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.position = new THREE.Vector3(0, 1.7, 12);
    this.velocity = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.health = 100; this.maxHealth = 100;
    this.shield = 100; this.maxShield = 100;
    this.speed = 6.4;
    this.ads = false;
  }
  update(dt) {
    const { input, camera } = this.ctx;
    if (input && input.locked) {
      this.yaw -= input.mouse.dx * 0.0022;
      this.pitch -= input.mouse.dy * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    }
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (input?.down('KeyW')) move.add(fwd);
    if (input?.down('KeyS')) move.sub(fwd);
    if (input?.down('KeyD')) move.add(right);
    if (input?.down('KeyA')) move.sub(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(this.speed * dt);
    this.position.add(move);
    camera.position.copy(this.position);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
  dispose() {}
}
