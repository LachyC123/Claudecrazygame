/**
 * BORDERLINE 4 — LIGHTING RIG
 * ==================================================================================
 * One call installs the entire lighting environment: sky dome, cascaded shadow maps,
 * hemisphere bounce, cool fill, sky-derived IBL, aerial-perspective fog, and the
 * shared cel uniform block that every cel material reads from.
 *
 * ----------------------------------------------------------------------------------
 * USE  (this is the whole API other modules need)
 * ----------------------------------------------------------------------------------
 *   import { installLightRig } from '../render/index.js';
 *
 *   const lighting = installLightRig(ctx);          // ctx = {scene,camera,renderer,cfg}
 *   lighting.setTimeOfDay(0.30);                    // 0 dawn .. 0.5 noon .. 1 dusk
 *   lighting.sunDirection                           // THREE.Vector3, points AT the sun
 *   lighting.sky                                    // the Sky instance
 *
 * You do NOT need to call `lighting.update()` — PostFX drives it every frame, right
 * before the composer runs, so the cascades are always fitted to the posed camera.
 * Calling it yourself is harmless (it de-dupes per rendered frame).
 *
 * If a module builds materials after startup, they are picked up automatically:
 * `autoAdopt()` walks the scene each frame, cel-patches any MeshStandardMaterial and
 * registers it with the cascade shader. Opt a material out with
 *   material.userData.noCel = true      // keep PBR response, still gets cascades
 *   material.userData.noCsm = true      // keep three's single-light shadow path
 *   object.userData.noShadowCast = true // never a shadow caster
 * ==================================================================================
 */

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from './Sky.js';
import { CEL_GLOBALS, makeCel, updateCelGlobals } from './CelMaterial.js';
import { LAYER_SKY } from '../core/Renderer.js';

const _dir = new THREE.Vector3();
const _neg = new THREE.Vector3();
const _col = new THREE.Color();
const _c2 = new THREE.Color();

/* ---------------------------------------------------------------------------- */
/* Time-of-day keyframes                                                         */
/* ---------------------------------------------------------------------------- */

