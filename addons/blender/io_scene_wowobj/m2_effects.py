"""Optional, bounded preview of exported M2 effects; not a WoW particle simulator."""
import json
import math
import random
import base64
import struct
from pathlib import Path
import bpy
from mathutils import Matrix, Vector, Quaternion


def initial_bone_matrix(bones, index, visiting=None):
    if index < 0 or index >= len(bones): return Matrix.Identity(4)
    visiting = set() if visiting is None else set(visiting)
    if index in visiting or len(visiting) > 128: raise ValueError('Invalid bone hierarchy')
    visiting.add(index)
    bone = bones[index]
    pivot = Vector(bone['pivot'])
    x,y,z,w = first(bone['rotation'], [0,0,0,1])
    rotation = Quaternion((w,x,y,z)); rotation.normalize()
    scale = first(bone['scale'], [1,1,1])
    matrix = (Matrix.Translation(pivot + Vector(first(bone['translation'], [0,0,0]))) @
              rotation.to_matrix().to_4x4() @ Matrix.Diagonal((*scale,1)) @ Matrix.Translation(-pivot))
    return initial_bone_matrix(bones, bone['parent'], visiting) @ matrix


def preview_rate(track):
    """Time-average the positive first rate clip for our constant-density preview."""
    timelines = track.get('timelines', [])
    if not timelines:
        return 0.0
    times, values = timelines[0].get('times', []), timelines[0].get('values', [])
    if not values:
        return 0.0
    if len(times) != len(values) or len(times) < 2 or times[-1] <= times[0]:
        return max(0.0, values[0])
    area = 0.0
    for t0, t1, a, b in zip(times, times[1:], values, values[1:]):
        if t1 <= t0:
            return max(0.0, values[0])
        if track.get('interpolation', 0) == 0:
            area += (t1-t0)*max(0.0,a)
        elif a*b < 0:
            positive = max(a,b)
            area += (t1-t0)*positive*positive/(2*abs(b-a))
        else:
            area += (t1-t0)*(max(0.0,a)+max(0.0,b))/2
    return area/(times[-1]-times[0])


def particle_spawn(entry, bones, rng):
    """Initial-pose preview; spherical surface interpretation remains experimental."""
    width = max(0, first(entry['width'], 0))
    length = max(0, first(entry['length'], 0))
    matrix = initial_bone_matrix(bones, entry['bone'])
    if entry['emitterType'] == 2 and bones:
        a = rng.uniform(-1,1) * first(entry['verticalRange'],0)
        b = rng.uniform(-1,1) * first(entry['horizontalRange'],0)
        direction = Vector((math.sin(a), math.cos(a)*math.cos(b), math.sin(b))).normalized()
        offset = Vector((direction.x*width, direction.y*length, direction.z*width))
    else:
        offset = Vector((rng.uniform(-width/2,width/2), rng.uniform(-length/2,length/2),0))
        direction = Vector((0,0,1))
    position = matrix @ (Vector(entry['position']) + offset)
    velocity = matrix.to_3x3() @ direction * first(entry['speed'],0)
    center = Vector(entry['position'])
    return Vector(convert(position-center)), Vector(convert(velocity))


def additive_particle_material(material):
    """Add-alpha particles emit texture RGB without an opaque surface beneath."""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    if nodes.get('M2 Additive Particle'):
        return
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    color = shader.inputs['Emission Color'].links[0].from_socket
    opacity = nodes['Lifetime opacity'].outputs[0]
    output = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
    emission = nodes.new('ShaderNodeEmission')
    links.new(color, emission.inputs['Color'])
    links.new(opacity, emission.inputs['Strength'])
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    add = nodes.new('ShaderNodeAddShader'); add.name = 'M2 Additive Particle'
    links.new(transparent.outputs[0], add.inputs[0])
    links.new(emission.outputs[0], add.inputs[1])
    links.new(add.outputs[0], output.inputs['Surface'])
    nodes.remove(shader)


