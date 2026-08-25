# Third-party assets

Everything else in this project is generated procedurally in code. The only vendored
binary assets are fonts, self-hosted so the build runs fully offline at runtime.

## Fonts — `public/fonts/`

| Family | Use | License |
|---|---|---|
| Anton | Display / titles / big HUD numerals | SIL Open Font License 1.1 |
| Oswald | HUD labels, body, numerals | SIL Open Font License 1.1 |
| Saira Condensed | Heavy condensed accents | SIL Open Font License 1.1 |

Source: Google Fonts (fonts.gstatic.com), retrieved as woff2 and rewritten to local
paths in `public/fonts/fonts.css`. The SIL OFL permits redistribution and embedding.

Rationale: HUD typography is the one thing that cannot be produced procedurally at
quality, and the headless capture environment has no `Impact`/`Haettenschweiler`, so
canvas text was falling back to a generic sans and reading as unstyled.

## Deliberately NOT used

Photoreal PBR texture libraries and HDRI probes were considered and rejected: the game
is cel-shaded with banded diffuse and ink outlines, where scanned photoreal materials
actively fight the art direction. All surface detail is procedural (see
`src/core/TextureLab.js`). Poly Haven and ambientCG are also blocked by this
environment's egress policy.
