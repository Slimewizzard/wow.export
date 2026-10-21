"""Shader 32770 view-space sphere-map highlight, based on exporter shader code."""
import bpy

def apply_reflection(material, base, reflection, unit):
    if unit.get('shaderID')!=32770:return False
    nodes,links=material.node_tree.nodes,material.node_tree.links
    if nodes.get('M2 Reflection Highlight'):return True
    def node(kind,name):
        n=nodes.new(kind);n.name=name;return n
    geometry=node('ShaderNodeNewGeometry','Reflection geometry')
    neg=node('ShaderNodeVectorMath','Reflection incoming');neg.operation='SCALE';neg.inputs[3].default_value=-1
    links.new(geometry.outputs['Incoming'],neg.inputs[0])
    reflect=node('ShaderNodeVectorMath','Reflection direction');reflect.operation='REFLECT'
    links.new(neg.outputs[0],reflect.inputs[0]);links.new(geometry.outputs['Normal'],reflect.inputs[1])
    camera=node('ShaderNodeVectorTransform','Reflection view space');camera.vector_type='VECTOR';camera.convert_from='WORLD';camera.convert_to='CAMERA'
    links.new(reflect.outputs[0],camera.inputs[0])
    offset=node('ShaderNodeVectorMath','Sphere map offset');offset.operation='ADD';offset.inputs[1].default_value=(0,0,1);links.new(camera.outputs[0],offset.inputs[0])
    length=node('ShaderNodeVectorMath','Sphere map length');length.operation='LENGTH';links.new(offset.outputs[0],length.inputs[0])
    def math(op,name,a=None,b=None):
        n=node('ShaderNodeMath',name);n.operation=op
        for i,v in enumerate((a,b)):
            if v is None:continue
            if isinstance(v,(float,int)):n.inputs[i].default_value=v
            else:links.new(v,n.inputs[i])
        return n.outputs[0]
    denominator=math('MAXIMUM','Sphere map safe denominator',math('MULTIPLY','Sphere map denominator',length.outputs['Value'],2),.000001)
    split=node('ShaderNodeSeparateXYZ','Sphere map axes');links.new(camera.outputs[0],split.inputs[0])
    uv=node('ShaderNodeCombineXYZ','Reflection UV')
    for i in (0,1):links.new(math('ADD','Reflection UV offset',math('DIVIDE','Reflection UV divide',split.outputs[i],denominator),.5),uv.inputs[i])
    links.new(uv.outputs[0],reflection.inputs['Vector'])
    reflection.extension='EXTEND';reflection.label='Sphere-map reflection (shader 32770)'
    mask=math('MULTIPLY','Reflection alpha mask',reflection.outputs['Alpha'],math('SUBTRACT','Inverse base alpha',1,base.outputs['Alpha']))
    strength=node('ShaderNodeValue','Reflection strength');strength.outputs[0].default_value=1
    mask=math('MULTIPLY','Reflection amount',mask,strength.outputs[0])
    # A painted environment highlight must not act as a new scene light.
    rays=node('ShaderNodeLightPath','Reflection ray visibility')
    visible=math('MAXIMUM','Visible reflection rays',rays.outputs['Is Camera Ray'],rays.outputs['Is Glossy Ray'])
    highlight=node('ShaderNodeEmission','M2 Reflection Highlight')
    links.new(reflection.outputs['Color'],highlight.inputs['Color']);links.new(math('MULTIPLY','Reflection visible strength',mask,visible),highlight.inputs['Strength'])
    for out in [n for n in nodes if n.type=='OUTPUT_MATERIAL' and n.inputs['Surface'].is_linked]:
        original=out.inputs['Surface'].links[0].from_socket
        add=node('ShaderNodeAddShader','M2 Reflection surface')
        links.new(original,add.inputs[0]);links.new(highlight.outputs[0],add.inputs[1]);links.new(add.outputs[0],out.inputs['Surface'])
    material['Reflection setup']='32770: sphere-map RGB × reflection alpha × (1-base alpha). View-space mapping approximate in Blender; does not illuminate scene.'
    return True
