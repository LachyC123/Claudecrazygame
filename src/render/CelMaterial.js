/**
 * BORDERLINE 4 — CEL MATERIAL SYSTEM
 * ==================================================================================
 * The identity of the whole game. Every surface in the world should use this.
 *
 * It is NOT a replacement for PBR — it is a *patch* on THREE.MeshStandardMaterial
 * applied through onBeforeCompile, so you keep: real lights, CSM shadows, normal
 * maps, roughness/metalness, IBL/environment, vertex colors, instancing, skinning.
 * On top of that it adds:
 *
 *   • 2–4 band quantized diffuse ramp with a hard terminator (warm light / cool shadow)
 *   • hand-inked cross-hatch blended into the shadow band (triplanar + screen stipple)
 *   • fresnel rim light in a warm key colour to pop silhouettes off the background
 *   • painterly multi-octave grain in the albedo so nothing reads as flat vector fill
 *   • banded ("blobby") specular instead of a smooth PBR highlight
 *   • directional aerial perspective fog (horizon vs zenith vs sun inscatter)
 *
 * ----------------------------------------------------------------------------------
 * QUICK USE
 * ----------------------------------------------------------------------------------
 *   import { createCelMaterial } from '../render/index.js';
 *
 *   const mat = createCelMaterial({ color: 0xc8a06a, roughness: 0.9 });
 *   const mesh = new THREE.Mesh(geo, mat);
 *
 * For InstancedMesh:
 *   const mat = createCelInstancedMaterial({ color: 0xffffff, vertexColors: false });
 *   // per-instance colours work normally via mesh.setColorAt()
 *
 * To cel-ify a material you already built:
 *   makeCel(existingStandardMaterial, { rimColor: 0xffc98a });
 *
 * To opt a material OUT of the automatic cel pass (see Lighting.autoAdopt):
 *   material.userData.noCel = true;
 *
 * ----------------------------------------------------------------------------------
 * OPTIONS  (all optional; anything MeshStandardMaterial accepts is passed through)
 * ----------------------------------------------------------------------------------
 *   color, map, normalMap, roughnessMap, metalnessMap, emissive, emissiveIntensity,
 *   roughness, metalness, transparent, opacity, side, flatShading, vertexColors, ...
 *
 *   bands        (number, default 3)     diffuse quantization steps
 *   bandSoftness (number, default 0.035) 0 = razor terminator, 0.15 = airbrushed
 *   bandFloor    (number, default 0.06)  darkest band multiplier (0 = pure ambient)
 *   warm         (hex,  default 0xfff2dc) tint of the lit bands
 *   cool         (hex,  default 0x8fb6d8) tint of the shadow band
 *   rimColor     (hex,  default 0xffcf95)
 *   rimPower     (number, default 2.6)
 *   rimStrength  (number, default 0.55)   0 disables rim
 *   rimRange     (number, default 90)     metres at which rim has faded out
 *   hatch        (number, default 1.0)    cross-hatch amount in shadow (0 disables)
 *   hatchScale   (number, default 5.0)    lines per world metre
 *   grain        (number, default 1.0)    painterly albedo grain (0 disables)
 *   grainScale   (number, default 1.6)
 *   specBand     (number, default 1.0)    0 = smooth PBR spec, 1 = hard toon blob
 *   wobble       (number, default 0.06)   hand-drawn jitter of the terminator
 *   fog          (bool,  default true)    use the directional aerial-perspective fog
 *   outlineWidth (number, default 1.0)    hint consumed by the ink pass (userData)
 *
 * ----------------------------------------------------------------------------------
 * SHARED GLOBALS
 * ----------------------------------------------------------------------------------
 * `CEL_GLOBALS` is a single uniform block whose uniform *objects* are injected by
 * reference into every cel material. Mutating `CEL_GLOBALS.uCelSunDir.value` (etc.)
 * instantly re-lights every cel surface in the game — that is how time-of-day works.
 * Lighting.js owns it; you should normally not write to it directly.
 * ==================================================================================
 */

import * as THREE from 'three';

const _c = (v) => (v instanceof THREE.Color ? v.clone() : new THREE.Color(v));

