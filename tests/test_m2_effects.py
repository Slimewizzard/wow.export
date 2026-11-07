import sys
from pathlib import Path
import bpy
repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo/'addons'/'blender'))
from io_scene_wowobj import Settings, import_wowobj
from io_scene_wowobj.m2_effects import reconstruct_effects
for name, lights, emitters in [("OldSalt'sFireplace",1,3),('SturdyFireplace',2,4)]:
    source=Path(sys.argv[sys.argv.index('--')+1])/(name+'.obj')
    import_wowobj.importWoWOBJAddon(str(source), Settings(importEffects=(name=='SturdyFireplace')))
    obj=bpy.data.objects[source.name]
    if name=='SturdyFireplace':
        assert obj.get('M2 effects imported'), 'Enabled importer must create effects'
        root=next(o for o in obj.children if 'Preview notes' in o)
    else:
        assert not obj.get('M2 effects imported'), 'Effects must be opt-in'
        root=reconstruct_effects(obj,source)
    assert root.parent==obj
    assert len([o for o in root.children if o.type=='LIGHT'])==lights
    actual=[o for o in root.children if 'Preview particle count' in o]
    assert len(actual)==emitters, (name,len(actual),root['Review notes'])
    sprites=[o for e in actual for o in e.children]
    assert 0<len(sprites)<=emitters*24
    assert all(o.animation_data for o in sprites)
    before=len(bpy.data.objects)
    assert reconstruct_effects(obj,source) is None
    assert len(bpy.data.objects)==before
    bpy.context.scene.frame_set(1)
    root['Light power scale']=0.0
    root.update_tag()
    bpy.context.view_layer.update()
    assert all(o.data.energy==0 for o in root.children if o.type=='LIGHT' and o.data.type=='POINT')
    print(name, 'PASS',len(sprites),'sprites')
print('Effects checks passed')
