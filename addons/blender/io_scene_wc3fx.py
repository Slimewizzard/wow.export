"""Import baked Warcraft III PopcornFX packages from wow.export.

MIT license. Sprite orientation rules adapted from Darithos/W3ModelViewer,
revision 7e783bafbacf37e4e6ba7d746a83cf5da7c0b3c8 (copyright 2026 Darithos).
MIT License

Copyright (c) 2026 Darithos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
bl_info = {"name": "wow.export Warcraft III effects", "author": "wow.export contributors", "version": (0, 3, 1), "blender": (4, 2, 0), "location": "File > Import > Warcraft III effect (.wc3fx)", "description": "Experimental baked PopcornFX sprites and model import", "category": "Import-Export"}

import base64
import json
import math
import os
import struct
import tempfile
import uuid
import zipfile
from array import array

import bpy
from bpy.app.handlers import persistent
from bpy.props import StringProperty, BoolProperty, EnumProperty
from bpy_extras.io_utils import ImportHelper
from mathutils import Vector

_caches = {}
_clip_items = {}
_updating = False
MAX_CACHE = 128 * 1024 * 1024
MAX_PACKAGE = 512 * 1024 * 1024


def validate_cache(meta, data):
    if meta.get("schema") != "wow.export.wc3fx.v1" or data[:8] != b"W3FX\x01\x00\x00\x00":
        raise ValueError("Unsupported Warcraft III effect package")
    if len(data) > MAX_CACHE or not 1 <= meta["fps"] <= 60 or not 1 <= meta["frameCount"] <= 1801:
        raise ValueError("Effect cache exceeds importer limits")
    if meta.get("stride") != 17 or len(meta["frameOffsets"]) != meta["frameCount"]:
        raise ValueError("Invalid effect frame index")
    if len(meta["batches"]) > 4096 or sum(b["maxParticles"] for b in meta["batches"]) > 20000:
        raise ValueError("Effect exceeds the particle budget")
    previous = 8
    for offset in meta["frameOffsets"]:
        if offset != previous:
            raise ValueError("Invalid effect frame offset")
        for batch in meta["batches"]:
            if not 0 <= batch["maxParticles"] <= 20000 or offset + 4 > len(data):
                raise ValueError("Invalid particle batch")
            count = struct.unpack_from("<I", data, offset)[0]
            if count > batch["maxParticles"]:
                raise ValueError("Particle count exceeds the batch capacity")
            offset += 4 + count * 68
            if offset > len(data):
                raise ValueError("Truncated particle cache")
        previous = offset
    if previous != len(data):
        raise ValueError("Unexpected bytes after particle cache")


def _read_entry(archive, name, limit=MAX_CACHE):
    # Read bytes by name; never extract arbitrary archive paths onto the filesystem.
    item = archive.getinfo(name)
    if item.file_size > limit:
        raise ValueError("Package entry exceeds size limit: " + name)
    return archive.read(item)


def package_clips(meta):
    if meta.get('schema') == 'wow.export.wc3fx.v2':
        clips = meta.get('clips', [])
        if not 1 <= len(clips) <= 256 or not 0 <= meta.get('defaultClip', 0) < len(clips):
            raise ValueError('Invalid animation clip list')
        return clips
    if meta.get('schema') == 'wow.export.wc3fx.v1':
        return [meta]
    raise ValueError('Unsupported Warcraft III package; update the importer')


def validate_package(meta, data):
    team = meta.get('teamColor')
    if team:
        color, materials = team['color'], team['materials']
        if len(color) != 3 or not all(math.isfinite(c) and 0 <= c <= 1 for c in color) or len(materials) > 4096:
            raise ValueError('Invalid team color data')
        if any(not isinstance(m['material'], int) or m['material'] < 0 or not isinstance(m['base'], str) or not isinstance(m['mask'], str) for m in materials):
            raise ValueError('Invalid team color material')
    clips = package_clips(meta)
    buffers = data if isinstance(data, list) else [data]
    if len(clips) != len(buffers) or sum(len(b) for b in buffers) > MAX_CACHE:
        raise ValueError('Animation cache exceeds importer limits')
    if sum(b['maxParticles'] for c in clips for b in c['batches']) > 20000:
        raise ValueError('Combined animation particles exceed importer limits')
    for clip, buffer in zip(clips, buffers):
        validate_cache(clip, buffer)
        duration = clip.get('modelDuration', 0)
        if not math.isfinite(duration) or not 0 <= duration <= 3600:
            raise ValueError('Invalid model animation duration')


def find_root(obj):
    while obj:
        if obj.get('wc3fx_cache'):
            return obj
        obj = obj.parent
    return None


def prepare_model_animations(data, clips):
    """Give same-named MDX sequences distinct tracks in the temporary import GLB."""
    if len(data) < 20 or data[:4] != b'glTF' or struct.unpack_from('<I', data, 4)[0] != 2:
        raise ValueError('Invalid packaged model')
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A or length > len(data) - 20:
        raise ValueError('Invalid packaged model JSON')
    document = json.loads(data[20:20 + length])
    tracks, used = {}, set()
    for index, animation in enumerate(document.get('animations', [])):
        original = animation.get('name') or ''
        stem = original or 'Animation ' + str(index + 1)
        suffix, duplicate = '', 1
        while True:
            while len((stem + suffix).encode('utf-8')) > 63:
                stem = stem[:-1]
            name = stem + suffix
            if name not in used:
                break
            duplicate += 1; suffix = ' [' + str(duplicate) + ']'
        used.add(name); animation['name'] = name
        tracks.setdefault(original, []).append(name)
    for clip in clips:
        candidates = tracks.get(clip.get('sequence') or '', [])
        # Zero-duration sequences have no GLB animation and must not consume
        # the track belonging to a later sequence with the same name.
        clip['nlaTrack'] = candidates.pop(0) if candidates and clip.get('modelDuration', 1) > 0 else None
    encoded = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    return struct.pack('<4sIIII', b'glTF', 2, 20 + len(encoded) + len(tail), len(encoded), kind) + encoded + tail


def select_clip(root, index, set_timeline=True):
    meta, data = _cache(root); clips = package_clips(meta)
    if not 0 <= index < len(clips):
        raise ValueError('Invalid animation selection')
    clip = clips[index]; root['WC3FX animation index'] = index
    root['WC3FX animation'] = clip.get('nlaTrack') or clip.get('sequence') or 'Effect'
    scene = bpy.context.scene
    duration = max(clip['seconds'], clip.get('modelDuration', 0))
    for obj in root.children_recursive:
        if not obj.animation_data:
            continue
        animation = obj.animation_data
        animation.action = None; animation.use_nla = True
        for track in animation.nla_tracks:
            # Each imported glTF animation has its own NLA track. Never layer all clips.
            track.is_solo = False
            track.mute = track.name != clip.get('nlaTrack', clip.get('sequence'))
            for strip in track.strips:
                strip.mute = False
                length = strip.action_frame_end - strip.action_frame_start
                if not track.mute:
                    strip.repeat = max(1, duration * scene.render.fps / scene.render.fps_base / length) if clip.get('modelLoop') and length > 0 else 1
    if set_timeline:
        scene.frame_start = root.get('WC3FX start frame', 1)
        scene.frame_end = scene.frame_start + max(1, math.ceil(duration * scene.render.fps / scene.render.fps_base))
        scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()
    update_effects(scene)


def animation_items(self, context):
    root = find_root(self)
    if not root:
        return [('0', 'Effect', '', 0)]
    key = root['wc3fx_cache']
    if key not in _clip_items:
        meta, _ = _cache(root)
        _clip_items[key] = [(str(i), clip.get('nlaTrack') or clip.get('sequence') or 'Effect', '', i) for i, clip in enumerate(package_clips(meta))]
    return _clip_items[key]


def animation_get(self):
    return self.get('WC3FX animation index', 0)


def animation_set(self, value):
    select_clip(self, value)


def make_material(batch, image):
    material = bpy.data.materials.new("WC3FX " + batch["emitter"] + " / " + batch["layer"])
    material.use_nodes = True
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = 'DITHERED'
    material.use_backface_culling = False
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    emission = nodes.new('ShaderNodeEmission')
    colors = nodes.new('ShaderNodeVertexColor'); colors.layer_name = 'FXColor'
    texture = nodes.new('ShaderNodeTexImage'); texture.image = image; texture.extension = 'CLIP'
    tint = nodes.new('ShaderNodeMixRGB'); tint.blend_type = 'MULTIPLY'; tint.inputs[0].default_value = 1
    links.new(texture.outputs['Color'], tint.inputs[1]); links.new(colors.outputs['Color'], tint.inputs[2])
    links.new(tint.outputs['Color'], emission.inputs['Color'])
    coverage = nodes.new('ShaderNodeMath'); coverage.operation = 'MULTIPLY'; coverage.use_clamp = True
    links.new(texture.outputs['Alpha'], coverage.inputs[0]); links.new(colors.outputs['Alpha'], coverage.inputs[1])
    blend = batch['blend']
    if blend in (0, 1):
        if blend == 0:
            links.new(coverage.outputs[0], emission.inputs['Strength'])
        else:
            emission.inputs['Strength'].default_value = 1
        add = nodes.new('ShaderNodeAddShader')
        links.new(transparent.outputs[0], add.inputs[0]); links.new(emission.outputs[0], add.inputs[1]); links.new(add.outputs[0], output.inputs['Surface'])
    else:
        # Separate background coverage and emission avoids multiplying premultiplied RGB twice.
        black = nodes.new('ShaderNodeEmission'); black.inputs['Color'].default_value = (0, 0, 0, 1)
        background = nodes.new('ShaderNodeMixShader')
        links.new(coverage.outputs[0], background.inputs[0]); links.new(transparent.outputs[0], background.inputs[1]); links.new(black.outputs[0], background.inputs[2])
        links.new(colors.outputs['Alpha'] if blend == 3 else coverage.outputs[0], emission.inputs['Strength'])
        add = nodes.new('ShaderNodeAddShader')
        links.new(background.outputs[0], add.inputs[0]); links.new(emission.outputs[0], add.inputs[1]); links.new(add.outputs[0], output.inputs['Surface'])
    return material


def srgb_to_linear(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def color_conversion(to_linear):
    """WC3 tints encoded texture RGB before lighting; Blender shaders use linear RGB."""
    group = bpy.data.node_groups.new('WC3 sRGB to Linear' if to_linear else 'WC3 Linear to sRGB', 'ShaderNodeTree')
    group.interface.new_socket(name='Color', in_out='INPUT', socket_type='NodeSocketColor')
    group.interface.new_socket(name='Color', in_out='OUTPUT', socket_type='NodeSocketColor')
    nodes, links = group.nodes, group.links
    incoming = nodes.new('NodeGroupInput'); outgoing = nodes.new('NodeGroupOutput')
    split = nodes.new('ShaderNodeSeparateXYZ'); combine = nodes.new('ShaderNodeCombineXYZ')
    incoming.location = (-950, 0); split.location = (-750, 0); combine.location = (500, 0); outgoing.location = (700, 0)
    links.new(incoming.outputs[0], split.inputs[0]); links.new(combine.outputs[0], outgoing.inputs[0])
    for channel in range(3):
        column = 0
        def math_node(operation, *values):
            nonlocal column
            node = nodes.new('ShaderNodeMath'); node.operation = operation
            node.location = (-550 + (column % 5) * 190, -channel * 420 - (column // 5) * 150); column += 1
            for i, value in enumerate(values):
                if isinstance(value, (int, float)):
                    node.inputs[i].default_value = value
                else:
                    links.new(value, node.inputs[i])
            return node.outputs[0]
        value = split.outputs[channel]
        if to_linear:
            low = math_node('DIVIDE', value, 12.92)
            high = math_node('POWER', math_node('DIVIDE', math_node('ADD', value, 0.055), 1.055), 2.4)
        else:
            low = math_node('MULTIPLY', value, 12.92)
            high = math_node('SUBTRACT', math_node('MULTIPLY', math_node('POWER', math_node('MAXIMUM', value, 0), 1 / 2.4), 1.055), 0.055)
        threshold = math_node('LESS_THAN', value, 0.04045 if to_linear else 0.0031308)
        result = math_node('ADD', math_node('MULTIPLY', low, threshold), math_node('MULTIPLY', high, math_node('SUBTRACT', 1, threshold)))
        links.new(result, combine.inputs[channel])
    return group


def team_color_node(root):
    group = bpy.data.node_groups.get(root.get('wc3fx_team_color_group', ''))
    return group.nodes.get('Team Color') if group else None


def configure_team_color(root, imported, meta, archive, temporary):
    team = meta.get('teamColor')
    if not team or not team['materials']:
        return
    descriptions = {item['material']: item for item in team['materials']}
    materials = {slot.material for obj in imported if obj.type == 'MESH' for slot in obj.material_slots if slot.material and slot.material.get('wc3_team_material') in descriptions}
    if not materials:
        return
    control = bpy.data.node_groups.new('WC3 Team Color - ' + root.name, 'ShaderNodeTree')
    control.interface.new_socket(name='Color', in_out='OUTPUT', socket_type='NodeSocketColor')
    rgb = control.nodes.new('ShaderNodeRGB'); rgb.name = rgb.label = 'Team Color'
    rgb.outputs[0].default_value = (*[srgb_to_linear(c) for c in team['color']], 1)
    output = control.nodes.new('NodeGroupOutput'); output.location = (220, 0)
    control.links.new(rgb.outputs[0], output.inputs[0])
    root['wc3fx_team_color_group'] = control.name
    to_linear, to_srgb = color_conversion(True), color_conversion(False)
    tint = bpy.data.node_groups.new('WC3 Masked Team Tint', 'ShaderNodeTree')
    for label, kind in [('Base Color', 'NodeSocketColor'), ('Mask', 'NodeSocketFloat'), ('Team Color', 'NodeSocketColor')]:
        tint.interface.new_socket(name=label, in_out='INPUT', socket_type=kind)
    tint.interface.new_socket(name='Color', in_out='OUTPUT', socket_type='NodeSocketColor')
    nodes, links = tint.nodes, tint.links
    incoming = nodes.new('NodeGroupInput'); incoming.location = (-600, 0)
    encode = nodes.new('ShaderNodeGroup'); encode.node_tree = to_srgb; encode.location = (-380, -200)
    mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.label = 'Tint only the team-color mask'; mix.location = (-150, 0)
    decode = nodes.new('ShaderNodeGroup'); decode.node_tree = to_linear; decode.location = (80, 0)
    outgoing = nodes.new('NodeGroupOutput'); outgoing.location = (300, 0)
    links.new(incoming.outputs['Team Color'], encode.inputs[0]); links.new(encode.outputs[0], mix.inputs[2])
    links.new(incoming.outputs['Base Color'], mix.inputs[1]); links.new(incoming.outputs['Mask'], mix.inputs[0])
    links.new(mix.outputs[0], decode.inputs[0]); links.new(decode.outputs[0], outgoing.inputs[0])
    images = {}
    def image_for(file):
        if file not in images:
            destination = os.path.join(temporary, 'team-' + str(len(images)) + '.png')
            with open(destination, 'wb') as handle:
                handle.write(_read_entry(archive, file, 64 * 1024 * 1024))
            image = bpy.data.images.load(destination, check_existing=False)
            image.name = 'WC3 ' + os.path.basename(file); image.colorspace_settings.name = 'Non-Color'
            image.alpha_mode = 'CHANNEL_PACKED'; image.pack(); images[file] = image
        return images[file]
    for material in materials:
        description = descriptions[material['wc3_team_material']]
        nodes, links = material.node_tree.nodes, material.node_tree.links
        shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
        base = shader.inputs['Base Color'].links[0].from_node
        if base.type != 'TEX_IMAGE':
            raise ValueError('Unsupported glTF base-color layout for editable team color')
        base.image = image_for(description['base']); base.label = 'Untinted base color'
        # Leave the original image alpha links intact: team masks never control opacity.
        mask = nodes.new('ShaderNodeTexImage'); mask.image = image_for(description['mask']); mask.label = 'Team color mask'
        mask.extension = base.extension; mask.interpolation = base.interpolation
        for link in base.inputs['Vector'].links:
            links.new(link.from_socket, mask.inputs['Vector'])
        color = nodes.new('ShaderNodeGroup'); color.node_tree = control; color.label = 'Team Color (Tab to edit)'
        apply = nodes.new('ShaderNodeGroup'); apply.node_tree = tint; apply.label = 'Masked team color'
        x, y = shader.location; apply.location = (x - 230, y + 120); base.location = (x - 700, y + 120)
        mask.location = (x - 700, y - 200); color.location = (x - 450, y - 220)
        links.new(base.outputs['Color'], apply.inputs['Base Color']); links.new(mask.outputs['Color'], apply.inputs['Mask'])
        links.new(color.outputs[0], apply.inputs['Team Color']); links.new(apply.outputs[0], shader.inputs['Base Color'])


def _quad(record, mode, right, up, look, camera):
    center = Vector(record[0:3]); sx, sy = record[3:5]
    axis, normal, angle = Vector(record[5:8]), Vector(record[8:11]), record[11]
    if mode in (2, 3, 4):
        length = axis.length; direction = axis.normalized() if length > 1e-5 else Vector((0, 0, 1))
        side = direction.cross(look)
        side = side.normalized() if side.length_squared > 1e-8 else right
        return center, side * sx, direction * (length * 0.5 + (0 if mode == 2 else sx))
    if mode == 5:
        normal = normal.normalized() if normal.length_squared > 1e-8 else Vector((0, 0, 1))
        axis = axis - normal * axis.dot(normal)
        if axis.length_squared < 1e-8:
            axis = normal.cross(Vector((0, 0, 1)) if abs(normal.z) < 0.9 else Vector((1, 0, 0)))
        axis.normalize(); side = axis.cross(normal).normalized()
        return center, (side * math.cos(angle) + axis * math.sin(angle)) * sx, (axis * math.cos(angle) - side * math.sin(angle)) * sy
    if mode == 1 and camera is not None and (center - camera).length_squared > 1e-8:
        facing = (center - camera).normalized(); side = facing.cross(up)
        if side.length_squared > 1e-8:
            right = side.normalized(); up = right.cross(facing).normalized()
    return center, (right * math.cos(angle) + up * math.sin(angle)) * sx, (up * math.cos(angle) - right * math.sin(angle)) * sy


def _cache(root):
    key = root.get('wc3fx_cache')
    if key in _caches:
        return _caches[key]
    text = bpy.data.texts.get(key)
    if not text:
        raise ValueError("Missing packed WC3 effect cache")
    packed = json.loads(text.as_string())
    meta = packed['manifest']
    if packed.get('cacheEncoding') == 'base64-chunks':
        buffers = [base64.b64decode(''.join(chunks), validate=True) for chunks in packed['data']]
        data = buffers if meta['schema'] == 'wow.export.wc3fx.v2' else buffers[0]
    else:
        data = [base64.b64decode(item, validate=True) for item in packed['data']] if isinstance(packed['data'], list) else base64.b64decode(packed['data'], validate=True)
    validate_package(meta, data)
    _caches[key] = (meta, data)
    return meta, data


@persistent
def update_effects(scene, depsgraph=None):
    global _updating
    if _updating:
        return
    _updating = True
    try:
        for root in scene.objects:
            if not root.get('wc3fx_cache'):
                continue
            try:
                package, buffers = _cache(root)
                index = root.get('WC3FX animation index', package.get('defaultClip', 0))
                meta = package_clips(package)[index]
                data = buffers[index] if isinstance(buffers, list) else buffers
                elapsed = (scene.frame_current - root.get('WC3FX start frame', 1)) / (scene.render.fps / scene.render.fps_base)
                frame = min(meta['frameCount'] - 1, max(0, round(elapsed * meta['fps'])))
                right, up, look, camera = Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)), None
                if scene.camera:
                    local = root.matrix_world.inverted_safe() @ scene.camera.matrix_world
                    right = local.to_3x3().col[0].normalized(); up = local.to_3x3().col[1].normalized(); look = up.cross(right).normalized(); camera = local.translation
                meshes = {}
                for obj in root.children:
                    if 'wc3fx_batch' not in obj:
                        continue
                    active = obj.get('wc3fx_clip', 0) == index
                    obj.hide_viewport = not active; obj.hide_render = not active
                    if active:
                        meshes[obj['wc3fx_batch']] = obj
                    else:
                        obj['WC3FX visible particles'] = 0
                offset = meta['frameOffsets'][frame]
                for batch in meta['batches']:
                    count = struct.unpack_from('<I', data, offset)[0]; offset += 4
                    obj = meshes.get(batch['id'])
                    if obj is None:
                        offset += count * 68
                        continue
                    if package.get('schema') == 'wow.export.wc3fx.v2' and (elapsed < 0 or elapsed > meta['seconds']):
                        offset += count * 68; count = 0
                    capacity = batch['maxParticles']
                    coords = array('f', [0]) * (capacity * 12)
                    colors = array('f', [0]) * (capacity * 16)
                    uvs = array('f', [0]) * (capacity * 8)
                    cols, rows = max(1, batch['atlasColumns']), max(1, batch['atlasRows'])
                    for p in range(count):
                        record = struct.unpack_from('<17f', data, offset); offset += 68
                        if not all(math.isfinite(v) for v in record):
                            raise ValueError("Non-finite particle value")
                        center, r, u = _quad(record, batch['billboard'], right, up, look, camera)
                        corners = (center - r - u, center + r - u, center + r + u, center - r + u)
                        coords[p * 12:(p + 1) * 12] = array('f', (v for corner in corners for v in corner))
                        colors[p * 16:(p + 1) * 16] = array('f', record[12:16] * 4)
                        cell = int(record[16]) % (cols * rows); x, y = cell % cols, cell // cols
                        u0, u1, v0, v1 = x / cols, (x + 1) / cols, 1 - (y + 1) / rows, 1 - y / rows
                        uvs[p * 8:(p + 1) * 8] = array('f', (u0, v0, u1, v0, u1, v1, u0, v1))
                    mesh = obj.data
                    mesh.vertices.foreach_set('co', coords)
                    mesh.uv_layers.active.data.foreach_set('uv', uvs)
                    mesh.color_attributes['FXColor'].data.foreach_set('color', colors)
                    mesh.update()
                    obj['WC3FX visible particles'] = count
                root['WC3FX playback error'] = ''
            except Exception as error:
                root['WC3FX playback error'] = str(error)
                print('WC3FX playback:', error)
    finally:
        _updating = False


@persistent
def load_effects(_):
    _caches.clear()
    _clip_items.clear()
    update_effects(bpy.context.scene)


def import_package(filepath, set_timeline=True):
    with zipfile.ZipFile(filepath) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_PACKAGE:
            raise ValueError('Effect package exceeds 512 MiB')
        meta = json.loads(_read_entry(archive, 'manifest.json', 8 * 1024 * 1024))
        clips = package_clips(meta)
        buffers = [_read_entry(archive, clip['cache']) for clip in clips]
        data = buffers if meta['schema'] == 'wow.export.wc3fx.v2' else buffers[0]
        validate_package(meta, data)
        # Full skeletal animation sets can be larger than the particle-cache
        # budget (for example Tree of Life). They share the package size limit.
        model_data = prepare_model_animations(_read_entry(archive, meta['model'], MAX_PACKAGE), clips) if meta.get('model') else None
        collection = bpy.data.collections.new('WC3FX ' + os.path.basename(meta['source']))
        bpy.context.scene.collection.children.link(collection)
        root = bpy.data.objects.new(collection.name, None); collection.objects.link(root)
        root['WC3FX source'] = meta['source']; root['WC3FX notes'] = '\n'.join(meta.get('warnings', []))
        root['WC3FX start frame'] = bpy.context.scene.frame_current
        text = bpy.data.texts.new('WC3FX cache ' + uuid.uuid4().hex)
        text.use_fake_user = True
        # Blender's text insertion is very slow for multi-megabyte single lines.
        # Keep cache lines short, including after saving and reopening a .blend.
        packed = []
        for buffer in buffers:
            encoded = base64.b64encode(buffer).decode('ascii')
            packed.append([encoded[i:i + 4096] for i in range(0, len(encoded), 4096)])
        text.from_string(json.dumps({'manifest': meta, 'cacheEncoding': 'base64-chunks', 'data': packed}, indent=1))
        root['wc3fx_cache'] = text.name; _caches[text.name] = (meta, data)
        scene = bpy.context.scene
        if set_timeline:
            # glTF keyframe times are converted using the scene FPS during import.
            scene.render.fps = clips[0]['fps']; scene.render.fps_base = 1
        with tempfile.TemporaryDirectory(prefix='wow-wc3-blender-') as temp:
            if meta.get('model'):
                model_path = os.path.join(temp, 'model.glb')
                with open(model_path, 'wb') as handle:
                    handle.write(model_data)
                before = set(bpy.data.objects)
                bpy.ops.import_scene.gltf(filepath=model_path)
                imported = set(bpy.data.objects) - before
                for obj in imported:
                    for owner in list(obj.users_collection):
                        owner.objects.unlink(obj)
                    collection.objects.link(obj)
                    if obj.parent is None:
                        obj.parent = root
                    if obj.animation_data:
                        for track in obj.animation_data.nla_tracks:
                            for strip in track.strips:
                                strip.frame_start += root['WC3FX start frame'] - 1
                configure_team_color(root, imported, meta, archive, temp)
            images = {}
            for clip_index, batch in ((i, b) for i, clip in enumerate(clips) for b in clip['batches']):
                if not batch['maxParticles']:
                    continue
                image_name = batch.get('image')
                if image_name not in images:
                    if image_name:
                        image_path = os.path.join(temp, str(len(images)) + '.png')
                        with open(image_path, 'wb') as handle:
                            handle.write(_read_entry(archive, image_name, 64 * 1024 * 1024))
                        image = bpy.data.images.load(image_path, check_existing=False); image.pack()
                    else:
                        image = bpy.data.images.new('WC3FX missing texture', width=1, height=1); image.pixels[:] = (1, 0, 1, 1); image.pack()
                    images[image_name] = image
                count = batch['maxParticles']
                mesh = bpy.data.meshes.new('WC3FX ' + batch['layer'])
                mesh.from_pydata([(0, 0, 0)] * (count * 4), [], [(p * 4, p * 4 + 1, p * 4 + 2, p * 4 + 3) for p in range(count)])
                mesh.uv_layers.new(name='UVMap'); mesh.color_attributes.new(name='FXColor', type='FLOAT_COLOR', domain='CORNER')
                mesh.materials.append(make_material(batch, images[image_name]))
                obj = bpy.data.objects.new(batch['emitter'] + ' / ' + batch['layer'], mesh)
                collection.objects.link(obj); obj.parent = root; obj['wc3fx_batch'] = batch['id']
                obj['wc3fx_clip'] = clip_index
                if hasattr(obj, 'visible_shadow'):
                    obj.visible_shadow = False
        if set_timeline:
            scene.render.use_lock_interface = True
        select_clip(root, meta.get('defaultClip', 0), set_timeline)
        bpy.context.view_layer.objects.active = root; root.select_set(True)
        return root


class IMPORT_SCENE_OT_wc3fx(bpy.types.Operator, ImportHelper):
    bl_idname = 'import_scene.wc3fx'
    bl_label = 'Import Warcraft III effect'
    bl_options = {'REGISTER', 'UNDO'}
    filename_ext = '.wc3fx'
    filter_glob: StringProperty(default='*.wc3fx', options={'HIDDEN'})
    set_timeline: BoolProperty(name='Set scene frame range and FPS', default=True)

    def execute(self, context):
        try:
            root = import_package(self.filepath, self.set_timeline)
            if root.get('WC3FX notes'):
                self.report({'WARNING'}, 'Imported with notes; see the WC3FX parent Custom Properties.')
            return {'FINISHED'}
        except Exception as error:
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}


class VIEW3D_PT_wc3fx(bpy.types.Panel):
    bl_label = 'Warcraft III model'
    bl_idname = 'VIEW3D_PT_wc3fx'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Warcraft III'

    @classmethod
    def poll(cls, context):
        return find_root(context.object) is not None

    def draw(self, context):
        root = find_root(context.object)
        self.layout.prop(root, 'wc3fx_animation', text='Animation')
        self.layout.label(text='Each clip has its own particle bake.')
        color = team_color_node(root)
        if color:
            self.layout.prop(color.outputs[0], 'default_value', text='Team color')


def menu_import(self, context):
    self.layout.operator(IMPORT_SCENE_OT_wc3fx.bl_idname, text='Warcraft III effect (.wc3fx)')


def register():
    bpy.utils.register_class(IMPORT_SCENE_OT_wc3fx)
    bpy.utils.register_class(VIEW3D_PT_wc3fx)
    bpy.types.Object.wc3fx_animation = EnumProperty(name='Animation', items=animation_items, get=animation_get, set=animation_set)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)
    if update_effects not in bpy.app.handlers.frame_change_post:
        bpy.app.handlers.frame_change_post.append(update_effects)
    if load_effects not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(load_effects)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.utils.unregister_class(IMPORT_SCENE_OT_wc3fx)
    bpy.utils.unregister_class(VIEW3D_PT_wc3fx)
    del bpy.types.Object.wc3fx_animation
    for handler, collection in [(update_effects, bpy.app.handlers.frame_change_post), (load_effects, bpy.app.handlers.load_post)]:
        if handler in collection:
            collection.remove(handler)
    _caches.clear()
    _clip_items.clear()


if __name__ == '__main__':
    register()
