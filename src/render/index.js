/**
 * BORDERLINE 4 — RENDER CORE PUBLIC API
 * ==================================================================================
 * Import everything render-related from here:
 *
 *   import {
 *     createCelMaterial, createCelInstancedMaterial, makeCel, setCelParams,
 *     installLightRig, Sky, LAYER_SKY,
 *   } from '../render/index.js';
 *
 * ----------------------------------------------------------------------------------
 * MATERIALS  (src/render/CelMaterial.js)
 * ----------------------------------------------------------------------------------
 *   createCelMaterial(opts)            -> cel-patched MeshStandardMaterial
 *   createCelInstancedMaterial(opts)   -> same, defaults tuned for InstancedMesh
 *   makeCel(material, opts)            -> patch a material you already built
 *   setCelParams(material, params)     -> live tweak one material
 *   isCel(material)                    -> boolean
 *   CEL_GLOBALS                        -> shared uniform block (Lighting owns it)
 *
 *   opts: color/map/normalMap/roughness/metalness/... plus
 *         bands, bandSoftness, bandFloor, warm, cool, rimColor, rimPower,
 *         rimStrength, rimRange, hatch, hatchScale, grain, grainScale,
 *         specBand, wobble, fog, outlineWidth
 *
 * ----------------------------------------------------------------------------------
 * LIGHTING  (src/render/Lighting.js)
 * ----------------------------------------------------------------------------------
 *   installLightRig(ctx, opts?) -> Lighting     // idempotent; sets ctx.lighting
 *
 *   Installs in one call: sky dome, 3-cascade shadow maps, hemisphere bounce, cool
 *   fill, sky-derived IBL, aerial-perspective fog, and drives CEL_GLOBALS.
 *   Materials added to the scene later are cel-patched and registered with the
 *   cascades automatically.
 *
 *   lighting.setTimeOfDay(0..1)   lighting.setStyle({hatch,grain,rim,aerial})
 *   lighting.sunDirection         lighting.sky        lighting.csm
 *   lighting.adopt(objectOrMaterial)   // force-adopt something immediately
 *
 *   Per-object / per-material opt-outs (userData flags):
 *     material.userData.noCel        keep PBR shading response
 *     material.userData.noCsm        keep three's single-shadow path
 *     material.userData.noGBuffer    never contributes to ink outlines
 *     object.userData.noGBuffer      ditto (whole subtree)
 *     object.userData.noShadowCast   never a shadow caster
 *
 * ----------------------------------------------------------------------------------
 * SKY  (src/render/Sky.js)
 * ----------------------------------------------------------------------------------
 *   new Sky(opts).addTo(scene, camera)
 *   sky.setSun(dirVec3, colorHex, intensity)
 *   sky.setPalette({zenith, horizon, groundHaze, cloudLit, cloudShadow, inscatter})
 *   sky.setParams({coverage, cloudSharp, cloudScale, wind, hazePower, skyGain, grain})
 *   sky.sampleHorizon(target?) / sky.sampleZenith(target?)
 *
 * ----------------------------------------------------------------------------------
 * OUTLINES  (src/render/OutlinePass.js) — normally you only touch these via PostFX
 * ----------------------------------------------------------------------------------
 *   new GBufferPass(scene, camera, w, h)       // RGBA16F (viewNormal.xyz, viewZ)
 *   new InkOutlinePass(gbuffer, camera, opts)
 *   ctx.postfx.setOutline({widthNear, widthFar, strength, normalWeight, ...})
 * ==================================================================================
 */

export {
  CEL_GLOBALS,
  updateCelGlobals,
  makeCel,
  createCelMaterial,
  createCelInstancedMaterial,
  isCel,
  setCelParams,
} from './CelMaterial.js';

export { Sky, createSky } from './Sky.js';
export { Lighting, installLightRig, buildRenderProbe } from './Lighting.js';
export { GBufferPass, InkOutlinePass, INK_DEFAULTS } from './OutlinePass.js';
export { LAYER_SKY, RENDER_CAPS, setExposure, TONEMAP_GLSL } from '../core/Renderer.js';
