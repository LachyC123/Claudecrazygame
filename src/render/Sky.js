/**
 * BORDERLINE 4 — SKY
 * ==================================================================================
 * A single inverted sphere carrying the whole atmosphere: Rayleigh-ish vertical
 * gradient, warm horizon haze, sun disc (HDR, so it feeds the bloom threshold),
 * sun inscatter halo, and two layers of hand-painted procedural cloud.
 *
 * The clouds are deliberately NOT volumetric. They are projected onto two virtual
 * planes above the camera (so they foreshorten toward the horizon like real cloud
 * decks), thresholded into hard coverage, and shaded with a 3-step banded ramp plus
 * a darker ink lip on the lit edge — the same visual language as the cel materials.
 *
 * The dome sits on LAYER_SKY so the ink-outline G-buffer prepass can skip it; that is
 * what lets characters and mesas read as crisp black silhouettes against the sky.
 *
 * USE
 *   const sky = new Sky({ ... });
 *   sky.addTo(scene, camera);      // parents itself, follows the camera
 *   sky.update(dt, camera);        // once per frame (Lighting does this for you)
 *   sky.setSun(dirVec3, colorHex, intensity);
 *   sky.setPalette({ zenith, horizon, groundHaze, cloudLit, cloudShadow });
 *   sky.sampleHorizon() -> THREE.Color   // for matching fog to the sky
 * ==================================================================================
 */

import * as THREE from 'three';
import { LAYER_SKY } from '../core/Renderer.js';

const _tmpV = new THREE.Vector3();

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;      // pin to the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunSize;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGroundHaze;
uniform vec3  uCloudLit;
uniform vec3  uCloudShadow;
uniform vec3  uInscatter;

uniform vec2  uCamXZ;
uniform float uCoverage;
uniform float uCloudSharp;
uniform float uCloudScale;
uniform float uWind;
uniform float uHazePower;
uniform float uSkyGain;
uniform float uGrain;

/* ---------------- value noise / fbm ---------------- */
float h21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.11369));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
const mat2 M2 = mat2(0.86, 0.50, -0.50, 0.86);
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = M2 * p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = M2 * p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
/* ridged, for the wispy high deck */
float fbmR(vec2 p) {
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) {
    s += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
    p = M2 * p * 2.17 + 3.3; a *= 0.5;
  }
  return s;
}

/* Quantise cloud lighting into painterly steps with a soft-ish terminator. */
float band3(float x) {
  float s = clamp(x, 0.0, 1.0) * 3.0;
  float i = floor(s), f = s - i;
  return (i + smoothstep(0.34, 0.66, f)) / 3.0;
}

/*
 * One cloud deck. Returns vec4(rgb, alpha).
 *   H      : deck altitude above the camera (metres)
 *   scale  : noise frequency
 *   cov    : coverage bias (higher = more sky)
 *   wisp   : 0 = cumulus (billowy), 1 = cirrus (ridged, stretched)
 */
