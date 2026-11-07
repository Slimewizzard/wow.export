"""Run with Blender --background --factory-startup --python-exit-code 1
--python tests/wc3_fx_blender.py -- <exported.wc3fx> [attachment-expectations.json].
Uses a fresh scene; the optional JSON compares named emitter bones at sample frames.
"""
import bpy
import importlib.util
import json
import os
import sys
import tempfile
from mathutils import Vector

assert bpy.app.background and not bpy.data.filepath, 'Run in a fresh background Blender process'
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('io_scene_wc3fx', os.path.join(root_dir, 'addons', 'blender', 'io_scene_wc3fx.py'))
fx = importlib.util.module_from_spec(spec); sys.modules[spec.name] = fx; spec.loader.exec_module(fx); fx.register()
args = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene; scene.frame_set(1)
root = fx.import_package(os.path.abspath(args[0])); meta, data = fx._cache(root)
assert scene.render.fps == meta['fps']
assert all(image.packed_file for image in bpy.data.images if image.source == 'FILE' and image.has_data), 'Images must survive temporary directory cleanup'
try:
    fx.validate_cache(meta, data[:-1])
    raise AssertionError('Truncated cache accepted')
except ValueError:
    pass
counts, positions, poses = [], [], []
for frame in [1, max(2, meta['frameCount'] // 3), max(3, meta['frameCount'] // 2), meta['frameCount']]:
    scene.frame_set(frame)
    assert not root.get('WC3FX playback error'), root.get('WC3FX playback error')
    counts.append(sum(obj.get('WC3FX visible particles', 0) for obj in root.children))
    positions.append(sum(sum(v.co) for obj in root.children if 'wc3fx_batch' in obj for v in obj.data.vertices))
    bpy.context.view_layer.update()
    poses.append(tuple(round(v, 5) for obj in scene.objects if obj.type == 'ARMATURE' for bone in obj.pose.bones for row in bone.matrix for v in row))
if meta['totalSprites']:
    assert max(counts) > 0
else:
    assert meta['model'] and not meta['batches'] and not any(counts)
    assert any(obj.type == 'MESH' and 'wc3fx_batch' not in obj for obj in scene.objects)
    assert len(set(poses)) > 1, 'Model-only package must retain animated bone poses'
if len(args) > 1:
    with open(args[1]) as handle:
        expected = json.load(handle)
    armature = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    maximum_error = 0
    for entry in expected:
        bone = armature.pose.bones[entry['name']]
        for sample in entry['frames']:
            scene.frame_set(sample['frame']); bpy.context.view_layer.update()
            error = (armature.matrix_world @ bone.matrix.translation - Vector(sample['position'])).length
            maximum_error = max(maximum_error, error)
            assert error < 0.15, (entry['name'], sample['frame'], error)
    print('Attachment maximum error:', maximum_error)
with tempfile.TemporaryDirectory(prefix='wow-wc3-blender-test-') as folder:
    target = os.path.join(folder, 'roundtrip.blend')
    bpy.ops.wm.save_as_mainfile(filepath=target)
    bpy.ops.wm.open_mainfile(filepath=target)
    scene = bpy.context.scene; scene.frame_set(max(3, meta['frameCount'] // 2))
    roots = [obj for obj in scene.objects if obj.get('wc3fx_cache')]
    assert len(roots) == 1 and not roots[0].get('WC3FX playback error')
    if meta['totalSprites']:
        assert sum(obj.get('WC3FX visible particles', 0) for obj in roots[0].children) > 0
    else:
        assert any(obj.type == 'ARMATURE' and obj.animation_data and len(obj.animation_data.nla_tracks) for obj in scene.objects)
print('WC3FX PASS', json.dumps({'frames': meta['frameCount'], 'particleCounts': counts, 'positionSums': positions}))
