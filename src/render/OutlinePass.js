/**
 * BORDERLINE 4 — INK OUTLINES
 * ==================================================================================
 * The single most identity-defining effect in the game.
 *
 * Two pieces:
 *
 *  1. GBufferPass — a depth+normal prepass. Every opaque mesh is drawn once more with
 *     a swapped-in shader that writes  RGBA16F = (viewNormal.xyz, viewZ).  Alpha-tested
 *     foliage keeps its cutout (the variant inherits map/alphaTest from the source
 *     material) so grass cards do not turn into a field of rectangles. Sky and
 *     particles are excluded, which is exactly what makes characters and mesas read as
 *     crisp black silhouettes against the atmosphere.
 *
 *     Its target is also consumed by the AO, motion-blur and DOF passes, so the scene
 *     is only re-rendered once for the whole stack.
 *
 *  2. InkOutlinePass — screen-space edge detection over that buffer.
 *
 *     • DEPTH edges use the second derivative of 1/viewZ. Because 1/z is exactly linear
 *       in screen space across a plane, a raking ground plane produces zero response —
 *       only genuine depth discontinuities draw. This is what stops the desert floor
 *       from being outlined into static.
 *     • NORMAL edges use 1 - dot(n, n_neighbour) over 8 taps, giving interior creases
 *       (panel lines, rock facets, muscle) not just silhouettes.
 *     • LINE WIDTH is specified in pixels and interpolated from `widthNear` at the
 *       viewmodel to `widthFar` in the distance, so far geometry keeps a clean 1px
 *       contour instead of dissolving into noise.
 *     • THRESHOLDS scale with distance, and the whole effect fades out into the aerial
 *       perspective so the far mesas read as atmosphere, not line art.
 *     • WEIGHT VARIATION: a low-frequency screen-space fbm modulates line darkness and
 *       radius, plus ink pools slightly in already-dark areas — the lines read as a
 *       brush rather than a Sobel filter.
 *
 * USE
 *   const gb  = new GBufferPass(scene, camera, w, h);
 *   const ink = new InkOutlinePass(gb, camera, { widthNear: 2.4 });
 *   composer.addPass(gb); composer.addPass(renderPass); composer.addPass(ink);
 * ==================================================================================
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LAYER_SKY } from '../core/Renderer.js';

/* ============================================================================ */
/* G-buffer                                                                     */
/* ============================================================================ */

const GB_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>

varying vec3 vGNormal;
varying vec3 vGViewPos;
#ifdef GB_ALPHA
  varying vec2 vGUv;
  uniform mat3 uUvTransform;
#endif

void main() {
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vGNormal = transformedNormal;

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  vGViewPos = mvPosition.xyz;
  #ifdef GB_ALPHA
    vGUv = (uUvTransform * vec3(uv, 1.0)).xy;
  #endif
}
`;

const GB_FRAG = /* glsl */ `
precision highp float;

varying vec3 vGNormal;
varying vec3 vGViewPos;
#ifdef GB_ALPHA
  varying vec2 vGUv;
  uniform sampler2D uAlphaMap;
  uniform float uAlphaTest;
#endif

