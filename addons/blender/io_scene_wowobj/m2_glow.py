"""M2 additive glow layers with shared base/glow UV coordinates."""
import bpy


def emission_inputs(material):
    if not material or not material.use_nodes:
        return []
    result = []
    for node in material.node_tree.nodes:
        if node.name == 'M2 Reflection Highlight':
            continue
        if node.type == 'EMISSION':
            result.append(node.inputs['Strength'])
        elif node.type == 'BSDF_PRINCIPLED':
            strength = node.inputs['Emission Strength']
            color = node.inputs['Emission Color']
            if strength.is_linked or (strength.default_value > 0 and
                    (color.is_linked or any(color.default_value[:3]))):
                result.append(strength)
    return result


def bind_emission_control(obj):
    """Scale imported glow without replacing its texture mask or animation."""
    slots = [slot for slot in obj.material_slots if emission_inputs(slot.material)]
    if not slots:
        return
    if 'Emission' not in obj:
        obj['Emission'] = 1.0
    obj.id_properties_ui('Emission').update(
        min=0.0, max=100.0, soft_min=0.0, soft_max=10.0, default=1.0,
        description='Glow multiplier: 0 off, 1 exported brightness. Preserves animated flicker.')
    for slot in slots:
        slot_index = next(i for i, candidate in enumerate(obj.material_slots) if candidate == slot)
        control = 'Slot %d' % (slot_index + 1)
        if control not in obj:
            obj[control] = obj.get('Emission ' + control, 1.0)
        obj.id_properties_ui(control).update(min=0.0, max=100.0, soft_min=0.0, soft_max=10.0,
            default=1.0, description=slot.material.name + ": glow multiplier, combined with master Emission")
        # An object driver must not change another object's shared material.
        if slot.material.users > 1:
            slot.material = slot.material.copy()
        tree = slot.material.node_tree
        scale = tree.nodes.get('Object Emission Multiplier')
        if not scale:
            strength = emission_inputs(slot.material)[0]
            source = strength.links[0].from_socket if strength.is_linked else None
            scale = tree.nodes.new('ShaderNodeMath')
            scale.name = 'Object Emission Multiplier'
            scale.label = 'Object Emission × animated glow'
            scale.operation = 'MULTIPLY'
            scale.location = (100, -200)
            if source:
                tree.links.new(source, scale.inputs[0])
            else:
                scale.inputs[0].default_value = strength.default_value
            tree.links.new(scale.outputs[0], strength)
        scale.inputs[1].driver_remove('default_value')
        driver = scale.inputs[1].driver_add('default_value').driver
        driver.type = 'SCRIPTED'
        driver.expression = 'emission * material_strength'
        variable = driver.variables.new()
        variable.name = 'emission'
        variable.type = 'SINGLE_PROP'
        variable.targets[0].id = obj
        variable.targets[0].data_path = '["Emission"]'
        per_material = driver.variables.new()
        per_material.name = 'material_strength'
        per_material.type = 'SINGLE_PROP'
        per_material.targets[0].id = obj
        per_material.targets[0].data_path = '[\"%s\"]' % control


def apply_m2_glow(material, principled, texture_nodes, unit, metadata, settings):
    # ShaderMapper: Opaque_AddAlpha_Wgt / Mod_AddAlpha_Wgt, Diffuse_T1_T1.
    # Other shader families may use environment coordinates or different combiners.
    if unit.get('shaderID') not in (32778, 32782) or len(texture_nodes) != 2:
        return False
    base, glow = texture_nodes
    tree = material.node_tree
    if unit['shaderID'] == 32782 and settings.useAlpha:
        tree.links.new(base.outputs['Alpha'], principled.inputs['Alpha'])
    if not settings.createEmissiveMaterials:
        return True
    tree.links.new(glow.outputs['Color'], principled.inputs['Emission Color'])
    weight = tree.nodes.new('ShaderNodeValue')
    weight.name = 'M2 Glow Weight'
    weight.label = 'Exported glow weight'
    weight.location = (-350, -400)
    weight.outputs[0].default_value = 1.0
    multiply = tree.nodes.new('ShaderNodeMath')
    multiply.operation = 'MULTIPLY'
    multiply.label = 'Glow alpha × weight'
    multiply.location = (-100, -200)
    tree.links.new(glow.outputs['Alpha'], multiply.inputs[0])
    tree.links.new(weight.outputs[0], multiply.inputs[1])
    tree.links.new(multiply.outputs[0], principled.inputs['Emission Strength'])
    lookup = metadata.get('transparencyLookup', [])
    tracks = metadata.get('textureWeights', [])
    index = unit.get('textureWeightComboIndex', -2) + 1
    if not 0 <= index < len(lookup) or not 0 <= lookup[index] < len(tracks):
        return True
    track = tracks[lookup[index]]
    times, values = track.get('timestamps', []), track.get('values', [])
    # Use the first model animation. Do not concatenate unrelated animation tracks.
    if not times or not values or not times[0] or len(times[0]) != len(values[0]):
        return True
    samples = [(t, max(0.0, min(1.0, v / 32767.0))) for t, v in zip(times[0], values[0])]
    weight.outputs[0].default_value = samples[0][1]
    if not settings.importUVAnimations or len(samples) < 2:
        return True
    if track.get('interpolation', 1) not in (0, 1) or track.get('globalSeq', 65535) != 65535:
        return True
    if any(b[0] <= a[0] for a, b in zip(samples, samples[1:])):
        return True
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    for milliseconds, value in samples:
        weight.outputs[0].default_value = value
        weight.outputs[0].keyframe_insert('default_value', frame=1 + milliseconds * fps / 1000)
    animation = tree.animation_data
    action = animation.action
    if hasattr(action, 'fcurves'):
        curves = action.fcurves
    else:
        curves = [curve for layer in action.layers for strip in layer.strips
                  for bag in strip.channelbags for curve in bag.fcurves]
    data_path = weight.outputs[0].path_from_id('default_value')
    for curve in curves:
        if curve.data_path == data_path:
            for key in curve.keyframe_points:
                key.interpolation = 'CONSTANT' if track.get('interpolation') == 0 else 'LINEAR'
            # Repeat the selected clip's sampled interval; no particle animation is implied.
            curve.modifiers.new('CYCLES')
    weight.outputs[0].default_value = samples[0][1]
    return True