/** Shared uniform block — injected by reference into every cel material. */
export const CEL_GLOBALS = {
  uCelTime:        { value: 0 },
  uCelSunDir:      { value: new THREE.Vector3(0.46, 0.62, 0.63).normalize() },
  uCelSunColor:    { value: new THREE.Color(0xffe6bd) },
  uCelKeyIrr:      { value: 3.1 },      // luminance of the unshadowed key light
  uCelAmbTint:     { value: new THREE.Color(0xbcd2e6) },
  uCelAmbGain:     { value: 1.0 },
  uCelExposure:    { value: 1.0 },
  // aerial perspective
  uCelFogHorizon:  { value: new THREE.Color(0xcbd8d2) },
  uCelFogZenith:   { value: new THREE.Color(0x87a9bd) },
  uCelFogSun:      { value: new THREE.Color(0xffd39a) },
  uCelFogDensity:  { value: 0.0021 },
  uCelFogHeight:   { value: 46.0 },
  uCelFogFloor:    { value: -4.0 },
  uCelAerial:      { value: 1.0 },
  // global art dials
  uCelHatchGlobal: { value: 1.0 },
  uCelGrainGlobal: { value: 1.0 },
  uCelRimGlobal:   { value: 1.0 },
  uCelDetailFade:  { value: new THREE.Vector2(34.0, 130.0) }, // hatch/grain fade start,end
};

/** Advance shared animated globals. Called once per frame by Lighting/PostFX. */
export function updateCelGlobals(dt) {
  CEL_GLOBALS.uCelTime.value += dt;
}

/* ---------------------------------------------------------------------------- */
/* GLSL                                                                          */
/* ---------------------------------------------------------------------------- */

const CEL_COMMON = /* glsl */ `
uniform float uCelTime;
uniform vec3  uCelSunDir;
uniform vec3  uCelSunColor;
uniform float uCelKeyIrr;
uniform vec3  uCelAmbTint;
uniform float uCelAmbGain;
uniform vec3  uCelFogHorizon;
uniform vec3  uCelFogZenith;
uniform vec3  uCelFogSun;
uniform float uCelFogDensity;
uniform float uCelFogHeight;
uniform float uCelFogFloor;
uniform float uCelAerial;
uniform float uCelHatchGlobal;
uniform float uCelGrainGlobal;
uniform float uCelRimGlobal;
uniform vec2  uCelDetailFade;

uniform float uCelBands;
uniform float uCelBandSoft;
uniform float uCelBandFloor;
uniform vec3  uCelWarm;
uniform vec3  uCelCool;
uniform vec3  uCelRimColor;
uniform float uCelRimPower;
uniform float uCelRimStrength;
uniform float uCelRimRange;
uniform float uCelHatch;
uniform float uCelHatchScale;
uniform float uCelGrain;
uniform float uCelGrainScale;
uniform float uCelSpecBand;
uniform float uCelWobble;

varying vec3 vCelWorldPos;

const vec3 CEL_LUMA = vec3(0.2126, 0.7152, 0.0722);

float celHash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float celHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float celNoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = celHash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = celHash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = celHash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = celHash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = celHash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = celHash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = celHash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = celHash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

// Quantize 0..1 lighting into hard bands with a controllable terminator width.
float celQuantize(float t, float bands, float soft) {
  float x = clamp(t, 0.0, 1.0);
  float s = x * bands;
  float i = floor(s);
  float f = s - i;
  float w = clamp(soft * bands, 0.0008, 0.49);
  float e = smoothstep(0.5 - w, 0.5 + w, f);
  return clamp((i + e) / bands, 0.0, 1.0);
}

// A single family of ink strokes at a given angle.
float celStroke(vec2 p, float freq, float ang, float width) {
  vec2 d = vec2(cos(ang), sin(ang));
  float v = dot(p, d) * freq;
  // slight wobble so lines are not machine-straight
  v += sin(dot(p, vec2(-d.y, d.x)) * freq * 0.37) * 0.12;
  float s = abs(fract(v) - 0.5) * 2.0;
  return smoothstep(width, width + 0.42, s);
}

// Triplanar cross-hatch, dominant-axis projected (cheap, world stable).
float celHatchAmount(vec3 wp, vec3 n, vec2 screen, float fade) {
  vec3 an = abs(n);
  vec2 uv;
  if (an.y > an.x && an.y > an.z)      uv = wp.xz;
  else if (an.x > an.z)                uv = wp.zy;
  else                                 uv = wp.xy;
  float f = uCelHatchScale;
  float a = celStroke(uv, f, 0.62, 0.30);
  float b = celStroke(uv, f * 1.31, -0.85, 0.34);
  float h = min(a, b * 0.6 + 0.4);
  // screen-space stipple keeps it feeling like printed ink
  float stip = celHash21(floor(screen * 0.5) + 0.5);
  h *= mix(1.0, 0.82 + 0.18 * stip, 0.55);
  return mix(1.0, h, clamp(uCelHatch * uCelHatchGlobal, 0.0, 1.0) * fade);
}
`;

