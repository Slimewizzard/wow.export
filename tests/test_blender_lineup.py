import json
import sys
from pathlib import Path
import bpy
from mathutils import Vector

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'addons' / 'blender'))
from io_scene_room_blueprint import import_lineup, register, unregister
out = root/'tests'/'output'
out.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
# A model with geometry offset from origin, a parent, and nonuniform dimensions.
bpy.ops.mesh.primitive_cube_add(size=2, location=(8,4,5))
cube=bpy.context.object
cube.scale=(2,1,3)
parent=bpy.data.objects.new('Original model root',None)
bpy.context.scene.collection.objects.link(parent)
cube.parent=parent
parent.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'fixture.glb'),export_format='GLB',use_selection=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(location=(100,100,100))
sentinel=bpy.context.object
manifest={'schema':'room-building.export.v1','label':'test','items':[
 {'decorID':1,'name':'Long fixture','count':2,'status':'exported','file':'fixture.glb'},
 {'decorID':2,'name':'Other fixture','count':1,'status':'exported','file':'fixture.glb'},
 {'decorID':3,'name':'Missing','count':1,'status':'failed'}]}
(out/'test-manifest.json').write_text(json.dumps(manifest))
register()
room, instances, warnings=import_lineup(bpy.context,out/'test-manifest.json',columns=2,gap=2,labels=True)
assert len(instances)==3 and len(warnings)==1
assert sentinel.name in bpy.data.objects and tuple(sentinel.location)==(100,100,100)
assert instances[0].instance_collection==instances[1].instance_collection
boxes=[]
for instance in instances:
    asset=instance.instance_collection
    corners=[instance.matrix_world @ (obj.matrix_world @ Vector(c)-asset.instance_offset)
             for obj in asset.objects if obj.type=='MESH' for c in obj.bound_box]
    low=[min(c[a] for c in corners) for a in range(3)]
    high=[max(c[a] for c in corners) for a in range(3)]
    assert abs(low[2])<1e-5, (low,high)
    boxes.append((low,high))
for i,(low,high) in enumerate(boxes):
    for lo,hi in boxes[i+1:]:
        assert high[0]<lo[0] or hi[0]<low[0] or high[1]<lo[1] or hi[1]<low[1], 'Lineup overlaps'
assert len([o for o in room.objects if o.type=='FONT'])==3
unregister()
bpy.ops.wm.save_as_mainfile(filepath=str(out/'lineup-test.blend'))
print('PASS: real Blender glTF import; quantities, hierarchy, ground alignment, non-overlap, labels, existing scene preservation.')

