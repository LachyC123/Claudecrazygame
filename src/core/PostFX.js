/**
 * BORDERLINE 4 — POST-PROCESSING STACK
 * ==================================================================================
 * Order (each stage individually toggleable through `cfg.postfx`):
 *
 *   GBuffer prepass  (view normal + linear depth, RGBA16F)
 *   RenderPass       (scene, linear HDR)
 *   InkOutlinePass   (depth + normal edge detection — the Borderlands signature)
 *   AO               (Alchemy/HBAO from the G-buffer, banded for a painted feel)
 *   Bloom            (UnrealBloom, HDR threshold ~1 so only emissives and the sun blow)
 *   MotionBlur       (camera reprojection from the G-buffer)
 *   DepthOfField     (CoC from the G-buffer, ADS-driven)
 *   Grade            (chromatic aberration -> tonemap -> lift/gamma/gain + split tone
 *                     -> hit flash / low health -> vignette -> film grain -> dither)
 *   SMAA
 *   OutputPass       (linear -> sRGB)
 *
 * Everything after RenderPass reuses the single G-buffer, so the scene geometry is
 * only submitted twice per frame in total (once for the G-buffer, once for colour) on
 * top of the shadow cascades.
 *
 * ----------------------------------------------------------------------------------
 * PUBLIC API (other systems call these)
 * ----------------------------------------------------------------------------------
 *   postfx.setDofFocus(distanceMetres)     // where the lens is focused
 *   postfx.setAdsBlend(t)                  // 0 hip .. 1 aiming down sights
 *   postfx.setHitFlash(intensity)          // 0..1, decays automatically
 *   postfx.setLowHealth(t)                 // 0..1, desat + red pulse
 *   postfx.setExposure(ev)
 *   postfx.setBloom({strength, radius, threshold})
 *   postfx.setOutline({...})               // see OutlinePass INK_DEFAULTS
 *   postfx.setGrade({saturation, contrast, lift, gamma, gain, shadowTint, highlightTint})
 *   postfx.setTimeOfDay(t)                 // delegates to the light rig
 *   postfx.lighting                        // the Lighting instance
 * ==================================================================================
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { cfg } from './Config.js';
import { TONEMAP_GLSL } from './Renderer.js';
import { GBufferPass, InkOutlinePass } from '../render/OutlinePass.js';
import { installLightRig } from '../render/Lighting.js';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const NOISE_GLSL = /* glsl */ `
float h21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.11369));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float h13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
`;

const RECON_GLSL = /* glsl */ `
uniform vec2 uProj;          // (tanHalfFov * aspect, tanHalfFov)
vec3 viewPosFrom(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uProj.x * z, ndc.y * uProj.y * z, -z);
}
`;

/* ============================================================================ */
/* Ambient occlusion                                                            */
/* ============================================================================ */

const AO_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tGBuffer;
uniform vec2  uTexel;
uniform float uRadius;
uniform float uProjScale;
uniform float uBias;
uniform float uIntensity;
uniform float uMaxRadiusPx;
uniform float uFrame;
varying vec2 vUv;
${NOISE_GLSL}
${RECON_GLSL}

#ifndef AO_SAMPLES
#define AO_SAMPLES 14
#endif

