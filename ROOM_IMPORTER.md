# Room Blueprint workflow

This branch adds a Room Blueprint tab to wow.export, a WoW capture addon, and a Blender lineup importer.

## Capture in WoW

Copy `addons/wow/RoomProbe` to `_retail_/Interface/AddOns`. Reload the UI, run `/roomprobe blueprint livingroom`, and reopen the blueprint preview and View List. After the capture message, run `/roomprobe stop`, then `/reload`.

The file is `_retail_/WTF/Account/<account>/SavedVariables/RoomProbe.lua`. The addon passively records blueprint content events. It never imports a blueprint or calls restricted debug getters.

## Export in wow.export

Open the custom build, select a game installation, and choose **Room Blueprint**. Load the SavedVariables file above, choose the desired captured response, and click **Export blueprint decor** with textures enabled.

The exporter matches decor catalog IDs against HouseDecor, exports each distinct decor ID once, and keeps the blueprint quantities in `room-manifest.json`. Missing inventory counts are not subtracted. Unresolved IDs and failed exports are reported in that manifest. Each run creates a new folder under the configured export directory's `room-blueprints` folder. Keep that whole folder together.

Room shells and fixtures are recorded as metadata but are not exported by this first version. Original positions, angles and scales are unavailable. Dye metadata is retained but not applied to materials.

## Import into Blender

Install the `io_scene_room_blueprint` folder from `addons/blender` as a Blender addon, or install its ZIP through Preferences > Add-ons > Install from Disk. Enable **Room Blueprint Lineup**.

Use **File > Import > Room Blueprint Lineup (.json)** and choose `room-manifest.json`. The importer creates one selectable collection instance per piece, optionally includes the blueprint's quantities, and places the models in labeled rows with spacing based on their bounds. It preserves existing scene objects. Columns, gap and labels are configurable in the import dialog.

Move each instance as a complete furniture item. Blender's Make Instances Real command can convert it to editable objects if needed. The collection's custom properties contain warnings and the retained room/fixture metadata.

## Local portable build

The regular upstream build process includes the new tab. An optional Windows helper can reuse an installed wow.export runtime of the same version:

```
bun install
bun tools/build-room-importer.mjs
```

Pass the installed application's directory as an argument if it is not under LOCALAPPDATA. The output is `bin/room-importer`; use `Launch Room Blueprint.cmd`. It uses a separate profile and disables automatic updating. This helper is for local development; portable binaries and private captures must not be committed.

## Tests

```
node --test tests/blueprint.test.cjs tests/export_blueprint.test.cjs
blender --background --factory-startup --python tests/test_blender_lineup.py
python -m pip install --target .test-deps lupa
python tests/test_roomprobe.py
```

The JavaScript tests cover data-only Lua parsing, quantities, unresolved IDs and texture bundling. The Blender test checks real glTF import, repeated instances, hierarchy, ground alignment, non-overlapping bounds, labels and preservation of existing objects. The Lua test covers captures, disabled debug getters and opt-in blueprint events.
