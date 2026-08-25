import * as THREE from 'three';
import { MoveResult } from './Collision.js';

/**
 * BORDERLINE 4 — movement controller.
 *
 * Source-style acceleration/friction with air control, plus the modern shooter
 * traversal kit: coyote time, jump buffering, variable jump height, sprint,
 * crouch, momentum-preserving slide, ledge mantle/vault, and a dash.
 *
 * Physics runs on the engine's fixed 120 Hz step (`step`), input edges are
 * latched at frame rate (`sample`) so a keypress is never consumed twice.
 */

const _wish = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _norm = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export const TUNE = {
  radius: 0.38,
  standHeight: 1.84,
  crouchHeight: 1.15,
  standEye: 1.66,
  crouchEye: 0.92,
  slideEye: 0.78,

  walk: 5.3,
  run: 8.6,
  crouchSpeed: 2.9,
  adsScale: 0.62,
  backScale: 0.82,
  strafeScale: 0.92,

  accel: 14,               // × wishspeed per second (Source-style)
  airAccel: 9,
  airWishCap: 1.5,         // classic air-strafe cap
  airSteer: 2.4,
  friction: 8.2,
  stopSpeed: 1.9,
  slideFriction: 0.9,
  slideSteer: 3.4,

  gravity: 24.5,
  terminal: 58,
  jumpVel: 8.35,
  jumpCut: 0.42,           // vy multiplier when the key is released early
  coyote: 0.13,
  jumpBuffer: 0.16,
  airJumps: 0,

  slideEnterSpeed: 5.6,
  slideBoost: 1.9,
  slideMax: 14.5,
  slideExitSpeed: 3.9,
  slideMaxTime: 1.5,
  slideCooldown: 0.32,
  slideGravityPull: 0.85,

  dashSpeed: 17.5,
  dashTime: 0.17,
  dashCooldown: 1.9,
  dashAir: 1,

  mantleReach: 0.62,
  mantleMin: 0.55,
  mantleMax: 2.25,
  mantleTimeBase: 0.26,

  stepHeight: 0.55,
  snapDown: 0.52,
};

export class Controller {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.collision = player.collision;
    this.rig = null;                       // set by Player

    this.feet = new THREE.Vector3(player.position.x, player.position.y - TUNE.standEye, player.position.z);
    this.velocity = player.velocity;
    this.res = new MoveResult();

    // ── latched intent
    this.wishX = 0; this.wishY = 0;
    this.jumpHeld = false; this.jumpBuffer = 0;
    this.sprintHeld = false; this.crouchHeld = false;
    this.dashBuffer = 0;
    this.lookDx = 0; this.lookDy = 0;

    // ── state
    this.grounded = false;
    this.airTime = 0;
    this.coyote = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.surface = 'sand';
    this.height = TUNE.standHeight;
    this.eyeHeight = TUNE.standEye;
    this.eyeVel = 0;
    this.crouching = false;
    this.sprinting = false;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCd = 0;
    this.slideDir = 0;
    this.dashing = 0;
    this.dashCd = 0;
    this.airDashes = 0;
    this.mantle = null;
    this.mantleT = 0;
    this.jumpedAt = -1;
    this.time = 0;
    this.lastVy = 0;
    this.distance = 0;

