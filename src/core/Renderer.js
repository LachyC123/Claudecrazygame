/**
 * BORDERLINE 4 — RENDERER / COLOUR PIPELINE
 * ==================================================================================
 * Owns the WebGL context, the shadow configuration and the colour pipeline contract
 * that every other module renders into.
 *
 * COLOUR PIPELINE (important — read before touching a material)
 * ----------------------------------------------------------------------------------
 *   scene  --(linear HDR, values may exceed 1.0)-->  EffectComposer half-float targets
 *          --(PostFX: ink, AO, bloom, blur, DOF)-->  still linear HDR
 *          --(PostFX grade pass: exposure + filmic tonemap + lift/gamma/gain)--> linear LDR
 *          --(SMAA)--> --(OutputPass: linear -> sRGB)--> canvas
 *
 * Because tone mapping happens inside PostFX (so the grade can work on real HDR
 * values and the bloom threshold can be a physical luminance), `renderer.toneMapping`
 * is deliberately left at NoToneMapping. Do not change it — OutputPass would then
 * double-tonemap the already-graded image.
 *
 * EXPOSURE
 *   Use `setExposure(renderer, ev)` or `ctx.postfx.setExposure(ev)`. Both write the
 *   same value; `renderer.toneMappingExposure` is the single source of truth and the
 *   grade pass reads it every frame.
 * ==================================================================================
 */

import * as THREE from 'three';
import { cfg } from './Config.js';

/** Layer used by sky / background geometry: rendered by the camera, skipped by the
 *  ink-outline G-buffer prepass so that silhouettes read against the sky. */
export const LAYER_SKY = 3;

/** Runtime capability report, filled by createRenderer(). */
export const RENDER_CAPS = {
  webgl2: false,
  maxSamples: 0,
  maxTextureSize: 0,
  floatBlend: false,
  anisotropy: 1,
};

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,               // SMAA + supersample in PostFX instead
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: cfg.capture,
    failIfMajorPerformanceCaveat: false,
  });

  renderer.setPixelRatio(cfg.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);

  // ---- colour pipeline -------------------------------------------------------
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping is performed by PostFX's grade pass. See header.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  // ---- shadows ---------------------------------------------------------------
  renderer.shadowMap.enabled = !!cfg.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.autoClear = true;
  renderer.info.autoReset = true;
  renderer.sortObjects = true;

  // Cel shading has zero tolerance for banding in the dark bands — dithering the
  // 8-bit output is cheap insurance.
  renderer.domElement.style.imageRendering = 'auto';

  const gl = renderer.getContext();
  RENDER_CAPS.webgl2 = renderer.capabilities.isWebGL2 !== false;
  RENDER_CAPS.maxTextureSize = renderer.capabilities.maxTextureSize;
  RENDER_CAPS.anisotropy = renderer.capabilities.getMaxAnisotropy();
  try { RENDER_CAPS.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0; } catch (e) { RENDER_CAPS.maxSamples = 0; }
  RENDER_CAPS.floatBlend = !!renderer.extensions.get('EXT_float_blend');

  container.appendChild(renderer.domElement);
  return renderer;
}

/** Single source of truth for exposure; PostFX's grade pass reads this each frame. */
export function setExposure(renderer, ev) {
  renderer.toneMappingExposure = ev;
}

/**
 * GLSL for the house tone mapping curve. Used by PostFX's grade pass.
 *
 * A straight ACES fit crushes chroma, which is exactly wrong for a cel-shaded game —
 * the flat colour bands are the art. This is a filmic shoulder applied to the *norm*
 * of the colour rather than per-channel, so hue and saturation survive the highlight
 * roll-off; a small per-channel blend is mixed back in so speculars and muzzle flashes
 * still bleach toward white the way film does.
 */
export const TONEMAP_GLSL = /* glsl */ `
vec3 bl4Filmic(vec3 x) {
  // Hable-ish shoulder
  const float A = 0.22, B = 0.30, C = 0.10, D = 0.20, E = 0.011, F = 0.22;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 bl4ToneMap(vec3 c, float exposure, float bleach) {
  c = max(c * exposure, vec3(0.0));
  const float W = 11.2;
  float wScale = 1.0 / bl4Filmic(vec3(W)).x;

  // per-channel (bleaches toward white)
  vec3 perCh = bl4Filmic(c) * wScale;

  // hue preserving: tonemap the peak, scale the colour by the same ratio
  float pk = max(c.r, max(c.g, c.b));
  float pkT = bl4Filmic(vec3(pk)).x * wScale;
  vec3 hue = c * (pk > 1e-5 ? pkT / pk : 0.0);

  return clamp(mix(hue, perCh, clamp(bleach, 0.0, 1.0)), 0.0, 1.0);
}
`;
