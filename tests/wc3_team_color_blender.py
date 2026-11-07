"""Background Blender test: --python tests/wc3_team_color_blender.py -- <wc3fx>
Checks shared controls, independent imports, packed textures, rendered mask math,
and save/reopen persistence. Uses only a fresh background scene.
"""
import bpy
import importlib.util
import json
import os
import sys
import tempfile

assert bpy.app.background and not bpy.data.filepath
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('io_scene_wc3fx', os.path.join(repo, 'addons', 'blender', 'io_scene_wc3fx.py'))
fx = importlib.util.module_from_spec(spec); sys.modules[spec.name] = fx; spec.loader.exec_module(fx); fx.register()
package = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
root = fx.import_package(package)
meta, _ = fx._cache(root); rgb = fx.team_color_node(root)
expected = [fx.srgb_to_linear(c) for c in meta['teamColor']['color']]
assert max(abs(rgb.outputs[0].default_value[i] - expected[i]) for i in range(3)) < 1e-6
group = bpy.data.node_groups[root['wc3fx_team_color_group']]
materials = {s.material for o in root.children_recursive if o.type == 'MESH' for s in o.material_slots if s.material}
controlled = [m for m in materials if any(n.type == 'GROUP' and n.node_tree == group for n in m.node_tree.nodes)]
assert controlled
for material in controlled:
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    tint = shader.inputs['Base Color'].links[0].from_node
    assert tint.type == 'GROUP' and tint.node_tree.name.startswith('WC3 Masked Team Tint')
    base = tint.inputs['Base Color'].links[0].from_node
    mask = tint.inputs['Mask'].links[0].from_node
    assert base.image.packed_file and mask.image.packed_file
    assert base.image.colorspace_settings.name == mask.image.colorspace_settings.name == 'Non-Color'
    if shader.inputs['Alpha'].is_linked:
        seen, sources = set(), set()
        def trace(socket):
            for link in socket.links:
                sources.add((link.from_node, link.from_socket.name))
                if link.from_node not in seen:
                    seen.add(link.from_node)
                    for input in link.from_node.inputs:
                        trace(input)
        trace(shader.inputs['Alpha'])
        assert (base, 'Alpha') in sources and all(n != mask for n, _ in sources), 'Team mask must not replace opacity'
second = fx.import_package(package)
assert fx.team_color_node(second) != rgb
changed = (0.8, 0.1, 0.3)
rgb.outputs[0].default_value = (*[fx.srgb_to_linear(c) for c in changed], 1)
assert max(abs(fx.team_color_node(second).outputs[0].default_value[i] - expected[i]) for i in range(3)) < 1e-6
name, control_name = root.name, group.name
with tempfile.TemporaryDirectory(prefix='wow-wc3-team-color-') as folder:
    file = os.path.join(folder, 'color.blend')
    bpy.ops.wm.save_as_mainfile(filepath=file); bpy.ops.wm.open_mainfile(filepath=file)
    root = bpy.data.objects[name]; rgb = fx.team_color_node(root)
    assert max(abs(rgb.outputs[0].default_value[i] - fx.srgb_to_linear(changed[i])) for i in range(3)) < 1e-6
    assert all(img.packed_file for img in bpy.data.images if img.name.startswith('WC3 ') and img.source == 'FILE')
    # Render the actual shader group with known colors and mask amounts.
    # Emission avoids lighting/view-transform differences in the comparison.
    for obj in bpy.context.scene.objects:
        obj.hide_render = True
    bpy.ops.mesh.primitive_plane_add(size=2)
    plane = bpy.context.object
    material = bpy.data.materials.new('Team color rendering test'); material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links; nodes.clear()
    tint = nodes.new('ShaderNodeGroup'); tint.node_tree = bpy.data.node_groups['WC3 Masked Team Tint']
    color = nodes.new('ShaderNodeGroup'); color.node_tree = bpy.data.node_groups[control_name]
    links.new(color.outputs[0], tint.inputs['Team Color'])
    base = (0.6, 0.4, 0.2); tint.inputs['Base Color'].default_value = (*base, 1)
    emission = nodes.new('ShaderNodeEmission'); output = nodes.new('ShaderNodeOutputMaterial')
    links.new(tint.outputs[0], emission.inputs['Color']); links.new(emission.outputs[0], output.inputs['Surface'])
    plane.data.materials.append(material)
    bpy.ops.object.camera_add(location=(0, 0, 3)); camera = bpy.context.object
    camera.data.type = 'ORTHO'; camera.data.ortho_scale = 1
    scene = bpy.context.scene; scene.camera = camera; scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'; scene.cycles.samples = 1; scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 16; scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'OPEN_EXR'; scene.render.image_settings.color_depth = '32'
    errors = []
    for test_color, amount in [(changed, 0), (changed, 0.5), (changed, 1), ((0, 0, 0), 1), ((1, 1, 1), 1)]:
        rgb.outputs[0].default_value = (*[fx.srgb_to_linear(c) for c in test_color], 1)
        tint.inputs['Mask'].default_value = amount
        scene.render.filepath = os.path.join(folder, 'render.exr'); bpy.ops.render.render(write_still=True)
        rendered = bpy.data.images.load(scene.render.filepath, check_existing=False)
        pixel = list(rendered.pixels)[(8 * 16 + 8) * 4:][:3]
        expected = [fx.srgb_to_linear(base[i] * (1 - amount + amount * test_color[i])) for i in range(3)]
        errors.append(max(abs(a - b) for a, b in zip(pixel, expected)))
        bpy.data.images.remove(rendered)
    assert max(errors) < 0.0001, errors
print('WC3 TEAM COLOR PASS', json.dumps({'materials': len(controlled), 'maximumRenderedError': max(errors)}))
