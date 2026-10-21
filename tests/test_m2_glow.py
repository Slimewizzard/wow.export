"""Run with blender --background --factory-startup --python this_file -- export.obj."""
import sys
import json
from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'addons' / 'blender'))
from io_scene_wowobj import Settings, import_wowobj

source = Path(sys.argv[sys.argv.index('--') + 1])
metadata = json.loads(source.with_suffix('.json').read_text())
import_wowobj.importWoWOBJAddon(str(source), Settings())
glows = [m for m in bpy.data.objects[source.name].data.materials if m.use_nodes and m.node_tree.nodes.get('M2 Glow Weight')]
assert {m.name for m in glows} == {'mat_7dl_dalaran_kitchenfire01_B2', 'mat_7dl_dalaran_kitchenfire01_B0'}
for material in glows:
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    assert shader.inputs['Emission Color'].is_linked
    assert shader.inputs['Emission Strength'].is_linked
    if material.name.endswith('_B2'):
        assert shader.inputs['Alpha'].links[0].from_node.image.filepath.endswith('kitchenfire01.png')
        action = material.node_tree.animation_data.action
        curves = [c for layer in action.layers for strip in layer.strips for bag in strip.channelbags for c in bag.fcurves]
        fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
        assert abs(curves[0].evaluate(1 + fps * 2.667) - 6553 / 32767) < 0.001
        assert abs(curves[0].evaluate(1 + fps * 6.667) - 6553 / 32767) < 0.001
unit = next(u for u in metadata['skin']['textureUnits'] if u['shaderID'] == 32782)
disabled = import_wowobj.createAdvancedM2Material('disabled', unit, metadata['materials'], metadata['textures'], metadata['textureCombos'], Settings(createEmissiveMaterials=False), str(source.parent), metadata=metadata)
assert not disabled.node_tree.nodes.get('M2 Glow Weight')
assert next(n for n in disabled.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Alpha'].links
print('PASS: full OBJ import, both fire glow materials, correct alpha, animation values/repeat, emission option')



obj = bpy.data.objects[source.name]
assert obj['Emission'] == 1.0
controls = [key for key in obj.keys() if key.startswith('Slot ')]
assert len(controls) == 2
obj[controls[0]] = 0.0
obj.update_tag()
bpy.context.scene.frame_set(1)
slot = obj.material_slots[int(controls[0].split()[-1])-1]
assert slot.material.node_tree.nodes['Object Emission Multiplier'].inputs[1].default_value == 0.0
print('PASS object emission controls on fresh import')