const CEL_VERT_HEAD = /* glsl */ `
varying vec3 vCelWorldPos;
`;

const CEL_VERT_BODY = /* glsl */ `
  vec4 celWP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    celWP = batchingMatrix * celWP;
  #endif
  #ifdef USE_INSTANCING
    celWP = instanceMatrix * celWP;
  #endif
  vCelWorldPos = (modelMatrix * celWP).xyz;
`;

// Painterly albedo grain, injected right after <color_fragment>.
const CEL_GRAIN = /* glsl */ `
{
  float gAmt = clamp(uCelGrain * uCelGrainGlobal, 0.0, 2.0);
  if (gAmt > 0.001) {
    float gFade = 1.0 - smoothstep(uCelDetailFade.x * 2.2, uCelDetailFade.y * 1.6,
                                   distance(cameraPosition, vCelWorldPos));
    vec3 gp = vCelWorldPos * uCelGrainScale;
    float n1 = celNoise3(gp);
    float n2 = celNoise3(gp * 3.71 + 13.7);
    float n3 = celNoise3(gp * 11.3 + 5.1);
    float gv = (n1 - 0.5) * 0.62 + (n2 - 0.5) * 0.28 + (n3 - 0.5) * 0.10;
    gv *= gAmt * gFade;
    diffuseColor.rgb *= 1.0 + gv * 0.34;
    // subtle pigment bleed: warm where thick, cool where thin
    diffuseColor.rgb = mix(diffuseColor.rgb,
      diffuseColor.rgb * mix(vec3(0.90, 0.95, 1.06), vec3(1.09, 1.00, 0.88), gv * 2.0 + 0.5),
      0.55 * gAmt * gFade);
  }
}
`;

// The main event — replaces the accumulated PBR response with a banded one.
const CEL_LIGHT = /* glsl */ `
{
  vec3 celNw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 celToCam = cameraPosition - vCelWorldPos;
  float celDist = length(celToCam);
  vec3 celV = celToCam / max(celDist, 1e-4);
  float celFade = 1.0 - smoothstep(uCelDetailFade.x, uCelDetailFade.y, celDist);

  // ---- 1. band the direct diffuse -------------------------------------------
  vec3  dd   = reflectedLight.directDiffuse;
  float ddl  = max(dot(dd, CEL_LUMA), 0.0);
  float albL = max(dot(diffuseColor.rgb, CEL_LUMA), 0.025);
  vec3  chroma = ddl > 1e-5 ? dd / ddl : vec3(1.0);
  float E = ddl * PI / albL;                       // ~= incident irradiance luminance
  float t = E / max(uCelKeyIrr, 1e-3);

  // hand-drawn wobble on the terminator
  float wob = (celNoise3(vCelWorldPos * 2.3) - 0.5) * uCelWobble * celFade;
  t = clamp(t + wob, 0.0, 1.3);

  float q  = celQuantize(t, uCelBands, uCelBandSoft);
  float qf = mix(uCelBandFloor, 1.0, q);
  vec3  ramp = mix(uCelCool, uCelWarm, smoothstep(0.02, 0.85, q));

  float hatch = celHatchAmount(vCelWorldPos, celNw, gl_FragCoord.xy, celFade);
  float hatchLit = mix(hatch, 1.0, smoothstep(0.20, 0.72, q));

  reflectedLight.directDiffuse =
      diffuseColor.rgb * chroma * ramp * (qf * uCelKeyIrr * RECIPROCAL_PI) * hatchLit;

  // ---- 2. cool, hatched ambient ---------------------------------------------
  reflectedLight.indirectDiffuse *= uCelAmbTint * uCelAmbGain * mix(hatch, 1.0, 0.45);

  // ---- 3. hard toon specular blob -------------------------------------------
  if (uCelSpecBand > 0.001) {
    vec3  sp  = reflectedLight.directSpecular;
    float sl  = dot(sp, CEL_LUMA);
    float sq  = smoothstep(0.055, 0.135, sl);
    vec3  hard = mix(sp * 0.18, sp * 2.35 + uCelSunColor * 0.035, sq);
    reflectedLight.directSpecular = mix(sp, hard, uCelSpecBand);
    reflectedLight.indirectSpecular *= mix(1.0, 0.65, uCelSpecBand);
  }

  // ---- 4. fresnel rim --------------------------------------------------------
  float rimAmt = uCelRimStrength * uCelRimGlobal;
  if (rimAmt > 0.001) {
    float fres = pow(1.0 - clamp(dot(celNw, celV), 0.0, 1.0), uCelRimPower);
    float back = clamp(dot(celNw, -uCelSunDir) * 0.5 + 0.5, 0.0, 1.0);
    float rim = fres * rimAmt;
    rim *= mix(1.0, 0.34, smoothstep(0.30, 0.92, q));          // strongest in shadow
    rim *= mix(0.45, 1.35, back);                              // strongest when backlit
    rim *= 1.0 - smoothstep(uCelRimRange * 0.45, uCelRimRange, celDist);
    totalEmissiveRadiance += uCelRimColor * rim *
        mix(vec3(1.0), diffuseColor.rgb * 1.6 + 0.25, 0.45);
  }
}
`;

