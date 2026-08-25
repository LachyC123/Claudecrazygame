import * as THREE from 'three';
import { cfg } from '../core/Config.js';

/**
 * BORDERLINE 4 — first-person camera rig.
 *
 * Everything the camera does is driven by spring-dampers, never linear lerps:
 * landing dips overshoot and settle, recoil snaps out and recovers, strafe lean
 * has weight. The stride phase is the single source of truth for both head bob
 * and the `footstep` event, so audio, bob and the viewmodel are all in cadence.
 *
 * Public surface used by other agents (also mirrored on Player):
 *   rig.applyRecoil(pitch, yaw, kick?)   — weapons push recoil in
 *   rig.addTrauma(t)                     — 0..1 screenshake, decays
 *   rig.setAds(bool)
 *   rig.hitFrom(worldPos, amount)        — directional damage shake
 *   rig.bobPhase / rig.swayX / rig.swayY / rig.viewKick — viewmodel hooks
 */

// ── scratch ──────────────────────────────────────────────────────────────────
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _off = new THREE.Vector3();
const _v = new THREE.Vector3();
const DEG = Math.PI / 180;

/** Damped harmonic oscillator. `f` = angular frequency, `z` = damping ratio. */
export class Spring {
  constructor(f = 12, z = 1, x = 0) { this.f = f; this.z = z; this.x = x; this.v = 0; this.target = 0; }
  set(x) { this.x = x; this.v = 0; return this; }
  impulse(v) { this.v += v; return this; }
  nudge(dx) { this.x += dx; return this; }
  step(dt) {
    if (dt <= 0) return this.x;
    const d = dt > 0.05 ? 0.05 : dt;
    // keep 2·ζ·ω·h below ~0.5 for unconditional stability at any stiffness
    let n = Math.ceil(d * 4 * this.z * this.f);
    if (n < 1) n = 1; else if (n > 8) n = 8;
    const h = d / n;
    const k = this.f * this.f, c = 2 * this.z * this.f;
    for (let i = 0; i < n; i++) {
      this.v += (-c * this.v - k * (this.x - this.target)) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Smooth, cheap, deterministic pseudo-noise in [-1,1]. No allocation, no tables. */
function wobble(t, seed) {
  return (
    Math.sin(t * 1.113 + seed * 12.9898) * 0.55 +
    Math.sin(t * 2.317 + seed * 78.233) * 0.30 +
    Math.sin(t * 4.731 + seed * 43.771) * 0.15
  );
}

export class CameraRig {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.camera = ctx.camera;

    // ── view springs
    this.dip = new Spring(21, 0.52);        // vertical landing dip (metres)
    this.landPitch = new Spring(19, 0.55);  // pitch kick on landing (rad)
    this.roll = new Spring(11, 0.78);       // strafe / slide lean (rad)
    this.leanX = new Spring(13, 0.85);      // lateral body lean (metres)
    this.pitchTilt = new Spring(9, 0.9);    // sprint / slide pitch (rad)
    this.recoilP = new Spring(15, 0.42);    // recoil pitch (rad)
    this.recoilY = new Spring(14, 0.40);    // recoil yaw (rad)
    this.punch = new Spring(17, 0.5);       // FOV punch (deg)
    this.fov = new Spring(11, 1.0, cfg.fov);
    this.adsT = new Spring(13, 1.0);        // 0 hip .. 1 ads
    this.zOff = new Spring(14, 0.7);        // dolly (dash/slide push)

    // ── state
    this.stride = 0;                        // metres walked, drives bob phase
    this.bobPhase = 0;
    this.time = 0;
    this.trauma = 0;
    this.traumaDecay = 1.55;
    this.hitYaw = 0;                        // direction of the last hit, view-relative
    this.hitAmt = 0;
    this.ads = false;
    this.lowHealth = 0;
    this.footIndex = 0;
    this.aimPitchOffset = 0;                // recoil that permanently climbed the aim
    this.enabled = true;

    // ── viewmodel hooks (read by the weapons agent)
    this.swayX = 0; this.swayY = 0;
    this.viewKick = 0;
    this.bobOffset = new THREE.Vector3();
    this.velocityLocal = new THREE.Vector3();
    this.finalRoll = 0;
    this.shake = 0;
    this.focusDistance = 14;
    this._focusAcc = 0;

    // ── tuning
    this.tune = {
      bobAmp: 0.055,            // metres at full run
      bobLateral: 0.9,
      bobRollDeg: 0.85,
      strideWalk: 1.85,         // metres per full cycle (two steps)
      breathAmp: 0.0055,
      breathPitch: 0.0016,
      leanDeg: 3.1,
      sprintPitchDeg: 1.15,
      sprintFov: 7.5,
      speedFov: 3.2,
      dashFov: 12,
      slideFov: 5,
      slideRollDeg: 4.2,
      adsBobScale: 0.22,
      adsSwayScale: 0.28,
      traumaPitch: 0.055,
      traumaYaw: 0.06,
      traumaRoll: 0.09,
      traumaPos: 0.055,
      recoilAimTransfer: 0.30,  // fraction of recoil that actually climbs the aim
    };
  }

  // ── external API ──────────────────────────────────────────────────────────
  setAds(on) { this.ads = !!on; this.adsT.target = this.ads ? 1 : 0; }

  /** Weapons agent: push recoil into the view. pitch/yaw in radians. */
  applyRecoil(pitch = 0, yaw = 0, kick = 0) {
    this.recoilP.x += pitch * 0.55;
    this.recoilP.v += pitch * 16;
    this.recoilY.x += yaw * 0.55;
    this.recoilY.v += yaw * 15;
    this.punch.v += (kick || Math.abs(pitch) * 26);
    this.viewKick = Math.min(1, this.viewKick + Math.abs(pitch) * 6 + 0.25);
    // real aim climb — part of the kick is never recovered
    const t = this.tune.recoilAimTransfer;
    this.aimPitchOffset += pitch * t;
    this.player.pitch += pitch * t;
    this.player.yaw += yaw * t;
    this.addTrauma(Math.min(0.26, Math.abs(pitch) * 5 + 0.03));
  }

  /** 0..1 screenshake. Accumulates, squared on application, decays over ~0.7s. */
  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }

  /** Directional damage shake — `from` is the world position of the attacker. */
  hitFrom(from, amount = 0.4) {
    if (from) {
      _v.subVectors(this.player.position, from);
      const a = Math.atan2(-_v.x, -_v.z);
      this.hitYaw = a - this.player.yaw;
    } else this.hitYaw = 0;
    this.hitAmt = Math.min(1.2, this.hitAmt + amount);
    this.addTrauma(0.28 + amount * 0.5);
    this.landPitch.v -= amount * 4.2 * Math.cos(this.hitYaw);
    this.roll.v += amount * 5.0 * Math.sin(this.hitYaw);
  }

  /** Landing impact, metres/sec of absorbed downward speed. */
  land(impactSpeed) {
    const s = Math.min(1.6, impactSpeed / 11);
    if (s < 0.05) return;
    this.dip.v -= s * 2.9;
    this.landPitch.v -= s * 1.9;
    this.roll.v += (this.footIndex & 1 ? 1 : -1) * s * 0.8;
    this.punch.v -= s * 24;
    this.addTrauma(s * 0.34);
  }

  jump() { this.dip.v += 0.55; this.punch.v += 4; }
  dash() { this.punch.v += this.tune.dashFov * 3.2; this.zOff.v -= 2.4; this.addTrauma(0.16); }
  slideStart() { this.dip.v -= 1.1; this.punch.v += this.tune.slideFov * 2.0; }
  mantle(height) { this.dip.v -= 0.9; this.landPitch.v += 0.8; this.roll.v += 0.9; this.punch.v += 6; }

  // ── per-frame ─────────────────────────────────────────────────────────────
  update(dt, state) {
    const cam = this.camera;
    const p = this.player;

    // Capture / posed mode: exact authored transform, zero procedural motion.
    if (!this.enabled || dt <= 0) {
      cam.position.copy(p.position);
      cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
      const targetFov = this.ads ? cfg.adsFov : cfg.fov;
      this.adsT.set(this.ads ? 1 : 0);
      this.fov.set(targetFov); this.fov.target = targetFov;
      if (Math.abs(cam.fov - targetFov) > 1e-3) { cam.fov = targetFov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
      this._pushPostFX(0, true);
      return;
    }

    this.time += dt;
    const T = this.tune;
    const st = state;

    // ── velocity in view space (x = strafe, z = forward)
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    _fwd.set(-sy, 0, -cy);
    _right.set(cy, 0, -sy);
    const vx = p.velocity.x, vz = p.velocity.z;
    const localX = vx * _right.x + vz * _right.z;
    const localZ = vx * _fwd.x + vz * _fwd.z;
    this.velocityLocal.set(localX, p.velocity.y, localZ);
    const hSpeed = Math.sqrt(vx * vx + vz * vz);
    const runSpeed = st.runSpeed || 8.4;
    const speedFrac = Math.min(1.35, hSpeed / runSpeed);

    // ── stride phase → head bob + footsteps
    const adsBlend = this.adsT.x;
    let bobScale = 1 - adsBlend * (1 - T.adsBobScale);
    if (st.crouching) bobScale *= 0.55;
    if (st.sliding) bobScale = 0;

    if (st.grounded && !st.sliding && hSpeed > 0.35) {
      const strideLen = T.strideWalk * (st.sprinting ? 1.28 : st.crouching ? 0.72 : 1.0);
      const prev = this.bobPhase;
      this.bobPhase += (hSpeed / strideLen) * Math.PI * dt * 2;
      // a footfall every half cycle
      const prevStep = Math.floor(prev / Math.PI);
      const nowStep = Math.floor(this.bobPhase / Math.PI);
      if (nowStep !== prevStep) {
        this.footIndex++;
        this._footstep(st, hSpeed);
      }
      if (this.bobPhase > Math.PI * 1e4) this.bobPhase -= Math.PI * 1e4;
    } else {
      // ease the phase back to a foot-down pose instead of freezing mid-stride
      const target = Math.ceil(this.bobPhase / Math.PI) * Math.PI;
      this.bobPhase += (target - this.bobPhase) * Math.min(1, dt * 6);
    }

    const amp = T.bobAmp * Math.min(1, speedFrac) * bobScale;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * amp;
    const bobX = Math.sin(this.bobPhase * 0.5) * amp * T.bobLateral;
    const bobRoll = Math.sin(this.bobPhase * 0.5 + 0.6) * T.bobRollDeg * DEG * bobScale * Math.min(1, speedFrac);

    // ── breathing idle sway (fades out as you move, swells at low health)
    const idle = 1 - Math.min(1, hSpeed / 2.2);
    const breathe = idle * (1 + this.lowHealth * 1.9) * (1 - adsBlend * 0.45);
    const breathY = Math.sin(this.time * 1.35) * T.breathAmp * breathe;
    const breathPitch = Math.sin(this.time * 0.83) * T.breathPitch * breathe;
    const breathYaw = Math.sin(this.time * 0.61 + 1.7) * T.breathPitch * 1.4 * breathe;

    // ── lean / roll targets
    let rollTarget = -(localX / runSpeed) * T.leanDeg * DEG;
    if (st.sliding) rollTarget += (st.slideDir || 0) * T.slideRollDeg * DEG;
    rollTarget *= (1 - adsBlend * 0.55);
    this.roll.target = rollTarget;
    this.leanX.target = -(localX / runSpeed) * 0.045 * (1 - adsBlend * 0.6);

    // ── pitch tilt: sprint leans in, slide looks up slightly
    let tilt = 0;
    if (st.sprinting) tilt -= T.sprintPitchDeg * DEG;
    if (st.sliding) tilt += 1.6 * DEG;
    if (!st.grounded) tilt += Math.max(-1, p.velocity.y / 18) * 0.9 * DEG;
    this.pitchTilt.target = tilt;

    // ── mouse whip: fast look adds a counter-roll and viewmodel sway
    const mdx = st.lookDx || 0, mdy = st.lookDy || 0;
    this.roll.v -= mdx * 0.9;
    this.swayX += (-mdx * 2.2 - this.swayX) * Math.min(1, dt * 12);
    this.swayY += (-mdy * 2.2 - this.swayY) * Math.min(1, dt * 12);
    const swayScale = 1 - adsBlend * (1 - T.adsSwayScale);
    this.swayX *= 1 - Math.min(1, dt * 3.5); this.swayY *= 1 - Math.min(1, dt * 3.5);

    // ── step every spring
    this.dip.step(dt); this.landPitch.step(dt); this.roll.step(dt);
    this.leanX.step(dt); this.pitchTilt.step(dt);
    this.recoilP.step(dt); this.recoilY.step(dt);
    this.punch.step(dt); this.adsT.step(dt); this.zOff.step(dt);

    // ── trauma shake (squared response — small hits stay subtle)
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    this.hitAmt = Math.max(0, this.hitAmt - dt * 2.4);
    const tr = this.trauma * this.trauma;
    this.shake = tr;
    const tt = this.time * 22;
    const shPitch = tr * T.traumaPitch * wobble(tt, 1.7);
    const shYaw = tr * T.traumaYaw * wobble(tt, 5.3);
    const shRoll = tr * T.traumaRoll * wobble(tt, 9.1);
    const shX = tr * T.traumaPos * wobble(tt, 13.4);
    const shY = tr * T.traumaPos * wobble(tt, 17.8);

    // ── assemble the transform
    const eyeY = st.eyeHeight !== undefined ? st.eyeHeight : 0;
    _off.copy(p.position);
    _off.y += this.dip.x + bobY + breathY;
    const lateral = bobX + this.leanX.x + shX;
    _off.addScaledVector(_right, lateral);
    _off.addScaledVector(_fwd, this.zOff.x - Math.min(0.06, speedFrac * 0.035) * adsBlend);
    _off.y += shY;
    this.bobOffset.set(lateral, this.dip.x + bobY + breathY, this.zOff.x);

    const pitch = p.pitch + this.landPitch.x + this.pitchTilt.x + breathPitch + this.recoilP.x + shPitch;
    const yaw = p.yaw + breathYaw + this.recoilY.x + shYaw;
    const roll = this.roll.x + bobRoll + shRoll;
    this.finalRoll = roll;

    cam.position.copy(_off);
    cam.rotation.set(
      Math.max(-1.5533, Math.min(1.5533, pitch)),
      yaw,
      Math.max(-0.5, Math.min(0.5, roll)),
      'YXZ',
    );
    cam.updateMatrixWorld();

    // ── FOV: ads blend + sprint / speed / dash kick
    const base = cfg.fov + (cfg.adsFov - cfg.fov) * adsBlend;
    let kick = 0;
    if (st.sprinting) kick += T.sprintFov;
    if (st.sliding) kick += T.slideFov;
    if (st.dashing) kick += T.dashFov;
    kick += speedFrac * T.speedFov;
    kick *= (1 - adsBlend * 0.85);
    this.fov.target = base + kick;
    this.fov.step(dt);
    const f = this.fov.x + this.punch.x * 0.06;
    if (Math.abs(cam.fov - f) > 0.004) { cam.fov = f; cam.updateProjectionMatrix(); }

    this.viewKick *= 1 - Math.min(1, dt * 7);
    this._pushPostFX(dt, false);
  }

  _footstep(st, speed) {
    const ev = this.ctx.events;
    if (!ev) return;
    ev.emit('footstep', {
      surface: st.surface || 'sand',
      speed,
      loud: st.sprinting ? 1 : st.crouching ? 0.35 : 0.7,
      foot: (this.footIndex & 1) ? 'left' : 'right',
      position: this.player.position,
    });
    // micro-dip so each footfall reads even at walking pace
    const w = Math.min(1, speed / (st.runSpeed || 8.4));
    this.dip.v -= 0.16 * w * (st.crouching ? 0.5 : 1);
  }

  _pushPostFX(dt, posed) {
    const pfx = this.ctx.postfx;
    if (!pfx) return;
    if (pfx.setAdsBlend) pfx.setAdsBlend(this.adsT.x);
    if (pfx.setLowHealth) pfx.setLowHealth(this.lowHealth);

    // Depth of field: focus on whatever the crosshair is over, re-probed a few
    // times a second (a full ray march every frame is wasted work).
    if (pfx.setDofFocus && this.player.collision) {
      this._focusAcc -= dt;
      if (posed || this._focusAcc <= 0) {
        this._focusAcc = 0.12;
        this.camera.getWorldDirection(_v);
        const d = this.player.collision.rayDistance(this.camera.position, _v, 180);
        const target = Math.max(2.2, Math.min(160, d));
        this.focusDistance = posed ? target : this.focusDistance + (target - this.focusDistance) * 0.35;
        pfx.setDofFocus(this.focusDistance);
      }
    }
  }

  dispose() {}
}
