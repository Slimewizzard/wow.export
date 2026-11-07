"""Blender --background --factory-startup --python-exit-code 1
--python tests/wc3_animation_blender.py -- <package> [MDX pose expectations.json]
Checks all NLA clips, exclusive playback, cache switching and save/reopen.
"""
import bpy
import importlib.util
import json
import os
import struct
import sys
import tempfile
from mathutils import Vector

assert bpy.app.background and not bpy.data.filepath
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('io_scene_wc3fx', os.path.join(repo, 'addons', 'blender', 'io_scene_wc3fx.py'))
fx = importlib.util.module_from_spec(spec); sys.modules[spec.name] = fx; spec.loader.exec_module(fx); fx.register()
args = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene; scene.frame_set(1)
root = fx.import_package(os.path.abspath(args[0]))
meta, data = fx._cache(root); clips = fx.package_clips(meta)
assert max(map(len, bpy.data.texts[root['wc3fx_cache']].as_string().splitlines())) < 8192
assert meta['schema'] == 'wow.export.wc3fx.v2' and len(clips) > 1
armature = next(obj for obj in root.children_recursive if obj.type == 'ARMATURE')
tracks = armature.animation_data.nla_tracks
names = [clip['sequence'] for clip in clips]
track_names = [clip.get('nlaTrack', clip['sequence']) for clip in clips]
assert len(set(track_names)) == len(clips), track_names
assert set(t.name for t in tracks) == set(track_names), ([t.name for t in tracks], track_names)
assert len(tracks) == len(clips)
for i, clip in enumerate(clips):
    root.wc3fx_animation = str(i)
    assert root.get('WC3FX animation index') == i
    assert [t.name for t in tracks if not t.mute] == [track_names[i]]
    assert armature.animation_data.action is None
    scene.frame_set(1 + min(8, clip['frameCount'] - 1))
    assert not root.get('WC3FX playback error')
    offset = clip['frameOffsets'][scene.frame_current - 1]
    expected_count = 0
    for batch in clip['batches']:
        count = struct.unpack_from('<I', data[i], offset)[0]
        expected_count += count; offset += 4 + count * 68
    assert sum(obj.get('WC3FX visible particles', 0) for obj in root.children) == expected_count
    for obj in root.children:
        if 'wc3fx_clip' in obj:
            assert obj.hide_render == (obj['wc3fx_clip'] != i)
    if clip.get('modelDuration', 0) > 30:
        assert scene.frame_end >= 1 + clip['modelDuration'] * scene.render.fps
    scene.frame_set(2 + round(clip['seconds'] * scene.render.fps))
    assert sum(obj.get('WC3FX visible particles', 0) for obj in root.children) == 0, 'Particles must end with their bake'
maximum_error = 0
if len(args) > 1:
    with open(args[1]) as handle:
        samples = json.load(handle)
    failures = []
    for sample in samples:
        root.wc3fx_animation = str(names.index(sample['sequence']))
        scene.frame_set(sample['frame']); bpy.context.view_layer.update()
        for expected in sample['bones']:
            bone = armature.pose.bones.get(expected['name'])
            assert bone is not None, expected['name']
            actual = armature.matrix_world @ bone.matrix.translation
            error = (actual - Vector(expected['position'])).length
            maximum_error = max(maximum_error, error)
            if error > 0.15:
                failures.append((sample['sequence'], sample['frame'], bone.name, error))
    assert not failures, sorted(failures, key=lambda f: -f[-1])[:10]
selected = root.get('WC3FX animation index')
with tempfile.TemporaryDirectory(prefix='wow-wc3-animations-') as folder:
    file = os.path.join(folder, 'roundtrip.blend')
    bpy.ops.wm.save_as_mainfile(filepath=file); bpy.ops.wm.open_mainfile(filepath=file)
    root = next(o for o in bpy.context.scene.objects if o.get('wc3fx_cache'))
    assert root.get('WC3FX animation index') == selected
    root.wc3fx_animation = '0'
    assert not root.get('WC3FX playback error')
    armature = next(o for o in root.children_recursive if o.type == 'ARMATURE')
    assert [t.name for t in armature.animation_data.nla_tracks if not t.mute] == [track_names[0]]
    for i, name in enumerate(track_names):
        root.wc3fx_animation = str(i)
        assert [t.name for t in armature.animation_data.nla_tracks if not t.mute] == [name]
print('WC3 ANIMATIONS PASS', json.dumps({'clips': len(clips), 'maximumBonePositionError': maximum_error}))