// Directional aerial perspective. Replaces <fog_fragment>.
const CEL_FOG = /* glsl */ `
#ifdef USE_FOG
{
  vec3 fv = vCelWorldPos - cameraPosition;
  float fd = length(fv);
  fv /= max(fd, 1e-4);
  float hMid = max((vCelWorldPos.y + cameraPosition.y) * 0.5 - uCelFogFloor, 0.0);
  float dens = uCelFogDensity * exp(-hMid / max(uCelFogHeight, 1.0));
  float ff = 1.0 - exp(-dens * dens * fd * fd);
  float up = clamp(fv.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 fc = mix(uCelFogHorizon, uCelFogZenith, smoothstep(0.50, 0.94, up));
  float sdot = max(dot(fv, uCelSunDir), 0.0);
  fc += uCelFogSun * (pow(sdot, 5.0) * 0.55 + pow(sdot, 24.0) * 0.85);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, clamp(ff, 0.0, 1.0) * uCelAerial);
}
#endif
`;

/* ---------------------------------------------------------------------------- */
/* Patching                                                                      */
/* ---------------------------------------------------------------------------- */

function celUniformsFor(o = {}) {
  return {
    uCelBands:      { value: o.bands ?? 3.0 },
    uCelBandSoft:   { value: o.bandSoftness ?? 0.035 },
    uCelBandFloor:  { value: o.bandFloor ?? 0.06 },
    uCelWarm:       { value: _c(o.warm ?? 0xfff2dc) },
    uCelCool:       { value: _c(o.cool ?? 0x8fb6d8) },
    uCelRimColor:   { value: _c(o.rimColor ?? 0xffcf95) },
    uCelRimPower:   { value: o.rimPower ?? 2.6 },
    uCelRimStrength:{ value: o.rimStrength ?? 0.55 },
    uCelRimRange:   { value: o.rimRange ?? 90.0 },
    uCelHatch:      { value: o.hatch ?? 1.0 },
    uCelHatchScale: { value: o.hatchScale ?? 5.0 },
    uCelGrain:      { value: o.grain ?? 1.0 },
    uCelGrainScale: { value: o.grainScale ?? 1.6 },
    uCelSpecBand:   { value: o.specBand ?? 1.0 },
    uCelWobble:     { value: o.wobble ?? 0.06 },
  };
}

/**
 * Patch an existing MeshStandardMaterial (or MeshPhysicalMaterial) in place.
 * Idempotent. Returns the same material.
 */