const KEYS = [
  { // 0.00 — dawn
    t: 0.00, dir: [0.94, 0.10, -0.32],
    sunColor: 0xffa863, sunI: 1.35, sunDisc: 9.0, sunSize: 0.036,
    zenith: 0x27506f, horizon: 0xecc39b, ground: 0x6a5a49,
    cloudLit: 0xffd2a4, cloudShadow: 0x5e6f8e, inscatter: 0xff9d55,
    hemiSky: 0x8aa8c6, hemiGnd: 0x4b3c2e, hemiI: 1.02, ambGain: 1.18,
    fogDensity: 0.0038, fogHorizon: 0xd8b491, fogZenith: 0x5d7b98, fogSun: 0xff9f58,
    coverage: 0.50, exposure: 1.22, skyGain: 0.85,
    warm: 0xffdcb4, cool: 0x6d8bb0,
  },
  { // 0.22 — morning
    t: 0.22, dir: [0.70, 0.54, -0.46],
    sunColor: 0xffe6bc, sunI: 3.05, sunDisc: 20.0, sunSize: 0.029,
    zenith: 0x2b6b95, horizon: 0xd9d6c4, ground: 0x9d8b6c,
    cloudLit: 0xfff5e6, cloudShadow: 0x92a9c2, inscatter: 0xffcf96,
    hemiSky: 0xa8c7e0, hemiGnd: 0x6b5a42, hemiI: 1.55, ambGain: 1.35,
    fogDensity: 0.0027, fogHorizon: 0xcfd8ce, fogZenith: 0x7ea6be, fogSun: 0xffd6a2,
    coverage: 0.52, exposure: 1.06, skyGain: 1.0,
    warm: 0xfff1da, cool: 0x8db4d6,
  },
  { // 0.45 — noon
    t: 0.45, dir: [0.20, 0.95, -0.24],
    sunColor: 0xfff8ec, sunI: 3.55, sunDisc: 26.0, sunSize: 0.026,
    zenith: 0x2f7aa6, horizon: 0xd8e0dc, ground: 0xab9878,
    cloudLit: 0xfffdf6, cloudShadow: 0x9cb2c8, inscatter: 0xffe3bb,
    hemiSky: 0xb5d3ea, hemiGnd: 0x77664c, hemiI: 1.62, ambGain: 1.38,
    fogDensity: 0.0023, fogHorizon: 0xd3ddd8, fogZenith: 0x86b0c8, fogSun: 0xffe6c0,
    coverage: 0.54, exposure: 1.0, skyGain: 1.06,
    warm: 0xfff6e8, cool: 0x93bcdd,
  },
  { // 0.70 — afternoon
    t: 0.70, dir: [-0.52, 0.63, -0.58],
    sunColor: 0xffeccb, sunI: 3.20, sunDisc: 22.0, sunSize: 0.028,
    zenith: 0x2d6f9c, horizon: 0xdcd3bd, ground: 0xa48d67,
    cloudLit: 0xfff6e4, cloudShadow: 0x93a6c0, inscatter: 0xffd39c,
    hemiSky: 0xa9c9e2, hemiGnd: 0x6f5c42, hemiI: 1.52, ambGain: 1.32,
    fogDensity: 0.0028, fogHorizon: 0xd0d6c9, fogZenith: 0x7ea6c0, fogSun: 0xffd8a4,
    coverage: 0.55, exposure: 1.06, skyGain: 1.0,
    warm: 0xfff0d6, cool: 0x8ab0d4,
  },
  { // 0.88 — golden hour
    t: 0.88, dir: [-0.80, 0.26, -0.54],
    sunColor: 0xffc078, sunI: 2.35, sunDisc: 15.0, sunSize: 0.033,
    zenith: 0x2a5f8c, horizon: 0xefc192, ground: 0x8a6f4c,
    cloudLit: 0xffdfb0, cloudShadow: 0x77809e, inscatter: 0xffab5e,
    hemiSky: 0x94b0d0, hemiGnd: 0x5d4733, hemiI: 1.25, ambGain: 1.22,
    fogDensity: 0.0034, fogHorizon: 0xe0bd93, fogZenith: 0x6b8fae, fogSun: 0xffb469,
    coverage: 0.58, exposure: 1.14, skyGain: 0.94,
    warm: 0xffe0ae, cool: 0x7392b8,
  },
  { // 1.00 — dusk
    t: 1.00, dir: [-0.93, 0.07, -0.36],
    sunColor: 0xff8e4a, sunI: 1.15, sunDisc: 8.0, sunSize: 0.038,
    zenith: 0x203f63, horizon: 0xe09a6a, ground: 0x5d4a3a,
    cloudLit: 0xffb887, cloudShadow: 0x50597a, inscatter: 0xff7f42,
    hemiSky: 0x6d88ab, hemiGnd: 0x3e3226, hemiI: 0.92, ambGain: 1.15,
    fogDensity: 0.0042, fogHorizon: 0xcb9670, fogZenith: 0x4d6684, fogSun: 0xff8442,
    coverage: 0.60, exposure: 1.3, skyGain: 0.78,
    warm: 0xffcfa0, cool: 0x5b7699,
  },
];

const SCALARS = ['sunI', 'sunDisc', 'sunSize', 'hemiI', 'ambGain', 'fogDensity', 'coverage', 'exposure', 'skyGain'];
const COLORS = ['sunColor', 'zenith', 'horizon', 'ground', 'cloudLit', 'cloudShadow',
  'inscatter', 'hemiSky', 'hemiGnd', 'fogHorizon', 'fogZenith', 'fogSun', 'warm', 'cool'];

const _state = {};
for (const k of SCALARS) _state[k] = 0;
for (const k of COLORS) _state[k] = new THREE.Color();
_state.dir = new THREE.Vector3();

function sampleTOD(t) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = THREE.MathUtils.clamp((t - a.t) / Math.max(b.t - a.t, 1e-5), 0, 1);
  const s = f * f * (3 - 2 * f);
  for (const k of SCALARS) _state[k] = THREE.MathUtils.lerp(a[k], b[k], s);
  for (const k of COLORS) {
    _col.set(a[k]); _c2.set(b[k]);
    _state[k].copy(_col).lerp(_c2, s);
  }
  _state.dir.set(
    THREE.MathUtils.lerp(a.dir[0], b.dir[0], s),
    THREE.MathUtils.lerp(a.dir[1], b.dir[1], s),
    THREE.MathUtils.lerp(a.dir[2], b.dir[2], s),
  ).normalize();
  return _state;
}

