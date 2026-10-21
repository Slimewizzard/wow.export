const fs = require('fs/promises');
const path = require('path');
const InstallType = require('../install-type');
const DBDecor = require('../db/caches/DBDecor');
const ExportHelper = require('../casc/export-helper');
const listfile = require('../casc/listfile');
const modelUtils = require('../ui/model-viewer-utils');
const {readBlueprints, resolveInventory} = require('../room-blueprint');
const {bundleOBJ} = require('../room-obj-assets');

module.exports = {
    register() { this.registerNavButton('Room Blueprint', 'house.svg', InstallType.CASC); },
    data() { return {blueprints: [], selected: 0, items: [], ready: false, message: 'Load RoomProbe.lua from WoW SavedVariables.', exporting: false, format: 'OBJ', dyeMode:'captured'}; },
    template: `<div class="tab" style="padding:24px;overflow:auto;box-sizing:border-box;height:100%">
      <h2>Room Blueprint</h2>
      <p>Export the decor in a captured blueprint, then arrange its quantities in Blender.</p>
      <p><input type="file" accept=".lua,.json" @change="load_file" :disabled="!ready || exporting || $core.view.isBusy" /></p>
      <p v-if="blueprints.length"><select v-model.number="selected" @change="select_blueprint" :disabled="exporting">
        <option v-for="(bp,i) in blueprints" :value="i">{{bp.label}} — {{bp.id || 'legacy capture'}} — {{bp.time}}</option>
      </select></p>
      <p>{{message}}</p>
      <p v-if="blueprints.length">{{blueprints.length}} saved rooms / captures loaded.</p>
      <table v-if="items.length" style="width:100%;text-align:left"><thead><tr><th>Decor</th><th>Quantity</th><th>Status</th></tr></thead>
        <tbody><tr v-for="item in items" :key="item.decorID"><td style="padding:6px">{{item.name}}</td><td>{{item.count}}</td><td>{{item.status}}</td></tr></tbody>
      </table>
      <p v-if="items.length">Room shells and fixtures are retained in the manifest for reference. This export includes decor models; dyes are recorded but not applied.</p>
      <p><label>Format <select v-model="format" :disabled="exporting"><option>OBJ</option><option>GLTF</option><option>GLB</option></select></label></p>
      <p><label>Colours <select v-model="dyeMode" :disabled="exporting"><option value="captured">Base materials + captured dye IDs in manifest</option><option value="base">Base materials only</option></select></label></p>
      <p>Captured dye IDs are retained per instance; dye rendering is not yet implemented.</p>
      <p v-if="format === 'OBJ'"><label><input type="checkbox" v-model="$core.view.config.exportM2Effects" /> Export M2 effects for Blender</label></p>
      <p><label><input type="checkbox" v-model="$core.view.config.modelsExportTextures" :disabled="exporting" /> Export textures</label></p>
      <button @click="export_blueprint" :disabled="!items.length || exporting || $core.view.isBusy">Export blueprint decor</button>
      <p>Each run gets a new folder under your export directory’s room-blueprints folder. Keep the whole folder together for Blender.</p>
    </div>`,
    async mounted() {
        try { await DBDecor.initializeDecorData(); this.ready = true; }
        catch (e) { this.message = 'Could not load decor database: ' + e.message; }
    },
    methods: {
        async load_file(event) {
            const file = event.target.files?.[0]; if (!file) return;
            try {
                if (file.size > 20 * 1024 * 1024) throw new Error('File exceeds 20 MB');
                this.blueprints = readBlueprints(await file.text());
                this.selected = this.blueprints.length - 1;
                this.select_blueprint();
            } catch (e) { this.blueprints = []; this.items = []; this.message = e.message; }
        },
        select_blueprint() {
            this.items = resolveInventory(this.blueprints[this.selected], id => DBDecor.getDecorItemByID(id));
            this.message = `${this.items.length} unique decor models, ${this.items.reduce((n,i) => n+i.count,0)} instances. ${this.items.filter(i=>i.status==='unresolved').length} unresolved. ${this.items.reduce((n,i)=>n+(i.dyeCaptures?.length||0),0)} captured colour instances.`;
        },
        async export_blueprint() {
            if (this.exporting || this.$core.view.isBusy || !this.items.length) return;
            if (!this.$core.view.config.modelsExportTextures) { this.message = 'Enable Export textures before exporting the room.'; return; }
            this.exporting = true;
            const core = this.$core;
            const previousMeta = core.view.config.exportM2Meta;
            if (this.format === 'OBJ') core.view.config.exportM2Meta = true;
            const helper = new ExportHelper(this.items.length, 'decor');
            let started = false;
            try {
                const base = ExportHelper.getExportPath('room-blueprints');
                await fs.mkdir(base, {recursive:true});
                const folder = await fs.mkdtemp(path.join(base, 'room-'));
                const manifest = {...this.blueprints[this.selected], schema:'room-building.export.v1', format:this.format, dyeMode:this.dyeMode, items:this.items.map(i=>({...i, dyeCaptures:this.dyeMode==='captured'?(i.dyeCaptures||[]):[], status:'pending'})),
                    note:'Decor inventory only. No original placement transforms. Dyes and non-decor entries retained as metadata.'};
                const save = () => fs.writeFile(path.join(folder, 'room-manifest.json'), JSON.stringify(manifest,null,2));
                await save();
                helper.start(); started = true;
                for (const item of manifest.items) {
                    if (helper.isCancelled()) break;
                    try {
                        if (!item.modelFileDataID) throw new Error('Decor ID not found in this game build');
                        const data = await core.view.casc.getFile(item.modelFileDataID);
                        const ext = modelUtils.get_model_extension(modelUtils.detect_model_type(data));
                        const fileName = listfile.getByID(item.modelFileDataID) || listfile.formatUnknownFile(item.modelFileDataID,ext);
                        const stem = `decor-${item.decorID}`;
                        await modelUtils.export_model({core, data, file_data_id:item.modelFileDataID, file_name:fileName,
                            format:this.format, export_path:path.join(folder,stem+ext), helper, file_manifest:[]});
                        if (helper.isCancelled()) { item.status='cancelled'; break; }
                        item.file = stem + '.' + this.format.toLowerCase();
                        await fs.access(path.join(folder,item.file));
                        if (this.format === 'OBJ') item.assets = await bundleOBJ(path.join(folder,item.file));
                        // Bundle all referenced image files locally, regardless of shared-texture settings.
                        if (this.format === 'GLTF') {
                            const gltfPath = path.join(folder,item.file);
                            const gltf = JSON.parse(await fs.readFile(gltfPath,'utf8'));
                            for (const [index,image] of (gltf.images || []).entries()) {
                                if (!image.uri || image.uri.startsWith('data:')) continue;
                                const textureSource = path.resolve(folder, image.uri.replaceAll('\\', '/'));
                                const localName = `${stem}-texture-${index}${path.extname(textureSource)}`;
                                await fs.copyFile(textureSource,path.join(folder,localName));
                                image.uri = localName;
                            }
                            await fs.writeFile(gltfPath, JSON.stringify(gltf,null,2));
                        }
                        item.status='exported'; helper.mark(item.name,true);
                    } catch(e) { item.status='failed'; item.error=e.message; delete item.file; helper.mark(item.name,false,e.message,e.stack); }
                    await save();
                }
                for (const item of manifest.items) if (item.status === 'pending') item.status='cancelled';
                await save();
                this.items = manifest.items;
                this.message = `Exported ${manifest.items.filter(i=>i.status==='exported').length}/${manifest.items.length} models. Blender manifest: ${path.join(folder,'room-manifest.json')}`;
            } catch(e) { this.message = 'Export failed: ' + e.message; }
            finally { core.view.config.exportM2Meta = previousMeta; if (started) helper.finish(); this.exporting = false; }
        }
    }
};