def premultiplied_particle_material(material):
    """Blend 7 preview: premultiplied RGB plus background attenuated by alpha."""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    if nodes.get('M2 Premultiplied Particle'): return
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    color = shader.inputs['Emission Color'].links[0].from_socket
    opacity = nodes['Lifetime opacity']
    life = nodes.new('ShaderNodeMath'); life.operation='MULTIPLY'; life.inputs[0].default_value=1
    # Reuse the animated lifetime factor through a link, without texture alpha twice.
    life.name='M2 Lifetime factor'
    emission=nodes.new('ShaderNodeEmission'); links.new(color,emission.inputs['Color'])
    links.new(life.outputs[0],emission.inputs['Strength'])
    inverse=nodes.new('ShaderNodeMath'); inverse.operation='SUBTRACT'; inverse.inputs[0].default_value=1
    links.new(opacity.outputs[0],inverse.inputs[1])
    transparent=nodes.new('ShaderNodeBsdfTransparent'); links.new(inverse.outputs[0],transparent.inputs['Color'])
    add=nodes.new('ShaderNodeAddShader'); add.name='M2 Premultiplied Particle'
    links.new(transparent.outputs[0],add.inputs[0]); links.new(emission.outputs[0],add.inputs[1])
    output=next(n for n in nodes if n.type=='OUTPUT_MATERIAL'); links.new(add.outputs[0],output.inputs['Surface'])
    nodes.remove(shader)


def bind_particle_size(sprite, emitter):
    if 'Size multiplier' not in emitter:
        emitter['Size multiplier']=1.0
        emitter.id_properties_ui('Size multiplier').update(min=0,soft_max=30,description='Preview size adjustment; original lifetime size curve is retained')
    for key in ['Random size min','Random size max']:
        if key not in emitter:
            emitter[key]=1.0
            emitter.id_properties_ui(key).update(min=0,soft_max=3,description='Random multiplier per particle lifetime, multiplied by Size multiplier. Equal bounds give a fixed size.')
    start,period=1.0,24.0
    if sprite.animation_data and sprite.animation_data.action:
        action=sprite.animation_data.action
        curves=action.fcurves if hasattr(action,'fcurves') else [c for l in action.layers for s in l.strips for b in s.channelbags for c in b.fcurves]
        keys=[k.co.x for c in curves if c.data_path=='scale' for k in c.keyframe_points]
        if keys:start=min(keys);period=max(0.01,max(keys)-start)
    if 'Size random seed' not in sprite:
        sprite['Size random seed']=sum((i+1)*ord(c) for i,c in enumerate(sprite.name))
    seed=sprite['Size random seed']
    if 'Size pulsation' not in emitter:
        emitter['Size pulsation']=False
        emitter.id_properties_ui('Size pulsation').update(description='Smoothly pulse between the size bounds instead of choosing a fixed size per lifetime')
    if 'Pulse speed' not in emitter:
        emitter['Pulse speed']=1.0
        emitter.id_properties_ui('Pulse speed').update(min=0,soft_max=5,description='Size pulsation cycles per second')
    fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    # Avoid modulo and abs: both can force Python evaluation instead of Blender's simple-expression evaluator.
    random_value='(0.5+0.5*sin(floor((frame-(%.6f))/%.6f)*12.9898+%d))'%(start,period,seed)
    pulse_value='(0.5+0.5*sin(frame*speed*%.8f+%d))'%(2*math.pi/fps,seed)
    variation='(%s if pulse<0.5 else %s)'%(random_value,pulse_value)
    for axis in range(3):
        sprite.driver_remove('delta_scale',axis)
        driver=sprite.driver_add('delta_scale',axis).driver
        for variable in list(driver.variables):driver.variables.remove(variable)
        for name,key in [('size','Size multiplier'),('low','Random size min'),('high','Random size max'),('pulse','Size pulsation'),('speed','Pulse speed')]:
            variable=driver.variables.new();variable.name=name;variable.type='SINGLE_PROP'
            variable.targets[0].id=emitter;variable.targets[0].data_path='["%s"]'%key
        driver.expression='size*(min(low,high)+(max(low,high)-min(low,high))*%s)'%variation


