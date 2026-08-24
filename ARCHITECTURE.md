# BORDERLINE 4 — Architecture & Art Bible

A Borderlands-4-class looter shooter in Three.js. Every subsystem must hold AAA bar.

## Non-negotiable rules for all agents

1. **Own only your files.** Listed in your task. Never edit another agent's files.
   If you need something from another module, use the documented interface below.
2. **No external assets.** No CDN fetches, no binary downloads. All textures, meshes,
   audio are generated procedurally in code. The build must run fully offline.
3. **The app must always boot.** Never leave a file in a broken state. `npm run build`
   must succeed after your change.
4. **Three.js r169.** Import from `three` and `three/examples/jsm/...`.
5. **60 FPS budget on real GPUs.** Instance everything repeated. No per-frame allocation
   in hot loops — preallocate vectors/matrices at module scope.

## Art Bible (Borderlands 4 look)

- **Cel/toon shading**: 2–3 band diffuse ramp, hard terminator, warm light / cool shadow.
- **Ink outlines**: black contour lines on silhouettes AND interior creases. Line width
  scales with distance so far objects don't turn into mush. This is the single most
  identity-defining feature — get it right.
- **Hand-painted texture feel**: visible brush/hatch grain, cross-hatch in shadow regions,
  slight color bleed. Never photoreal PBR — but still use PBR lighting response underneath.
- **Palette**: sun-bleached desert ochre + dusty teal sky, punctuated by saturated
  rarity colors (white/green/blue/purple/orange/rainbow).
- **Composition**: strong horizon, big silhouette rock formations, atmospheric depth haze.
- **HUD**: angular, beveled, high-contrast, chunky numerals, orange/cyan accents.

## Module interfaces (the contract)

Engine calls, each frame, in order:
  input.update(dt) -> player.update(dt, world) -> weapons.update(dt) -> enemies.update(dt)
  -> loot.update(dt) -> vfx.update(dt) -> hud.update(dt) -> postfx.render(dt)

### Shared context object `ctx` passed to every subsystem constructor:
```
ctx = {
  scene, camera, renderer, clock,
  rng,                 // src/core/Rng.js — deterministic, seeded
  input,               // src/core/Input.js
  world,               // src/world/World.js
  events,              // tiny emitter: on(name,fn), emit(name,payload)
  assets,              // src/core/TextureLab.js — procedural texture cache
  audio,               // src/audio/Audio.js
  vfx,                 // src/vfx/VFX.js
  cfg,                 // src/core/Config.js — quality settings
}
```

### Events (the decoupling seam — use these, don't reach across modules)
- `shot`        {origin, dir, weapon}
- `hit`         {point, normal, target, damage, element, crit, weapon}
- `damage`      {target, amount, element, crit, point}
- `kill`        {enemy, point}
- `lootDrop`    {position, item}
- `pickup`      {item}
- `explosion`   {position, radius, element}
- `reload`      {weapon}

### Every subsystem class exposes:
```
class Thing { constructor(ctx) {} update(dt) {} dispose() {} }
```

## Deterministic capture protocol (used by the visual critic — DO NOT BREAK)

`?capture=<sceneName>&seed=<n>` boots the game into a frozen, reproducible pose:
- Fixed seed, fixed camera transform, fixed time-of-day, AI frozen mid-action.
- After the scene is fully warmed (all shaders compiled, N frames rendered), the page sets
  `window.__READY__ = true` and `document.title = 'READY'`.
- Capture scenes are registered in `src/capture.js`. Add one for your subsystem so the
  critic can shoot it in isolation.

Screenshot: `node tools/screenshot.mjs "http://localhost:5173/?capture=vista" shots/vista.png`
