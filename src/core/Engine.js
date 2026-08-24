import * as THREE from 'three';
import { cfg } from './Config.js';

// Fixed-timestep simulation with interpolated rendering.
export class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.systems = [];
    this.fixedDt = 1 / 120;
    this.acc = 0;
    this.maxSub = 8;
    this.time = 0;
    this.frame = 0;
    this.clock = new THREE.Clock();
    this.running = false;
    this.stats = { fps: 0, ms: 0, _acc: 0, _n: 0 };
    this._raf = null;
  }
  add(system) { if (system) this.systems.push(system); return system; }
  start() { if (this.running) return; this.running = true; this.clock.start(); this._loop(); }
  stop() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); }

  _loop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const t0 = performance.now();
    let dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    this.frame++;

    // Fixed-step physics/gameplay
    this.acc += dt;
    let steps = 0;
    while (this.acc >= this.fixedDt && steps < this.maxSub) {
      for (const s of this.systems) s.fixedUpdate?.(this.fixedDt);
      this.acc -= this.fixedDt;
      steps++;
    }
    if (steps === this.maxSub) this.acc = 0;

    // Variable-step update (animation, VFX, camera, UI)
    for (const s of this.systems) s.update?.(dt, this.time);

    // Render last
    this.ctx.postfx ? this.ctx.postfx.render(dt) : this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    for (const s of this.systems) s.lateUpdate?.(dt);
    this.ctx.input?.endFrame();

    const ms = performance.now() - t0;
    this.stats._acc += ms; this.stats._n++;
    if (this.stats._n >= 20) { this.stats.ms = this.stats._acc / this.stats._n; this.stats.fps = 1000 / Math.max(this.stats.ms, 0.001); this.stats._acc = 0; this.stats._n = 0; }
  };

  // Render exactly n frames synchronously-ish (used by capture warmup).
  async warm(n = 20) {
    for (let i = 0; i < n; i++) {
      for (const s of this.systems) s.update?.(1 / 60, this.time + i / 60);
      this.ctx.postfx ? this.ctx.postfx.render(1 / 60) : this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
}