void main() {
  vec4 g = texture2D(tGBuffer, vUv);
  float z = g.w;
  if (z <= 1e-4) { gl_FragColor = vec4(1.0); return; }

  vec3 n = normalize(g.xyz);
  vec3 p = viewPosFrom(vUv, z);

  float radiusPx = uRadius * uProjScale / z;
  radiusPx = clamp(radiusPx, 3.0, uMaxRadiusPx);

  float ang = h21(gl_FragCoord.xy + uFrame * 7.13) * 6.2831853;
  float occ = 0.0;
  float valid = 0.0;

  for (int i = 0; i < AO_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float a = ang + fi * 2.3999632;
    float rr = radiusPx * sqrt(fi / float(AO_SAMPLES));
    vec2 uvS = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
    if (uvS.x < 0.0 || uvS.x > 1.0 || uvS.y < 0.0 || uvS.y > 1.0) continue;
    vec4 gs = texture2D(tGBuffer, uvS);
    if (gs.w <= 1e-4) { valid += 1.0; continue; }
    vec3 s = viewPosFrom(uvS, gs.w);
    vec3 v = s - p;
    float vv = dot(v, v);
    float vn = dot(v, n);
    float falloff = 1.0 - min(vv / (uRadius * uRadius), 1.0);
    occ += max(0.0, vn - uBias * z) / (vv + 0.015) * falloff;
    valid += 1.0;
  }

  float ao = 1.0 - uIntensity * occ / max(valid, 1.0);
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0), z, 0.0, 1.0);
}
`;

class AOComputePass extends Pass {
  constructor(gbuffer, camera, w, h, samples = 14, scale = 1) {
    super();
    this.needsSwap = false;
    this.gbuffer = gbuffer;
    this.camera = camera;
    this.scale = scale;
    w = Math.max(2, Math.round(w * scale));
    h = Math.max(2, Math.round(h * scale));
    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.target.texture.name = 'BL4.AO';
    this.uniforms = {
      tGBuffer: { value: gbuffer.target.texture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uRadius: { value: 0.85 },
      uProjScale: { value: 500 },
      uBias: { value: 0.014 },
      uIntensity: { value: 1.55 },
      uMaxRadiusPx: { value: 72 },
      uProj: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BL4.AOCompute',
      defines: { AO_SAMPLES: samples },
      uniforms: this.uniforms,
      vertexShader: FS_VERT,
      fragmentShader: AO_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._h = h;
  }
  render(renderer) {
    const cam = this.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    this.uniforms.uProj.value.set(tanHalf * cam.aspect, tanHalf);
    this.uniforms.uProjScale.value = (this._h * 0.5) / tanHalf;
    this.uniforms.tGBuffer.value = this.gbuffer.target.texture;
    this.uniforms.uFrame.value = (this.uniforms.uFrame.value + 1) % 64;
    renderer.setRenderTarget(this.target);
    this.fsQuad.render(renderer);
  }
  setSize(w, h) {
    w = Math.max(2, Math.round(w * this.scale));
    h = Math.max(2, Math.round(h * this.scale));
    this.target.setSize(w, h);
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._h = h;
  }
  dispose() { this.target.dispose(); this.material.dispose(); this.fsQuad.dispose(); }
}

const AO_APPLY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tAO;
uniform sampler2D tGBuffer;
uniform vec2  uAOTexel;
uniform vec3  uTint;
uniform float uStrength;
uniform float uBand;
varying vec2 vUv;

float band3(float x) {
  float s = clamp(x, 0.0, 1.0) * 3.0;
  float i = floor(s), f = s - i;
  return (i + smoothstep(0.30, 0.70, f)) / 3.0;
}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float zC = texture2D(tGBuffer, vUv).w;
  if (zC <= 1e-4) { gl_FragColor = c; return; }

  // depth-aware 3x3 gather (also upsamples a half-res AO buffer cleanly)
  float sum = 0.0, wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uAOTexel;
      vec2 s = texture2D(tAO, vUv + o).xy;
      float w = exp(-abs(s.y - zC) * 5.0 / max(zC, 1.0));
      sum += s.x * w; wsum += w;
    }
  }
  float ao = wsum > 0.0 ? sum / wsum : 1.0;
  ao = mix(ao, band3(ao), uBand);
  float k = (1.0 - ao) * uStrength;
  gl_FragColor = vec4(c.rgb * mix(vec3(1.0), uTint, clamp(k, 0.0, 1.0)), c.a);
}
`;

