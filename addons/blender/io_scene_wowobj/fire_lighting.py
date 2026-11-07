"""Optional artistic lighting for recognized fire particle previews."""
from pathlib import Path
import bpy
from mathutils import Vector


def fire_sprites(obj):
    result=[]
    for child in obj.children_recursive:
        if child.type!='MESH' or not child.parent or 'Preview particle count' not in child.parent: continue
        for mat in child.data.materials:
            if mat and mat.use_nodes and any(n.type=='TEX_IMAGE' and n.image and
                    any(token in Path(n.image.filepath.replace('\\','/')).name.lower() for token in ('fire','flame'))
                    for n in mat.node_tree.nodes):
                result.append(child);break
    return result


def property_driver(block, path, control, prop, expression='value', extra=()):
    driver=block.driver_add(path).driver
    for name,key in [('value',prop),*extra]:
        var=driver.variables.new();var.name=name;var.type='SINGLE_PROP'
        var.targets[0].id=control;var.targets[0].data_path='["%s"]'%key
    driver.expression=expression


def apply_fire_lighting(obj):
    existing=next((o for o in obj.children if o.get('Fire Lighting preset')),None)
    if existing:return existing
    sprites=fire_sprites(obj)
    if not sprites:
        obj['Fire Lighting status']='No fire/flame particle texture found; no preset lights added.'
        return None
    bpy.context.view_layer.update()
    inverse=obj.matrix_world.inverted_safe()
    # Sample the imported preview's current centers, including its height tuning.
    center=sum((inverse@s.matrix_world.translation for s in sprites),Vector())/len(sprites)
    extent=max(0.25,min(4,max(obj.dimensions)))
    control=bpy.data.objects.new(obj.name+' - Fire Lighting',None)
    obj.users_collection[0].objects.link(control);control.parent=obj
    control.location=center;control.empty_display_type='SPHERE';control.empty_display_size=0.12
    control['Fire Lighting preset']=True
    control['Power']=150.0
    control['Interior fill']=40.0
    control['Radius']=min(0.35,extent*0.1)
    control['Range']=max(2.0,extent)
    control['Flicker']=0.12
    control['Notes']='Artistic approximation. Move this controller to position both lights. Interior fill is shadowless and can leak through thin walls; set it to zero to disable. Original M2 lights are retained. Texture-name recognition can include other fire effects.'
    for name,maximum,description in [
        ('Power',1000,'Soft fire light power in watts'),
        ('Interior fill',250,'Shadowless warm fill in watts; zero disables; may illuminate through walls'),
        ('Radius',2,'Soft light radius in Blender units'),
        ('Range',20,'Light distance cutoff in Blender units'),
        ('Flicker',1,'Amount of gentle procedural flicker; zero gives constant light')]:
        control.id_properties_ui(name).update(min=0,soft_max=maximum,description=description)
    fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    for label,prop,shadows in [('Fire light','Power',True),('Interior fill','Interior fill',False)]:
        data=bpy.data.lights.new(label,'POINT');data.use_nodes=False
        data.color=(1.0,0.27,0.055);data.use_shadow=shadows
        data.use_custom_distance=True
        light=bpy.data.objects.new(label,data);obj.users_collection[0].objects.link(light);light.parent=control
        property_driver(data,'shadow_soft_size',control,'Radius')
        property_driver(data,'cutoff_distance',control,'Range')
        expression='max(0,value)*(1-min(1,max(0,flicker))*(0.5+0.3*sin(frame/%r*7.1)+0.2*sin(frame/%r*13.7+1.2)))'%(fps,fps)
        property_driver(data,'energy',control,prop,expression,(('flicker','Flicker'),))
        light['Lighting role']='Approximate fire lighting, not a source M2 light'
    control.update_tag();bpy.context.view_layer.update()
    obj['Fire Lighting status']='Preset created; adjust the Fire Lighting controller.'
    return control