void main() {
  #ifdef GB_ALPHA
    if (texture2D(uAlphaMap, vGUv).a < uAlphaTest) discard;
  #endif

  #ifdef FLAT_SHADED
    vec3 fdx = dFdx(vGViewPos);
    vec3 fdy = dFdy(vGViewPos);
    vec3 n = normalize(cross(fdx, fdy));
  #else
    vec3 n = normalize(vGNormal);
  #endif
  if (!gl_FrontFacing) n = -n;

  gl_FragColor = vec4(n, max(-vGViewPos.z, 1e-4));
}
`;

const _clearColor = new THREE.Color(0, 0, 0);

export class GBufferPass extends Pass {
  constructor(scene, camera, width = 1, height = 1, opts = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.enabled = true;

    this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'BL4.GBuffer';

    this._variants = new WeakMap();
    this._objs = [];
    this._mats = [];
    this._hidden = [];
    this._collect = (o) => this._collectObject(o);
    this.includeSky = !!opts.includeSky;
  }

  _variantFor(src) {
    let v = this._variants.get(src);
    if (v) {
      v.side = src.side;
      return v;
    }
    const cutout = !!(src.alphaTest > 0 && (src.map || src.alphaMap));
    const uniforms = {};
    const defines = {};
    if (cutout) {
      defines.GB_ALPHA = '';
      const tex = src.alphaMap || src.map;
      uniforms.uAlphaMap = { value: tex };
      uniforms.uAlphaTest = { value: src.alphaTest };
      uniforms.uUvTransform = { value: (tex && tex.matrix) ? tex.matrix : new THREE.Matrix3() };
    }
    if (src.flatShading) defines.FLAT_SHADED = '';

    v = new THREE.ShaderMaterial({
      name: 'BL4.GBuffer',
      uniforms,
      defines,
      vertexShader: GB_VERT,
      fragmentShader: GB_FRAG,
      side: src.side,
      fog: false,
      toneMapped: false,
      lights: false,
    });
    this._variants.set(src, v);
    return v;
  }

  _collectObject(o) {
    if (o.userData && o.userData.noGBuffer) { o.visible = false; this._hidden.push(o); return; }
    if (o.isPoints || o.isLine || o.isSprite) { o.visible = false; this._hidden.push(o); return; }
    if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)) return;

    const m = o.material;
    if (Array.isArray(m)) {
      let arr = o.userData.__gbMats;
      if (!arr || arr.__src !== m) {
        arr = m.map((x) => this._variantFor(x));
        arr.__src = m;
        o.userData.__gbMats = arr;
      }
      this._objs.push(o); this._mats.push(m);
      o.material = arr;
      return;
    }
    if (!m) return;
    // Fully transparent surfaces (glass, beams, decals) must not carve silhouettes.
    if (m.transparent && !(m.alphaTest > 0)) { o.visible = false; this._hidden.push(o); return; }
    if (m.userData && m.userData.noGBuffer) { o.visible = false; this._hidden.push(o); return; }

    this._objs.push(o); this._mats.push(m);
    o.material = this._variantFor(m);
  }

  render(renderer /*, writeBuffer, readBuffer */) {
    const objs = this._objs, mats = this._mats, hidden = this._hidden;
    objs.length = 0; mats.length = 0; hidden.length = 0;

    const skyWasOn = this.camera.layers.isEnabled(LAYER_SKY);
    if (!this.includeSky && skyWasOn) this.camera.layers.disable(LAYER_SKY);

    this.scene.traverseVisible(this._collect);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoUpdate = renderer.shadowMap.autoUpdate;
    const prevNeedsUpdate = renderer.shadowMap.needsUpdate;
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    const prevClear = renderer.getClearColor(_clearColor).getHex();
    const prevAlpha = renderer.getClearAlpha();

    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    this.scene.background = null;
    this.scene.fog = null;

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);

    renderer.setClearColor(prevClear, prevAlpha);
    renderer.shadowMap.autoUpdate = prevAutoUpdate;
    renderer.shadowMap.needsUpdate = prevNeedsUpdate;
    this.scene.background = prevBg;
    this.scene.fog = prevFog;
    renderer.setRenderTarget(prevTarget);

    for (let i = 0; i < objs.length; i++) objs[i].material = mats[i];
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    if (!this.includeSky && skyWasOn) this.camera.layers.enable(LAYER_SKY);
  }

  setSize(w, h) { this.target.setSize(Math.max(1, w), Math.max(1, h)); }
  dispose() { this.target.dispose(); }
}

/* ============================================================================ */
/* Ink outline                                                                  */
/* ============================================================================ */

const INK_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tGBuffer;
uniform vec2  uTexel;
uniform vec3  uInk;
uniform float uStrength;
uniform float uWidthNear;
uniform float uWidthFar;
uniform vec2  uWidthDist;     // (near metres, far metres)
uniform float uDepthThresh;
uniform float uDepthKnee;
uniform float uNormalThresh;
uniform float uNormalKnee;
uniform float uNormalWeight;
uniform float uNormalFalloff;
uniform vec2  uFade;          // (fade start, fade end) metres
uniform float uJitter;
uniform float uVariation;
uniform float uInkPooling;
uniform float uTime;
uniform float uInterior;

varying vec2 vUv;

const float FAR_SENTINEL = 8000.0;

float h21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.11369));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x),
             mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm2(vec2 p) { return vn(p) * 0.62 + vn(p * 2.31 + 5.7) * 0.38; }

vec4 gb(vec2 uv) {
  vec4 g = texture2D(tGBuffer, uv);
  if (g.w <= 1e-4) g.w = FAR_SENTINEL;
  return g;
}

void main() {
  vec4 sc = texture2D(tDiffuse, vUv);
  vec4 gC = gb(vUv);
  float zC = gC.w;

  // --- line width in PIXELS, tapering with distance --------------------------
  float wpx = mix(uWidthNear, uWidthFar,
                  smoothstep(uWidthDist.x, uWidthDist.y, min(zC, FAR_SENTINEL)));

  // hand-inked weight variation
  vec2 sp = vUv / uTexel;
  float grain = fbm2(sp * 0.018 + uTime * 0.01);
  float grain2 = fbm2(sp * 0.11 + 31.7);
  wpx *= 1.0 + (grain - 0.5) * uJitter;

  vec2 r = uTexel * max(wpx * 0.5, 0.35);
  vec2 rd = r * 0.7071;

  vec4 gL = gb(vUv - vec2(r.x, 0.0));
  vec4 gR = gb(vUv + vec2(r.x, 0.0));
  vec4 gU = gb(vUv + vec2(0.0, r.y));
  vec4 gD = gb(vUv - vec2(0.0, r.y));

  float zMin = min(min(zC, gL.w), min(min(gR.w, gU.w), gD.w));
  vec3 nC = normalize(gC.xyz + 1e-6);

  // --- cheap 4-tap cross first ------------------------------------------------
  float iC = 1.0 / zC;
  float lap = abs(1.0 / gL.w + 1.0 / gR.w - 2.0 * iC)
            + abs(1.0 / gU.w + 1.0 / gD.w - 2.0 * iC);
  float rel = lap * zMin;

  float ne = 0.0;
  ne = max(ne, 1.0 - dot(nC, normalize(gL.xyz + 1e-6)));
  ne = max(ne, 1.0 - dot(nC, normalize(gR.xyz + 1e-6)));
  ne = max(ne, 1.0 - dot(nC, normalize(gU.xyz + 1e-6)));
  ne = max(ne, 1.0 - dot(nC, normalize(gD.xyz + 1e-6)));

  float dTh = uDepthThresh * (1.0 + zMin * 0.0035);
  float nTh = uNormalThresh * (1.0 + zC * uNormalFalloff);

  // Flat interior: skip the four diagonal taps entirely. On a typical frame this is
  // most of the screen, and it costs nothing in line quality.
  if (rel < dTh * 0.45 && ne < nTh * 0.45) { gl_FragColor = sc; return; }

  // --- diagonals sharpen corners and thicken the contour ----------------------
  vec4 gA = gb(vUv + vec2(rd.x, rd.y));
  vec4 gB = gb(vUv + vec2(-rd.x, rd.y));
  vec4 gE = gb(vUv + vec2(rd.x, -rd.y));
  vec4 gF = gb(vUv + vec2(-rd.x, -rd.y));
  zMin = min(zMin, min(min(gA.w, gB.w), min(gE.w, gF.w)));
  rel = (lap + (abs(1.0 / gA.w + 1.0 / gF.w - 2.0 * iC)
              + abs(1.0 / gB.w + 1.0 / gE.w - 2.0 * iC)) * 0.7) * zMin;

  ne = max(ne, (1.0 - dot(nC, normalize(gA.xyz + 1e-6))) * 0.85);
  ne = max(ne, (1.0 - dot(nC, normalize(gF.xyz + 1e-6))) * 0.85);
  ne = max(ne, (1.0 - dot(nC, normalize(gB.xyz + 1e-6))) * 0.85);
  ne = max(ne, (1.0 - dot(nC, normalize(gE.xyz + 1e-6))) * 0.85);

  dTh = uDepthThresh * (1.0 + zMin * 0.0035);
  float edgeD = smoothstep(dTh, dTh + uDepthKnee, rel);
  float edgeN = smoothstep(nTh, nTh + uNormalKnee, ne) * uNormalWeight * uInterior;
  if (zC >= FAR_SENTINEL - 1.0) edgeN = 0.0;

  float e = max(edgeD, edgeN);

  // --- atmospheric fade: distant geometry becomes haze, not line art ---------
  e *= 1.0 - smoothstep(uFade.x, uFade.y, zMin);

  // --- brush weight ----------------------------------------------------------
  e *= mix(1.0, 0.55 + 0.9 * grain2, uVariation);

  // ink pools where the image is already dark, thins where it is blown out
  float luma = dot(sc.rgb, vec3(0.2126, 0.7152, 0.0722));
  e *= mix(1.0, clamp(1.35 - luma * 0.55, 0.6, 1.45), uInkPooling);

  e = clamp(e * uStrength, 0.0, 1.0);

  vec3 inkCol = mix(sc.rgb * 0.09, uInk, 0.82);
  gl_FragColor = vec4(mix(sc.rgb, inkCol, e), sc.a);
}
`;

