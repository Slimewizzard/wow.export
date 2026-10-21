bl_info = {
    'name': 'Room Blueprint Lineup', 'author': 'RoomBuilding', 'version': (0, 1, 0),
    'blender': (4, 0, 0), 'location': 'File > Import > Room Blueprint Lineup',
    'description': 'Import exported blueprint decor as a labeled, spaced lineup', 'category': 'Import-Export',
}
import json
import math
from pathlib import Path
import bpy
from bpy.props import StringProperty, IntProperty, FloatProperty, BoolProperty, CollectionProperty, EnumProperty
from bpy_extras.io_utils import ImportHelper
from mathutils import Vector


def import_lineup(context, filepath, columns=4, gap=2.0, quantities=True, labels=False, selected_ids=None, layout='GRID', effects=True, fire_lighting=False):
    source = Path(filepath).resolve()
    manifest = json.loads(source.read_text(encoding='utf-8-sig'))
    if manifest.get('schema') != 'room-building.export.v1':
        raise ValueError('Choose room-manifest.json produced by Room Blueprint export')
    items = manifest.get('items')
    if not isinstance(items, list) or len(items) > 10000:
        raise ValueError('Invalid item list')
    columns, gap = max(1, int(columns)), max(0.1, float(gap))
    prepared, warnings, total = [], [], 0
    for item in items:
        if selected_ids is not None and str(item.get('decorID')) not in selected_ids:
            continue
        if item.get('status') != 'exported':
            warnings.append(f"{item.get('name', 'Unknown')}: {item.get('status', 'not exported')}")
            continue
        count = item.get('count')
        if type(count) is not int or not 1 <= count <= 10000:
            raise ValueError('Invalid quantity')
        total += count if quantities else 1
        if total > 10000:
            raise ValueError('Import exceeds 10,000 instances')
        file = (source.parent / item['file']).resolve()
        if not file.is_relative_to(source.parent) or file.suffix.lower() not in ('.gltf', '.glb', '.obj'):
            raise ValueError('Model paths must be OBJ/glTF/GLB files within the export folder')
        if not file.is_file():
            warnings.append(f"{item['name']}: model file missing")
            continue
        prepared.append((item, file, count if quantities else 1))
    if not prepared:
        raise ValueError('No exported models are available to import')
    if context.object and context.object.mode != 'OBJECT':
        raise ValueError('Switch to Object Mode before importing')
    room = bpy.data.collections.new('Room lineup - ' + str(manifest.get('label', 'Blueprint')))
    context.scene.collection.children.link(room)
    assets = []
    for item, file, count in prepared:
        before = set(bpy.data.objects)
        old_collections = set(bpy.data.collections)
        try:
            if file.suffix.lower() == '.obj':
                from io_scene_wowobj import Settings, import_wowobj
                import_wowobj.importWoWOBJAddon(str(file), Settings(allowDuplicates=True, importEffects=effects, fireLighting=fire_lighting))
            else:
                bpy.ops.import_scene.gltf(filepath=str(file))
            objects = set(bpy.data.objects) - before
            context.view_layer.update()
            corners = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == 'MESH' and not (obj.parent and 'Preview particle count' in obj.parent) for corner in obj.bound_box]
            if not corners:
                raise ValueError('Model contains no mesh geometry')
            low = Vector(tuple(min(c[axis] for c in corners) for axis in range(3)))
            high = Vector(tuple(max(c[axis] for c in corners) for axis in range(3)))
            if not all(math.isfinite(v) for v in (*low, *high)):
                raise ValueError('Invalid model bounds')
            asset = bpy.data.collections.new(f"Asset {item['decorID']} - {item['name']}")
            # Unlinked asset collections are visible only through the lineup instances.
            for obj in objects:
                for owner in list(obj.users_collection):
                    owner.objects.unlink(obj)
                asset.objects.link(obj)
            asset.instance_offset = Vector(((low.x+high.x)/2, (low.y+high.y)/2, low.z))
            assets.append((item, asset, high-low, count))
        except Exception as error:
            for obj in set(bpy.data.objects) - before:
                bpy.data.objects.remove(obj, do_unlink=True)
            warnings.append(f"{item['name']}: {error}")
        # Remove only empty collections created by this import.
        for coll in set(bpy.data.collections) - old_collections:
            if not coll.objects and not coll.children:
                bpy.data.collections.remove(coll)
    if not assets:
        bpy.data.collections.remove(room)
        raise ValueError('Every model failed to import: ' + '; '.join(warnings))
    cell_x = max(size.x for _, _, size, _ in assets) + gap
    cell_y = max(size.y for _, _, size, _ in assets) + gap
    instances = []
    for item, asset, size, count in assets:
        for copy_index in range(count):
            index = len(instances)
            from .real_items import editable_copy
            position=Vector(((index % columns) * cell_x, -(index // columns) * cell_y, 0) if layout=='GRID' else ((index*cell_x,0,0) if layout=='ROW' else (0,0,0)))
            instance=editable_copy(asset,room,f"{item['name']} [{copy_index+1}/{count}]",position)
            instance.empty_display_size = 0.25
            instance['decor_id'] = item['decorID']
            instance['blueprint_quantity'] = item['count']
            instance['source_file'] = str(item['file'])
            instance['variants_json'] = json.dumps(item.get('variants', []))
            instance['captured_dyes_json'] = json.dumps(item.get('dyeCaptures', []))
            instance['dye_status'] = 'Captured IDs only; base materials. Captures are not assigned to arbitrary duplicate pieces.'
            instances.append(instance)
            if labels:
                text = bpy.data.curves.new(instance.name + ' label', 'FONT')
                text.body = f"{item['name']} ({copy_index+1}/{count})"
                text.align_x = 'CENTER'
                text.size = min(0.3, cell_x / max(10, len(text.body)) * 1.4)
                label = bpy.data.objects.new(text.name, text)
                room.objects.link(label)
                label.parent = instance
                label.location = (0, -size.y / 2 - gap * 0.4, 0.02)
                label.hide_select = True
    for _,asset,_,_ in assets:
        for obj in list(asset.objects):bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.collections.remove(asset)
    room['source_manifest'] = str(source)
    room['other_groups_json'] = json.dumps(manifest.get('otherGroups', []))
    room['import_warnings'] = '\n'.join(warnings)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in instances:
        obj.select_set(True)
    context.view_layer.objects.active = instances[0]
    context.view_layer.update()
    return room, instances, warnings


class ROOMBLUEPRINT_PG_item(bpy.types.PropertyGroup):
    decor_id: StringProperty()
    selected: BoolProperty(default=True)


class ROOMBLUEPRINT_UL_items(bpy.types.UIList):
    def draw_item(self,context,layout,data,item,icon,active_data,active_propname,index):
        layout.prop(item,'selected',text='')
        layout.label(text=item.name)


class IMPORT_SCENE_OT_room_blueprint(bpy.types.Operator, ImportHelper):
    bl_idname = 'import_scene.room_blueprint'
    bl_label = 'Import Room Blueprint Lineup'
    bl_options = {'REGISTER', 'UNDO'}
    filename_ext = '.json'
    filter_glob: StringProperty(default='*.json', options={'HIDDEN'})
    columns: IntProperty(name='Columns', default=4, min=1, max=100)
    gap: FloatProperty(name='Gap', default=2.0, min=0.1, max=100)
    quantities: BoolProperty(name='Include blueprint quantities', default=True)
    labels: BoolProperty(name='Item labels', default=False)
    effects: BoolProperty(name='Import M2 effects (OBJ)', default=True)
    fire_lighting: BoolProperty(name='Fire Lighting preset (OBJ)', default=False)
    layout_mode: EnumProperty(name='Placement',items=[('GRID','XY grid',''),('ROW','Single row',''),('PILE','Pile at origin','')],default='GRID')
    items: CollectionProperty(type=ROOMBLUEPRINT_PG_item)
    active_item: IntProperty(default=0)
    reviewed: BoolProperty(default=False,options={'HIDDEN','SKIP_SAVE'})

    def draw(self, context):
        layout=self.layout
        if self.items:
            layout.template_list('ROOMBLUEPRINT_UL_items','',self,'items',self,'active_item',rows=10)
            layout.label(text='Dye captures are retained as metadata; materials use base colours.')
        for key in ('layout_mode','columns','gap','quantities','labels','effects','fire_lighting'):
            layout.prop(self,key)

    def execute(self, context):
        try:
            if not self.reviewed:
                manifest=json.loads(Path(self.filepath).read_text(encoding='utf-8-sig'))
                if manifest.get('schema') != 'room-building.export.v1': raise ValueError('Choose room-manifest.json')
                self.items.clear()
                for item in manifest.get('items',[]):
                    if item.get('status')=='exported':
                        row=self.items.add();row.decor_id=str(item['decorID']);row.name=f"{item['name']} × {item['count']}";row.selected=True
                self.reviewed=True
                return context.window_manager.invoke_props_dialog(self,width=620)
            chosen={item.decor_id for item in self.items if item.selected}
            room, objects, warnings = import_lineup(context, self.filepath, self.columns, self.gap, self.quantities, self.labels,chosen,self.layout_mode,self.effects,self.fire_lighting)
            self.report({'WARNING'} if warnings else {'INFO'}, f'Imported {len(objects)} pieces; {len(warnings)} skipped. Details in collection properties.')
            return {'FINISHED'}
        except Exception as error:
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}


def menu_import(self, context):
    self.layout.operator(IMPORT_SCENE_OT_room_blueprint.bl_idname, text='Room Blueprint Lineup (.json)')


def register():
    bpy.utils.register_class(ROOMBLUEPRINT_PG_item)
    bpy.utils.register_class(ROOMBLUEPRINT_UL_items)
    bpy.utils.register_class(IMPORT_SCENE_OT_room_blueprint)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.utils.unregister_class(IMPORT_SCENE_OT_room_blueprint)
    bpy.utils.unregister_class(ROOMBLUEPRINT_UL_items)
    bpy.utils.unregister_class(ROOMBLUEPRINT_PG_item)