/* ---------------------------------------------------------------------------- */
/* Lighting                                                                      */
/* ---------------------------------------------------------------------------- */

const DEFAULTS = {
  timeOfDay: 0.30,
  cascades: 3,
  shadowMapSize: 2048,
  shadowDistance: 300,
  shadowSplits: [0.035, 0.17, 1.0],
  fogScale: 1.0,
  autoAdopt: true,
  autoShadows: true,
  takeover: true,      // remove pre-existing hemisphere/directional lights
  ibl: true,
  sky: true,
};

export class Lighting {
  constructor(ctx, opts = {}) {
    const cfg = ctx.cfg || {};
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.renderer = ctx.renderer;

    this.opts = {
      ...DEFAULTS,
      cascades: cfg.cascades ?? DEFAULTS.cascades,
      shadowMapSize: cfg.shadowMapSize ?? DEFAULTS.shadowMapSize,
      ...opts,
    };
    this.shadowsEnabled = cfg.shadows !== false;

    this.group = new THREE.Group();
    this.group.name = 'LightRig';
    this.scene.add(this.group);

    this.sunDirection = new THREE.Vector3(0.53, 0.68, -0.39).normalize();
    this.sunColor = new THREE.Color(0xffe6bc);
    this.sunIntensity = 3.0;

    this._adopted = new WeakSet();
    this._adoptFn = (o) => this._adoptObject(o);
    this._frame = -1;
    this._envDirty = true;
    this._envTimer = 0;
    this._captureMode = !!cfg.capture;
    this._shadowFrames = 0;
    this._t = this.opts.timeOfDay;

    if (this.opts.takeover) this._removeLegacyLights();

    // ---- sky ------------------------------------------------------------------
    if (this.opts.sky) {
      this.sky = new Sky({ renderer: this.renderer });
      this.sky.addTo(this.scene, this.camera);
      this.scene.background = null;
    }
    this.camera.layers.enable(LAYER_SKY);

    // ---- key + cascades -------------------------------------------------------
    // NOTE: three indexes directionalShadow[] by directional-light order, so every
    // shadow-casting directional light must be added BEFORE any that does not cast.
    this._buildKey();

    // ---- bounce / fill --------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xa8c7e0, 0x6b5a42, 1.0);
    this.hemi.name = 'SkyBounce';
    this.group.add(this.hemi);

    // Cool rim/fill from the anti-sun side. Keeps shadow-side forms readable
    // without breaking the single-key cel terminator.
    this.fill = new THREE.DirectionalLight(0x9fc2e6, 0.34);
    this.fill.castShadow = false;
    this.fill.name = 'CoolFill';
    this.group.add(this.fill, this.fill.target);

    // ---- fog ------------------------------------------------------------------
    this.fog = new THREE.FogExp2(0xcfd8ce, 0.0027);
    this.scene.fog = this.fog;

    // House art dials — see Lighting.setStyle().
    this.setStyle({ hatch: 0.62, grain: 0.85, rim: 0.75, detailNear: 9, detailFar: 30 });
    this.setTimeOfDay(this._t);
    if (this.opts.ibl) this._buildEnv();
    if (this.opts.autoAdopt) this.autoAdopt();

    ctx.lighting = this;
  }

  /* -------------------------------------------------------------------------- */

  _removeLegacyLights() {
    const kill = [];
    this.scene.traverse((o) => {
      if (o === this.group || o.parent === this.group) return;
      if (o.isHemisphereLight || o.isDirectionalLight || o.isAmbientLight) kill.push(o);
    });
    for (const l of kill) l.parent?.remove(l);
  }