    // shared with the camera rig — one object, never reallocated
    this.state = {
      grounded: false, sprinting: false, crouching: false, sliding: false,
      dashing: false, mantling: false, slideDir: 0, surface: 'sand',
      eyeHeight: TUNE.standEye, runSpeed: TUNE.run, lookDx: 0, lookDy: 0,
      speed: 0, airTime: 0,
    };
  }

  /** Feet position derived from the (authoritative) eye position. */
  syncFromEye() {
    this.feet.set(this.player.position.x, this.player.position.y - this.eyeHeight, this.player.position.z);
  }
  writeEye() {
    this.player.position.set(this.feet.x, this.feet.y + this.eyeHeight, this.feet.z);
  }

  // ── frame-rate input latch ────────────────────────────────────────────────
  sample(dt) {
    const input = this.ctx.input;
    this.lookDx = 0; this.lookDy = 0;
    if (!input || !input.enabled) { this.wishX = 0; this.wishY = 0; return; }

    let x = 0, y = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) y += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) y -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) x += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) x -= 1;
    this.wishX = x; this.wishY = y;

    const jumpDown = input.down('Space');
    if (input.hit('Space')) this.jumpBuffer = TUNE.jumpBuffer;
    this.jumpHeld = jumpDown;

    this.sprintHeld = input.down('ShiftLeft') || input.down('ShiftRight');
    this.crouchHeld = input.down('ControlLeft') || input.down('KeyC') || input.down('ControlRight');
    if (input.hit('KeyQ')) this.dashBuffer = 0.2;
  }

  /** Mouse-look deltas are handed in by Player so the rig can use them for whip-lean. */
  reportLook(dx, dy) { this.lookDx += dx; this.lookDy += dy; }

  // ── fixed-step simulation ─────────────────────────────────────────────────
  step(dt) {
    const T = TUNE;
    this.time += dt;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.dashBuffer = Math.max(0, this.dashBuffer - dt);
    this.slideCd = Math.max(0, this.slideCd - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);

    if (this.mantle) { this._stepMantle(dt); return; }

    const v = this.velocity;
    const wasGrounded = this.grounded;
    this.lastVy = v.y;

    // ── wish direction in world space, flattened onto the ground plane
    const p = this.player;
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    let wx = this.wishX * T.strafeScale;
    let wy = this.wishY * (this.wishY < 0 ? T.backScale : 1);
    _wish.set(-sy * wy + cy * wx, 0, -cy * wy - sy * wx);
    const wishLen = _wish.length();
    if (wishLen > 1e-4) _wish.multiplyScalar(1 / wishLen);
    const moving = wishLen > 0.05;

    // ── state machine
    this._updateSprint(moving);
    this._updateStance(dt, moving);
    this._updateDash(dt, moving);

    // ── speed target
    let wishSpeed = this.crouching ? T.crouchSpeed : this.sprinting ? T.run : T.walk;
    if (p.ads) wishSpeed *= T.adsScale;
    wishSpeed *= Math.min(1, wishLen);
    if (this.sliding) wishSpeed = 0;

    if (this.grounded && !this.sliding) {
      // project the wish direction onto the slope so hills feel solid
      if (this.groundNormal.y < 0.999 && moving) {
        const d = _wish.dot(this.groundNormal);
        _wish.addScaledVector(this.groundNormal, -d).normalize();
      }
      this._friction(dt, T.friction, T.stopSpeed);
      this._accelerate(_wish, wishSpeed, T.accel, dt);
    } else if (this.sliding) {
      this._slidePhysics(dt, _wish, moving);
    } else {
      this._airMove(dt, _wish, moving, wishSpeed);
    }

    // ── gravity
    if (!this.dashing) {
      v.y -= T.gravity * dt;
      if (v.y < -T.terminal) v.y = -T.terminal;
    }

    // ── jump / mantle
    if (this.jumpBuffer > 0) {
      if (this._tryMantle()) { this.jumpBuffer = 0; return; }
      if (this.grounded || this.coyote > 0) this._doJump();
    }
    if (!this.jumpHeld && v.y > 0 && this.time - this.jumpedAt < 0.42 && this.jumpedAt >= 0) {
      v.y *= Math.pow(T.jumpCut, dt * 60);      // frame-rate independent cut
    }

    // ── integrate + collide
    _delta.copy(v).multiplyScalar(dt);
    this.collision.move(this.feet, _delta, T.radius, this.height, v, this.res, !this.sliding);

    // ── ground bookkeeping
    let grounded = this.res.grounded;
    if (!grounded && wasGrounded && v.y <= 0.8 && this.time - this.jumpedAt > 0.12) {
      if (this.collision.snapDown(this.feet, T.radius, this.height, TUNE.snapDown, this.res)) {
        grounded = true;
        if (v.y < 0) v.y = 0;
      }
    }

    if (grounded) {
      this.groundNormal.copy(this.res.groundNormal);
      this.surface = this.res.groundSurface || 'sand';
      this.coyote = TUNE.coyote;
      this.airTime = 0;
      this.airDashes = 0;
      // steep slope: slide down instead of standing
      if (this.groundNormal.y < 0.62) {
        _tmp.copy(this.groundNormal); _tmp.y = 0;
        const l = _tmp.length();
        if (l > 1e-4) v.addScaledVector(_tmp.multiplyScalar(1 / l), TUNE.gravity * 0.55 * dt);
      }
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      this.groundNormal.set(0, 1, 0);
    }

    if (!wasGrounded && grounded) this._onLand();
    if (wasGrounded && !grounded && this.sliding) this.slideTime = Math.min(this.slideTime, TUNE.slideMaxTime - 0.25);
    this.grounded = grounded;

    // ── eye height (spring, so crouch/slide has weight)
    this._settleEye(dt);
    this.writeEye();
    this.distance += Math.sqrt(v.x * v.x + v.z * v.z) * dt;
    this._publish();
  }

  // ── movement primitives ───────────────────────────────────────────────────
  _friction(dt, friction, stopSpeed) {
    const v = this.velocity;
    const speed = Math.sqrt(v.x * v.x + v.z * v.z);
    if (speed < 1e-4) { v.x = 0; v.z = 0; return; }
    const control = speed < stopSpeed ? stopSpeed : speed;
    let drop = control * friction * dt;
    if (this.res.groundSlippery) drop *= 0.25;
    const scale = Math.max(0, speed - drop) / speed;
    v.x *= scale; v.z *= scale;
  }

  _accelerate(dir, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const v = this.velocity;
    const current = v.x * dir.x + v.y * dir.y + v.z * dir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    let a = accel * wishSpeed * dt;
    if (a > add) a = add;
    v.addScaledVector(dir, a);
  }

  _airMove(dt, dir, moving, wishSpeed) {
    if (!moving) return;
    const T = TUNE, v = this.velocity;
    // classic capped air acceleration — enables strafe-jumping
    this._accelerate(dir, Math.min(wishSpeed, T.airWishCap), T.airAccel, dt);
    // plus gentle steering so casual air movement feels modern, without adding speed
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.2) {
      const k = Math.min(1, T.airSteer * dt);
      const tx = dir.x * hs, tz = dir.z * hs;
      v.x += (tx - v.x) * k * 0.35;
      v.z += (tz - v.z) * k * 0.35;
      const ns = Math.sqrt(v.x * v.x + v.z * v.z);
      if (ns > hs) { const s = hs / ns; v.x *= s; v.z *= s; }
    }
  }

  _slidePhysics(dt, dir, moving) {
    const T = TUNE, v = this.velocity;
    this.slideTime += dt;
    if (this.grounded) {
      // downhill acceleration — slides carry you off ridges
      _tmp.copy(this.groundNormal);
      const slope = 1 - _tmp.y;
      if (slope > 0.002) {
        _tmp2.set(_tmp.x, 0, _tmp.z);
        const l = _tmp2.length();
        if (l > 1e-4) {
          _tmp2.multiplyScalar(1 / l);
          const along = v.x * _tmp2.x + v.z * _tmp2.z;
          const pull = T.gravity * slope * T.slideGravityPull * dt;
          v.x += _tmp2.x * pull; v.z += _tmp2.z * pull;
          if (along < 0) { v.x *= 1 - dt * 1.4; v.z *= 1 - dt * 1.4; }   // uphill bleeds
        }
      }
      this._friction(dt, T.slideFriction, 0.6);
      if (moving) {
        // steering only — never accelerates the slide
        const hs = Math.sqrt(v.x * v.x + v.z * v.z);
        const k = Math.min(1, T.slideSteer * dt) * 0.25;
        v.x += (dir.x * hs - v.x) * k;
        v.z += (dir.z * hs - v.z) * k;
        const ns = Math.sqrt(v.x * v.x + v.z * v.z);
        if (ns > hs && ns > 1e-4) { const s = hs / ns; v.x *= s; v.z *= s; }
      }
    }
    const speed = Math.sqrt(v.x * v.x + v.z * v.z);
    this.slideDir = this.wishX !== 0 ? -Math.sign(this.wishX) : 0;
    if (speed < T.slideExitSpeed || this.slideTime > T.slideMaxTime || !this.crouchHeld) this._endSlide();
  }

  // ── stance ────────────────────────────────────────────────────────────────
  _updateSprint(moving) {
    const canSprint = moving && this.wishY > 0 && !this.player.ads && !this.crouching && !this.sliding;
    this.sprinting = this.sprintHeld && canSprint && (this.grounded || this.sprinting);
  }

  _updateStance(dt, moving) {
    const T = TUNE;
    const v = this.velocity;
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);

    if (this.crouchHeld && !this.crouching && !this.sliding) {
      if (this.grounded && hs > T.slideEnterSpeed && this.slideCd <= 0) this._startSlide(hs);
      else this._setCrouch(true);
    } else if (!this.crouchHeld && (this.crouching || this.sliding)) {
      if (this.sliding) this._endSlide();
      else this._setCrouch(false);
    }
    // blocked overhead: stay down
    if (!this.crouchHeld && this.crouching && !this._canStand()) this._setCrouch(true);
  }

  _canStand() {
    _tmp.copy(this.feet);
    return this.collision.capsuleFree(_tmp, TUNE.radius, TUNE.standHeight, 0.05);
  }

  _setCrouch(on) {
    if (on === this.crouching && !this.sliding) return;
    if (on) { this.crouching = true; this.height = TUNE.crouchHeight; }
    else {
      if (!this._canStand()) { this.crouching = true; this.height = TUNE.crouchHeight; return; }
      this.crouching = false; this.height = TUNE.standHeight;
    }
    this.sliding = false;
  }

  _startSlide(speed) {
    const T = TUNE, v = this.velocity;
    this.sliding = true; this.crouching = true;
    this.height = T.crouchHeight;
    this.slideTime = 0;
    this.sprinting = false;
    const boosted = Math.min(T.slideMax, speed + T.slideBoost);
    const s = boosted / Math.max(speed, 1e-4);
    v.x *= s; v.z *= s;
    this.rig?.slideStart();
    this.ctx.events?.emit('slide', { position: this.player.position, speed: boosted });
  }

  _endSlide() {
    if (!this.sliding) return;
    this.sliding = false;
    this.slideCd = TUNE.slideCooldown;
    if (!this.crouchHeld && this._canStand()) { this.crouching = false; this.height = TUNE.standHeight; }
  }

  _updateDash(dt, moving) {
    const T = TUNE;
    if (this.dashing > 0) {
      this.dashing -= dt;
      if (this.dashing <= 0) {
        this.dashing = 0;
        const v = this.velocity;
        const hs = Math.sqrt(v.x * v.x + v.z * v.z);
        const cap = this.sprinting ? T.run * 1.15 : T.walk * 1.3;
        if (hs > cap) { const s = (cap + (hs - cap) * 0.35) / hs; v.x *= s; v.z *= s; }
      }
      return;
    }
    if (this.dashBuffer <= 0 || this.dashCd > 0) return;
    if (!this.grounded && this.airDashes >= T.dashAir) return;
    this.dashBuffer = 0;
    this.dashCd = T.dashCooldown;
    this.dashing = T.dashTime;
    if (!this.grounded) this.airDashes++;
    const p = this.player;
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    if (moving) _tmp.set(_wish.x, 0, _wish.z);
    else _tmp.set(-sy, 0, -cy);
    _tmp.normalize();
    const v = this.velocity;
    v.x = _tmp.x * T.dashSpeed;
    v.z = _tmp.z * T.dashSpeed;
    if (v.y < 0) v.y *= 0.25;
    this._endSlide();
    this.rig?.dash();
    this.ctx.events?.emit('dash', { position: this.player.position, dir: _tmp });
  }

  _doJump() {
    const T = TUNE, v = this.velocity;
    if (this.crouching && !this.sliding && !this._canStand()) return;
    const wasSliding = this.sliding;
    if (wasSliding) {
      // slide-hop: keep every bit of momentum
      this.sliding = false; this.slideCd = T.slideCooldown * 0.5;
      if (this._canStand()) { this.crouching = false; this.height = T.standHeight; }
    } else if (this.crouching) {
      this.crouching = false; this.height = T.standHeight;
    }
    v.y = T.jumpVel * (wasSliding ? 0.92 : 1);
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpedAt = this.time;
    this.feet.y += 0.02;
    this.rig?.jump();
    this.ctx.events?.emit('jump', { position: this.player.position, surface: this.surface });
    this.ctx.events?.emit('footstep', { surface: this.surface, speed: 0, loud: 0.5, foot: 'jump', position: this.player.position });
  }

  _onLand() {
    const impact = Math.max(0, -this.lastVy);
    this.rig?.land(impact);
    if (impact > 1.2) {
      this.ctx.events?.emit('land', { position: this.player.position, impact, surface: this.surface });
      this.ctx.events?.emit('footstep', { surface: this.surface, speed: impact, loud: Math.min(1, 0.5 + impact / 14), foot: 'land', position: this.player.position });
    }
    // fall damage above ~13 m/s
    if (impact > 13.5) {
      this.player.takeDamage((impact - 13.5) * 5.5, { type: 'fall', shieldPierce: true });
    }
    this.airDashes = 0;
  }

  // ── mantle / vault ────────────────────────────────────────────────────────
  _tryMantle() {
    const T = TUNE;
    const p = this.player;
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    // only vault when actually heading at the wall
    const facing = this.wishY > 0 || (this.grounded === false && this.velocity.lengthSq() > 1);
    if (!facing) return false;

    const fx = -sy, fz = -cy;
    const reach = T.radius + T.mantleReach;
    _probe.set(this.feet.x + fx * reach, this.feet.y, this.feet.z + fz * reach);
    const top = this.collision.surfaceUnder(
      _probe.x, _probe.z,
      this.feet.y + T.mantleMax,
      this.feet.y + T.mantleMin,
      _norm,
    );
    if (!Number.isFinite(top) || top === -Infinity) return false;
    if (_norm.y < 0.6) return false;                       // ledge must be standable
    const rise = top - this.feet.y;
    if (rise < T.mantleMin || rise > T.mantleMax) return false;

    // is there actually something to climb, or just empty air?
    _tmp.set(this.feet.x + fx * (T.radius * 0.6), this.feet.y + 0.25, this.feet.z + fz * (T.radius * 0.6));
    const blocked = !this.collision.capsuleFree(_tmp, T.radius, Math.min(this.height, rise * 0.9 + 0.1), 0.02)
      || this.res.hitWall;
    if (!blocked && rise > 0.9) return false;

    // destination must fit a standing capsule
    _tmp.set(this.feet.x + fx * (reach + 0.18), top + 0.03, this.feet.z + fz * (reach + 0.18));
    if (!this.collision.capsuleFree(_tmp, T.radius, T.standHeight, 0.06)) return false;

    this.mantle = {
      sx: this.feet.x, sy: this.feet.y, sz: this.feet.z,
      ex: _tmp.x, ey: _tmp.y, ez: _tmp.z,
      dur: T.mantleTimeBase + rise * 0.085,
    };
    this.mantleT = 0;
    this.sliding = false;
    this.crouching = false;
    this.height = T.standHeight;
    this.velocity.set(0, 0, 0);
    this.rig?.mantle(rise);
    this.ctx.events?.emit('mantle', { position: this.player.position, height: rise, surface: this.collision.probeSurface });
    return true;
  }

  _stepMantle(dt) {
    const m = this.mantle;
    this.mantleT += dt;
    let t = Math.min(1, this.mantleT / m.dur);
    // pull up first, then step forward — reads as a real vault, not a slide
    const up = t < 0.62 ? t / 0.62 : 1;
    const fwd = t < 0.34 ? 0 : (t - 0.34) / 0.66;
    const eu = 1 - (1 - up) * (1 - up);                    // ease-out on the climb
    const ef = fwd * fwd * (3 - 2 * fwd);                  // smoothstep on the reach
    this.feet.y = m.sy + (m.ey - m.sy) * eu;
    this.feet.x = m.sx + (m.ex - m.sx) * ef;
    this.feet.z = m.sz + (m.ez - m.sz) * ef;
    this.grounded = false;
    this._settleEye(dt);
    this.writeEye();
    if (t >= 1) {
      this.mantle = null;
      this.grounded = true;
      this.coyote = TUNE.coyote;
      this.velocity.set(0, 0, 0);
      const p = this.player;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      this.velocity.set(-sy * 2.4, 0, -cy * 2.4);          // step off with a little pace
      this.ctx.events?.emit('footstep', { surface: this.surface, speed: 2, loud: 0.8, foot: 'mantle', position: p.position });
    }
    this._publish();
  }

  // ── output ────────────────────────────────────────────────────────────────
  _settleEye(dt) {
    const target = this.sliding ? TUNE.slideEye : this.crouching ? TUNE.crouchEye : TUNE.standEye;
    // critically damped, frame-rate independent
    const f = 16, k = f * f, c = 2 * f;
    let n = Math.max(1, Math.min(6, Math.ceil(dt * 4 * f)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.eyeVel += (-c * this.eyeVel - k * (this.eyeHeight - target)) * h;
      this.eyeHeight += this.eyeVel * h;
    }
    if (this.eyeHeight < 0.4) { this.eyeHeight = 0.4; this.eyeVel = 0; }
  }

  _publish() {
    const s = this.state, v = this.velocity;
    s.grounded = this.grounded;
    s.sprinting = this.sprinting;
    s.crouching = this.crouching;
    s.sliding = this.sliding;
    s.dashing = this.dashing > 0;
    s.mantling = !!this.mantle;
    s.slideDir = this.slideDir;
    s.surface = this.surface;
    s.eyeHeight = this.eyeHeight;
    s.runSpeed = TUNE.run;
    s.speed = Math.sqrt(v.x * v.x + v.z * v.z);
    s.airTime = this.airTime;
  }

  /** Push the accumulated look delta into the state the rig reads, then clear it. */
  flushLook() {
    this.state.lookDx = this.lookDx;
    this.state.lookDy = this.lookDy;
    this.lookDx = 0; this.lookDy = 0;
  }

  teleport(x, y, z) {
    this.feet.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.mantle = null; this.sliding = false; this.crouching = false;
    this.height = TUNE.standHeight;
    this.eyeHeight = TUNE.standEye; this.eyeVel = 0;
    this.writeEye();
    this._publish();
  }
}