class AOApplyPass extends Pass {
  constructor(aoPass, gbuffer, opts = {}) {
    super();
    this.aoPass = aoPass;
    this.gbuffer = gbuffer;
    this.uniforms = {
      tDiffuse: { value: null },
      tAO: { value: aoPass.target.texture },
      tGBuffer: { value: gbuffer.target.texture },
      uAOTexel: { value: new THREE.Vector2(1, 1) },
      uTint: { value: new THREE.Color(opts.tint ?? 0x3d4a5c) },
      uStrength: { value: opts.strength ?? 0.9 },
      uBand: { value: opts.band ?? 0.45 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BL4.AOApply',
      uniforms: this.uniforms,
      vertexShader: FS_VERT, fragmentShader: AO_APPLY_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tAO.value = this.aoPass.target.texture;
    this.uniforms.tGBuffer.value = this.gbuffer.target.texture;
    const s = this.aoPass.target;
    this.uniforms.uAOTexel.value.set(1 / s.width, 1 / s.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* ============================================================================ */
/* Camera motion blur                                                           */
/* ============================================================================ */

const MB_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tGBuffer;
uniform mat4  uCamWorld;
uniform mat4  uPrevVP;
uniform float uScale;
uniform float uMaxPx;
uniform vec2  uTexel;
uniform float uNearGuard;
varying vec2 vUv;
${NOISE_GLSL}
${RECON_GLSL}

#define MB_TAPS 7

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec4 g = texture2D(tGBuffer, vUv);
  float z = g.w;
  if (z <= 1e-4) { gl_FragColor = base; return; }

  vec3 vp = viewPosFrom(vUv, z);
  vec4 wp = uCamWorld * vec4(vp, 1.0);
  vec4 pc = uPrevVP * wp;
  if (pc.w <= 0.0) { gl_FragColor = base; return; }
  vec2 pUv = (pc.xy / pc.w) * 0.5 + 0.5;

  vec2 vel = (vUv - pUv) * uScale;
  // don't smear the viewmodel
  vel *= smoothstep(uNearGuard, uNearGuard * 2.2, z);

  float lenPx = length(vel / uTexel);
  if (lenPx < 0.75) { gl_FragColor = base; return; }
  if (lenPx > uMaxPx) vel *= uMaxPx / lenPx;

  float jitter = h21(gl_FragCoord.xy) - 0.5;
  vec3 acc = base.rgb; float wsum = 1.0;
  for (int i = 1; i < MB_TAPS; i++) {
    float t = (float(i) + jitter) / float(MB_TAPS - 1) - 0.5;
    vec2 uvS = vUv + vel * t;
    vec4 gs = texture2D(tGBuffer, uvS);
    // reject samples much closer to the camera (stops background eating foreground)
    float w = gs.w <= 1e-4 ? 1.0 : smoothstep(0.0, 1.0, 1.0 - max(0.0, (z - gs.w) / max(z, 1.0)) * 3.0);
    acc += texture2D(tDiffuse, uvS).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, base.a);
}
`;

class MotionBlurPass extends Pass {
  constructor(gbuffer, camera, opts = {}) {
    super();
    this.gbuffer = gbuffer;
    this.camera = camera;
    this.prevVP = new THREE.Matrix4();
    this._vp = new THREE.Matrix4();
    this._first = true;
    this.uniforms = {
      tDiffuse: { value: null },
      tGBuffer: { value: gbuffer.target.texture },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uScale: { value: opts.scale ?? 0.72 },
      uMaxPx: { value: opts.maxPx ?? 26 },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uNearGuard: { value: opts.nearGuard ?? 1.1 },
      uProj: { value: new THREE.Vector2(1, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BL4.MotionBlur',
      uniforms: this.uniforms,
      vertexShader: FS_VERT, fragmentShader: MB_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    this.uniforms.uProj.value.set(tanHalf * cam.aspect, tanHalf);
    this.uniforms.uCamWorld.value.copy(cam.matrixWorld);
    this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (this._first) { this.prevVP.copy(this._vp); this._first = false; }
    this.uniforms.uPrevVP.value.copy(this.prevVP);
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tGBuffer.value = this.gbuffer.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
    this.prevVP.copy(this._vp);
  }
  setSize(w, h) { this.uniforms.uTexel.value.set(1 / w, 1 / h); }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* ============================================================================ */
/* Depth of field                                                               */
/* ============================================================================ */

const DOF_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tGBuffer;
uniform vec2  uTexel;
uniform float uFocus;
uniform float uAperture;
uniform float uMaxCoC;
uniform float uNearGuard;
varying vec2 vUv;
${NOISE_GLSL}

#define DOF_TAPS 12

float cocOf(float z) {
  if (z <= 1e-4) return uMaxCoC * 0.30;         // sky sits at infinity
  float c = (z - uFocus) / max(z, 0.05) * uAperture;
  c = clamp(c, -uMaxCoC, uMaxCoC);
  // keep the viewmodel razor sharp
  c *= smoothstep(uNearGuard * 0.55, uNearGuard, z);
  return c;
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float zC = texture2D(tGBuffer, vUv).w;
  float cC = cocOf(zC);
  float r = abs(cC);
  if (r < 0.6) { gl_FragColor = base; return; }

  float ang = h21(gl_FragCoord.xy) * 6.2831853;
  vec3 acc = base.rgb; float wsum = 1.0;
  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = float(i) + 0.5;
    float a = ang + fi * 2.3999632;
    float rr = r * sqrt(fi / float(DOF_TAPS));
    vec2 uvS = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
    float zs = texture2D(tGBuffer, uvS).w;
    float cs = cocOf(zs);
    // a sample only bleeds in if its own circle of confusion reaches this pixel
    float w = clamp((abs(cs) - rr) * 0.5 + 1.0, 0.0, 1.0);
    if (zs > zC + 0.25 && zs > 1e-4) w *= 1.0;
    acc += texture2D(tDiffuse, uvS).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, base.a);
}
`;

class DofPass extends Pass {
  constructor(gbuffer, opts = {}) {
    super();
    this.gbuffer = gbuffer;
    this.uniforms = {
      tDiffuse: { value: null },
      tGBuffer: { value: gbuffer.target.texture },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uFocus: { value: 24 },
      uAperture: { value: opts.aperture ?? 1.5 },
      uMaxCoC: { value: opts.maxCoC ?? 3.0 },
      uNearGuard: { value: opts.nearGuard ?? 1.1 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BL4.DOF',
      uniforms: this.uniforms,
      vertexShader: FS_VERT, fragmentShader: DOF_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tGBuffer.value = this.gbuffer.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  setSize(w, h) { this.uniforms.uTexel.value.set(1 / w, 1 / h); }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* ============================================================================ */
/* Grade: CA -> tonemap -> lift/gamma/gain -> flash -> vignette -> grain         */
/* ============================================================================ */

const GRADE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uTime;
uniform float uExposure;
uniform float uBleach;

uniform float uCA;
uniform float uGrain;
uniform float uVignette;
uniform float uVignetteSoft;

uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uTintAmount;
uniform float uSaturation;
uniform float uContrast;
uniform float uToe;

uniform float uHitFlash;
uniform float uLowHealth;

varying vec2 vUv;
${NOISE_GLSL}
${TONEMAP_GLSL}

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);

  /* ---- chromatic aberration: edges only ---------------------------------- */
  vec3 col;
  // ~2.5 device px of split at the extreme corner, zero in the centre
  float ca = uCA * (r2 * r2) * 0.055;
  if (ca > 1e-6) {
    vec2 dir = cc * ca;
    col.r = texture2D(tDiffuse, uv + dir).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - dir).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  /* ---- tone map, then move into a perceptual space to grade --------------- */
  col = bl4ToneMap(col, uExposure, uBleach);
  col = pow(max(col, vec3(0.0)), vec3(0.4545454545));

  /* ---- lift / gamma / gain ------------------------------------------------ */
  col = clamp(col * uGain + uLift, 0.0, 1.0);
  col = pow(col, uGamma);

  /* ---- split tone: teal shadows, warm highlights -------------------------- */
  float l = dot(col, LUMA);
  vec3 sh = mix(col, col * uShadowTint * 1.35, uTintAmount * (1.0 - smoothstep(0.0, 0.55, l)));
  vec3 hi = mix(sh, sh * uHighlightTint, uTintAmount * smoothstep(0.45, 1.0, l));
  col = hi;

  /* ---- contrast (filmic S-curve about mid grey) + saturation -------------- */
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uToe);
  l = dot(col, LUMA);
  col = clamp(mix(vec3(l), col, uSaturation), 0.0, 1.0);

  /* ---- damage feedback ---------------------------------------------------- */
  if (uLowHealth > 0.001) {
    float pulse = 0.62 + 0.38 * sin(uTime * 5.2);
    float edge = smoothstep(0.06, 0.36, r2);
    col = mix(col, vec3(dot(col, LUMA)), uLowHealth * 0.45);
    col = mix(col, vec3(0.55, 0.03, 0.05), uLowHealth * edge * 0.55 * pulse);
  }
  if (uHitFlash > 0.001) {
    col = mix(col, vec3(0.85, 0.12, 0.10), uHitFlash * (0.16 + 0.5 * smoothstep(0.02, 0.30, r2)));
  }

  /* ---- vignette ------------------------------------------------------------ */
  float vig = 1.0 - uVignette * smoothstep(uVignetteSoft, 0.52, r2);
  col *= vig;

  /* ---- film grain (finer in the highlights, like real stock) -------------- */
  if (uGrain > 0.0001) {
    float n = h13(vec3(gl_FragCoord.xy, floor(uTime * 24.0)));
    float lum = dot(col, LUMA);
    col += (n - 0.5) * uGrain * mix(0.10, 0.028, lum);
  }

  /* ---- ordered dither kills 8-bit banding in the cel bands ---------------- */
  float d = h21(gl_FragCoord.xy * 1.37) - 0.5;
  col += d * (1.5 / 255.0);

  /* ---- back to linear for the output transform ---------------------------- */
  col = pow(max(col, vec3(0.0)), vec3(2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

class GradePass extends Pass {
  constructor(opts = {}) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uTime: { value: 0 },
      uExposure: { value: 1.0 },
      uBleach: { value: 0.35 },
      uCA: { value: 1.0 },
      uGrain: { value: 1.0 },
      uVignette: { value: 0.42 },
      uVignetteSoft: { value: 0.06 },
      uLift: { value: new THREE.Vector3(-0.004, 0.002, 0.014) },
      uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.02) },
      uGain: { value: new THREE.Vector3(1.05, 1.005, 0.955) },
      uShadowTint: { value: new THREE.Color(0.62, 0.78, 0.92) },
      uHighlightTint: { value: new THREE.Color(1.06, 1.0, 0.90) },
      uTintAmount: { value: 0.55 },
      uSaturation: { value: 1.16 },
      uContrast: { value: 1.06 },
      uToe: { value: 0.16 },
      uHitFlash: { value: 0 },
      uLowHealth: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BL4.Grade',
      uniforms: this.uniforms,
      vertexShader: FS_VERT, fragmentShader: GRADE_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer, deltaTime) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uTime.value += deltaTime || 0.016;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  setSize(w, h) { this.uniforms.uTexel.value.set(1 / w, 1 / h); }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* ============================================================================ */
/* PostFX                                                                       */
/* ============================================================================ */

const _size = new THREE.Vector2();

export class PostFX {
  constructor(ctx) {
    this.ctx = ctx;
    const { renderer, scene, camera } = ctx;
    const fx = cfg.postfx || {};
    // dev override: ?fxoff=bloom,ao,ink,dof,smaa,mb,sky  (profiling / bug isolation)
    const _off = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('fxoff')) || '';
    const off = new Set(_off ? _off.split(',') : []);
    this._off = off;

    // The light rig lives here so the whole render core comes up as one unit even
    // if the world module has not adopted the API yet.
    this.lighting = installLightRig(ctx, off.has('sky') ? { sky: false, ibl: false } : undefined);

    this.renderScale = cfg.renderScale ?? (cfg.capture ? 1.0 : (cfg.quality === 'ultra' ? 1.15 : 1.0));
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x * this.renderScale));
    const h = Math.max(2, Math.round(_size.y * this.renderScale));

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);

    // 1. G-buffer (needed by ink, AO, motion blur, DOF)
    this.needGBuffer = fx.outlines !== false || fx.ssao !== false || fx.motionBlur !== false || fx.dof !== false;
    if (this.needGBuffer) {
      this.gbuffer = new GBufferPass(scene, camera, w, h);
      this.composer.addPass(this.gbuffer);
    }

    // 2. scene
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // 3. ink outlines
    if (fx.outlines !== false && !off.has('ink') && this.gbuffer) {
      this.ink = new InkOutlinePass(this.gbuffer, camera);
      this.composer.addPass(this.ink);
    }

    // 4. ambient occlusion
    if (fx.ssao !== false && !off.has('ao') && this.gbuffer) {
      const aoScale = cfg.capture ? 1.0 : 0.65;
      this.ao = new AOComputePass(this.gbuffer, camera, w, h, cfg.capture ? 16 : 12, aoScale);
      this.aoApply = new AOApplyPass(this.ao, this.gbuffer);
      this.composer.addPass(this.ao);
      this.composer.addPass(this.aoApply);
    }

    // 5. selective bloom — HDR threshold, so only emissives and the sun blow out
    if (fx.bloom !== false && !off.has('bloom')) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.62, 0.72, 1.0);
      this.composer.addPass(this.bloom);
    }

    // 6. camera motion blur
    if (fx.motionBlur !== false && !off.has('mb') && this.gbuffer) {
      this.motionBlur = new MotionBlurPass(this.gbuffer, camera);
      this.composer.addPass(this.motionBlur);
    }

    // 7. depth of field
    if (fx.dof !== false && !off.has('dof') && this.gbuffer) {
      this.dof = new DofPass(this.gbuffer);
      this.composer.addPass(this.dof);
    }

    // 8. grade / CA / grain / vignette
    this.grade = new GradePass();
    this.composer.addPass(this.grade);
    if (fx.chromatic === false) this.grade.uniforms.uCA.value = 0;
    if (fx.grain === false) this.grade.uniforms.uGrain.value = 0;
    if (fx.vignette === false) this.grade.uniforms.uVignette.value = 0;

    // 9. AA
    if (fx.taa !== false && !off.has('smaa')) {
      this.smaa = new SMAAPass(w, h);
      this.composer.addPass(this.smaa);
    }

    // 10. output transform
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // ---- optional per-pass profiler (?pfxstats) --------------------------------
    if (typeof location !== 'undefined' && location.search.includes('pfxstats')) this._instrument();

    // ---- driver state ---------------------------------------------------------
    this._ads = 0;
    this._adsTarget = 0;
    this._focus = 30;
    this._focusTarget = 30;
    this._hitFlash = 0;
    this._lowHealth = 0;

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);

