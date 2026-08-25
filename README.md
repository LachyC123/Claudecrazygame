# BORDERLINE 4

A Borderlands-class cel-shaded looter shooter built in Three.js r169. Everything you see —
terrain, rocks, weapons, characters, textures, particles, audio — is generated procedurally
in code. There are no model files and no texture files in this repository.

```bash
npm install
npm run dev        # http://localhost:5173
```

**Controls** — `WASD` move, `Shift` sprint, `Space` jump, `Ctrl` crouch/slide,
`Mouse` look, `LMB` fire, `RMB` aim, `R` reload, `1-4` weapon slots, `Tab` inventory,
`M` mute. Click the canvas to capture the pointer.

## Layout

| Path | Responsibility |
|---|---|
| `src/core/` | Engine loop, renderer, post-processing, input, seeded RNG, event bus, procedural texture lab |
| `src/render/` | Cel material system, ink outline pass, sky, lighting rig |
| `src/world/` | Terrain, rock formations, vegetation, structures, props |
| `src/player/` | FPS controller, collision, camera rig |
| `src/weapons/` | Procedural weapon generation, viewmodel, ballistics |
| `src/enemies/` | Enemy meshes, animation, AI, ragdolls |
| `src/vfx/` | Particles, impacts, explosions, tracers, decals |
| `src/loot/` | Rarity, loot beams, drops, inventory |
| `src/ui/` | HUD, reticle, compass, quest tracker |
| `src/audio/` | Procedural WebAudio synthesis |

`ARCHITECTURE.md` is the binding contract between these modules — interfaces, the event
seam, and the art direction bible. Read it before changing anything.

## Development loop

The project is built and refined by parallel agents scored by a hostile visual critic.
Two pieces of tooling make that possible:

**Deterministic capture.** `?capture=<scene>` boots into a frozen, reproducible pose with a
fixed seed and camera transform, warms every shader, then sets `window.__READY__`. This makes
screenshots comparable across runs instead of catching arbitrary frames.

```bash
tools/prep-critique.sh 1          # capture all scenes + build blind A/B pairs
node tools/capture-all.mjs --out shots/x  # captures + draw calls / triangles / errors
```

**Blind A/B.** `tools/blindpair.mjs` copies a captured frame and a reference frame from a
shipped game to neutral `image_A` / `image_B` names in randomised order, withholding the key,
so the critic judges craft rather than provenance. `CRITIC.md` holds the scoring rubric —
a pass requires 82/100 with no category below 7.

## Assets

Procedural, with one exception: three SIL Open Font License typefaces are vendored in
`public/fonts`. See `ASSETS.md` for the reasoning and licensing.
