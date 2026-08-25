import * as THREE from 'three';
import { cfg } from '../core/Config.js';
import { Collision } from './Collision.js';
import { Controller, TUNE } from './Controller.js';
import { CameraRig } from './CameraRig.js';

/**
 * BORDERLINE 4 — the player.
 *
 * INTERFACE (do not change): new Player(ctx); player.update(dt); player.position; player.health
 *
 * `position` is the *eye* position — the same thing the capture protocol poses and
 * the camera reads. The physics capsule hangs below it; writing to `position`
 * from outside (as `src/capture.js` does) rebases the capsule on the next step.
 *
 * Composition:
 *   Collision   — capsule vs world.colliders + heightfield, swept, with step-up
 *   Controller  — Source-style movement, slide / dash / mantle, 120 Hz fixed step
 *   CameraRig   — spring-driven bob, dip, lean, recoil, trauma, FOV
 *
 * Exposed for the weapons / HUD / audio agents:
 *   applyRecoil(pitch, yaw, kick?)   addTrauma(t)   setAds(bool)   ads
 *   takeDamage(amount, opts)  heal(n)  addShield(n)  addImpulse(vec3)  teleport(x,y,z)
 *   getForward(out)  getEyePosition(out)  speed  grounded  sprinting  sliding
 *   health/maxHealth  shield/maxShield  level/xp
 *
 * Events emitted: footstep, jump, land, slide, dash, mantle,
 *                 playerDamage, shieldBreak, shieldRecharge, playerDeath, playerRespawn
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

export class Player {
  constructor(ctx) {
    this.ctx = ctx;

    // ── transform (position === eye, writable from outside)
    this.position = new THREE.Vector3(0, TUNE.standEye, 12);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.adsSensitivity = 0.62;

    // ── vitals
    this.maxHealth = 100; this.health = 100;
    this.maxShield = 140; this.shield = 140;
    this.shieldDelay = 3.2;         // seconds after damage before recharge starts
    this.shieldBreakDelay = 1.15;   // extra penalty when it pops
    this.shieldRate = 0.46;         // fraction of max per second
    this.healthRegenDelay = 9;
    this.healthRegenRate = 2.2;
    this.regenTimer = 0;
    this.alive = true;
    this.deadTime = 0;
    this.level = 21; this.xp = 0; this.xpToNext = 4200;

    // ── combat readouts
    this.ads = false;
    this.lastHitDir = new THREE.Vector3(0, 0, 1);
    this.invuln = 0;

    // ── subsystems
    this.collision = new Collision(ctx);
    this.controller = new Controller(ctx, this);
    this.rig = new CameraRig(ctx, this);
    this.controller.rig = this.rig;
    this.camera = ctx.camera;

    // ── capture mode: hard-freeze. The engine keeps running for a beat after
    //    __READY__, so any physics at all would drift the authored pose.
    this.frozen = !!ctx.captureRequest;
    this.rig.enabled = !this.frozen;

    // World publishes a spawn point (eye height above its terrain) — use it.
    const ws = ctx.world?.spawn;
    if (ws && typeof ws.x === 'number' && !ctx.captureRequest) this.position.copy(ws);
    this.spawn = this.position.clone();
    this._lastOut = this.position.clone();
    this.controller.syncFromEye();
    this.controller.writeEye();
    this._lastOut.copy(this.position);

    this._offDamage = ctx.events?.on('damage', (e) => {
      if (!e || e._applied) return;
      if (e.target === this || e.target === 'player' || e.target === ctx.player) {
        this.takeDamage(e.amount ?? 0, e);
      }
    });
    this._offExplosion = ctx.events?.on('explosion', (e) => {
      if (!e || !e.position) return;
      _v0.subVectors(this.position, e.position);
      const d = _v0.length();
      const r = e.radius ?? 4;
      if (d > r || d < 1e-4) return;
      const f = 1 - d / r;
      _v0.multiplyScalar(1 / d);
      this.addImpulse(_v0.multiplyScalar(f * (e.force ?? 9)));
      this.rig.addTrauma(f * 0.55);
    });
  }

  // ── external API ──────────────────────────────────────────────────────────
  /** Weapons agent may own ADS: the first external call hands control over. */
  setAds(on) { this._adsExternal = true; return this._applyAds(on); }
  _applyAds(on) { this.ads = !!on; this.rig.setAds(this.ads); return this.ads; }
  get isAds() { return this.ads; }
  applyRecoil(pitch = 0, yaw = 0, kick = 0) { this.rig.applyRecoil(pitch, yaw, kick); }
  addTrauma(t) { this.rig.addTrauma(t); }
  addImpulse(v) { this.velocity.add(v); if (v.y > 0.4) this.controller.grounded = false; }
  teleport(x, y, z) {
    this.controller.teleport(x, y - this.controller.eyeHeight, z);
    this._lastOut.copy(this.position);
  }

  getForward(out = _v1) {
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
  }
  getEyePosition(out = _v1) { return out.copy(this.position); }

  get speed() { const v = this.velocity; return Math.sqrt(v.x * v.x + v.z * v.z); }
  get grounded() { return this.controller.grounded; }
  get sprinting() { return this.controller.sprinting; }
  get sliding() { return this.controller.sliding; }
  get crouching() { return this.controller.crouching; }
  get surface() { return this.controller.surface; }
  get eyeHeight() { return this.controller.eyeHeight; }
  get hp() { return this.health; }

  addXp(n) {
    this.xp += n;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext; this.level++;
      this.xpToNext = Math.round(this.xpToNext * 1.13);
      this.ctx.events?.emit('levelUp', { level: this.level });
    }
  }

  heal(n) { this.health = Math.min(this.maxHealth, this.health + n); }
  addShield(n) { this.shield = Math.min(this.maxShield, this.shield + n); }

  /**
   * @param {number} amount
   * @param {{point?:THREE.Vector3, source?:any, element?:string, shieldPierce?:boolean, type?:string}} [opts]
   */
  takeDamage(amount, opts) {
    if (!this.alive || this.frozen || amount <= 0 || this.invuln > 0) return 0;
    const from = opts?.point || opts?.source?.position || null;
    let left = amount;

    if (!opts?.shieldPierce && this.shield > 0) {
      const absorbed = Math.min(this.shield, left);
      this.shield -= absorbed; left -= absorbed;
      if (this.shield <= 0.001) {
        this.shield = 0;
        this.regenTimer = this.shieldDelay + this.shieldBreakDelay;
        this.ctx.events?.emit('shieldBreak', { position: this.position, point: from });
        this.rig.addTrauma(0.45);
        this.ctx.postfx?.setHitFlash?.(0.85);
      }
    }
    if (left > 0) this.health = Math.max(0, this.health - left);
    this.regenTimer = Math.max(this.regenTimer, this.shieldDelay);

    this.rig.hitFrom(from, Math.min(0.9, amount / 45 + 0.12));
    this.ctx.postfx?.setHitFlash?.(Math.min(1, 0.28 + amount / 60));
    if (from) this.lastHitDir.subVectors(from, this.position).normalize();

    this.ctx.events?.emit('playerDamage', {
      target: this, amount, remaining: this.health, shield: this.shield,
      point: from, element: opts?.element, _applied: true,
    });

    if (this.health <= 0) this._die(opts);
    return amount;
  }

  _die(opts) {
    this.alive = false;
    this.deadTime = 0;
    this.health = 0;
    this.rig.addTrauma(0.9);
    this.ctx.events?.emit('playerDeath', { position: this.position, source: opts?.source });
  }

  respawn() {
    this.alive = true;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.regenTimer = 0;
    const s = this.spawn;
    this.teleport(s.x, s.y, s.z);
    this.rig.dip.set(0); this.rig.trauma = 0;
    this.ctx.events?.emit('playerRespawn', { position: this.position });
  }

  // ── simulation ────────────────────────────────────────────────────────────
  /** Physics. Fixed 120 Hz from the engine — never called during capture warmup. */
  fixedUpdate(dt) {
    if (this.frozen || !this.alive) return;
    // Somebody moved us from outside (capture pose, scripted teleport): rebase.
    if (!this.position.equals(this._lastOut)) this.controller.syncFromEye();
    this.controller.step(dt);
    this._lastOut.copy(this.position);
  }

  /** Look, camera, vitals. Safe to call with dt === 0 (capture poses this way). */
  update(dt = 0, time = 0) {
    const ctx = this.ctx;

    if (this.frozen) {
      // Deterministic posed frame: exactly the transform capture.js asked for.
      this.ads = !!ctx.forceAds;
      this._applyAds(this.ads);
      // Safety net only: if the world agent grows terrain under an authored
      // capture pose, lift the eye out of the rock rather than shooting a black
      // frame. Never lowers, never touches yaw/pitch.
      if (!this._poseChecked) {
        this._poseChecked = true;
        const g = this.collision.heightAt(this.position.x, this.position.z);
        if (Number.isFinite(g) && this.position.y < g + 0.9) {
          console.warn(`[player] capture pose was inside terrain (y=${this.position.y.toFixed(2)}, ground=${g.toFixed(2)}) — lifting`);
          this.position.y = g + 1.7;
        }
      }
      this.controller.syncFromEye();
      this.rig.update(0, this.controller.state);
      this._lastOut.copy(this.position);
      return;
    }

    // ── mouse look
    const input = ctx.input;
    let dx = 0, dy = 0;
    if (input && input.locked && input.enabled && this.alive) {
      const s = this.sensitivity * (this.ads ? this.adsSensitivity : 1);
      dx = input.mouse.dx * s;
      dy = input.mouse.dy * s;
      this.yaw -= dx;
      this.pitch -= dy;
      if (this.pitch > 1.5) this.pitch = 1.5; else if (this.pitch < -1.5) this.pitch = -1.5;
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }
    this.controller.reportLook(dx, dy);
    this.controller.flushLook();

    if (dt > 0) {
      this.controller.sample(dt);
      this._vitals(dt);
      this.invuln = Math.max(0, this.invuln - dt);
    }

    // aim-down-sights follows the right mouse button unless the weapons agent drives it
    if (input && input.enabled && this.alive && !this._adsExternal) {
      const want = !!input.mouse.right && !this.controller.sprinting && !this.controller.sliding;
      if (want !== this.ads) this._applyAds(want);
    }

    this.rig.lowHealth = this.alive
      ? Math.max(0, 1 - this.health / (this.maxHealth * 0.4)) * (this.shield > 0 ? 0.35 : 1)
      : 1;
    this.rig.update(dt, this.controller.state);
    this._lastOut.copy(this.position);

    if (!this.alive && dt > 0) {
      this.deadTime += dt;
      if (this.deadTime > 3.2) this.respawn();
    }
  }

  _vitals(dt) {
    if (!this.alive) return;
    if (this.regenTimer > 0) {
      this.regenTimer -= dt;
      if (this.regenTimer <= 0 && this.shield < this.maxShield) {
        this.ctx.events?.emit('shieldRecharge', { position: this.position });
      }
      return;
    }
    if (this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + this.maxShield * this.shieldRate * dt);
    } else if (this.health < this.maxHealth) {
      // slow out-of-combat trickle once the shield is topped off
      this.health = Math.min(this.maxHealth, this.health + this.healthRegenRate * dt);
    }
  }

  dispose() {
    this._offDamage?.();
    this._offExplosion?.();
    this.collision.dispose();
    this.rig.dispose();
  }
}
