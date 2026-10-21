# Warcraft III dependencies

No game assets are distributed with this module.

## war3-model 4.0.1

Source: https://github.com/4eb0da/war3-model
Commit: `542d884380c358b19db1b25f2d7d1072dd8c636f`
Package: https://registry.npmjs.org/war3-model/-/war3-model-4.0.1.tgz

`vendor/war3-model.js` is the package's CommonJS bundle. MIT license, copyright
2017–2023 4eb0da; see `vendor/war3-model.LICENSE`.

Local modifications support MDX 1800: read 16-bit SKIN values, skip the additional
light fields, and parse camera IDUF scalar tracks. The WebGL shaders use brighter
fallback ambient light when no environment map is loaded. `model.js` additionally masks
camera record size flags and preserves the 16-bit weights for GLB export.
Cleanup also skips unallocated HD shader programs for classic model previews.
These adaptations were tested against Warcraft III 3.0.1.24371.

The bundle contains gl-matrix and the JPEG decoder used for BLP1 textures:

- gl-matrix: MIT, copyright 2015–2020 Brandon Jones and Colin MacKenzie IV.
  See `vendor/gl-matrix.LICENSE`.
- JPEG decoder: copyright 2011 notmasteryet, Apache License 2.0.
  See `vendor/jpeg-decoder.LICENSE`. The war3-model upstream modified the decoder
  to support Blizzard BLP1 JPEG data.
  Source: https://github.com/4eb0da/war3-model/blob/542d884380c358b19db1b25f2d7d1072dd8c636f/third_party/decoder.js

## gl-matrix 3.3.0

`vendor/gl-matrix.js` is the standalone minified package used by our camera and
GLB exporter. Source: https://github.com/toji/gl-matrix
Package: https://registry.npmjs.org/gl-matrix/-/gl-matrix-3.3.0.tgz
MIT license; see `vendor/gl-matrix.LICENSE`.

## CASC/TVFS format reference

The independent JavaScript storage reader uses CascLib's TVFS implementation as
a format reference: https://github.com/ladislav-zezula/CascLib/blob/master/src/CascRootFile_TVFS.cpp
CascLib is copyright Ladislav Zezula, MIT licensed. Its license is retained in
`vendor/CascLib.LICENSE`. No native CascLib binary is required.
