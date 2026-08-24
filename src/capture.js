import * as THREE from 'three';

// Deterministic capture poses for the visual critic. Add a scene here for your subsystem.
// URL: ?capture=<name>&seed=<n>
// Contract: after warmup, window.__READY__ = true and document.title = 'READY'.

export const CAPTURE_SCENES = {
  // Wide establishing shot of the landscape — the "is this AAA?" money shot.
  vista: (g) => {
    g.player.position.set(6, 3.2, 42);
    g.player.yaw = 0.32; g.player.pitch = -0.06;
    g.hideViewmodel = false;
  },
  // Gunplay: viewmodel + enemies + muzzle flash mid-fire.
  combat: (g) => {
    g.player.position.set(0, 1.75, 16);
    g.player.yaw = 0.0; g.player.pitch = -0.02;
    g.forceFire = true;
  },
  // Close-up on the weapon viewmodel — texture/material scrutiny.
  weapon: (g) => {
    g.player.position.set(0, 1.75, 8);
    g.player.yaw = 0; g.player.pitch = 0;
    g.forceAds = true;
  },
  // Enemy character study.
  enemy: (g) => {
    g.player.position.set(0, 1.7, 6);
    g.player.yaw = 0; g.player.pitch = -0.03;
  },
  // Loot beams + drops + rarity colors.
  loot: (g) => {
    g.player.position.set(0, 1.7, 7);
    g.player.yaw = 0; g.player.pitch = -0.12;
    g.spawnLootShowcase = true;
  },
  // HUD legibility pass.
  hud: (g) => {
    g.player.position.set(6, 3.2, 42);
    g.player.yaw = 0.32; g.player.pitch = -0.06;
  },
};

export function getCaptureRequest() {
  const p = new URLSearchParams(location.search);
  const name = p.get('capture');
  if (!name) return null;
  return {
    name,
    seed: parseInt(p.get('seed') || '20260824', 10),
    apply: CAPTURE_SCENES[name] || CAPTURE_SCENES.vista,
    frames: parseInt(p.get('frames') || '45', 10),
  };
}

export async function finishCapture(engine) {
  await engine.warm(engine.ctx.captureRequest?.frames ?? 45);
  window.__READY__ = true;
  document.title = 'READY';
}
