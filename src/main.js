import * as THREE from 'three';
import { cfg } from './core/Config.js';
import { Rng } from './core/Rng.js';
import { Events } from './core/Events.js';
import { Input } from './core/Input.js';
import { Engine } from './core/Engine.js';
import { createRenderer } from './core/Renderer.js';
import { PostFX } from './core/PostFX.js';
import { TextureLab } from './core/TextureLab.js';
import { World } from './world/World.js';
import { Player } from './player/Player.js';
import { Weapons } from './weapons/Weapons.js';
import { Enemies } from './enemies/Enemies.js';
import { Loot } from './loot/Loot.js';
import { VFX } from './vfx/VFX.js';
import { HUD } from './ui/HUD.js';
import { Audio } from './audio/Audio.js';
import { getCaptureRequest, finishCapture } from './capture.js';

const bootEl = document.getElementById('boot');
const barEl = document.getElementById('barfill');
const hintEl = document.getElementById('boothint');
const progress = (p, label) => {
  if (barEl) barEl.style.width = `${Math.round(p * 100)}%`;
  if (label && hintEl) hintEl.textContent = label;
};

async function boot() {
  const captureRequest = getCaptureRequest();
  const container = document.getElementById('app');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.fov, innerWidth / innerHeight, 0.05, 2000);
  const renderer = createRenderer(container);
  const rng = new Rng(captureRequest?.seed ?? 20260824);

  const ctx = {
    scene, camera, renderer, rng,
    events: new Events(),
    assets: new TextureLab(),
    cfg, captureRequest,
    input: new Input(renderer.domElement),
    // filled in below
    world: null, player: null, weapons: null, enemies: null,
    loot: null, vfx: null, hud: null, audio: null, postfx: null, engine: null,
    // capture-mode switches read by subsystems
    forceFire: false, forceAds: false, spawnLootShowcase: false, hideViewmodel: false,
  };
  window.__CTX__ = ctx;

  progress(0.1, 'building world…');
  ctx.world = new World(ctx); await ctx.world.build();

  progress(0.35, 'calibrating optics…');
  ctx.postfx = new PostFX(ctx);

  progress(0.5, 'arming…');
  ctx.audio = new Audio(ctx);
  ctx.vfx = new VFX(ctx);
  ctx.player = new Player(ctx);
  ctx.weapons = new Weapons(ctx);

  progress(0.7, 'spawning hostiles…');
  ctx.enemies = new Enemies(ctx);
  ctx.loot = new Loot(ctx);

  progress(0.88, 'painting hud…');
  ctx.hud = new HUD(ctx);

  const engine = new Engine(ctx);
  ctx.engine = engine;
  engine.add(ctx.world); engine.add(ctx.player); engine.add(ctx.weapons);
  engine.add(ctx.enemies); engine.add(ctx.loot); engine.add(ctx.vfx);
  engine.add(ctx.hud); engine.add(ctx.audio);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  progress(1, 'ready');

  if (captureRequest) {
    captureRequest.apply(ctx);
    ctx.input.enabled = false;
    bootEl?.classList.add('hide');
    // Pose the camera before warmup so nothing pops.
    ctx.player.update(0);
    await finishCapture(engine);
    engine.start();
  } else {
    setTimeout(() => bootEl?.classList.add('hide'), 400);
    engine.start();
  }
}

boot().catch((err) => {
  console.error(err);
  document.title = 'BOOT_ERROR';
  window.__BOOT_ERROR__ = String(err?.stack || err);
  if (hintEl) hintEl.textContent = 'boot error — see console';
});
