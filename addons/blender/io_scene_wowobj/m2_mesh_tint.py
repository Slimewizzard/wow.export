"""Exported colour and opacity tracks for single-texture additive M2 meshes."""
import bpy


def track_socket(socket, track, settings, divisor=1.0):
    times, values = track.get('timestamps', []), track.get('values', [])
    if not times or not values or not values[0]:
        return
    def value(v):
        return (*v, 1.0) if isinstance(v, (list, tuple)) else max(0.0, min(1.0, v / divisor))
    socket.default_value = value(values[0][0])
    if not getattr(settings, 'importUVAnimations', False) or len(times[0]) < 2 or len(times[0]) != len(values[0]):
        return
    if track.get('interpolation', 1) not in (0, 1):
        return
    if any(b <= a for a, b in zip(times[0], times[0][1:])):
        return
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    for t, v in zip(times[0], values[0]):
        socket.default_value = value(v)
        socket.keyframe_insert('default_value', frame=1+t*fps/1000)
    action = socket.id_data.animation_data.action
    curves = action.fcurves if hasattr(action, 'fcurves') else [c for l in action.layers for s in l.strips for b in s.channelbags for c in b.fcurves]
    for curve in curves:
        if curve.data_path == socket.path_from_id('default_value'):
            for key in curve.keyframe_points:
                key.interpolation = 'CONSTANT' if track.get('interpolation') == 0 else 'LINEAR'
            curve.modifiers.new('CYCLES')
    socket.default_value = value(values[0][0])


def apply_mesh_tint(material, texture, unit, metadata, settings):
    tree = material.node_tree
    if tree.nodes.get('M2 Mesh Tint'):
        return
    emission = next((n for n in tree.nodes if n.type == 'EMISSION'), None)
    if emission is None:
        return
    tint = tree.nodes.new('ShaderNodeMixRGB')
    tint.name = 'M2 Mesh Tint'
    tint.blend_type = 'MULTIPLY'
    tint.inputs[0].default_value = 1
    tint.inputs[2].default_value = (1,1,1,1)
    tree.links.new(texture.outputs['Color'], tint.inputs[1])
    tree.links.new(tint.outputs[0], emission.inputs['Color'])
    alpha = tree.nodes.new('ShaderNodeValue')
    alpha.name = 'M2 Mesh Opacity'
    alpha.outputs[0].default_value = 1
    weight = tree.nodes.new('ShaderNodeValue')
    weight.name = 'M2 Mesh Weight'
    weight.outputs[0].default_value = 1
    colours = metadata.get('colors', [])
    index = unit.get('colorIndex', 65535)
    if 0 <= index < len(colours):
        track_socket(tint.inputs[2], colours[index].get('color', {}), settings)
        track_socket(alpha.outputs[0], colours[index].get('alpha', {}), settings, 32767)
    lookup = metadata.get('transparencyLookup', [])
    index = unit.get('textureWeightComboIndex', 65535)
    tracks = metadata.get('textureWeights', [])
    if 0 <= index < len(lookup) and 0 <= lookup[index] < len(tracks):
        track_socket(weight.outputs[0], tracks[lookup[index]], settings, 32767)
    source = texture.outputs['Alpha']
    for factor in (alpha.outputs[0], weight.outputs[0]):
        multiply = tree.nodes.new('ShaderNodeMath')
        multiply.operation = 'MULTIPLY'
        tree.links.new(source, multiply.inputs[0])
        tree.links.new(factor, multiply.inputs[1])
        source = multiply.outputs[0]
    control = tree.nodes.get('Object Emission Multiplier')
    tree.links.new(source, control.inputs[0] if control else emission.inputs['Strength'])
    material['M2 mesh tint'] = 'Exported first clip colour/opacity; sampled interval loops. Bone billboarding remains approximate.'