export function makeCel(material, opts = {}) {
  if (!material || material.userData?.cel) return material;
  if (!(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return material;
  if (material.userData?.noCel) return material;

  material.userData = material.userData || {};
  material.userData.cel = true;
  material.userData.outlineWidth = opts.outlineWidth ?? 1.0;

  const own = celUniformsFor(opts);
  material.userData.celUniforms = own;

  const useFog = opts.fog !== false;
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);

    for (const k in CEL_GLOBALS) if (!shader.uniforms[k]) shader.uniforms[k] = CEL_GLOBALS[k];
    for (const k in own) shader.uniforms[k] = own[k];

    // --- vertex ---
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + CEL_VERT_HEAD)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + CEL_VERT_BODY);

    // --- fragment ---
    let fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CEL_COMMON)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + CEL_GRAIN)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + CEL_LIGHT);

    if (useFog) fs = fs.replace('#include <fog_fragment>', CEL_FOG);
    shader.fragmentShader = fs;

    material.userData.shader = shader;
  };

  material.customProgramCacheKey = function () {
    const base = prevKey ? prevKey.call(this) : '';
    return `${base}|cel${useFog ? 'F' : ''}`;
  };

  material.needsUpdate = true;
  return material;
}

const STANDARD_KEYS = new Set([
  'bands', 'bandSoftness', 'bandFloor', 'warm', 'cool', 'rimColor', 'rimPower',
  'rimStrength', 'rimRange', 'hatch', 'hatchScale', 'grain', 'grainScale',
  'specBand', 'wobble', 'fog', 'outlineWidth', 'physical',
]);

function splitOpts(opts = {}) {
  const std = {};
  for (const k in opts) if (!STANDARD_KEYS.has(k)) std[k] = opts[k];
  if (std.color !== undefined && !(std.color instanceof THREE.Color)) std.color = _c(std.color);
  if (std.emissive !== undefined && !(std.emissive instanceof THREE.Color)) std.emissive = _c(std.emissive);
  return std;
}

/**
 * createCelMaterial(opts) -> THREE.MeshStandardMaterial (cel-patched)
 * The primary way every agent should build world/character/prop materials.
 */
export function createCelMaterial(opts = {}) {
  const std = splitOpts(opts);
  if (std.roughness === undefined) std.roughness = 0.85;
  if (std.metalness === undefined) std.metalness = 0.0;
  const mat = opts.physical
    ? new THREE.MeshPhysicalMaterial(std)
    : new THREE.MeshStandardMaterial(std);
  mat.fog = opts.fog !== false;
  return makeCel(mat, opts);
}

/**
 * createCelInstancedMaterial(opts) -> cel material tuned for InstancedMesh.
 * Instancing is handled automatically by three; this variant just biases the
 * defaults toward cheap (less hatch/grain) since instanced fields are dense.
 */
export function createCelInstancedMaterial(opts = {}) {
  return createCelMaterial({
    hatch: 0.55,
    grain: 0.7,
    rimStrength: 0.4,
    specBand: 0.7,
    ...opts,
  });
}

/** True if the material has already been cel-patched. */
export function isCel(material) {
  return !!(material && material.userData && material.userData.cel);
}

/**
 * Per-material live tweaks after creation.
 *   setCelParams(mat, { rimStrength: 1.2, hatch: 0 })
 */
export function setCelParams(material, params = {}) {
  const u = material?.userData?.celUniforms;
  if (!u) return material;
  const map = {
    bands: 'uCelBands', bandSoftness: 'uCelBandSoft', bandFloor: 'uCelBandFloor',
    warm: 'uCelWarm', cool: 'uCelCool', rimColor: 'uCelRimColor',
    rimPower: 'uCelRimPower', rimStrength: 'uCelRimStrength', rimRange: 'uCelRimRange',
    hatch: 'uCelHatch', hatchScale: 'uCelHatchScale', grain: 'uCelGrain',
    grainScale: 'uCelGrainScale', specBand: 'uCelSpecBand', wobble: 'uCelWobble',
  };
  for (const k in params) {
    const un = map[k];
    if (!un || !u[un]) continue;
    if (u[un].value instanceof THREE.Color) u[un].value.set(params[k]);
    else u[un].value = params[k];
  }
  return material;
}
