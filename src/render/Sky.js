/**
 * BORDERLINE 4 — SKY
 * ==================================================================================
 * A single inverted sphere carrying the whole atmosphere: Rayleigh-ish vertical
 * gradient, warm horizon haze, an HDR sun disc (so it — and only it — feeds the bloom
 * threshold), sun inscatter, and two layers of hand-painted procedural cloud.
 *
 * The clouds are deliberately NOT volumetric. Their noise is baked ONCE at startup
 * into a seamlessly tiling 512² LUT (r = cumulus fbm, g = ridged cirrus, b = large
 * scale coverage mask), so the dome shader costs six texture fetches instead of thirty
 * fbm evaluations. At runtime the LUT is projected onto two virtual cloud planes above
 * the camera — so the decks foreshorten toward the horizon like a real cloud layer —
 * thresholded into hard coverage, and shaded with a three-step banded ramp plus a
 * darker ink lip on the lit edge: the same visual language as the cel materials.
 *
 * The dome sits on LAYER_SKY so the ink-outline G-buffer prepass can skip it. That is
 * what lets characters and mesas read as crisp black silhouettes against the sky.
 *
 * USE
 *   const sky = new Sky({ renderer });
 *   sky.addTo(scene, camera);      // parents itself, follows the camera
 *   sky.update(dt, camera);        // once per frame (Lighting does this for you)
 *   sky.setSun(dirVec3, colorHex, discIntensity);
 *   sky.setPalette({ zenith, horizon, groundHaze, cloudLit, cloudShadow, inscatter });
 *   sky.setParams({ coverage, cloudSharp, cloudScale, wind, hazePower, skyGain, grain });
 *   sky.sampleHorizon() -> THREE.Color   // for matching fog to the sky
 * ==================================================================================
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LAYER_SKY } from '../core/Renderer.js';

const _tmpV = new THREE.Vector3();

/* ---------------------------------------------------------------------------- */
/* Cloud LUT bake                                                                */
/* ---------------------------------------------------------------------------- */

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uPeriod;

float h21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.11369));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
/* value noise on a lattice that wraps every per cells -> seamless tile */
float vnT(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, per), b = mod(i + 1.0, per);
  float n00 = h21(vec2(a.x, a.y));
  float n10 = h21(vec2(b.x, a.y));
  float n01 = h21(vec2(a.x, b.y));
  float n11 = h21(vec2(b.x, b.y));
  return mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y);
}
float fbmT(vec2 p, float per, int oct) {
  float s = 0.0, a = 0.5, nrm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnT(p, per); nrm += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / nrm;
}
float ridgeT(vec2 p, float per, int oct) {
  float s = 0.0, a = 0.55, nrm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * (1.0 - abs(vnT(p, per) * 2.0 - 1.0)); nrm += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / nrm;
}

