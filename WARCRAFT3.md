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

Preview rendering supports node IDs below 254. Larger models can still be
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

### PopcornFX preview investigation

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

The application still does not play PopcornFX. A preview integration would adapt
the parser/VM into a worker or ship an isolated simulator helper, resolve the MDX
`.pkfx` references to installed `.pkb` files, and feed particle frames, textures,
blending, atlases, and emitter transforms into WebGL. The upstream implementation
approximates some noise and scene queries; visual comparisons against the game
and explicit handling of unsupported features remain necessary.