    if (cfg.capture) {
      // deterministic: no animated grain crawl, no motion smear in a still
      this.grade.uniforms.uGrain.value = 0.65;
      if (this.motionBlur) this.motionBlur.enabled = false;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Public setters (other systems drive these)                                */
  /* ------------------------------------------------------------------------ */

  /** Focus distance in metres. Weapons/Player call this with the aim-trace hit. */
  setDofFocus(dist) {
    if (!isFinite(dist)) return;
    this._focusTarget = THREE.MathUtils.clamp(dist, 0.4, 400);
  }

  /** 0 = hip fire, 1 = fully aiming down sights. Drives DOF + vignette + FOV feel. */
  setAdsBlend(t) { this._adsTarget = THREE.MathUtils.clamp(t || 0, 0, 1); }

  /** Punch of red when the player takes a hit. Decays on its own. */
  setHitFlash(v) { this._hitFlash = Math.max(this._hitFlash, THREE.MathUtils.clamp(v || 0, 0, 1)); }

  /** 0 = healthy, 1 = critical. Desaturates and pulses a red edge. */
  setLowHealth(t) { this._lowHealth = THREE.MathUtils.clamp(t || 0, 0, 1); }

  setExposure(ev) { this.ctx.renderer.toneMappingExposure = ev; }

  setBloom({ strength, radius, threshold } = {}) {
    if (!this.bloom) return;
    if (strength !== undefined) this.bloom.strength = strength;
    if (radius !== undefined) this.bloom.radius = radius;
    if (threshold !== undefined) this.bloom.threshold = threshold;
  }

  setOutline(p) { this.ink?.setParams(p); return this; }

  setGrade(p = {}) {
    const u = this.grade.uniforms;
    if (p.saturation !== undefined) u.uSaturation.value = p.saturation;
    if (p.contrast !== undefined) u.uContrast.value = p.contrast;
    if (p.toe !== undefined) u.uToe.value = p.toe;
    if (p.bleach !== undefined) u.uBleach.value = p.bleach;
    if (p.vignette !== undefined) u.uVignette.value = p.vignette;
    if (p.grain !== undefined) u.uGrain.value = p.grain;
    if (p.chromatic !== undefined) u.uCA.value = p.chromatic;
    if (p.tintAmount !== undefined) u.uTintAmount.value = p.tintAmount;
    if (p.lift) u.uLift.value.fromArray(p.lift);
    if (p.gamma) u.uGamma.value.fromArray(p.gamma);
    if (p.gain) u.uGain.value.fromArray(p.gain);
    if (p.shadowTint !== undefined) u.uShadowTint.value.set(p.shadowTint);
    if (p.highlightTint !== undefined) u.uHighlightTint.value.set(p.highlightTint);
    return this;
  }

  setAO(p = {}) {
    if (!this.ao) return this;
    if (p.radius !== undefined) this.ao.uniforms.uRadius.value = p.radius;
    if (p.intensity !== undefined) this.ao.uniforms.uIntensity.value = p.intensity;
    if (p.strength !== undefined) this.aoApply.uniforms.uStrength.value = p.strength;
    if (p.tint !== undefined) this.aoApply.uniforms.uTint.value.set(p.tint);
    if (p.band !== undefined) this.aoApply.uniforms.uBand.value = p.band;
    return this;
  }

  setTimeOfDay(t) { this.lighting?.setTimeOfDay(t); return this; }

  /* ------------------------------------------------------------------------ */

  resize() {
    const { renderer, camera } = this.ctx;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x * this.renderScale));
    const h = Math.max(2, Math.round(_size.y * this.renderScale));
    this.composer.setSize(w, h);
    this.lighting?.onResize();
  }

  render(dt) {
    const d = Math.min(dt || 0.016, 0.1);

    // The rig fits its cascades to the camera that is about to be rendered.
    this.lighting?.update(d);

    // smooth the ADS / focus drivers
    const k = 1 - Math.exp(-d * 12);
    this._ads += (this._adsTarget - this._ads) * k;
    this._focus += (this._focusTarget - this._focus) * (1 - Math.exp(-d * 6));
    this._hitFlash = Math.max(0, this._hitFlash - d * 3.2);

    if (this.dof) {
      const u = this.dof.uniforms;
      u.uFocus.value = this._focus;
      u.uAperture.value = 0.9 + this._ads * 3.4;
      u.uMaxCoC.value = (2.0 + this._ads * 5.5) * this.renderScale;
    }
    if (this.motionBlur) {
      this.motionBlur.uniforms.uScale.value = 0.62 * (1 - this._ads * 0.5);
    }
    const g = this.grade.uniforms;
    g.uExposure.value = this.ctx.renderer.toneMappingExposure;
    g.uHitFlash.value = this._hitFlash;
    g.uLowHealth.value = this._lowHealth;
    g.uVignette.value = 0.42 + this._ads * 0.22;
    g.uCA.value = (cfg.postfx?.chromatic === false ? 0 : 1) * (1.0 + this._ads * 0.5);

    this.composer.render(d);
  }

  /** Wraps every pass's render() with a CPU timer. Results in window.__PFX_STATS__. */
  _instrument() {
    const stats = {};
    window.__PFX_STATS__ = stats;
    for (const pass of this.composer.passes) {
      const name = pass.constructor.name;
      const orig = pass.render.bind(pass);
      stats[name] = 0;
      pass.render = (...a) => {
        const t = performance.now();
        orig(...a);
        this.ctx.renderer.getContext().flush();
        stats[name] = stats[name] * 0.9 + (performance.now() - t) * 0.1;
      };
    }
  }

  dispose() {
    removeEventListener('resize', this._onResize);
    this.gbuffer?.dispose();
    this.ink?.dispose();
    this.ao?.dispose();
    this.aoApply?.dispose();
    this.motionBlur?.dispose();
    this.dof?.dispose();
    this.grade?.dispose();
    this.composer?.dispose?.();
  }
}

export default PostFX;