vec4 cloudDeck(vec3 d, float H, float scale, float cov, float wisp, float speed, float thick) {
  float dy = d.y;
  if (dy < 0.008) return vec4(0.0);

  float t = H / dy;
  vec2 p = uCamXZ * 0.35 + d.xz * t;
  p *= scale;
  if (wisp > 0.5) p.y *= 0.34;                       // stretch cirrus into streaks

  vec2 drift = vec2(uTime * speed * uWind, uTime * speed * 0.22 * uWind);
  vec2 q = p + drift;

  // domain warp -> hand-painted, non-repeating shapes
  vec2 w = vec2(fbm3(q * 0.55 + 11.3), fbm3(q * 0.55 + 41.7)) - 0.5;
  q += w * (wisp > 0.5 ? 1.9 : 1.15);

  float dns = wisp > 0.5 ? fbmR(q) : fbm4(q);

  // horizon compression makes far cloud dense; fade it into haze instead
  float hz = smoothstep(0.012, 0.20, dy);
  float covr = cov + (1.0 - hz) * 0.30;

  float sharp = uCloudSharp;
  float a = smoothstep(covr, covr + sharp, dns);
  if (a <= 0.001) return vec4(0.0);

  // --- shading: compare against a sample displaced toward the sun -------------
  vec2 sunXZ = normalize(uSunDir.xz + vec2(0.0001, 0.0)) * (0.55 + 0.9 * thick);
  float lit = wisp > 0.5 ? fbmR(q + sunXZ) : fbm4(q + sunXZ);
  float self = clamp((dns - lit) * 2.6 + 0.52, 0.0, 1.0);
  // thicker cores sit in their own shadow
  self *= mix(1.0, 0.62, smoothstep(covr + sharp, covr + sharp * 3.2, dns));
  float sun = clamp(dot(normalize(d), uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  self = clamp(self * mix(0.82, 1.22, sun), 0.0, 1.0);

  float bandv = band3(self);
  vec3 col = mix(uCloudShadow, uCloudLit, bandv);

  // silver lining where the deck faces the sun
  float rim = smoothstep(0.55, 1.0, sun) * smoothstep(0.55, 0.18, a) * (1.0 - wisp * 0.5);
  col += uSunColor * rim * 0.85;

  // painterly ink lip on the coverage boundary
  float lip = smoothstep(covr, covr + sharp * 0.42, dns) *
              (1.0 - smoothstep(covr + sharp * 0.42, covr + sharp * 1.25, dns));
  col *= 1.0 - lip * 0.30 * (1.0 - wisp * 0.6);

  a *= hz;
  a *= mix(1.0, 0.55, wisp);
  return vec4(col, clamp(a, 0.0, 1.0));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;

  /* ---- base gradient ------------------------------------------------------- */
  float up = clamp(y, 0.0, 1.0);
  float g = pow(up, uHazePower);
  vec3 sky = mix(uHorizon, uZenith, g);

  // thin bright band right on the horizon line (dust + scatter)
  float band = exp(-abs(y) * 26.0);
  sky = mix(sky, uHorizon * 1.16 + uInscatter * 0.10, band * 0.55);

  // below the horizon: dusty ground haze
  float below = smoothstep(0.0, -0.10, y);
  sky = mix(sky, uGroundHaze, below);

  /* ---- sun ---------------------------------------------------------------- */
  float sd = dot(d, uSunDir);
  float cosI = cos(uSunSize * 0.55);
  float cosO = cos(uSunSize);
  float disc = smoothstep(cosO, cosI, sd);
  float halo = pow(max(sd, 0.0), 260.0) * 1.4
             + pow(max(sd, 0.0), 26.0) * 0.34
             + pow(max(sd, 0.0), 5.0) * 0.13;
  sky += uInscatter * halo * uSunIntensity * 0.9;

  /* ---- cloud decks --------------------------------------------------------- */
  vec4 hi = cloudDeck(d, 2100.0, uCloudScale * 0.55, uCoverage + 0.10, 1.0, 0.0035, 0.25);
  vec4 lo = cloudDeck(d, 780.0,  uCloudScale,        uCoverage,        0.0, 0.0090, 1.0);

  sky = mix(sky, hi.rgb, hi.a * 0.72);
  sky = mix(sky, lo.rgb, lo.a);

  // the sun burns through thin cloud
  sky += uSunColor * disc * uSunIntensity * (1.0 - lo.a * 0.85) * (1.0 - hi.a * 0.35);

  sky *= uSkyGain;

  /* ---- painterly tooth ----------------------------------------------------- */
  float n = h21(gl_FragCoord.xy * 0.37 + fract(uTime) * 0.11);
  float n2 = vnoise(d.xz * 220.0 + d.y * 130.0);
  sky *= 1.0 + ((n - 0.5) * 0.014 + (n2 - 0.5) * 0.030) * uGrain;

  gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);
}
`;

const DEFAULTS = {
  radius: 1600,
  zenith: 0x2f6f96,
  horizon: 0xcfd9d0,
  groundHaze: 0xa39070,
  cloudLit: 0xfdfaf2,
  cloudShadow: 0x8fa4bb,
  inscatter: 0xffd9a0,
  sunColor: 0xfff0d2,
  sunIntensity: 26.0,
  sunSize: 0.028,
  coverage: 0.46,
  cloudSharp: 0.20,
  cloudScale: 0.0021,
  wind: 1.0,
  hazePower: 0.46,
  skyGain: 1.0,
  grain: 1.0,
};

export class Sky {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.opts = o;

    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.46, 0.62, 0.63).normalize() },
      uSunColor: { value: new THREE.Color(o.sunColor) },
      uSunIntensity: { value: o.sunIntensity },
      uSunSize: { value: o.sunSize },
      uZenith: { value: new THREE.Color(o.zenith) },
      uHorizon: { value: new THREE.Color(o.horizon) },
      uGroundHaze: { value: new THREE.Color(o.groundHaze) },
      uCloudLit: { value: new THREE.Color(o.cloudLit) },
      uCloudShadow: { value: new THREE.Color(o.cloudShadow) },
      uInscatter: { value: new THREE.Color(o.inscatter) },
      uCamXZ: { value: new THREE.Vector2() },
      uCoverage: { value: o.coverage },
      uCloudSharp: { value: o.cloudSharp },
      uCloudScale: { value: o.cloudScale },
      uWind: { value: o.wind },
      uHazePower: { value: o.hazePower },
      uSkyGain: { value: o.skyGain },
      uGrain: { value: o.grain },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'BL4Sky',
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });

    this.geometry = new THREE.SphereGeometry(1, 48, 32);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.scale.setScalar(o.radius);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.layers.set(LAYER_SKY);
    this.mesh.userData.noCel = true;
    this.mesh.userData.noGBuffer = true;
  }

  /** Add the dome to a scene and make sure the camera can see the sky layer. */
  addTo(scene, camera) {
    scene.add(this.mesh);
    if (camera) camera.layers.enable(LAYER_SKY);
    return this;
  }

  setSun(dir, color, intensity) {
    if (dir) this.uniforms.uSunDir.value.copy(dir).normalize();
    if (color !== undefined && color !== null) this.uniforms.uSunColor.value.set(color);
    if (intensity !== undefined) this.uniforms.uSunIntensity.value = intensity;
    return this;
  }

  setPalette(p = {}) {
    const u = this.uniforms;
    if (p.zenith !== undefined) u.uZenith.value.set(p.zenith);
    if (p.horizon !== undefined) u.uHorizon.value.set(p.horizon);
    if (p.groundHaze !== undefined) u.uGroundHaze.value.set(p.groundHaze);
    if (p.cloudLit !== undefined) u.uCloudLit.value.set(p.cloudLit);
    if (p.cloudShadow !== undefined) u.uCloudShadow.value.set(p.cloudShadow);
    if (p.inscatter !== undefined) u.uInscatter.value.set(p.inscatter);
    return this;
  }

  /** Scalar dials: coverage, cloudSharp, cloudScale, wind, hazePower, skyGain, grain, sunSize. */
  setParams(p = {}) {
    const map = {
      coverage: 'uCoverage', cloudSharp: 'uCloudSharp', cloudScale: 'uCloudScale',
      wind: 'uWind', hazePower: 'uHazePower', skyGain: 'uSkyGain', grain: 'uGrain',
      sunSize: 'uSunSize', sunIntensity: 'uSunIntensity',
    };
    for (const k in p) { const n = map[k]; if (n && this.uniforms[n]) this.uniforms[n].value = p[k]; }
    return this;
  }

  /** Approximate colour of the sky at the horizon — use it to tint fog. */
  sampleHorizon(target = new THREE.Color()) {
    return target.copy(this.uniforms.uHorizon.value).multiplyScalar(this.uniforms.uSkyGain.value * 1.05);
  }

  /** Approximate colour of the sky at the zenith. */
  sampleZenith(target = new THREE.Color()) {
    return target.copy(this.uniforms.uZenith.value).multiplyScalar(this.uniforms.uSkyGain.value);
  }

  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    if (camera) {
      camera.getWorldPosition(_tmpV);
      this.mesh.position.copy(_tmpV);
      this.uniforms.uCamXZ.value.set(_tmpV.x, _tmpV.z);
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createSky(opts) { return new Sky(opts); }
