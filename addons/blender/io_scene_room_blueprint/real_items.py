"""Copy an asset hierarchy into editable, independent scene objects."""
import bpy
from mathutils import Matrix

def editable_copy(asset,collection,name,position):
    originals=list(asset.objects)
    remap={};materials={}
    for old in originals:
        new=old.copy();collection.objects.link(new);remap[old]=new
        if old.data:
            new.data=old.data.copy();remap[old.data]=new.data
        if old.type=='MESH':
            for slot in new.material_slots:
                if slot.material:
                    mat=slot.material
                    if mat not in materials:materials[mat]=mat.copy()
                    slot.material=materials[mat]
    remap.update(materials)
    for old,new in list(remap.items()):
        if getattr(old,'node_tree',None) and getattr(new,'node_tree',None):remap[old.node_tree]=new.node_tree
    for old in originals:
        new=remap[old]
        new.parent=remap.get(old.parent)
        for constraint in new.constraints:
            if hasattr(constraint,'target') and constraint.target in remap:constraint.target=remap[constraint.target]
    for new in remap.values():
        animation=getattr(new,'animation_data',None)
        if animation:
            for curve in animation.drivers:
                for variable in curve.driver.variables:
                    for target in variable.targets:
                        if target.id in remap:target.id=remap[target.id]
    roots=[remap[o] for o in originals if o.parent not in remap]
    if len(roots)==1:
        root=roots[0]
    else:
        root=bpy.data.objects.new(name,None);collection.objects.link(root)
        for child in roots:
            world=child.matrix_world.copy();child.parent=root;child.matrix_world=world
    root.name=name
    root.matrix_world=Matrix.Translation(position-asset.instance_offset) @ root.matrix_world
    return root