  _buildKey() {
    const o = this.opts;
    _neg.copy(this.sunDirection).negate();
    if (!this.shadowsEnabled) {
      this.key = new THREE.DirectionalLight(this.sunColor.getHex(), this.sunIntensity);
      this.group.add(this.key, this.key.target);
      this.csm = null;
      return;
    }
    try {
      const splits = o.shadowSplits.slice(0, o.cascades);
      splits[splits.length - 1] = 1.0;
      this.csm = new CSM({
        camera: this.camera,
        parent: this.group,
        cascades: o.cascades,
        maxFar: o.shadowDistance,
        mode: 'custom',
        customSplitsCallback: (amount, near, far, target) => {
          for (let i = 0; i < amount; i++) target.push(splits[i] ?? ((i + 1) / amount));
        },
        shadowMapSize: o.shadowMapSize,
        shadowBias: -0.00012,
        lightDirection: _neg.clone().normalize(),
        lightIntensity: this.sunIntensity,
        lightNear: 1,
        lightFar: 1400,
        lightMargin: 260,
      });
      this.csm.fade = true;
      // Normal-offset bias per cascade — kills acne without peter-panning.
      const nb = [0.014, 0.06, 0.30];
      this.csm.lights.forEach((l, i) => {
        l.shadow.normalBias = nb[Math.min(i, nb.length - 1)];
        l.shadow.bias = -0.00012;
        l.shadow.radius = 1.6;
        l.shadow.camera.updateProjectionMatrix();
      });
      this.csm.updateFrustums();
    } catch (e) {
      console.warn('[Lighting] CSM unavailable, falling back to single shadow', e);
      this.csm = null;
      this.key = new THREE.DirectionalLight(this.sunColor.getHex(), this.sunIntensity);
      this.key.castShadow = true;
      this.key.shadow.mapSize.set(o.shadowMapSize, o.shadowMapSize);
      const c = this.key.shadow.camera;
      c.left = -90; c.right = 90; c.top = 90; c.bottom = -90; c.near = 1; c.far = 600;
      this.key.shadow.normalBias = 0.05;
      this.key.shadow.bias = -0.0003;
      this.group.add(this.key, this.key.target);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Public                                                                      */
  /* -------------------------------------------------------------------------- */

  /** 0 = dawn, 0.45 = noon, 0.88 = golden hour, 1 = dusk. */
  setTimeOfDay(t) {
    this._t = THREE.MathUtils.clamp(t, 0, 1);
    const s = sampleTOD(this._t);

    this.sunDirection.copy(s.dir);
    this.sunColor.copy(s.sunColor);
    this.sunIntensity = s.sunI;

    // key
    _neg.copy(this.sunDirection).negate();
    if (this.csm) {
      this.csm.lightDirection.copy(_neg);
      this.csm.lightIntensity = s.sunI;
      for (const l of this.csm.lights) { l.color.copy(s.sunColor); l.intensity = s.sunI; }
    } else if (this.key) {
      this.key.color.copy(s.sunColor);
      this.key.intensity = s.sunI;
      this.key.position.copy(this.sunDirection).multiplyScalar(220);
      this.key.target.position.set(0, 0, 0);
      this.key.target.updateMatrixWorld();
    }

    // hemi + fill
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGnd);
    this.hemi.intensity = s.hemiI;
    this.fill.color.copy(s.hemiSky).lerp(_col.set(0xbfe0ff), 0.35);
    this.fill.intensity = 0.30 * s.hemiI;
    this.fill.position.set(-this.sunDirection.x * 120, 60 + this.sunDirection.y * 40, -this.sunDirection.z * 120);
    this.fill.target.position.set(0, 0, 0);
    this.fill.target.updateMatrixWorld();

    // sky
    if (this.sky) {
      this.sky.setSun(this.sunDirection, s.sunColor, s.sunDisc);
      this.sky.setPalette({
        zenith: s.zenith, horizon: s.horizon, groundHaze: s.ground,
        cloudLit: s.cloudLit, cloudShadow: s.cloudShadow, inscatter: s.inscatter,
      });
      this.sky.setParams({ coverage: s.coverage, skyGain: s.skyGain, sunSize: s.sunSize });
    }

    // cel globals
    const G = CEL_GLOBALS;
    G.uCelSunDir.value.copy(this.sunDirection);
    G.uCelSunColor.value.copy(s.sunColor);
    G.uCelKeyIrr.value = s.sunI;
    G.uCelAmbTint.value.copy(s.hemiSky).lerp(_col.set(0xffffff), 0.25);
    G.uCelAmbGain.value = s.ambGain;
    G.uCelFogHorizon.value.copy(s.fogHorizon);
    G.uCelFogZenith.value.copy(s.fogZenith);
    G.uCelFogSun.value.copy(s.fogSun);
    G.uCelFogDensity.value = s.fogDensity * this.opts.fogScale;

    // three fog (for anything that is not a cel material — sprites, points, VFX)
    if (this.fog) {
      this.fog.color.copy(s.fogHorizon);
      this.fog.density = s.fogDensity * 0.85 * this.opts.fogScale;
    }

    this.renderer.toneMappingExposure = s.exposure;
    this._envDirty = true;
    return this;
  }

  get timeOfDay() { return this._t; }

  /** Global cel art dials — hatch/grain/rim strength, aerial perspective amount. */
  setStyle({ hatch, grain, rim, aerial, detailNear, detailFar } = {}) {
    const G = CEL_GLOBALS;
    if (hatch !== undefined) G.uCelHatchGlobal.value = hatch;
    if (grain !== undefined) G.uCelGrainGlobal.value = grain;
    if (rim !== undefined) G.uCelRimGlobal.value = rim;
    if (aerial !== undefined) G.uCelAerial.value = aerial;
    if (detailNear !== undefined) G.uCelDetailFade.value.x = detailNear;
    if (detailFar !== undefined) G.uCelDetailFade.value.y = detailFar;
    return this;
  }

  /** Register one material with the cascade shader + the cel patch. Idempotent. */
  registerMaterial(mat) {
    if (!mat || this._adopted.has(mat)) return mat;
    this._adopted.add(mat);
    const ud = mat.userData || (mat.userData = {});
    if (this.csm && !ud.noCsm && (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) {
      this._csmSetup(mat);
    }
    if (!ud.noCel) makeCel(mat, ud.celOpts || {});
    return mat;
  }

  /** Adopt a whole subtree (or a single material). */
  adopt(target) {
    if (!target) return;
    if (target.isMaterial) { this.registerMaterial(target); return; }
    target.traverse?.((o) => this._adoptObject(o));
    if (!target.traverse) this._adoptObject(target);
  }

  _adoptObject(o) {
    if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) {
      if (this.opts.autoShadows && !this._adopted.has(o)) {
        this._adopted.add(o);
        if (o.userData.noShadow !== true) {
          o.receiveShadow = o.userData.noShadowReceive === true ? false : true;
          const heavy = o.isInstancedMesh && o.count > 6000;
          if (!o.castShadow && !heavy && o.userData.noShadowCast !== true) {
            const m = Array.isArray(o.material) ? o.material[0] : o.material;
            if (m && !m.transparent) o.castShadow = true;
          }
        }
      }
      const m = o.material;
      if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) this.registerMaterial(m[i]); }
      else this.registerMaterial(m);
    }
  }

  /** Walk the scene and pick up anything created since the last pass. */
  autoAdopt() {
    this.scene.traverse(this._adoptFn);
  }

  _csmSetup(material) {
    const csm = this.csm;
    material.defines = material.defines || {};
    material.defines.USE_CSM = 1;
    material.defines.CSM_CASCADES = csm.cascades;
    if (csm.fade) material.defines.CSM_FADE = '';
    const breaks = [];
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      const far = Math.min(csm.camera.far, csm.maxFar);
      csm.getExtendedBreaks(breaks);
      shader.uniforms.CSM_cascades = { value: breaks };
      shader.uniforms.cameraNear = { value: csm.camera.near };
      shader.uniforms.shadowFar = { value: far };
      csm.shaders.set(material, shader);
      if (prev) prev.call(this, shader, renderer);
    };
    csm.shaders.set(material, null);
    material.needsUpdate = true;
  }

  _buildEnv() {
    if (!this.sky) return;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const dome = new THREE.Mesh(this.sky.geometry, this.sky.material);
      dome.scale.setScalar(400);
      dome.frustumCulled = false;
      envScene.add(dome);
      const rt = pmrem.fromScene(envScene, 0.02, 0.1, 900);
      this._envRT?.dispose();
      this._envRT = rt;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.42;
      pmrem.dispose();
      envScene.remove(dome);
    } catch (e) {
      console.warn('[Lighting] IBL generation failed', e);
    }
    this._envDirty = false;
  }

  /** Called by PostFX every frame, before the composer runs. Safe to call twice. */
  update(dt) {
    const f = this.renderer.info.render.frame;
    if (f === this._frame) return;
    this._frame = f;

    updateCelGlobals(dt);
    if (this.sky) this.sky.update(dt, this.camera);
    if (this.opts.autoAdopt) this.autoAdopt();

    if (this.csm) {
      this.csm.update();
      this.csm.updateUniforms();
    }

    // Capture poses are frozen by contract, so the cascades only need rasterising
    // until they have settled. Saves three 2k shadow renders on every warm frame.
    if (this._captureMode) {
      this._shadowFrames++;
      this.renderer.shadowMap.autoUpdate = this._shadowFrames < 3;
    }

    if (this._envDirty) {
      this._envTimer += dt;
      if (this._envTimer > 0.25) { this._envTimer = 0; this._buildEnv(); }
    }
  }

  onResize() { if (this.csm) this.csm.updateFrustums(); }

  dispose() {
    this.csm?.remove();
    this.csm?.dispose();
    this.sky?.dispose();
    this._envRT?.dispose();
    this.scene.remove(this.group);
    if (this.ctx.lighting === this) this.ctx.lighting = null;
  }
}

