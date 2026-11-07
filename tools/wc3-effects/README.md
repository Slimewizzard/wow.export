# Warcraft III effect baker

Build with the .NET 10 SDK:

```powershell
./tools/build-wc3-effects.ps1
```

The self-contained Windows x64 helper is written to `bin/wc3-effects/`.
The source CLI finds it there. A packaged app expects the complete published
directory at `tools/wc3-effects/` beside its executable, including licenses.
Copy `addons/blender/io_scene_wc3fx.py` to that same relative path in the app.

`wc3-effects.exe request.json output-directory` accepts a bounded JSON request
with `fps`, `seconds`, `teamColor`, and `emitters`. Each emitter supplies its name,
source path, base64 compiled bake and optional states at two simulation steps per
output frame. States contain the row-vector matrix in metres, color/alpha,
emission multiplier, activation gate and animation-loop restart marker.

The helper writes `bake.json` and `frames.bin`. The frame cache starts with ASCII
`W3FX` and little-endian uint32 version 1. Each indexed frame contains one uint32
particle count per batch followed by that many records of 17 little-endian
float32 values: position XYZ, half-size XY, axis XYZ, normal XYZ, rotation radians,
color RGBA, atlas frame. Positions and sizes use WC3 model units (50 per metre).
The enclosing `.wc3fx` ZIP adds the chosen model animations, decoded textures,
original effect files, dependency records and warnings. Single-clip/standalone
exports use manifest schema `wow.export.wc3fx.v1` and `frames.bin`. All-animation
exports use `wow.export.wc3fx.v2`, with `clips` containing one v1 cache description
per MDX sequence and `defaultClip` selecting the initial clip. Each clip references
its own `clips/<index>.bin`, records its `sequence`, `sequenceIndex`, `modelLoop`
and full `modelDuration` in seconds. One shared `model.glb` contains every skeletal
animation; textures and original dependencies are deduplicated across clips.

Both manifest versions can include optional `teamColor: { color: [r,g,b],
materials: [{ material, base, mask }] }`. Color channels are the selected sRGB
values in 0–1; `material` matches the GLB material extra `wc3_team_material`.
`base` and `mask` reference untinted RGBA and grayscale PNGs under `team-color/`.
Masks preserve the source ORM alpha independently of base texture opacity.
The importer recreates the tint before the sRGB-to-linear conversion. The embedded
GLB keeps its baked color for compatibility, while importer 0.3.0 replaces only
the tagged base-color paths with editable nodes. Baked particle colors stay fixed.

Caps: 30 seconds, 60 output FPS, 128 emitters, 20,000 allocated sprite slots,
128 MiB frame cache, with the sprite-slot/cache caps shared across all clips in a
package. All-animation export supports up to 256 clips. The app terminates each
simulation after three minutes. Failed
simulations leave no final package; temporary files are removed. Existing exports
are checked before source reads and remain protected by exclusive writes.

The upstream MIT simulator source and its notice are in `vendor/`. See
`src/js/warcraft3/THIRD_PARTY.md` for pinned provenance and adaptations.
