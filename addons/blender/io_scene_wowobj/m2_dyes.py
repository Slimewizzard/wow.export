"""Conservative manual dye preview for paired housing dye maps.

RGB region masks and influence shading are inferred from exported assets.
This is not the WoW dye palette/gradient shader. Zero strength preserves the base.
"""
from pathlib import Path
import re
import bpy
import numpy as np


def apply_dye_controls(material, metadata, base_dir, base_texture=None):
    if not material or not material.use_nodes:
        return False
    tree=material.node_tree
    if tree.nodes.get('WoW Dye Controls'):
        return True
    shader=next((n for n in tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
    if not shader or not shader.inputs['Base Color'].is_linked:
        return False
    textures=metadata.get('textures',[])
    regions=[t for t in textures if '_dyecolormap_' in t.get('fileNameInternal','').lower()]
    # Only an unambiguous pair belonging to this material's base texture.
    pairs=[]
    for region in regions:
        prefix=region['fileNameInternal'].lower().split('_dyecolormap_')[0]
        base_name=base_texture or ''
        if not base_name:
            images={Path(n.image.filepath).name for n in tree.nodes if n.type=='TEX_IMAGE' and n.image}
            bases=[t for t in textures if Path(t.get('fileNameExternal','').replace('\\','/')).name in images and '_dye' not in t.get('fileNameInternal','')]
            if not any(re.sub(r'_\d+\.blp$','',t.get('fileNameInternal','').lower())==prefix for t in bases):
                continue
        elif re.sub(r'_\d+\.blp$','',base_name.lower())!=prefix:
            continue
        influences=[t for t in textures if t.get('fileNameInternal','').lower().startswith(prefix+'_dyeinfluencemap_')]
        if len(influences)==1:pairs.append((region,influences[0]))
    if len(pairs)!=1:
        return False
    region,influence=pairs[0]
    paths=[Path(base_dir)/t.get('fileNameExternal','').replace('\\','/') for t in (region,influence)]
    if not all(p.is_file() for p in paths):
        material['Dye review']='Missing dye map file; original material retained.'
        return False
    mask_image=bpy.data.images.load(str(paths[0]),check_existing=True)
    # A dedicated data image avoids changing colour interpretation of other users.
    if mask_image.colorspace_settings.name!='Non-Color':
        mask_image=mask_image.copy();mask_image.colorspace_settings.name='Non-Color'
    pixels=np.empty(len(mask_image.pixels),dtype=np.float32);mask_image.pixels.foreach_get(pixels)
    if not pixels.size:return False
    rgb=pixels.reshape(-1,4)[:,:3]
    active=[i for i in range(3) if np.any(rgb[:,i]>.1)]
    if not active:return False
    influence_image=bpy.data.images.load(str(paths[1]),check_existing=True)
    group=bpy.data.node_groups.new('WoW masked dyes - '+material.name,'ShaderNodeTree')
    def socket(name,kind,default=None):
        s=group.interface.new_socket(name=name,in_out='INPUT',socket_type=kind)
        if default is not None:s.default_value=default
        return s
    socket('Original colour','NodeSocketColor')
    socket('Region map','NodeSocketColor')
    socket('Influence shading','NodeSocketColor')
    for i in active:
        name='Slot '+str(i+1)
        socket(name+' colour','NodeSocketColor',(1,1,1,1))
        strength=socket(name+' strength','NodeSocketFloat',0.0);strength.min_value=0;strength.max_value=1
        strength.description='Manual dye preview for '+name.lower()+' mask; zero preserves original appearance.'
    group.interface.new_socket(name='Colour',in_out='OUTPUT',socket_type='NodeSocketColor')
    nodes,links=group.nodes,group.links
    inputs=nodes.new('NodeGroupInput');inputs.location=(-650,0)
    output=nodes.new('NodeGroupOutput');output.location=(650,0)
    separate=nodes.new('ShaderNodeSeparateColor');separate.mode='RGB';separate.location=(-450,-200)
    links.new(inputs.outputs['Region map'],separate.inputs[0])
    result=inputs.outputs['Original colour']
    for i in active:
        name='Slot '+str(i+1)
        factor=nodes.new('ShaderNodeMath');factor.operation='MULTIPLY';factor.use_clamp=True
        links.new(separate.outputs[i],factor.inputs[0]);links.new(inputs.outputs[name+' strength'],factor.inputs[1])
        dyed=nodes.new('ShaderNodeMixRGB');dyed.blend_type='MULTIPLY';dyed.inputs[0].default_value=1
        links.new(inputs.outputs['Influence shading'],dyed.inputs[1]);links.new(inputs.outputs[name+' colour'],dyed.inputs[2])
        mix=nodes.new('ShaderNodeMixRGB');mix.blend_type='MIX'
        links.new(factor.outputs[0],mix.inputs[0]);links.new(result,mix.inputs[1]);links.new(dyed.outputs[0],mix.inputs[2])
        factor.location=(-200,-i*220);dyed.location=(0,-i*220);mix.location=(220+i*140,100)
        result=mix.outputs[0]
    links.new(result,output.inputs[0])
    original=shader.inputs['Base Color'].links[0].from_socket
    control=tree.nodes.new('ShaderNodeGroup');control.node_tree=group;control.name='WoW Dye Controls';control.label='Dyes — manual masked colours';control.width=260;control.location=(shader.location.x-300,shader.location.y)
    tree.links.new(original,control.inputs['Original colour'])
    for t,img,name,y in [(region,mask_image,'Dye regions',-300),(influence,influence_image,'Dye shading',-600)]:
        tex=tree.nodes.new('ShaderNodeTexImage');tex.image=img;tex.name=name;tex.label=Path(t['fileNameInternal']).name;tex.location=(shader.location.x-650,shader.location.y+y)
        tree.links.new(tex.outputs['Color'],control.inputs['Region map' if name=='Dye regions' else 'Influence shading'])
    tree.links.new(control.outputs[0],shader.inputs['Base Color'])
    material['Dye review']='Manual RGB-region approximation. Strength 0 preserves base. WoW palette IDs/gradients and channel-to-slot mapping are not resolved.'
    material['Dye region source']=region['fileNameInternal']
    return True
