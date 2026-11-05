# Brand assets

Everything here is hand-authored SVG except the two PNGs, which are committed because social
platforms and iOS do not accept SVG.

| File | Used by | Notes |
| :--- | :--- | :--- |
| `favicon.svg` | site `<link rel="icon">`, README hero | The mark on its own dark plate, so it is visible on a light **and** a dark background — the only variant safe to use without a colour-scheme query. |
| `logo.svg` | site, light backgrounds | Dark ink. Invisible on dark; use the favicon plate instead when the background is unknown. |
| `logo-dark.svg` | dark backgrounds | Light ink. Pair with `logo.svg` through `<picture>` when both schemes must be served. |
| `apple-touch-icon.png` | site, iOS home screen | 180×180, drawn from the same 32-unit grid as `favicon.svg`. |
| `social-card.svg` | source of the card below | The layout, in the tokens the card is drawn in. |
| `social-card.png` | `og:image`, `twitter:image`, GitHub social preview | **1200×630.** This is the file platforms actually fetch. |
| `how-it-works.svg` | README, site | The dump-versus-snapshot contrast: the pitch, drawn. |

## Why the PNG is checked in

`og:image` must be a raster format, and rasterising an SVG needs a tool this project will not
add as a dependency. The PNG therefore ships as an artefact, not as build output, and changing
the card means editing `social-card.svg`, re-rendering at exactly 1200×630, and committing
both. `scripts/audit-site.mjs` fails the build if any page references an `og:image` that is
missing or the wrong size, so a stale PNG cannot ship quietly.

The GitHub **social preview** is uploaded in repository settings — there is no API for it — and
should be `social-card.png`.

## Colour and type

| Token | Value | Use |
| :--- | :--- | :--- |
| Ink (light) | `#1f2328` | lines and text on light |
| Ink (dark) | `#e6edf3` | lines and text on dark |
| Plate | `#0d1117` | favicon and card background |
| Accent | `#1a7f37` light / `#2da44e` dark | the one thing that passed: `validate` |
| Muted | `#57606a` light / `#9da7b3` dark | secondary text |

Fonts are the system stack — `-apple-system, "Segoe UI", Helvetica, Arial` — and
`ui-monospace, SFMono-Regular, Menlo, Consolas` for anything that is a command or a hash. No
webfonts: a documentation site that cannot render before a font request is a worse trade than
a slightly different `a` on macOS.
