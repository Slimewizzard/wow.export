# Warcraft III asset browser

Choose **Open Warcraft III: Reforged** on the source screen, then select the
installation folder containing `.build.info`, for example `E:\Blizzard\Warcraft III`.
The module reads the locally installed CASC archives without changing game files.

Use the art filter for Reforged HD, Classic SD, Definitive, or all art sets.
Search accepts names and paths. Ctrl/Shift-click selects multiple files.
The type filter separates **Models** and **PopcornFX effects**. PopcornFX includes
compiled `.pkb`/`.pkfx` files and MDX files with `CORN` emitters. MDX files containing
only PopcornFX leave the Models list; models combining meshes or classic effects
with PopcornFX appear in both. Other categories remain Textures, Audio and All files.
The first visit scans MDX chunk headers in the background and shows progress;
the results are cached by archive content key, so unchanged assets are not reread.
Unreadable MDX files remain discoverable under Models and All files.

Models support orbit, pan, zoom, animation selection and scrubbing, playback speed,
team color, wireframe, and level of detail. Previews prefer a Stand/Idle animation
and frame flat ground decals from above. Effect-only assets that cannot be rendered
show an explanation in the preview. DDS and BLP textures have image previews.
The All files view also allows text inspection and raw extraction.

Select an output folder, choose a format, and click **Export selected**:

- **GLB model + textures** embeds PNG textures, a skin with joints at WC3 pivots,
  and all, selected, or no skeletal animations. Clips are sampled at 30 fps.
  The selected LOD and team color apply to the export. Batch export uses these
  same settings for every selected model.
- **PNG textures** decodes selected DDS/BLP assets into PNG files.
- **Blender + PopcornFX (experimental)** writes a `.wc3fx` package containing
  baked sprite animation, effect textures, original effect files, dependency
  records, and all model animations by default when the asset has geometry.
  Choose **Selected animation** to export just the preview's current clip.
  Bake seconds and FPS control a separate particle cache for each exported clip;
  full skeletal clips are retained regardless of the particle bake duration.
  Looping model clips repeat when the particle bake is longer than the clip;
  non-looping clips stop emitting at their end and leave particles to decay.
  Models without PopcornFX still export in the same `.wc3fx` format, including
  their textures and chosen skeletal animations. The particle bake is skipped
  and does not require the native helper. Classic particles/ribbons remain
  unsupported and are listed in the export notes.
- **Original files + model textures** copies original bytes, with available
  texture dependencies for MDX models. Original MDX retains animation and effect
  records. External effect dependencies such as PopcornFX packages are not
  automatically collected.

Files retain their virtual directory structure. **Overwrite if already exists**
uses the app's saved Overwrite Files preference. Uncheck it to skip existing output
files before reading or converting the selected asset. Native texture dependencies
also get this check; exclusive writes still protect against a file appearing after
the check. Check it to replace existing files. Cancel stops after the current file. Export results
show the full destination path for each selected asset; **Show in folder** opens
the containing folder and selects the actual file. Skipped existing files can
also be revealed. The completion toast reveals the first result in a batch.

## Importing effects in Blender

1. Select **Blender + PopcornFX (experimental)** and export an MDX or `.pkb`.
2. Click **Show Blender importer**. Install `io_scene_wc3fx.py` through Blender
   Preferences > Add-ons > Install from Disk, then enable it. Update to version
   **0.3.1** for editable team colors and separate selection of same-named
   animations; restart Blender after updating.
3. Use **File > Import > Warcraft III effect (.wc3fx)** and select the package.
   Scrub or play the timeline. Select an active render camera for billboarding.
4. With the model or its parent selected, open the 3D View sidebar (**N**) >
   **Warcraft III** and choose **Animation**. Each clip has its own NLA track;
   the selector activates only that track and its corresponding particle cache.
   Repeated source names get a numbered suffix, such as **Stand 3 [2]**.
   Particles disappear after their baked duration; longer skeletal clips continue.
5. **Team color** in the same sidebar starts with the color chosen in wow.export.
   It updates the converted model materials together using the original team mask.
   The Shader Editor also contains a shared **Team Color** node group; enter it
   with Tab to edit its RGB color node. Each import has an independent control.

New packages preserve untinted base textures and team masks, including the Reforged
HD/Definitive ORM alpha mask, so recoloring does not lose channels even when the
initial color is black. Image opacity remains separate. The nodes and textures
survive saving/reopening without the add-on (particle playback still needs it).
Ordinary GLB exports and baked particle colors keep their exported color. Existing
packages need re-exporting to gain editable model colors; enable overwrite when
replacing them. Older packages still import with their original fixed colors.

All-animation exports use package schema v2. Single-animation and standalone
effect exports retain v1, and the updated importer reads both versions.

The importer packs images and the animation cache into the `.blend`. Keep the
add-on enabled for playback after reopening; saved geometry alone is one frame.
Version 0.3.1 also splits packed particle data into short text lines to avoid
long import delays on large effects; existing saved caches remain readable.
Full model animation data uses the 512 MiB package limit independently of the
128 MiB particle-cache budget, allowing large sets such as Tree of Life.
The imported parent can be moved, scaled, or rotated, and its **WC3FX start frame**
custom property offsets playback. Import notes are on that parent's custom
properties. Camera-facing cards update on frame changes and face the active
render camera, rather than the free viewport camera.