void main() {
  float per = uPeriod;
  vec2 p = vUv * per;

  // integer-offset domain warp keeps the tile seamless
  vec2 w = vec2(fbmT(p * 0.5 + vec2(3.0, 11.0), per * 0.5, 2),
                fbmT(p * 0.5 + vec2(17.0, 5.0), per * 0.5, 2)) - 0.5;
  vec2 q = p + w * 2.6;

  float cumulus = fbmT(q, per, 5);
  // billow: push mid-tones apart so the threshold yields chunky, rounded shapes
  cumulus = clamp(cumulus * 1.20 - 0.07, 0.0, 1.0);
  cumulus = mix(cumulus, cumulus * cumulus * (3.0 - 2.0 * cumulus), 0.55);

  vec2 qc = vec2(q.x, q.y * 0.35) + vec2(23.0, 7.0);
  float cirrus = ridgeT(qc, per, 4);

  float mask = fbmT(p * 0.25 + vec2(41.0, 29.0), per * 0.25, 2);
  mask = clamp(mask * 1.55 - 0.24, 0.0, 1.0);

  gl_FragColor = vec4(cumulus, cirrus, mask, 1.0);
}
`;

let _sharedCloudLUT = null;

function bakeCloudLUT(renderer, size = 512) {
  if (_sharedCloudLUT) return _sharedCloudLUT;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapNearestFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = 'BL4.CloudLUT';
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
  rt.texture.generateMipmaps = true;
  rt.texture.minFilter = THREE.LinearMipmapNearestFilter;  // 1 fetch, no shimmer
  rt.texture.anisotropy = 1;

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPeriod: { value: 8.0 } },
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    depthTest: false, depthWrite: false,
  });
  const quad = new FullScreenQuad(mat);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  quad.render(renderer);
  renderer.setRenderTarget(prev);
  quad.dispose();
  mat.dispose();

  _sharedCloudLUT = rt.texture;
  return _sharedCloudLUT;
}

/* ---------------------------------------------------------------------------- */
/* Dome                                                                          */
/* ---------------------------------------------------------------------------- */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;      // pin to the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform sampler2D tClouds;
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

float h21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.11369));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

/* three painterly steps with a soft-ish terminator */
float band3(float x) {
  float s = clamp(x, 0.0, 1.0) * 3.0;
  float i = floor(s), f = s - i;
  return (i + smoothstep(0.32, 0.68, f)) / 3.0;
}

/*
 * One cloud deck projected onto a plane H metres above the camera.
 *   wisp 0 = cumulus (billowy, LUT.r), 1 = cirrus (ridged streaks, LUT.g)
 */
vec4 cloudDeck(vec3 d, float H, float scale, float cov, float wisp, float speed) {
  float dy = d.y;
  if (dy < 0.010) return vec4(0.0);

  float t = H / dy;
  vec2 p = uCamXZ * 0.30 + d.xz * t;
  if (wisp > 0.5) p.y *= 0.42;
  vec2 uv = p * scale + vec2(uTime * speed * uWind, uTime * speed * 0.24 * uWind);

  vec4 A = texture2D(tClouds, uv);
  vec4 B = texture2D(tClouds, uv * 0.43 + vec2(0.317, 0.611));

  float base = wisp > 0.5 ? A.g : A.r;
  float det  = wisp > 0.5 ? B.g : B.r;
  float dns = (base * 0.64 + det * 0.36) * (0.60 + 0.72 * A.b) * 1.18;

  float hz = smoothstep(0.030, 0.30, dy);
  float covr = cov + (1.0 - hz) * 0.34;

  float sharp = uCloudSharp;
  float a = smoothstep(covr, covr + sharp, dns);
  if (a <= 0.002) return vec4(0.0);

  // self-shadow: compare against the LUT displaced toward the sun.
  // Cirrus is optically thin, so it skips the extra fetch and is shaded flat-bright.
  float self;
  if (wisp > 0.5) {
    self = 0.70 + 0.25 * (1.0 - smoothstep(covr, covr + sharp * 2.2, dns));
  } else {
    vec2 sunOff = normalize(uSunDir.xz + vec2(1e-4, 0.0)) * 0.050;
    float litD = (texture2D(tClouds, uv + sunOff).r * 0.64 + det * 0.36) * (0.60 + 0.72 * A.b) * 1.18;
    self = clamp((dns - litD) * 3.4 + 0.50, 0.0, 1.0);
    self *= mix(1.0, 0.60, smoothstep(covr + sharp, covr + sharp * 3.0, dns));
  }

  float sun = clamp(dot(d, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  self = clamp(self * mix(0.80, 1.24, sun), 0.0, 1.0);

  vec3 col = mix(uCloudShadow, uCloudLit, band3(self));

  // silver lining on the sunward edge
  float rim = smoothstep(0.52, 1.0, sun) * smoothstep(0.62, 0.16, a);
  col += uSunColor * rim * (1.0 - wisp * 0.55) * 0.80;

  // painterly ink lip on the coverage boundary
  float lip = smoothstep(covr, covr + sharp * 0.40, dns) *
              (1.0 - smoothstep(covr + sharp * 0.40, covr + sharp * 1.20, dns));
  col *= 1.0 - lip * 0.26 * (1.0 - wisp * 0.6);

  a *= hz * mix(1.0, 0.60, wisp);
  return vec4(col, clamp(a, 0.0, 1.0));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;

  /* ---- base gradient ------------------------------------------------------- */
  float up = clamp(y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, uHazePower));

  // thin dust band right on the horizon line
  float band = exp(-abs(y) * 22.0);
  sky = mix(sky, uHorizon * 1.10 + uInscatter * 0.08, band * 0.45);

  // below the horizon: dusty ground haze
  sky = mix(sky, uGroundHaze, smoothstep(0.0, -0.09, y));

  /* ---- sun ---------------------------------------------------------------- */
  float sd = dot(d, uSunDir);
  float sp = max(sd, 0.0);
  float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.55), sd);
  float halo = pow(sp, 220.0) * 0.55 + pow(sp, 24.0) * 0.20 + pow(sp, 4.0) * 0.085;
  sky += uInscatter * halo;
  sky += uInscatter * pow(sp, 1.4) * 0.045;

  /* ---- cloud decks --------------------------------------------------------- */
  vec4 hi = cloudDeck(d, 3000.0, uCloudScale * 0.40, uCoverage + 0.20, 1.0, 0.0018);
  vec4 lo = cloudDeck(d, 760.0,  uCloudScale,        uCoverage,        0.0, 0.0075);

  sky = mix(sky, hi.rgb, hi.a * 0.38);
  sky = mix(sky, lo.rgb, lo.a);

  // the sun burns through thin cloud
  sky += uSunColor * disc * uSunIntensity * (1.0 - lo.a * 0.88) * (1.0 - hi.a * 0.40);

  sky *= uSkyGain;

  /* ---- painterly tooth ----------------------------------------------------- */
  float n = h21(gl_FragCoord.xy * 0.37);
  sky *= 1.0 + (n - 0.5) * 0.016 * uGrain;

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
  cloudSharp: 0.175,
  cloudScale: 0.00058,
  wind: 1.0,
  hazePower: 0.52,
  skyGain: 1.0,
  grain: 1.0,
  lutSize: 512,
};

export class Sky {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.opts = o;

    this.uniforms = {
      tClouds: { value: null },
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
    this.mesh.layers.set(LAYER_SKY);
    this.mesh.userData.noCel = true;
    this.mesh.userData.noGBuffer = true;

    if (o.renderer) this.bake(o.renderer);
  }

  /** Bake the tiling cloud LUT. Cheap, one-off, shared between Sky instances. */
  bake(renderer) {
    if (!renderer || this.uniforms.tClouds.value) return this;
    this.uniforms.tClouds.value = bakeCloudLUT(renderer, this.opts.lutSize);
    return this;
  }

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

  setParams(p = {}) {
    const map = {
      coverage: 'uCoverage', cloudSharp: 'uCloudSharp', cloudScale: 'uCloudScale',
      wind: 'uWind', hazePower: 'uHazePower', skyGain: 'uSkyGain', grain: 'uGrain',
      sunSize: 'uSunSize', sunIntensity: 'uSunIntensity',
    };
    for (const k in p) { const n = map[k]; if (n && this.uniforms[n]) this.uniforms[n].value = p[k]; }
    return this;
  }

  sampleHorizon(target = new THREE.Color()) {
    return target.copy(this.uniforms.uHorizon.value).multiplyScalar(this.uniforms.uSkyGain.value * 1.05);
  }
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