const INK_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const INK_DEFAULTS = {
  ink: 0x07070a,
  strength: 1.0,
  widthNear: 3.2,
  widthFar: 1.2,
  widthDist: [4.0, 120.0],
  depthThresh: 0.022,
  depthKnee: 0.055,
  normalThresh: 0.26,
  normalKnee: 0.30,
  normalWeight: 0.92,
  normalFalloff: 0.010,
  fade: [230.0, 520.0],
  jitter: 0.30,
  variation: 0.42,
  inkPooling: 0.55,
  interior: 1.0,
};

export class InkOutlinePass extends Pass {
  constructor(gbuffer, camera, opts = {}) {
    super();
    this.gbuffer = gbuffer;
    this.camera = camera;
    const o = { ...INK_DEFAULTS, ...opts };

    this.uniforms = {
      tDiffuse: { value: null },
      tGBuffer: { value: gbuffer ? gbuffer.target.texture : null },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uInk: { value: new THREE.Color(o.ink) },
      uStrength: { value: o.strength },
      uWidthNear: { value: o.widthNear },
      uWidthFar: { value: o.widthFar },
      uWidthDist: { value: new THREE.Vector2(o.widthDist[0], o.widthDist[1]) },
      uDepthThresh: { value: o.depthThresh },
      uDepthKnee: { value: o.depthKnee },
      uNormalThresh: { value: o.normalThresh },
      uNormalKnee: { value: o.normalKnee },
      uNormalWeight: { value: o.normalWeight },
      uNormalFalloff: { value: o.normalFalloff },
      uFade: { value: new THREE.Vector2(o.fade[0], o.fade[1]) },
      uJitter: { value: o.jitter },
      uVariation: { value: o.variation },
      uInkPooling: { value: o.inkPooling },
      uTime: { value: 0 },
      uInterior: { value: o.interior },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'BL4.Ink',
      uniforms: this.uniforms,
      vertexShader: INK_VERT,
      fragmentShader: INK_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._pixelScale = 1;
  }

  /** Live tuning. Accepts any key from INK_DEFAULTS. */
  setParams(p = {}) {
    const u = this.uniforms;
    if (p.ink !== undefined) u.uInk.value.set(p.ink);
    if (p.widthDist) u.uWidthDist.value.set(p.widthDist[0], p.widthDist[1]);
    if (p.fade) u.uFade.value.set(p.fade[0], p.fade[1]);
    const map = {
      strength: 'uStrength', widthNear: 'uWidthNear', widthFar: 'uWidthFar',
      depthThresh: 'uDepthThresh', depthKnee: 'uDepthKnee',
      normalThresh: 'uNormalThresh', normalKnee: 'uNormalKnee',
      normalWeight: 'uNormalWeight', normalFalloff: 'uNormalFalloff',
      jitter: 'uJitter', variation: 'uVariation', inkPooling: 'uInkPooling',
      interior: 'uInterior',
    };
    for (const k in p) { const n = map[k]; if (n) u[n].value = p[k]; }
    return this;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tGBuffer.value = this.gbuffer.target.texture;
    this.uniforms.uTime.value += deltaTime || 0.016;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  setSize(w, h) {
    this.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    // Keep line thickness constant in *device* pixels regardless of supersampling.
    this._pixelScale = 1;
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

export { INK_DEFAULTS };