def particle_engine_outputs(material):
    """Share animated color/opacity, with an explicit Cycles transparency mix."""
    nodes,links=material.node_tree.nodes,material.node_tree.links
    if nodes.get('M2 Cycles Output'): return
    if not (nodes.get('M2 Additive Particle') or nodes.get('M2 Premultiplied Particle')): return
    output=next(n for n in nodes if n.type=='OUTPUT_MATERIAL')
    emission=next(n for n in nodes if n.type=='EMISSION')
    color=emission.inputs['Color'].links[0].from_socket
    strength=emission.inputs['Strength'].links[0].from_socket
    output.name='M2 Eevee Output';output.label='Eevee particle';output.target='EEVEE';output.location=(1100,200)
    coverage=nodes.new('ShaderNodeRGBToBW');coverage.name='M2 Cycles Coverage'
    links.new(color,coverage.inputs[0])
    alpha=nodes.new('ShaderNodeMath');alpha.operation='MULTIPLY';alpha.use_clamp=True;alpha.name='M2 Cycles Alpha'
    links.new(coverage.outputs[0],alpha.inputs[0]);links.new(strength,alpha.inputs[1])
    safe=nodes.new('ShaderNodeMath');safe.operation='MAXIMUM';safe.inputs[1].default_value=0.000001
    links.new(alpha.outputs[0],safe.inputs[0])
    unpremultiply=nodes.new('ShaderNodeMath');unpremultiply.operation='DIVIDE';unpremultiply.name='M2 Cycles Emission Strength'
    links.new(strength,unpremultiply.inputs[0]);links.new(safe.outputs[0],unpremultiply.inputs[1])
    cycles_emission=nodes.new('ShaderNodeEmission');cycles_emission.name='M2 Cycles Emission'
    links.new(color,cycles_emission.inputs['Color']);links.new(unpremultiply.outputs[0],cycles_emission.inputs['Strength'])
    transparent=nodes.new('ShaderNodeBsdfTransparent');transparent.name='M2 Cycles Transparent'
    mix=nodes.new('ShaderNodeMixShader');mix.name='M2 Cycles Particle'
    links.new(alpha.outputs[0],mix.inputs[0]);links.new(transparent.outputs[0],mix.inputs[1]);links.new(cycles_emission.outputs[0],mix.inputs[2])
    cycles_output=nodes.new('ShaderNodeOutputMaterial');cycles_output.name='M2 Cycles Output';cycles_output.label='Cycles particle';cycles_output.target='CYCLES';cycles_output.location=(1100,-300)
    links.new(mix.outputs[0],cycles_output.inputs['Surface'])
    cycles_output.is_active_output=True
    output.is_active_output=True
    for i,node in enumerate([coverage,alpha,safe,unpremultiply,cycles_emission,transparent,mix]):
        node.location=(i%4*220-50,-300-i//4*220)
    material['Particle rendering']='Separate Eevee and Cycles outputs share texture and lifetime animation. Cycles uses bounded coverage with an explicit transparent mix.'


def refine_particle_preview(sprite, entry, index):
    """Deterministic visual variation, separate from recovered emitter values."""
    if sprite.get('Preview variation applied'): return
    emitter=sprite.parent
    rng=random.Random(entry['id']*100003+index*997+19)
    for name,description in [('Height offset','Vertical preview offset in model units'),
                              ('Extra spread','Additional horizontal preview spread in model units')]:
        if name not in emitter:
            emitter[name]=0.0
            emitter.id_properties_ui(name).update(soft_min=-1 if name=='Height offset' else 0,soft_max=2,description=description)
    driver=emitter.driver_add('delta_location',1).driver
    if not driver.variables:
        v=driver.variables.new();v.name='height';v.type='SINGLE_PROP';v.targets[0].id=emitter;v.targets[0].data_path='["Height offset"]'
    driver.expression='height'
    driver=sprite.driver_add('delta_location',2).driver
    v=driver.variables.new();v.name='spread';v.type='SINGLE_PROP';v.targets[0].id=emitter;v.targets[0].data_path='["Extra spread"]'
    driver.expression='%r * spread' % rng.uniform(-0.5,0.5)
    rows,cols=max(1,entry['rows']),max(1,entry['columns'])
    tile=rng.randrange(rows*cols)
    for loop in sprite.data.uv_layers.active.data:
        loop.uv.x+=(tile%cols)/cols
        loop.uv.y+=(tile//cols)/rows
    material=sprite.data.materials[0]
    if material.node_tree.animation_data:
        for curve in material.node_tree.animation_data.drivers:
            if 'Location' in curve.data_path or 'inputs[1]' in curve.data_path:
                # Mapping Location is inputs[1]; randomize only mapping nodes.
                if 'Mapping' in curve.data_path:
                    curve.driver.expression='(%s) + %r' % (curve.driver.expression,rng.random())
    factor=max(0.2,1+rng.uniform(-1,1)*min(0.8,entry.get('lifespanVariation',0)))
    phase=rng.uniform(-15,0)
    for block in [sprite,material.node_tree]:
        if not block.animation_data or not block.animation_data.action: continue
        action=block.animation_data.action
        curves=action.fcurves if hasattr(action,'fcurves') else [c for l in action.layers for s in l.strips for b in s.channelbags for c in b.fcurves]
        for curve in curves:
            for key in curve.keyframe_points:
                key.co.x=key.co.x*factor+phase
            curve.update()
    sprite['Preview variation applied']=True
    sprite['Preview atlas tile']=tile


def add_particle_layers(material, entry, textures, source):
    """Approximate scrolling modulation layers; not the full WoW shader."""
    if entry['blend'] != 7 or not entry['flags'] & 0x10000000: return
    nodes,links=material.node_tree.nodes,material.node_tree.links
    if nodes.get('M2 Layer UV'): return
    raw=base64.b64decode(entry.get('rawRecord',''))
    if len(raw)!=492: return
    tint=next(n for n in nodes if n.type=='MIX_RGB')
    color=tint.inputs[1].links[0].from_socket
    uv=nodes.new('ShaderNodeTexCoord');uv.name='M2 Layer UV'
    fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    for layer in range(2):
        index=(entry['texture']>>(5*(layer+1)))&31
        if index>=len(textures): continue
        rel=textures[index].get('fileNameExternal')
        if not rel: continue
        path=(Path(source).parent/rel.replace('\\','/')).resolve()
        if not path.is_file(): continue
        tex=nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(path),check_existing=True)
        mapping=nodes.new('ShaderNodeMapping');links.new(uv.outputs['UV'],mapping.inputs['Vector'])
        scale=struct.unpack_from('b',raw,44+layer)[0]/32
        mapping.inputs['Scale'].default_value=(scale,scale,1)
        for axis in range(2):
            speed=struct.unpack_from('<h',raw,476+layer*4+axis*2)[0]/512
            driver=mapping.inputs['Location'].driver_add('default_value',axis).driver
            driver.expression='%r * (frame-1) / %r' % (speed,fps)
        links.new(mapping.outputs['Vector'],tex.inputs['Vector'])
        multiply=nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1
        links.new(color,multiply.inputs[1]);links.new(tex.outputs['Color'],multiply.inputs[2])
        gain=nodes.new('ShaderNodeVectorMath');gain.operation='SCALE';gain.inputs['Scale'].default_value=2
        links.new(multiply.outputs[0],gain.inputs[0]);color=gain.outputs[0]
    links.new(color,tint.inputs[1])
    # Approximate the combined layer coverage so dark modulation does not
    # leave an opaque silhouette from the original mask alone.
    coverage=nodes.new('ShaderNodeRGBToBW');coverage.name='M2 Layer Coverage'
    links.new(color,coverage.inputs[0])
    links.new(coverage.outputs[0],nodes['Lifetime opacity'].inputs[0])


def first(track, default):
    for timeline in track.get('timelines', []):
        if timeline.get('values'):
            return timeline['values'][0]
    return default


def convert(v):
    return (v[0], v[2], -v[1])


def sample(ramp, time, default):
    values, times = ramp.get('values', []), ramp.get('times', [])
    if not values or len(values) != len(times):
        return default
    if time <= times[0]: return values[0]
    for i in range(1, len(times)):
        if time <= times[i]:
            factor = (time-times[i-1]) / max(0.000001, times[i]-times[i-1])
            a,b=values[i-1],values[i]
            return [x+(y-x)*factor for x,y in zip(a,b)] if isinstance(a,list) else a+(b-a)*factor
    return values[-1]


def animate_loop(block):
    if not block.animation_data or not block.animation_data.action:
        return
    action = block.animation_data.action
    curves = (action.fcurves if hasattr(action, 'fcurves') else
              [c for l in action.layers for s in l.strips for b in s.channelbags for c in b.fcurves])
    for curve in curves:
        for key in curve.keyframe_points:
            key.interpolation = 'LINEAR'
        curve.modifiers.new('CYCLES')


def reconstruct_effects(obj, source):
    source = Path(source)
    sidecar = source.with_suffix('.effects.json')
    if not sidecar.is_file():
        return
    if sidecar.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Effects metadata exceeds 32 MB')
    effects = json.loads(sidecar.read_text(encoding='utf-8-sig'))
    if effects.get('schema') != 'wow.export.effects.v1':
        raise ValueError('Unsupported effects metadata')
    if obj.get('M2 effects imported'):
        return
    collection = obj.users_collection[0]
    notes = list(effects.get('warnings', []))
    root = bpy.data.objects.new(obj.name + ' - approximate effects', None)
    collection.objects.link(root)
    root.parent = obj
    root['Light power scale'] = 100.0
    root.id_properties_ui('Light power scale').update(min=0, soft_max=1000, description='Approximate conversion of source point-light intensity to Blender power')
    root['Preview notes'] = 'Approximate lights and looping sprites. Review power, size and blend appearance.'
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    for entry in effects.get('lights', [])[:32]:
        if entry['type'] not in (0, 1):
            notes.append('Unsupported light type %s' % entry['type']); continue
        data = bpy.data.lights.new('M2 light %s' % entry['id'], 'POINT' if entry['type'] == 1 else 'SUN')
        data.use_nodes = False
        light = bpy.data.objects.new(data.name, data)
        collection.objects.link(light); light.parent = root
        light.location = convert(entry['position'])
        data.color = first(entry['diffuseColor'], (1, 1, 1))
        data.energy = max(0, first(entry['diffuseIntensity'], 0)) * (100 if data.type == 'POINT' else 1)
        if data.type == 'POINT':
            driver = data.driver_add('energy').driver
            variable = driver.variables.new(); variable.name = 'power'; variable.type = 'SINGLE_PROP'
            variable.targets[0].id = root; variable.targets[0].data_path = '["Light power scale"]'
            driver.expression = '%r * power' % max(0, first(entry['diffuseIntensity'], 0))
        light['Source data'] = json.dumps(entry)
        light['Needs adjustment'] = 'Intensity units approximated; ambient, attenuation and bone animation not reproduced.'
    textures = effects.get('textures', [])
    for entry in effects.get('particles', [])[:32]:
        # MultiTexture flag: three 5-bit indices in the texture field.
        texture_index = (entry['texture'] & 31) if entry['flags'] & 0x10000000 else entry['texture']
        if texture_index >= len(textures):
            notes.append('Emitter %s: missing texture index' % entry['id']); continue
        rel = textures[texture_index].get('fileNameExternal')
        if not rel:
            notes.append('Emitter %s: texture not exported' % entry['id']); continue
        image_path = (source.parent / rel.replace('\\', '/')).resolve()
        if not image_path.is_file():
            notes.append('Emitter %s: missing texture file' % entry['id']); continue
        if entry['emitterType'] not in (1, 2):
            notes.append('Emitter %s: unsupported emitter type' % entry['id']); continue
        life = max(0.05, min(10, first(entry['lifespan'], 1)))
        rate = preview_rate(entry['rate'])
        count = min(24, math.ceil(rate * life))
        emitter = bpy.data.objects.new('M2 emitter %s' % entry['id'], None)
        collection.objects.link(emitter); emitter.parent = root
        emitter.location = convert(entry['position'])
        emitter['Source data'] = json.dumps(entry)
        emitter['Needs adjustment'] = 'Initial bone pose only. Sphere surface spawning is experimental; first texture layer and initial rate/speed. No bone motion, drag, turbulence or exact engine blending.'
        emitter['Spawn mode'] = 'Experimental sphere surface' if entry['emitterType'] == 2 and effects.get('bones') else 'Plane preview'
        emitter['Source particle count'] = rate * life
        emitter['Preview particle count'] = count
        if len((entry['rate'].get('timelines') or [{}])[0].get('values', [])) > 1:
            emitter['Rate approximation'] = 'Positive time-average of first rate clip; individual burst timing not reconstructed.'
            notes.append('Emitter %s: animated rate uses positive clip average, not exact burst timing.' % entry['id'])
        rng = random.Random(entry['id'])
        rows, columns = max(1, entry['rows']), max(1, entry['columns'])
        if rows * columns > 4096:
            notes.append('Emitter %s: unreasonable atlas dimensions' % entry['id']); continue
        image = bpy.data.images.load(str(image_path), check_existing=True)
        image.alpha_mode = 'CHANNEL_PACKED'
        color = (entry.get('color', {}).get('values') or [[1, 1, 1]])[0]
        color = tuple(max(0, min(1, c / 255 if max(color) > 1 else c)) for c in color)
        scale = max([max(v) for v in entry.get('scale', {}).get('values', [])] or [0.2])
        width = max(0, first(entry['width'], 0))
        length = max(0, first(entry['length'], 0))
        speed = first(entry['speed'], 0)
        mat = bpy.data.materials.new(emitter.name + ' preview')
        mat.use_nodes = True; mat.surface_render_method = 'BLENDED'
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        tex = nodes.new('ShaderNodeTexImage'); tex.image = image
        tint = nodes.new('ShaderNodeMixRGB'); tint.blend_type = 'MULTIPLY'; tint.inputs[0].default_value = 1
        tint.inputs[2].default_value = (*color, 1)
        links.new(tex.outputs['Color'], tint.inputs[1]); links.new(tint.outputs[0], shader.inputs['Base Color'])
        opacity = nodes.new('ShaderNodeMath'); opacity.name = 'Lifetime opacity'; opacity.operation = 'MULTIPLY'
        links.new(tex.outputs['Alpha'], opacity.inputs[0]); links.new(opacity.outputs[0], shader.inputs['Alpha'])
        add_particle_layers(mat, entry, textures, source)
        if entry['blend'] in (4, 7):
            links.new(tint.outputs[0], shader.inputs['Emission Color']); shader.inputs['Emission Strength'].default_value = 1
        if entry['blend'] == 4:
            additive_particle_material(mat)
        elif entry['blend'] == 7:
            premultiplied_particle_material(mat)
        particle_engine_outputs(mat)
        for i in range(count):
            mesh = bpy.data.meshes.new(emitter.name + ' sprite')
            mesh.from_pydata([(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)], [], [(0,1,2,3)])
            uv = mesh.uv_layers.new()
            for loop, coord in zip(uv.data, [(0,0),(1/columns,0),(1/columns,1/rows),(0,1/rows)]): loop.uv = coord
            sprite = bpy.data.objects.new(mesh.name, mesh)
            sprite['Centered particle pivot']=True
            sprite.visible_shadow = False  # Effect cards must not block Cycles shadow rays.
            collection.objects.link(sprite); sprite.parent = emitter
            sprite.rotation_euler.y = math.pi / 2  # Face model +X; local Y is vertical.
            bind_particle_size(sprite, emitter)
            sprite_mat = mat.copy(); mesh.materials.append(sprite_mat)
            sprite_tint = sprite_mat.node_tree.nodes.get(tint.name)
            sprite_alpha = sprite_mat.node_tree.nodes.get(opacity.name)
            spawn, velocity = particle_spawn(entry, effects.get('bones', []), rng)
            start = 1 - (i / max(1,count)) * life * fps
            fractions = sorted(set([0,1] + [max(0,min(1,t)) for key in ('color','alpha','scale') for t in entry.get(key,{}).get('times',[])]))
            for fraction in fractions:
                sprite.location = spawn + velocity * life * fraction
                size = sample(entry.get('scale',{}), fraction, [scale,scale])
                sprite.scale = (size[0],size[1],1)
                frame = start + fraction * life * fps
                sprite.keyframe_insert('location', frame=frame); sprite.keyframe_insert('scale', frame=frame)
                rgb = sample(entry.get('color',{}), fraction, [255,255,255])
                sprite_tint.inputs[2].default_value = (*[max(0,min(1,c/255)) for c in rgb],1)
                sprite_tint.inputs[2].keyframe_insert('default_value',frame=frame)
                sprite_alpha.inputs[1].default_value = max(0,min(1,sample(entry.get('alpha',{}),fraction,32767)/32767))
                sprite_alpha.inputs[1].keyframe_insert('default_value',frame=frame)
                lifetime_node=sprite_mat.node_tree.nodes.get('M2 Lifetime factor')
                if lifetime_node:
                    lifetime_node.inputs[1].default_value=sprite_alpha.inputs[1].default_value
                    lifetime_node.inputs[1].keyframe_insert('default_value',frame=frame)
            animate_loop(sprite)
            animate_loop(sprite_mat.node_tree)
            refine_particle_preview(sprite, entry, i)
            bind_particle_size(sprite, emitter)
        bpy.data.materials.remove(mat)
        if rows*columns>1: notes.append('Emitter %s: preview varies atlas tiles and scroll phases; exact flipbook timing remains unverified.' % entry['id'])
    for entry in effects.get('ribbons', [])[:64]:
        marker = bpy.data.objects.new('M2 ribbon %s - needs trail reconstruction' % entry['id'], None)
        collection.objects.link(marker); marker.parent = root; marker.location = convert(entry['position'])
        marker['Source data'] = json.dumps(entry)
        notes.append('Ribbon %s: attachment marker only; motion history is required for its trail.' % entry['id'])
    root['Review notes'] = '\n'.join(notes)
    obj['M2 effects imported'] = True
    if effects.get('particles'):
        bpy.context.scene.cycles.transparent_max_bounces = max(64, bpy.context.scene.cycles.transparent_max_bounces)
        notes.append('Cycles transparent bounce limit raised to at least 64 for overlapping particle cards (scene-wide).')
    obj['M2 effects review'] = '\n'.join(notes)
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    return root