/** Install the complete rig into ctx.scene and return it. Idempotent per ctx. */
export function installLightRig(ctx, opts) {
  if (ctx.lighting) return ctx.lighting;
  return new Lighting(ctx, opts);
}

/* ---------------------------------------------------------------------------- */
/* Dev harness                                                                   */
/* ---------------------------------------------------------------------------- */

/**
 * Drops a small set of cel-shaded stand-in forms into the scene so the light rig,
 * shadow cascades, ambient occlusion and ink outlines can be judged without waiting
 * on the world module. Dev only — PostFX builds it when the URL carries ?rendertest.
 */
export function buildRenderProbe(scene, seedIn = 1337) {
  let seed = seedIn >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const group = new THREE.Group();
  group.name = 'RenderProbe';

  const rock = (r, detail) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = Math.sin(v.x * 1.7 + 3.1) * Math.cos(v.z * 1.3) * 0.5 + Math.sin(v.y * 2.9) * 0.3;
      v.multiplyScalar(1 + n * 0.20 + (rnd() - 0.5) * 0.08);
      pos.setXYZ(i, v.x, v.y * 0.82, v.z);
    }
    g.computeVertexNormals();
    return g;
  };

  const matRock = new THREE.MeshStandardMaterial({ color: 0x9a7c58, roughness: 0.95, flatShading: true });
  const matRock2 = new THREE.MeshStandardMaterial({ color: 0x7d6a55, roughness: 0.92, flatShading: true });
  const matMetal = new THREE.MeshStandardMaterial({ color: 0x6d7a80, roughness: 0.42, metalness: 0.75 });
  const matPaint = new THREE.MeshStandardMaterial({ color: 0xc2452e, roughness: 0.6 });

  for (let i = 0; i < 14; i++) {
    const r = 1.2 + rnd() * 5.5;
    const m = new THREE.Mesh(rock(r, r > 4 ? 2 : 1), rnd() > 0.5 ? matRock : matRock2);
    const a = rnd() * Math.PI * 2;
    const d = 8 + rnd() * 52;
    m.position.set(4 - Math.sin(0.32) * d + Math.cos(a) * 6, r * 0.45, 40 - Math.cos(0.32) * d + Math.sin(a) * 8);
    m.rotation.y = rnd() * 6.28;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // mid-ground mesa
  const mesa = new THREE.Mesh(rock(14, 2), matRock);
  mesa.position.set(-46, 4, -34);
  mesa.scale.set(1.5, 2.2, 1.5);
  mesa.castShadow = mesa.receiveShadow = true;
  group.add(mesa);

  // crates + a pole: hard edges to prove the interior-crease outlines
  for (let i = 0; i < 5; i++) {
    const s = 0.7 + rnd() * 0.6;
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), i % 2 ? matMetal : matPaint);
    m.position.set(2 + (rnd() - 0.5) * 5, s * 0.5, 32 - i * 1.6 + (rnd() - 0.5) * 2);
    m.rotation.y = rnd() * 1.5;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 6, 8), matMetal);
  pole.position.set(-1.6, 3, 33);
  pole.castShadow = pole.receiveShadow = true;
  group.add(pole);

  // character stand-in
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.0, 6, 12), matPaint);
  body.position.set(3.4, 1.0, 28);
  body.castShadow = body.receiveShadow = true;
  group.add(body);

  scene.add(group);
  return group;
}
