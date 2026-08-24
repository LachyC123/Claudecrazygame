// Quality tiers. `capture` mode forces deterministic, high-quality settings.
const isCapture = new URLSearchParams(location.search).has('capture');

export const cfg = {
  capture: isCapture,
  quality: 'ultra',            // low | med | high | ultra
  pixelRatio: Math.min(devicePixelRatio || 1, isCapture ? 1 : 2),
  shadows: true,
  shadowMapSize: 2048,
  cascades: 3,
  postfx: {
    taa: true, ssao: true, bloom: true, motionBlur: true,
    dof: true, chromatic: true, grain: true, vignette: true, outlines: true,
  },
  terrain: { size: 700, segments: 384, viewDistance: 900 },
  vegetation: { grass: 90000, bushes: 1400, trees: 220 },
  particles: { budget: 24000 },
  fov: 78,
  adsFov: 52,
};

export function applyQuality(tier) {
  cfg.quality = tier;
  if (tier === 'low') { Object.assign(cfg.postfx, { taa: false, ssao: false, dof: false, motionBlur: false }); cfg.shadowMapSize = 1024; cfg.vegetation.grass = 12000; }
  if (tier === 'med') { Object.assign(cfg.postfx, { taa: true, ssao: true, dof: false, motionBlur: false }); cfg.shadowMapSize = 1536; cfg.vegetation.grass = 35000; }
}