This first version supports billboard sprites, including plane/axis alignment,
atlas cell animation, per-particle colour/opacity, and animated MDX attachment
transforms and visibility gates. It uses cached geometry playback rather than
editable particle simulation. Ribbons, distortion and light renderers are listed
as unsupported. Materials and turbulence are approximate; collision, target-based
behaviour, speed/lifetime multipliers, UV flipping and fractional atlas blending
are not fully reproduced. An effect with no supported sprites and no model mesh
fails with an explanation instead of producing a blank successful export.

## Compatibility and limits

Tested against Warcraft III **3.0.1.24371**, including its MDX **1800** models.
The bundled library also parses older MDX revisions. This source reader requires
a modern local CASC/TVFS installation; old Warcraft III MPQ installations and
remote CDN downloads are not supported by this module.

GLB carries mesh, texture, and skeletal animation data. WC3 particles, ribbons,
animated mesh visibility, animated materials/UVs, billboarding, and selective
transform inheritance do not have full conversion. Classic layered materials
are approximated. Export notes identify affected features; native MDX is the
preservation format. Previews are not a pixel-exact reproduction of the game.

Preview rendering supports mesh bone IDs below 254; non-mesh helper nodes may
have higher IDs. Models exceeding the mesh bone limit can still be
exported. Texture conversion supports BLP1 and DDS BC1–BC5 plus supported
uncompressed/DX10 equivalents. Unsupported files remain available for raw export.
Missing local archive data must be installed through Battle.net. The reader has
a 512 MiB per-file memory limit.

## Development

The module is `src/js/modules/tab_warcraft3.js`; storage, preview, texture decoder,
and GLB exporter are in `src/js/warcraft3/`. The normal wow.export build includes
the module. Libraries are pinned and vendored, with attribution and modification
notes in `src/js/warcraft3/THIRD_PARTY.md`; no npm dependency changes are needed.

A Node CLI shares the same backend:

```powershell
node tools/wc3.js list 'E:\Blizzard\Warcraft III' footman
node tools/wc3.js glb 'E:\Blizzard\Warcraft III' 'war3.w3mod/_hd.w3mod/units/human/footman/footman.mdx' 'D:\Exports\WC3'
node --test tests/wc3.test.js
$env:WC3_INSTALL = 'E:\Blizzard\Warcraft III'
node --test tests/wc3.test.js
```

The optional integration test reads the installation and checks MDX 1800 parsing,
skin weights, embedded textures, animation clips, and exported joint transforms
against the preview engine. It does not modify the installation.

### PopcornFX simulation and validation

Build 3.0.1.24371 contains 2,233 compiled `.pkb` files and 3,615 MDX files with
PopcornFX emitters; 1,257 of those MDX files have no mesh or classic emitter chunks.
The complete classification scan took about 53 seconds on the development machine;
loading the resulting cache took 69 ms. These timings exclude opening the installation.

[Darithos/W3ModelViewer](https://github.com/Darithos/W3ModelViewer) has an MIT-licensed
C# parser and simulator for these baked effects. At revision
`7e783bafbacf37e4e6ba7d746a83cf5da7c0b3c8`, its `PkBakeFile`, `PkScript`,
`PkEffectDef`, and `PkRuntime` classes were compiled into a standalone research probe.
Sixteen sampled effects from this installation all simulated for three seconds at
60 steps/second, producing particles in renderer-bearing layers, including
billboard, ribbon, and distortion effects. This verifies simulation compatibility
for those samples, not visual fidelity or coverage of every effect.

The Blender package exporter now uses a separate native helper built from this
simulator. Build it with `tools/build-wc3-effects.ps1` using the .NET 10 SDK;
the packaged Windows x64 build includes the runtime and does not require a
separate .NET installation. See `tools/wc3-effects/README.md` for the cache format
and packaging paths. In-app WebGL playback of PopcornFX is still unsupported.

The first end-to-end checks use a standalone Glow, an animated Firepit, and the
DE Hero Paladin's Attack 1. Blender 5.2.2 imports, animates, saves/reopens and renders
the effect packages. Sampled Paladin emitter-bone positions match the imported
animated rig within 0.00004 model units. This checks timing and attachment
transforms; it does not establish pixel-exact rendering of every effect.

Run `node --test tests/wc3.test.js tests/wc3-effects.test.js` after building the
helper. Set `WC3_INSTALL` to include real-asset tests. The optional Blender test is:

```powershell
blender --background --factory-startup --python-exit-code 1 --python tests/wc3_fx_blender.py -- 'exported.mdx.wc3fx'
blender --background --factory-startup --python-exit-code 1 --python tests/wc3_animation_blender.py -- 'all-animations.mdx.wc3fx'
blender --background --factory-startup --python-exit-code 1 --python tests/wc3_team_color_blender.py -- 'editable-color.mdx.wc3fx'
```
